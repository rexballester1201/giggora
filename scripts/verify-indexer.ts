#!/usr/bin/env node
/**
 * Giggora — Phase 4 indexer acceptance test (brief §22, §39).
 *
 * Compares the indexed database against the CHAIN ITSELF, block by block. The
 * RPC node is ground truth here; nothing is trusted just because the indexer
 * wrote it.
 *
 * Checks:
 *   1. Checkpoint is consistent with the data (never ahead of it)
 *   2. No gaps in the indexed block range
 *   3. No duplicate rows
 *   4. Every block matches RPC: hash, parent, timestamp, validator, gas, tx count
 *   5. Every transaction matches RPC: hash, from/to, value, status, gas, fee
 *   6. Log counts match per block
 *   7. Token transfers reconcile against the raw logs they were decoded from
 *
 * Usage:
 *   node scripts/verify-indexer.ts [--limit 1000]
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPublicClient, defineChain, http } from "viem";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
) as Record<string, string>;

const li = process.argv.indexOf("--limit");
const LIMIT = li !== -1 && process.argv[li + 1] ? Number(process.argv[li + 1]) : 1000;

const CHAIN_ID = Number(env.CHAIN_ID);
const giggora = defineChain({
  id: CHAIN_ID,
  name: env.CHAIN_NAME,
  nativeCurrency: {
    name: env.CURRENCY_NAME,
    symbol: env.CURRENCY_SYMBOL,
    decimals: Number(env.CURRENCY_DECIMALS),
  },
  rpcUrls: { default: { http: [env.RPC_URL] } },
});

const rpc = createPublicClient({ chain: giggora, transport: http(env.RPC_URL) });
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL,
  max: 4,
});

const hex = (b: Buffer | null) => (b === null ? null : `0x${b.toString("hex")}`);

let failures = 0;
async function check(name: string, fn: () => Promise<string | void>) {
  process.stdout.write(`  ${name.padEnd(52, " ")}`);
  try {
    const detail = await fn();
    console.log(`PASS  ${detail ?? ""}`);
  } catch (err: any) {
    failures++;
    console.log(`FAIL\n      -> ${err.message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

console.log(`
  Giggora :: Phase 4 indexer acceptance test
  ==========================================
  Comparing the database against the chain (RPC is ground truth)
`);

const stateRes = await pool.query("SELECT last_processed_block FROM indexer_state WHERE id=1");
assert(stateRes.rowCount === 1, "indexer_state has no row — has the indexer run?");
const checkpoint = Number(stateRes.rows[0].last_processed_block);

const rangeRes = await pool.query(
  "SELECT min(number) AS lo, max(number) AS hi, count(*) AS n FROM blocks"
);
const lo = Number(rangeRes.rows[0].lo);
const hi = Number(rangeRes.rows[0].hi);
const n = Number(rangeRes.rows[0].n);

// Verify the newest LIMIT blocks in the indexed range.
const from = Math.max(lo, hi - LIMIT + 1);
console.log(`  indexed range ${lo}..${hi} (${n} blocks); verifying ${from}..${hi}\n`);

// 1. checkpoint consistency
await check("Checkpoint never ahead of stored data", async () => {
  assert(
    checkpoint <= hi,
    `checkpoint is ${checkpoint} but highest stored block is ${hi} — data loss window`
  );
  return `checkpoint ${checkpoint}, max block ${hi}`;
});

// 2. no gaps
await check("No gaps in indexed block range", async () => {
  const r = await pool.query(
    `SELECT count(*)::int AS missing FROM generate_series($1::bigint, $2::bigint) g(num)
     WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.number = g.num)`,
    [lo, hi]
  );
  const missing = r.rows[0].missing;
  assert(missing === 0, `${missing} block(s) missing between ${lo} and ${hi}`);
  return `${hi - lo + 1} contiguous blocks`;
});

// 3. no duplicates
await check("No duplicate rows", async () => {
  const dupes = await pool.query(`
    SELECT
      (SELECT count(*) FROM (SELECT number FROM blocks GROUP BY number HAVING count(*)>1) a) AS b,
      (SELECT count(*) FROM (SELECT hash FROM transactions GROUP BY hash HAVING count(*)>1) c) AS t,
      (SELECT count(*) FROM (SELECT transaction_hash, log_index FROM logs
         GROUP BY transaction_hash, log_index HAVING count(*)>1) d) AS l
  `);
  const { b, t, l } = dupes.rows[0];
  assert(Number(b) === 0 && Number(t) === 0 && Number(l) === 0,
    `duplicates: blocks=${b} txs=${t} logs=${l}`);
  return "blocks, transactions, logs all unique";
});

// 4. block-level match against RPC
await check(`Every block matches RPC (${from}..${hi})`, async () => {
  const rows = await pool.query(
    `SELECT number, hash, parent_hash, timestamp, validator, gas_used, gas_limit,
            transaction_count
       FROM blocks WHERE number BETWEEN $1 AND $2 ORDER BY number`,
    [from, hi]
  );

  const mismatches: string[] = [];
  for (const row of rows.rows) {
    const num = Number(row.number);
    const chain = await rpc.getBlock({ blockNumber: BigInt(num) });

    if (hex(row.hash) !== chain.hash) mismatches.push(`#${num} hash`);
    if (hex(row.parent_hash) !== chain.parentHash) mismatches.push(`#${num} parentHash`);
    if (hex(row.validator) !== chain.miner.toLowerCase()) mismatches.push(`#${num} validator`);
    if (BigInt(row.gas_used) !== chain.gasUsed) mismatches.push(`#${num} gasUsed`);
    if (BigInt(row.gas_limit) !== chain.gasLimit) mismatches.push(`#${num} gasLimit`);
    if (Number(row.transaction_count) !== chain.transactions.length) {
      mismatches.push(`#${num} txCount ${row.transaction_count}!=${chain.transactions.length}`);
    }
    const dbTs = Math.floor(new Date(row.timestamp).getTime() / 1000);
    if (dbTs !== Number(chain.timestamp)) mismatches.push(`#${num} timestamp`);

    if (mismatches.length > 5) break;
  }

  assert(mismatches.length === 0, mismatches.slice(0, 5).join("; "));
  return `${rows.rowCount} blocks verified field-by-field`;
});

// 5. transaction-level match against RPC
await check("Every transaction matches RPC", async () => {
  const rows = await pool.query(
    `SELECT hash, block_number, transaction_index, from_address, to_address, value,
            status, gas_used, effective_gas_price, fee, nonce
       FROM transactions WHERE block_number BETWEEN $1 AND $2
       ORDER BY block_number, transaction_index`,
    [from, hi]
  );

  const mismatches: string[] = [];
  for (const row of rows.rows) {
    const h = hex(row.hash) as `0x${string}`;
    const tx = await rpc.getTransaction({ hash: h });
    const receipt = await rpc.getTransactionReceipt({ hash: h });

    if (Number(row.block_number) !== Number(tx.blockNumber)) mismatches.push(`${h} block`);
    if (hex(row.from_address) !== tx.from.toLowerCase()) mismatches.push(`${h} from`);
    const dbTo = hex(row.to_address);
    const chainTo = tx.to ? tx.to.toLowerCase() : null;
    if (dbTo !== chainTo) mismatches.push(`${h} to`);
    if (BigInt(row.value) !== tx.value) mismatches.push(`${h} value`);
    if (Number(row.nonce) !== tx.nonce) mismatches.push(`${h} nonce`);
    if (Number(row.status) !== (receipt.status === "success" ? 1 : 0)) {
      mismatches.push(`${h} status`);
    }
    if (BigInt(row.gas_used) !== receipt.gasUsed) mismatches.push(`${h} gasUsed`);
    if (BigInt(row.fee) !== receipt.gasUsed * receipt.effectiveGasPrice) {
      mismatches.push(`${h} fee`);
    }

    if (mismatches.length > 5) break;
  }

  assert(mismatches.length === 0, mismatches.slice(0, 5).join("; "));
  return `${rows.rowCount} transactions verified against RPC`;
});

// 6. log counts per block
await check("Log counts match RPC per block", async () => {
  const rows = await pool.query(
    `SELECT block_number, count(*)::int AS n FROM logs
      WHERE block_number BETWEEN $1 AND $2 GROUP BY block_number ORDER BY block_number`,
    [from, hi]
  );

  const mismatches: string[] = [];
  let total = 0;
  for (const row of rows.rows) {
    const num = Number(row.block_number);
    const chainLogs = await rpc.getLogs({ fromBlock: BigInt(num), toBlock: BigInt(num) });
    total += Number(row.n);
    if (Number(row.n) !== chainLogs.length) {
      mismatches.push(`#${num} ${row.n}!=${chainLogs.length}`);
      if (mismatches.length > 5) break;
    }
  }

  assert(mismatches.length === 0, mismatches.slice(0, 5).join("; "));
  return `${total} logs across ${rows.rowCount} blocks`;
});

// 7. token transfers reconcile against the logs they came from
await check("Token transfers reconcile with source logs", async () => {
  // Every ERC-20 transfer must come from a 3-topic Transfer log with data;
  // every ERC-721 from a 4-topic one with empty data. This is the distinction
  // the whole decoder rests on, so it is checked against stored reality.
  const bad = await pool.query(`
    SELECT tt.standard,
           count(*) FILTER (WHERE tt.standard='erc20'  AND l.topic3 IS NOT NULL) AS erc20_with_topic3,
           count(*) FILTER (WHERE tt.standard='erc721' AND l.topic3 IS NULL)     AS erc721_without_topic3,
           count(*) FILTER (WHERE tt.standard='erc20'  AND tt.value IS NULL)     AS erc20_null_value,
           count(*) FILTER (WHERE tt.standard='erc721' AND tt.token_id IS NULL)  AS erc721_null_id
      FROM token_transfers tt
      JOIN logs l ON l.transaction_hash = tt.transaction_hash AND l.log_index = tt.log_index
     GROUP BY tt.standard
  `);

  const problems: string[] = [];
  for (const r of bad.rows) {
    if (Number(r.erc20_with_topic3) > 0) problems.push(`erc20 rows with topic3: ${r.erc20_with_topic3}`);
    if (Number(r.erc721_without_topic3) > 0) problems.push(`erc721 rows without topic3: ${r.erc721_without_topic3}`);
    if (Number(r.erc20_null_value) > 0) problems.push(`erc20 rows with NULL value: ${r.erc20_null_value}`);
    if (Number(r.erc721_null_id) > 0) problems.push(`erc721 rows with NULL token_id: ${r.erc721_null_id}`);
  }
  assert(problems.length === 0, problems.join("; "));

  const orphan = await pool.query(`
    SELECT count(*)::int AS n FROM token_transfers tt
     WHERE NOT EXISTS (
       SELECT 1 FROM logs l
        WHERE l.transaction_hash = tt.transaction_hash AND l.log_index = tt.log_index)
  `);
  assert(Number(orphan.rows[0].n) === 0, `${orphan.rows[0].n} transfers with no source log`);

  const counts = await pool.query(
    `SELECT standard, count(*)::int AS n FROM token_transfers GROUP BY standard ORDER BY standard`
  );
  return counts.rows.map((r: any) => `${r.standard}=${r.n}`).join(" ");
});

// 8. referential integrity
await check("Referential integrity (no orphan rows)", async () => {
  const r = await pool.query(`
    SELECT
      (SELECT count(*) FROM transactions t
        WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.number=t.block_number))::int AS orphan_tx,
      (SELECT count(*) FROM logs l
        WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.hash=l.transaction_hash))::int AS orphan_log
  `);
  const { orphan_tx, orphan_log } = r.rows[0];
  assert(orphan_tx === 0 && orphan_log === 0,
    `orphan transactions=${orphan_tx}, orphan logs=${orphan_log}`);
  return "all foreign keys resolve";
});

console.log(`
  SYSTEM STATUS
  -------------
  Indexer              ${failures === 0 ? "PASS" : "FAIL"}
  Database             ${failures === 0 ? "PASS" : "FAIL"}
`);

await pool.end();

if (failures > 0) {
  console.log(`  ${failures} check(s) FAILED.\n`);
  process.exit(1);
}
console.log(`  All indexer checks passed.\n`);

#!/usr/bin/env node
/**
 * Giggora indexer (brief §21, §22).
 *
 * Reads blocks, transactions, receipts and logs from the RPC node and writes
 * them to Postgres.
 *
 * The property that makes it crash-safe: a block's rows AND the checkpoint
 * advance inside ONE database transaction. The checkpoint therefore can never
 * be ahead of the data it claims to describe, so a kill -9 at any instant
 * leaves the database consistent and the next start resumes exactly where it
 * left off.
 *
 * Every insert is ON CONFLICT DO NOTHING, so re-processing a block is a no-op
 * rather than a duplicate-key crash — that is what makes it idempotent and
 * safe to re-run over a range.
 *
 * There is deliberately NO reorg handling: QBFT gives absolute finality, so a
 * committed block can never be replaced. See database/migrations/001_initial.sql.
 *
 * Usage:
 *   node indexer/src/index.ts                 # follow the chain head
 *   node indexer/src/index.ts --once          # catch up to head, then exit
 *   node indexer/src/index.ts --from 0 --to 500
 *   node indexer/src/index.ts --status
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPublicClient, defineChain, http } from "viem";
import { toBytes, toNumeric, toTimestamp } from "./hex.ts";
import { decodeTransfers } from "./decode.ts";
import { resolvePendingTokenMetadata, refreshTokenSupplies } from "./tokens.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- config ------------------------------------------------------------------
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
) as Record<string, string>;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): number | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : null;
}

const CHAIN_ID = Number(env.CHAIN_ID);
const RPC_URL = env.RPC_URL;
const DATABASE_URL = process.env.DATABASE_URL ?? env.DATABASE_URL;
const POLL_MS = 1000;
// Bounded so one iteration cannot try to hold thousands of blocks in memory.
const MAX_BATCH = 50;

const giggora = defineChain({
  id: CHAIN_ID,
  name: env.CHAIN_NAME,
  nativeCurrency: {
    name: env.CURRENCY_NAME,
    symbol: env.CURRENCY_SYMBOL,
    decimals: Number(env.CURRENCY_DECIMALS),
  },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const rpc = createPublicClient({ chain: giggora, transport: http(RPC_URL) });
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let shuttingDown = false;

// --- checkpoint --------------------------------------------------------------
async function getCheckpoint(): Promise<number> {
  const r = await pool.query("SELECT last_processed_block FROM indexer_state WHERE id = 1");
  if (r.rowCount === 0) return -1; // nothing indexed yet; genesis is block 0
  return Number(r.rows[0].last_processed_block);
}

// --- indexing ----------------------------------------------------------------
/**
 * Index one block and advance the checkpoint atomically.
 *
 * Everything below happens inside BEGIN/COMMIT. If the process dies mid-way,
 * Postgres rolls the whole thing back and the checkpoint still points at the
 * last fully-written block.
 */
async function indexBlock(blockNumber: number): Promise<{ txs: number; logs: number; transfers: number }> {
  const block = await rpc.getBlock({ blockNumber: BigInt(blockNumber), includeTransactions: true });

  // Receipts carry status, gasUsed, effectiveGasPrice, logs and contractAddress
  // — none of which are on the transaction itself.
  const receipts = await Promise.all(
    block.transactions.map((tx: any) => rpc.getTransactionReceipt({ hash: tx.hash }))
  );

  const client = await pool.connect();
  let txCount = 0;
  let logCount = 0;
  let transferCount = 0;
  // Rows ACTUALLY inserted (rowCount 0 when ON CONFLICT skipped) — used to keep
  // the running totals in indexer_state correct across re-indexing.
  let insertedTxs = 0;
  let insertedLogs = 0;
  let insertedTransfers = 0;
  const newTokens = [];

  try {
    await client.query("BEGIN");

    const ts = toTimestamp(block.timestamp);

    await client.query(
      `INSERT INTO blocks (
         number, hash, parent_hash, timestamp, validator, gas_used, gas_limit,
         base_fee_per_gas, transaction_count, size, state_root, receipts_root,
         transactions_root, extra_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (number) DO NOTHING`,
      [
        blockNumber,
        toBytes(block.hash),
        toBytes(block.parentHash),
        ts,
        toBytes(block.miner),
        toNumeric(block.gasUsed),
        toNumeric(block.gasLimit),
        toNumeric(block.baseFeePerGas ?? null),
        block.transactions.length,
        Number(block.size),
        toBytes(block.stateRoot),
        toBytes(block.receiptsRoot),
        toBytes(block.transactionsRoot),
        toBytes(block.extraData),
      ]
    );

    for (let i = 0; i < block.transactions.length; i++) {
      const tx: any = block.transactions[i];
      const receipt = receipts[i];

      const gasUsed = receipt.gasUsed;
      const effectiveGasPrice = receipt.effectiveGasPrice;
      const fee = gasUsed * effectiveGasPrice;

      const txRes = await client.query(
        `INSERT INTO transactions (
           hash, block_number, transaction_index, from_address, to_address, value,
           nonce, gas, gas_price, max_fee_per_gas, max_priority_fee_per_gas, input,
           transaction_type, status, gas_used, effective_gas_price,
           cumulative_gas_used, contract_address, fee, timestamp
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (hash) DO NOTHING`,
        [
          toBytes(tx.hash),
          blockNumber,
          Number(tx.transactionIndex),
          toBytes(tx.from),
          toBytes(tx.to ?? null),
          toNumeric(tx.value),
          Number(tx.nonce),
          toNumeric(tx.gas),
          toNumeric(tx.gasPrice ?? null),
          toNumeric(tx.maxFeePerGas ?? null),
          toNumeric(tx.maxPriorityFeePerGas ?? null),
          toBytes(tx.input),
          typeof tx.type === "number" ? tx.type : txTypeToNumber(tx.type),
          receipt.status === "success" ? 1 : 0,
          toNumeric(gasUsed),
          toNumeric(effectiveGasPrice),
          toNumeric(receipt.cumulativeGasUsed),
          toBytes(receipt.contractAddress ?? null),
          toNumeric(fee),
          ts,
        ]
      );
      txCount++;
      insertedTxs += txRes.rowCount ?? 0;

      // Track addresses seen. A contract creation marks the new address.
      await touchAddress(client, tx.from, blockNumber, false);
      if (tx.to) await touchAddress(client, tx.to, blockNumber, false);
      if (receipt.contractAddress) {
        await touchAddress(client, receipt.contractAddress, blockNumber, true);
      }

      for (const log of receipt.logs) {
        const logRes = await client.query(
          `INSERT INTO logs (
             transaction_hash, log_index, block_number, address,
             topic0, topic1, topic2, topic3, data
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (transaction_hash, log_index) DO NOTHING`,
          [
            toBytes(log.transactionHash),
            Number(log.logIndex),
            blockNumber,
            toBytes(log.address),
            toBytes(log.topics[0] ?? null),
            toBytes(log.topics[1] ?? null),
            toBytes(log.topics[2] ?? null),
            toBytes(log.topics[3] ?? null),
            toBytes(log.data),
          ]
        );
        logCount++;
        insertedLogs += logRes.rowCount ?? 0;

        const transfers = decodeTransfers({
          address: log.address,
          topics: log.topics as string[],
          data: log.data,
          logIndex: Number(log.logIndex),
        });

        for (const t of transfers) {
          const ttRes = await client.query(
            `INSERT INTO token_transfers (
               transaction_hash, log_index, batch_index, block_number, token_address,
               standard, from_address, to_address, value, token_id, timestamp
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (transaction_hash, log_index, batch_index) DO NOTHING`,
            [
              toBytes(log.transactionHash),
              Number(log.logIndex),
              t.batchIndex,
              blockNumber,
              t.tokenAddress,
              t.standard,
              t.fromAddress,
              t.toAddress,
              toNumeric(t.value),
              toNumeric(t.tokenId),
              ts,
            ]
          );
          transferCount++;
          insertedTransfers += ttRes.rowCount ?? 0;

          // Record the token contract the first time we see it move anything.
          const tokRes = await client.query(
            `INSERT INTO tokens (address, standard, first_seen_block)
             VALUES ($1,$2,$3) ON CONFLICT (address) DO NOTHING`,
            [t.tokenAddress, t.standard, blockNumber]
          );
          if ((tokRes.rowCount ?? 0) > 0) {
            newTokens.push({ address: t.tokenAddress, standard: t.standard });
          }
        }
      }
    }

    // Checkpoint advances in the SAME transaction as the data above.
    //
    // Counters are incremented by rows ACTUALLY inserted, not by rows seen.
    // Every insert above is ON CONFLICT DO NOTHING, so rowCount is 0 when a row
    // already existed — which keeps the counters correct when a range is
    // re-indexed, instead of double counting.
    await client.query(
      `INSERT INTO indexer_state (
         id, last_processed_block, chain_id,
         total_transactions, total_logs, total_token_transfers
       )
       VALUES (1, $1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE
         SET last_processed_block   = EXCLUDED.last_processed_block,
             total_transactions     = indexer_state.total_transactions + EXCLUDED.total_transactions,
             total_logs             = indexer_state.total_logs + EXCLUDED.total_logs,
             total_token_transfers  = indexer_state.total_token_transfers + EXCLUDED.total_token_transfers,
             updated_at = now()`,
      [blockNumber, CHAIN_ID, insertedTxs, insertedLogs, insertedTransfers]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { txs: txCount, logs: logCount, transfers: transferCount };
}

function txTypeToNumber(t: string | undefined): number {
  switch (t) {
    case "legacy":
      return 0;
    case "eip2930":
      return 1;
    case "eip1559":
      return 2;
    case "eip4844":
      return 3;
    default:
      return 0;
  }
}

async function touchAddress(
  client: pg.PoolClient,
  address: string,
  blockNumber: number,
  isContract: boolean
) {
  await client.query(
    `INSERT INTO addresses (address, is_contract, first_seen_block, last_seen_block)
     VALUES ($1,$2,$3,$3)
     ON CONFLICT (address) DO UPDATE
       SET last_seen_block = GREATEST(addresses.last_seen_block, EXCLUDED.last_seen_block),
           is_contract = addresses.is_contract OR EXCLUDED.is_contract`,
    [toBytes(address), isContract, blockNumber]
  );
}

// --- entry points ------------------------------------------------------------
async function showStatus() {
  const checkpoint = await getCheckpoint();
  const head = Number(await rpc.getBlockNumber());
  const counts = await pool.query(`
    SELECT
      (SELECT count(*) FROM blocks)          AS blocks,
      (SELECT count(*) FROM transactions)    AS transactions,
      (SELECT count(*) FROM logs)            AS logs,
      (SELECT count(*) FROM token_transfers) AS token_transfers,
      (SELECT count(*) FROM addresses)       AS addresses,
      (SELECT count(*) FROM tokens)          AS tokens
  `);
  const c = counts.rows[0];
  console.log(`
  Giggora indexer status
  ----------------------
  chain id          ${CHAIN_ID}
  chain head        ${head}
  last processed    ${checkpoint}
  behind by         ${head - checkpoint}

  blocks            ${c.blocks}
  transactions      ${c.transactions}
  logs              ${c.logs}
  token transfers   ${c.token_transfers}
  addresses         ${c.addresses}
  tokens            ${c.tokens}
`);
}

async function run() {
  if (flag("status")) {
    await showStatus();
    return;
  }

  if (flag("tokens")) {
    const n = await resolvePendingTokenMetadata(pool, rpc, 500);
    const r = await refreshTokenSupplies(pool, rpc, 500);
    console.log(`token metadata: ${n} resolved, ${r} supplies refreshed`);
    return;
  }

  const from = opt("from");
  const to = opt("to");
  const once = flag("once");

  let next = from !== null ? from : (await getCheckpoint()) + 1;
  const startedAt = Date.now();
  let blocksDone = 0;
  let txsDone = 0;
  let transfersDone = 0;

  console.log(
    `indexer: chain ${CHAIN_ID}, starting at block ${next}` +
      (to !== null ? `, stopping at ${to}` : once ? ", catch-up then exit" : ", following head")
  );

  while (!shuttingDown) {
    const head = to !== null ? to : Number(await rpc.getBlockNumber());

    if (next > head) {
      if (once || to !== null) break;
      await sleep(POLL_MS);
      continue;
    }

    // Resolve any newly-seen token contracts. Deliberately outside the block
    // transaction: a slow or reverting eth_call must not stall ingestion.
    try {
      await resolvePendingTokenMetadata(pool, rpc, 25);
    } catch (err) {
      console.error(`  token metadata resolution failed (non-fatal): ${(err as Error).message}`);
    }

    const target = Math.min(head, next + MAX_BATCH - 1);
    for (let n = next; n <= target && !shuttingDown; n++) {
      const r = await indexBlock(n);
      blocksDone++;
      txsDone += r.txs;
      transfersDone += r.transfers;
      next = n + 1;

      if (blocksDone % 100 === 0) {
        const rate = blocksDone / ((Date.now() - startedAt) / 1000);
        console.log(
          `  indexed ${blocksDone} blocks (head ${head}, at ${n}), ` +
            `${txsDone} txs, ${transfersDone} transfers, ${rate.toFixed(1)} blk/s`
        );
      }
    }
  }

  const secs = (Date.now() - startedAt) / 1000;
  console.log(
    `indexer stopped: ${blocksDone} blocks, ${txsDone} txs, ${transfersDone} transfers ` +
      `in ${secs.toFixed(1)}s`
  );
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log(`\n  ${sig} received, finishing current block then stopping...`);
  });
}

try {
  await run();
} finally {
  await pool.end();
}

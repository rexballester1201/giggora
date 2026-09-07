#!/usr/bin/env node
/**
 * Giggora — cross-check the custom indexer against Blockscout (architecture.md §6).
 *
 * Two INDEPENDENT implementations index the same chain into two separate
 * databases. Anywhere they disagree, at least one of them has a bug. That is a
 * far stronger signal than either agreeing with itself.
 *
 * This complements scripts/verify-indexer.ts rather than replacing it: that one
 * compares against the RPC node (canonical truth), this one compares against a
 * mature third-party implementation (catches shared-assumption errors, and
 * proves the chain is indexable by standard tooling).
 *
 * Only the OVERLAPPING block range is compared — the two indexers run at
 * different speeds and being at different heights is not a defect.
 *
 * Usage:  node scripts/crosscheck-blockscout.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

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

const base = `postgresql://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@localhost:${env.POSTGRES_HOST_PORT}`;
const ours = new pg.Pool({ connectionString: `${base}/${env.POSTGRES_DB}`, max: 3 });
const theirs = new pg.Pool({ connectionString: `${base}/blockscout`, max: 3 });

let failures = 0;
async function check(name: string, fn: () => Promise<string | void>) {
  process.stdout.write(`  ${name.padEnd(50, " ")}`);
  try {
    const d = await fn();
    console.log(`PASS  ${d ?? ""}`);
  } catch (e: any) {
    failures++;
    console.log(`FAIL\n      -> ${e.message}`);
  }
}
function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

console.log(`
  Giggora :: custom indexer vs Blockscout
  ======================================
  Two independent implementations, two separate databases, same chain.
`);

const o = await ours.query("SELECT min(number) lo, max(number) hi, count(*)::int n FROM blocks");
const t = await theirs.query(
  "SELECT min(number) lo, max(number) hi, count(*)::int n FROM blocks WHERE consensus"
);

const oLo = Number(o.rows[0].lo), oHi = Number(o.rows[0].hi);
const tLo = Number(t.rows[0].lo), tHi = Number(t.rows[0].hi);
const lo = Math.max(oLo, tLo);
const hi = Math.min(oHi, tHi);

console.log(`  giggora    ${oLo}..${oHi}  (${o.rows[0].n} blocks)`);
console.log(`  blockscout ${tLo}..${tHi}  (${t.rows[0].n} blocks)`);
console.log(`  overlap    ${lo}..${hi}  (${hi - lo + 1} blocks compared)\n`);

assert(hi >= lo, "no overlapping block range to compare");

// --- 1. same blocks present ---
await check("Both indexed the same block numbers", async () => {
  const a = await ours.query(
    "SELECT number FROM blocks WHERE number BETWEEN $1 AND $2 ORDER BY number",
    [lo, hi]
  );
  const b = await theirs.query(
    "SELECT number FROM blocks WHERE consensus AND number BETWEEN $1 AND $2 ORDER BY number",
    [lo, hi]
  );
  const setA = new Set(a.rows.map((r: any) => Number(r.number)));
  const setB = new Set(b.rows.map((r: any) => Number(r.number)));
  const onlyA = [...setA].filter((x) => !setB.has(x));
  const onlyB = [...setB].filter((x) => !setA.has(x));
  assert(
    onlyA.length === 0 && onlyB.length === 0,
    `only in giggora: ${onlyA.slice(0, 5)}; only in blockscout: ${onlyB.slice(0, 5)}`
  );
  return `${setA.size} blocks in both`;
});

// --- 2. block hashes agree ---
await check("Block hashes agree", async () => {
  const a = await ours.query(
    "SELECT number, encode(hash,'hex') h, encode(parent_hash,'hex') p, encode(validator,'hex') v, gas_used FROM blocks WHERE number BETWEEN $1 AND $2",
    [lo, hi]
  );
  const b = await theirs.query(
    "SELECT number, encode(hash,'hex') h, encode(parent_hash,'hex') p, encode(miner_hash,'hex') v, gas_used FROM blocks WHERE consensus AND number BETWEEN $1 AND $2",
    [lo, hi]
  );
  const byNum = new Map(b.rows.map((r: any) => [Number(r.number), r]));

  const bad: string[] = [];
  for (const r of a.rows) {
    const m: any = byNum.get(Number(r.number));
    if (!m) continue;
    if (r.h !== m.h) bad.push(`#${r.number} hash`);
    if (r.p !== m.p) bad.push(`#${r.number} parent`);
    if (r.v !== m.v) bad.push(`#${r.number} validator`);
    if (String(r.gas_used) !== String(m.gas_used)) bad.push(`#${r.number} gasUsed`);
    if (bad.length > 5) break;
  }
  assert(bad.length === 0, bad.slice(0, 5).join("; "));
  return `${a.rowCount} blocks: hash, parent, validator, gas all identical`;
});

// --- 3. transaction sets agree ---
await check("Transaction hashes agree", async () => {
  const a = await ours.query(
    "SELECT encode(hash,'hex') h FROM transactions WHERE block_number BETWEEN $1 AND $2",
    [lo, hi]
  );
  const b = await theirs.query(
    "SELECT encode(hash,'hex') h FROM transactions WHERE block_number BETWEEN $1 AND $2",
    [lo, hi]
  );
  const setA = new Set(a.rows.map((r: any) => r.h));
  const setB = new Set(b.rows.map((r: any) => r.h));
  const onlyA = [...setA].filter((x) => !setB.has(x));
  const onlyB = [...setB].filter((x) => !setA.has(x));
  assert(
    onlyA.length === 0 && onlyB.length === 0,
    `${onlyA.length} only in giggora, ${onlyB.length} only in blockscout ` +
      `(e.g. ${onlyA[0] ?? onlyB[0]})`
  );
  return `${setA.size} transactions match exactly`;
});

// --- 4. per-block transaction counts ---
await check("Per-block transaction counts agree", async () => {
  const a = await ours.query(
    "SELECT block_number n, count(*)::int c FROM transactions WHERE block_number BETWEEN $1 AND $2 GROUP BY 1",
    [lo, hi]
  );
  const b = await theirs.query(
    "SELECT block_number n, count(*)::int c FROM transactions WHERE block_number BETWEEN $1 AND $2 GROUP BY 1",
    [lo, hi]
  );
  const mb = new Map(b.rows.map((r: any) => [Number(r.n), r.c]));
  const bad: string[] = [];
  let total = 0;
  for (const r of a.rows) {
    total += r.c;
    const other = mb.get(Number(r.n)) ?? 0;
    if (r.c !== other) bad.push(`#${r.n}: ${r.c} vs ${other}`);
    if (bad.length > 5) break;
  }
  assert(bad.length === 0, bad.slice(0, 5).join("; "));
  return `${total} transactions across ${a.rowCount} blocks`;
});

// --- 5. token transfers ---
//
// IMPORTANT: the two schemas represent ERC-1155 batches differently, and a
// naive count comparison reports a false failure.
//
//   Giggora    one row PER TOKEN ID  (batch_index disambiguates)
//   Blockscout one row PER LOG       (token_ids / amounts stored as arrays)
//
// Ours is normalised so that "every transfer of token id X" is a plain indexed
// lookup rather than an array scan. Blockscout's is denormalised. Neither is
// wrong, so the like-for-like comparison is at LOG granularity: count distinct
// (transaction_hash, log_index) on our side.
//
// Verified when this difference first surfaced: our raw ERC-1155 count exceeded
// Blockscout's by exactly the number of rows with batch_index > 0.
await check("Token transfer counts agree (per log)", async () => {
  const a = await ours.query(
    `SELECT count(DISTINCT (transaction_hash, log_index))::int c FROM token_transfers
      WHERE block_number BETWEEN $1 AND $2`,
    [lo, hi]
  );
  const b = await theirs.query(
    "SELECT count(*)::int c FROM token_transfers WHERE block_number BETWEEN $1 AND $2",
    [lo, hi]
  );
  const ca = a.rows[0].c;
  const cb = b.rows[0].c;
  assert(ca === cb, `giggora=${ca} blockscout=${cb} (compared per log)`);

  const expanded = await ours.query(
    "SELECT count(*)::int c FROM token_transfers WHERE batch_index > 0 AND block_number BETWEEN $1 AND $2",
    [lo, hi]
  );
  return `${ca} transfer logs in both (+${expanded.rows[0].c} batch-expanded rows in giggora)`;
});

// --- 6. token standards detected ---
await check("Token standards detected identically", async () => {
  const a = await ours.query(
    `SELECT standard, count(DISTINCT (transaction_hash, log_index))::int c FROM token_transfers
      WHERE block_number BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`,
    [lo, hi]
  );
  const b = await theirs.query(
    `SELECT lower(token_type) standard, count(*)::int c FROM token_transfers
      WHERE block_number BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`,
    [lo, hi]
  );
  // Blockscout writes ERC-20 / ERC-721 / ERC-1155; we write erc20 / erc721 / erc1155.
  const norm = (s: string) => s.replace(/-/g, "").toLowerCase();
  const mb = new Map(b.rows.map((r: any) => [norm(r.standard), r.c]));
  const bad: string[] = [];
  for (const r of a.rows) {
    const other = mb.get(r.standard) ?? 0;
    if (r.c !== other) bad.push(`${r.standard}: giggora=${r.c} blockscout=${other}`);
  }
  assert(bad.length === 0, bad.join("; "));
  return a.rows.map((r: any) => `${r.standard}=${r.c}`).join(" ");
});

console.log(`
  SYSTEM STATUS
  -------------
  Cross-check          ${failures === 0 ? "PASS" : "FAIL"}
`);

await ours.end();
await theirs.end();

if (failures > 0) {
  console.log(`  ${failures} disagreement(s) between implementations.\n`);
  process.exit(1);
}
console.log(`  Both implementations agree across ${hi - lo + 1} blocks.\n`);

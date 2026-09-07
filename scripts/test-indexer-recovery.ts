#!/usr/bin/env node
/**
 * Giggora — indexer crash-recovery test (brief §22).
 *
 * The claim being tested: the indexer is restartable, idempotent and crash
 * tolerant, and resumes from its checkpoint with no gaps and no duplicates.
 *
 * The test earns that claim rather than asserting it. It repeatedly SIGKILLs
 * the indexer mid-write — no cleanup, no graceful shutdown, the same as pulling
 * power — then restarts it and checks the database is still consistent.
 *
 * SIGKILL specifically, not SIGTERM: the indexer handles SIGTERM gracefully by
 * finishing the current block, which would prove nothing. SIGKILL cannot be
 * trapped, so any half-written block must be rolled back by Postgres alone.
 *
 * Usage:  node scripts/test-indexer-recovery.ts [--kills 3]
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
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

const ki = process.argv.indexOf("--kills");
const KILLS = ki !== -1 && process.argv[ki + 1] ? Number(process.argv[ki + 1]) : 3;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL,
  max: 4,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function report(ok: boolean, label: string, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function state() {
  const r = await pool.query(`
    SELECT
      (SELECT last_processed_block FROM indexer_state WHERE id=1)          AS checkpoint,
      (SELECT count(*)::int FROM blocks)                                   AS blocks,
      (SELECT max(number)    FROM blocks)                                  AS max_block,
      (SELECT min(number)    FROM blocks)                                  AS min_block,
      (SELECT count(*)::int FROM transactions)                             AS txs,
      (SELECT count(*)::int FROM logs)                                     AS logs,
      (SELECT count(*)::int FROM token_transfers)                          AS transfers
  `);
  const row = r.rows[0];
  return {
    checkpoint: row.checkpoint === null ? -1 : Number(row.checkpoint),
    blocks: row.blocks,
    maxBlock: row.max_block === null ? -1 : Number(row.max_block),
    minBlock: row.min_block === null ? -1 : Number(row.min_block),
    txs: row.txs,
    logs: row.logs,
    transfers: row.transfers,
  };
}

async function gaps(lo: number, hi: number): Promise<number> {
  if (hi < lo) return 0;
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM generate_series($1::bigint,$2::bigint) g(num)
      WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.number=g.num)`,
    [lo, hi]
  );
  return r.rows[0].n;
}

async function duplicates(): Promise<number> {
  const r = await pool.query(`
    SELECT
      (SELECT count(*) FROM (SELECT number FROM blocks GROUP BY number HAVING count(*)>1) a)
    + (SELECT count(*) FROM (SELECT hash FROM transactions GROUP BY hash HAVING count(*)>1) b)
    + (SELECT count(*) FROM (SELECT transaction_hash, log_index FROM logs
         GROUP BY transaction_hash, log_index HAVING count(*)>1) c) AS n
  `);
  return Number(r.rows[0].n);
}

/** Run the indexer and SIGKILL it after `killAfterMs`. Returns when it is dead. */
function runAndKill(killAfterMs: number): Promise<void> {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [join(ROOT, "indexer", "src", "index.ts")], {
      cwd: ROOT,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      // SIGKILL cannot be trapped — this is an uncatchable, immediate kill.
      child.kill("SIGKILL");
    }, killAfterMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolveP();
    });
  });
}

function runOnce(): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [join(ROOT, "indexer", "src", "index.ts"), "--once"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    child.on("exit", (code) => (code === 0 ? resolveP() : rejectP(new Error(`exit ${code}`))));
  });
}

// -----------------------------------------------------------------------------
console.log(`
  Giggora :: indexer crash-recovery test
  ======================================
  Strategy: SIGKILL the indexer mid-write ${KILLS}x, restart, verify consistency.
  SIGKILL is uncatchable, so recovery depends entirely on transactional writes.
`);

// Start from empty so the indexer is guaranteed to be actively writing when
// we kill it, rather than idling at the chain head.
console.log("  Resetting database to force a full re-index...\n");
await pool.query(
  "TRUNCATE blocks, transactions, logs, token_transfers, tokens, addresses, indexer_state RESTART IDENTITY CASCADE"
);

const before = await state();
report(before.blocks === 0 && before.checkpoint === -1, "Database reset to empty");

let prevCheckpoint = -1;

for (let i = 1; i <= KILLS; i++) {
  // Vary the kill timing so we land at different points in the write cycle.
  const delay = 700 + i * 450;
  console.log(`\n  --- kill cycle ${i}/${KILLS} (SIGKILL after ${delay}ms) ---`);

  await runAndKill(delay);
  await sleep(300); // let Postgres finish rolling back the killed transaction

  const s = await state();

  // THE core invariant. If the checkpoint were ever ahead of the stored data,
  // the next run would skip blocks and leave a permanent hole.
  report(
    s.checkpoint <= s.maxBlock || s.blocks === 0,
    "Checkpoint never ahead of stored data",
    `checkpoint=${s.checkpoint} maxBlock=${s.maxBlock}`
  );

  const g = s.blocks > 0 ? await gaps(s.minBlock, s.maxBlock) : 0;
  report(g === 0, "No gaps after crash", `${s.blocks} blocks, ${g} gaps`);

  const d = await duplicates();
  report(d === 0, "No duplicates after crash", `${d} duplicate keys`);

  report(
    s.checkpoint >= prevCheckpoint,
    "Progress never goes backwards",
    `${prevCheckpoint} -> ${s.checkpoint}`
  );
  prevCheckpoint = s.checkpoint;
}

// Now let it finish cleanly and confirm it catches all the way up.
console.log(`\n  --- clean catch-up run ---`);
await runOnce();
const after = await state();

report(after.checkpoint > prevCheckpoint, "Resumed and advanced after final restart",
  `${prevCheckpoint} -> ${after.checkpoint}`);

const finalGaps = await gaps(after.minBlock, after.maxBlock);
report(finalGaps === 0, "Final state has no gaps",
  `blocks ${after.minBlock}..${after.maxBlock} (${after.blocks})`);

const finalDupes = await duplicates();
report(finalDupes === 0, "Final state has no duplicates");

report(after.minBlock === 0, "Indexed from genesis", `min block ${after.minBlock}`);
report(after.checkpoint === after.maxBlock, "Checkpoint equals highest block",
  `${after.checkpoint} == ${after.maxBlock}`);

// Idempotency: re-indexing an already-indexed range must change nothing.
console.log(`\n  --- idempotency: re-index an already-indexed range ---`);
const snapshot = await state();
await new Promise<void>((res, rej) => {
  const child = spawn(
    process.execPath,
    [join(ROOT, "indexer", "src", "index.ts"), "--from", "0", "--to", "50"],
    { cwd: ROOT, stdio: "ignore" }
  );
  child.on("exit", (c) => (c === 0 ? res() : rej(new Error(`exit ${c}`))));
});
const reindexed = await state();

report(
  reindexed.blocks === snapshot.blocks &&
    reindexed.txs === snapshot.txs &&
    reindexed.logs === snapshot.logs &&
    reindexed.transfers === snapshot.transfers,
  "Re-indexing blocks 0-50 changed no row counts",
  `blocks ${snapshot.blocks}->${reindexed.blocks}, txs ${snapshot.txs}->${reindexed.txs}, ` +
    `logs ${snapshot.logs}->${reindexed.logs}`
);
report(await duplicates() === 0, "Re-indexing created no duplicates");

console.log(`
  SYSTEM STATUS
  -------------
  Crash recovery       ${failures === 0 ? "PASS" : "FAIL"}
  Idempotency          ${failures === 0 ? "PASS" : "FAIL"}
`);

await pool.end();

if (failures > 0) {
  console.log(`  ${failures} check(s) FAILED.\n`);
  process.exit(1);
}
console.log(`  Indexer survives SIGKILL with no gaps, no duplicates, no lost progress.\n`);

#!/usr/bin/env node
/**
 * Giggora — QBFT transition upgrade test.
 *
 * This exists because the claim was made before it was tested. The architecture
 * document asserted that `transitions` provides scheduled upgrades without a
 * hard fork, and that assertion was load-bearing in choosing Besu + QBFT — but
 * nothing had ever exercised it. An untested upgrade path is not an upgrade path.
 *
 * Testing it found two things documentation did not tell us:
 *
 *   - `transitions` must sit INSIDE `config`. At the top level of the genesis
 *     file it is silently ignored: no error, no warning, no effect.
 *   - The change appears to take effect at NODE RESTART, not at the scheduled
 *     block. This test measures that explicitly rather than assuming either way,
 *     because it decides whether an upgrade can be staged in advance.
 *
 * Usage:  node scripts/test-qbft-transition.mjs
 */

import { readFileSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENESIS = join(ROOT, "blockchain", "genesis", "genesis.json");
// A snapshot THIS run takes, restored by THIS run. The test used to restore
// from schedule-transition's shared backup file, which (a) no longer exists in
// that form — backups are now per-target — and (b) could be stale from an
// earlier, unrelated transition, so "restore" put back the wrong genesis.
const SNAPSHOT = join(ROOT, "blockchain", "genesis", "genesis.json.transition-test-snapshot");

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const OLD_PERIOD = Number(env.BLOCK_PERIOD_SECONDS ?? 2);
const NEW_PERIOD = 6;
const NODES = ["validator-1", "validator-2", "validator-3", "validator-4", "rpc"];

let pass = 0;
let fail = 0;
function report(ok, label, detail = "") {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
function note(text) {
  console.log(`  NOTE  ${text}`);
}
function assert(c, m) {
  if (!c) throw new Error(m);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" });

async function rpc(method, params = []) {
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(env.RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch {
      await sleep(1500);
    }
  }
  throw new Error(`RPC unreachable: ${method}`);
}

const head = async () => parseInt(await rpc("eth_blockNumber"), 16);
const genesisHash = async () => (await rpc("eth_getBlockByNumber", ["0x0", false])).hash;

/** Stop then start ALL nodes. Not a rolling restart — see the header. */
async function cycleAllNodes() {
  // -p pins the project: a COMPOSE_PROJECT_NAME left in the shell must never
  // make this stop the nodes of another stack.
  sh("docker", ["compose", "-p", "giggora", "stop", ...NODES]);
  await sleep(4000);
  sh("docker", ["compose", "-p", "giggora", "start", ...NODES]);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      await rpc("eth_blockNumber");
      return true;
    } catch {
      await sleep(2000);
    }
  }
  return false;
}

function load(seconds) {
  return spawn(
    process.execPath,
    [join(ROOT, "scripts", "load-generator.mjs"), "--tps", "5", "--duration", String(seconds)],
    { cwd: ROOT, stdio: "ignore" }
  );
}

/**
 * Average seconds between blocks that CARRY TRANSACTIONS.
 *
 * Empty blocks are governed by emptyblockperiodseconds (60s) and would swamp
 * the signal, so they are excluded — blockperiodseconds only governs loaded
 * blocks.
 */
async function loadedBlockPeriod(sampleSeconds) {
  const gen = load(sampleSeconds + 15);
  await sleep(12_000);
  const from = await head();
  await sleep(sampleSeconds * 1000);
  const to = await head();
  gen.kill("SIGKILL");

  const deltas = [];
  let prevTs = null;
  for (let n = from; n <= to; n++) {
    const b = await rpc("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
    if (!b) continue;
    const ts = parseInt(b.timestamp, 16);
    if (prevTs !== null && b.transactions.length > 0) deltas.push(ts - prevTs);
    prevTs = ts;
  }
  if (!deltas.length) return { avg: null, samples: 0, from, to };
  return {
    avg: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    samples: deltas.length,
    from,
    to,
  };
}

console.log(`
  Giggora :: QBFT transition upgrade test
  =======================================
  Proves a consensus parameter can be changed on a LIVE chain without a hard
  fork and without losing chain identity.
`);

const hashBefore = await genesisHash();
console.log(`  genesis ${hashBefore}\n`);

let scheduled = false;
// Taken before anything is scheduled, so the restore is exact.
copyFileSync(GENESIS, SNAPSHOT);
// What "restored" must mean: the transitions that were there BEFORE this test,
// which may legitimately be non-empty (a transition already in force on the
// chain). The old assertion demanded `!g.config.transitions`, which only a
// restore that ERASED an in-force transition — forking the network — could
// satisfy once one existed.
const ORIGINAL_TRANSITIONS = JSON.stringify(
  JSON.parse(readFileSync(GENESIS, "utf8")).config.transitions ?? null
);
try {
  // -------------------------------------------------------------------------
  console.log("  1. Baseline block period under load");
  // -------------------------------------------------------------------------
  const base = await loadedBlockPeriod(40);
  assert(base.avg !== null, "no loaded blocks produced; is the chain healthy?");
  report(
    Math.abs(base.avg - OLD_PERIOD) < 2,
    "Baseline matches configured blockperiodseconds",
    `${base.avg.toFixed(1)}s over ${base.samples} blocks (configured ${OLD_PERIOD}s)`
  );

  const headBefore = await head();

  // -------------------------------------------------------------------------
  console.log("\n  2. Schedule the transition");
  // -------------------------------------------------------------------------
  const target = headBefore + 25;
  const out = sh(process.execPath, [
    join(ROOT, "scripts", "schedule-transition.mjs"),
    "--at", String(target),
    "--blockperiodseconds", String(NEW_PERIOD),
  ]);
  scheduled = true;
  report(out.includes("Transition scheduled"), "Scheduler wrote the transition", `at block ${target}`);

  const g = JSON.parse(readFileSync(GENESIS, "utf8"));
  report(
    Boolean(g.config.transitions?.qbft?.some((t) => t.block === target)),
    "transitions is INSIDE config",
    "top-level placement is silently ignored by Besu"
  );
  report(g.transitions === undefined, "No stale top-level transitions key");

  // -------------------------------------------------------------------------
  console.log("\n  3. Stop and start every node");
  // -------------------------------------------------------------------------
  const up = await cycleAllNodes();
  report(up, "All nodes stopped and started, RPC serving again");
  assert(up, "RPC never returned after the node cycle");

  // -------------------------------------------------------------------------
  console.log("\n  4. Chain identity survived");
  // -------------------------------------------------------------------------
  const hashAfter = await genesisHash();
  report(hashAfter === hashBefore, "Genesis hash unchanged", `${hashAfter.slice(0, 18)}…`);
  assert(hashAfter === hashBefore, "genesis hash changed — this is a DIFFERENT chain");

  const headAfter = await head();
  report(headAfter >= headBefore, "Chain continued, did not restart", `${headBefore} -> ${headAfter}`);

  const probe = await rpc("eth_getBlockByNumber", ["0x" + (headBefore - 2).toString(16), false]);
  report(probe !== null, "Pre-upgrade history intact", `block ${headBefore - 2} still present`);

  // -------------------------------------------------------------------------
  console.log("\n  5. When does the change actually take effect?");
  // -------------------------------------------------------------------------
  // Measured BEFORE the scheduled block is reached. If the period has already
  // changed here, the parameter applies at RESTART rather than at the scheduled
  // height — which means an upgrade cannot be staged in advance, and every node
  // must be cycled in the same maintenance window.
  const beforeTarget = await loadedBlockPeriod(40);
  const nowHead = await head();
  const reachedTarget = nowHead >= target;

  if (beforeTarget.avg !== null && !reachedTarget) {
    const changedEarly = Math.abs(beforeTarget.avg - NEW_PERIOD) < 2;
    note(
      changedEarly
        ? `Period is ALREADY ${beforeTarget.avg.toFixed(1)}s at block ${nowHead}, before the scheduled ${target}. ` +
          `The change applies at RESTART, not at the scheduled block.`
        : `Period is still ${beforeTarget.avg.toFixed(1)}s at block ${nowHead} (scheduled ${target}) — ` +
          `the change is correctly deferred to the scheduled block.`
    );
  }

  // -------------------------------------------------------------------------
  console.log(`\n  6. Cross block ${target} and confirm the new period`);
  // -------------------------------------------------------------------------
  const gen = load(180);
  const deadline = Date.now() + 200_000;
  while (Date.now() < deadline && (await head()) <= target + 2) await sleep(3000);
  gen.kill("SIGKILL");
  report((await head()) > target, "Chain advanced past the transition block", `head ${await head()}`);

  const after = await loadedBlockPeriod(50);
  assert(after.avg !== null, "no loaded blocks after the transition");
  report(
    Math.abs(after.avg - NEW_PERIOD) < 2,
    "Block period CHANGED to the scheduled value",
    `${after.avg.toFixed(1)}s over ${after.samples} blocks (scheduled ${NEW_PERIOD}s, was ${OLD_PERIOD}s)`
  );
} catch (err) {
  fail++;
  console.log(`\n  ERROR: ${err.message}`);
} finally {
  // -------------------------------------------------------------------------
  console.log("\n  7. Restore the original configuration");
  // -------------------------------------------------------------------------
  if (scheduled && existsSync(SNAPSHOT)) {
    copyFileSync(SNAPSHOT, GENESIS);
    unlinkSync(SNAPSHOT);
    try {
      const up = await cycleAllNodes();
      const g = JSON.parse(readFileSync(GENESIS, "utf8"));
      const restored = await loadedBlockPeriod(40);
      report(
        up &&
          JSON.stringify(g.config.transitions ?? null) === ORIGINAL_TRANSITIONS &&
          restored.avg !== null &&
          Math.abs(restored.avg - OLD_PERIOD) < 2,
        "Restored to the original block period",
        restored.avg !== null ? `${restored.avg.toFixed(1)}s (configured ${OLD_PERIOD}s)` : "no samples"
      );
    } catch (e) {
      fail++;
      console.log(`  FAIL  Restore failed — ${e.message}`);
    }
  }
}

console.log(`
  SYSTEM STATUS
  -------------
  QBFT transitions     ${fail === 0 ? "PASS" : "FAIL"}

  ${pass} passed, ${fail} failed
`);

if (fail > 0) process.exit(1);

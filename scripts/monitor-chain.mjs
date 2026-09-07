#!/usr/bin/env node
/**
 * Giggora — chain health monitor (brief §28, §31).
 *
 * Exists because "is the process up?" is the wrong question for a QBFT chain.
 * Every failure this project has actually hit was invisible to a process check:
 *
 *   - The chain halted with all four validators UP and healthy, because two were
 *     stopped and quorum (3 of 4) was lost. Containers: fine. Blocks: zero.
 *   - After quorum was restored, validators deadlocked in round change — split
 *     2/2 across rounds 4 and 5 — and took ~2 minutes to converge. Every node
 *     reported healthy throughout.
 *   - A validator can be in the validator set and silently never propose. Set
 *     membership and block production are different things.
 *
 * So this checks the things that actually break: liveness, quorum headroom,
 * per-validator production, round-change escalation, indexer lag and API health.
 *
 * Exit code 0 = OK, 1 = WARN, 2 = CRITICAL — suitable for cron or a systemd
 * timer piping into any alerting system.
 *
 * Usage:
 *   node scripts/monitor-chain.mjs                 # one-shot check
 *   node scripts/monitor-chain.mjs --watch 30      # re-check every 30s
 *   node scripts/monitor-chain.mjs --json          # machine-readable
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (n) => process.argv.includes(`--${n}`);
const JSON_OUT = flag("json");

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const RPC_URL = process.env.RPC_URL ?? env.RPC_URL;
const API_URL = process.env.API_URL ?? "http://localhost:4100";
const BLOCK_PERIOD = Number(env.BLOCK_PERIOD_SECONDS ?? 2);
const EMPTY_PERIOD = Number(env.EMPTY_BLOCK_PERIOD_SECONDS ?? 60);

/**
 * How long the chain may legitimately produce nothing.
 *
 * On an IDLE chain that is emptyblockperiodseconds, not blockperiodseconds —
 * getting this wrong is how you page someone at 3am for a chain that is working
 * exactly as configured. Twice the empty period plus slack.
 */
const LIVENESS_BUDGET_S = EMPTY_PERIOD * 2 + 30;

const results = [];
function record(level, check, message, detail = {}) {
  results.push({ level, check, message, ...detail });
}

async function rpc(method, params = [], url = RPC_URL) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// ---------------------------------------------------------------------------
async function checkLiveness() {
  let head, block;
  try {
    head = parseInt(await rpc("eth_blockNumber"), 16);
    block = await rpc("eth_getBlockByNumber", ["0x" + head.toString(16), false]);
  } catch (e) {
    record("CRITICAL", "liveness", `RPC unreachable: ${e.message}`);
    return null;
  }

  const age = Math.floor(Date.now() / 1000) - parseInt(block.timestamp, 16);

  if (age > LIVENESS_BUDGET_S) {
    record("CRITICAL", "liveness", `No block for ${age}s — chain appears HALTED`, {
      head,
      lastBlockAgeSeconds: age,
      budgetSeconds: LIVENESS_BUDGET_S,
    });
  } else if (age > EMPTY_PERIOD + 15) {
    record("WARN", "liveness", `Last block ${age}s ago (empty period is ${EMPTY_PERIOD}s)`, {
      head,
      lastBlockAgeSeconds: age,
    });
  } else {
    record("OK", "liveness", `Head ${head}, last block ${age}s ago`, { head, lastBlockAgeSeconds: age });
  }
  // "Producing" means within the legitimate idle budget — not merely non-zero.
  return { head, producing: age <= LIVENESS_BUDGET_S };
}

// ---------------------------------------------------------------------------
async function checkQuorum() {
  let validators;
  try {
    validators = await rpc("qbft_getValidatorsByBlockNumber", ["latest"]);
  } catch (e) {
    record("CRITICAL", "quorum", `Cannot read validator set: ${e.message}`);
    return null;
  }

  const n = validators.length;
  const quorum = Math.ceil((2 * n) / 3);
  const canLose = n - quorum;
  const byzantine = Math.floor((n - 1) / 3);

  // How many validators are actually reachable. Each is probed on its own RPC
  // if those ports are exposed; on production hosts this comes from the
  // per-host monitor instead.
  let reachable = null;
  const debugPorts = (process.env.VALIDATOR_RPC_PORTS ?? "8551,8552,8553,8554")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (debugPorts.length) {
    let up = 0;
    for (const p of debugPorts) {
      try {
        await rpc("eth_blockNumber", [], `http://localhost:${p}`);
        up++;
      } catch {
        /* unreachable */
      }
    }
    reachable = up;
  }

  if (canLose === 0) {
    record("WARN", "quorum", `n=${n} has NO fault tolerance (quorum ${quorum})`, { n, quorum });
  }

  if (reachable !== null && reachable < quorum) {
    record("CRITICAL", "quorum", `Only ${reachable}/${n} validators reachable, quorum is ${quorum} — chain cannot produce blocks`, {
      n, quorum, reachable,
    });
  } else if (reachable !== null && reachable - quorum < canLose) {
    record("WARN", "quorum", `${reachable}/${n} validators reachable — no headroom left above quorum ${quorum}`, {
      n, quorum, reachable,
    });
  } else {
    record("OK", "quorum", `${n} validators, quorum ${quorum}, tolerates ${canLose} down (${byzantine} byzantine)`, {
      n, quorum, reachable, canLose, byzantine,
    });
  }
  return { validators, n, quorum };
}

// ---------------------------------------------------------------------------
/**
 * A validator can sit in the set and never propose. Membership is not
 * production, so this compares actual proposers over a recent window.
 */
async function checkProposers(head, quorumInfo) {
  if (head === null || !quorumInfo) return;
  const { validators, n } = quorumInfo;

  const SAMPLE = Math.min(100, head);
  if (SAMPLE < n * 2) {
    record("OK", "proposers", `Chain too short to assess (${head} blocks)`);
    return;
  }

  const counts = Object.fromEntries(validators.map((v) => [v.toLowerCase(), 0]));
  let unknown = 0;
  for (let i = 0; i < SAMPLE; i++) {
    const b = await rpc("eth_getBlockByNumber", ["0x" + (head - i).toString(16), false]);
    if (!b) continue;
    const m = b.miner.toLowerCase();
    if (m in counts) counts[m]++;
    else unknown++;
  }

  const silent = Object.entries(counts).filter(([, c]) => c === 0).map(([a]) => a);
  const expected = SAMPLE / n;

  if (silent.length) {
    // Losing proposers is how a chain slides toward losing quorum, so this is
    // the early warning that matters most.
    record(
      silent.length > n - Math.ceil((2 * n) / 3) ? "CRITICAL" : "WARN",
      "proposers",
      `${silent.length}/${n} validators produced NO blocks in the last ${SAMPLE}`,
      { silent, sample: SAMPLE }
    );
  } else {
    const spread = Object.values(counts);
    const min = Math.min(...spread);
    const skewed = min < expected * 0.5;
    record(
      skewed ? "WARN" : "OK",
      "proposers",
      skewed
        ? `Uneven production over ${SAMPLE} blocks (min ${min}, expected ~${expected.toFixed(0)})`
        : `All ${n} validators producing (${spread.join("/")} of ${SAMPLE})`,
      { counts, sample: SAMPLE }
    );
  }
  if (unknown) {
    record("WARN", "proposers", `${unknown} blocks proposed by an address not in the current validator set`);
  }
}

// ---------------------------------------------------------------------------
/**
 * Round-change escalation — the early warning for the failure actually observed
 * on this chain, where validators split across rounds and stalled.
 *
 * Round 0 is normal. Anything climbing means proposals are failing.
 *
 * CORRELATED WITH LIVENESS ON PURPOSE. Round changes in the log are a symptom,
 * not a verdict: after a real outage the recovery churn stays in the log window
 * long after the chain is producing blocks again. Escalating rounds are only
 * CRITICAL when the chain is ALSO not producing — otherwise this fires on a
 * healthy chain and trains everyone to ignore it, which is worse than having no
 * alert at all.
 *
 * Reads container logs, so it only works where the nodes are local; on
 * production hosts each host runs its own monitor.
 */
function checkRoundChanges(chainProducing) {
  let out;
  try {
    out = execFileSync(
      "docker",
      ["compose", "logs", "--since", "120s", "validator-1", "validator-2", "validator-3", "validator-4"],
      { cwd: ROOT, encoding: "utf8", stdio: "pipe", timeout: 20000 }
    );
  } catch {
    record("OK", "rounds", "Not checked (containers not reachable from here)");
    return;
  }

  const rounds = [...out.matchAll(/Round:\s*(\d+)/g)].map((m) => Number(m[1]));
  if (!rounds.length) {
    record("OK", "rounds", "No round changes in the last 120s");
    return;
  }

  const max = Math.max(...rounds);

  if (!chainProducing && max >= 3) {
    record("CRITICAL", "rounds", `Round change at ${max} AND chain not producing — consensus is stuck`, {
      maxRound: max, occurrences: rounds.length,
    });
  } else if (!chainProducing) {
    record("WARN", "rounds", `${rounds.length} round change(s) (max ${max}) while chain is not producing`, {
      maxRound: max, occurrences: rounds.length,
    });
  } else if (max >= 3) {
    // Blocks ARE flowing, so this is recovery churn or a transient wobble.
    // Worth seeing, not worth paging.
    record("WARN", "rounds", `Round reached ${max} recently, but chain is producing normally (likely recovery churn)`, {
      maxRound: max, occurrences: rounds.length,
    });
  } else {
    record("OK", "rounds", `${rounds.length} round change(s), max round ${max}, chain producing`, {
      maxRound: max, occurrences: rounds.length,
    });
  }
}

// ---------------------------------------------------------------------------
async function checkIndexerAndApi(head) {
  let stats;
  try {
    const res = await fetch(`${API_URL}/api/stats`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    stats = await res.json();
  } catch (e) {
    record("WARN", "api", `Explorer API unreachable: ${e.message}`);
    return;
  }

  record("OK", "api", `Explorer API responding (chain ${stats.chainId})`);

  const lag = head !== null && stats.lastIndexedBlock !== null ? head - stats.lastIndexedBlock : null;
  if (lag === null) {
    record("WARN", "indexer", "Cannot determine indexer lag");
  } else if (lag > 100) {
    record("CRITICAL", "indexer", `Indexer is ${lag} blocks behind`, { lag });
  } else if (lag > 20) {
    record("WARN", "indexer", `Indexer is ${lag} blocks behind`, { lag });
  } else {
    record("OK", "indexer", `Indexer ${lag} block(s) behind`, { lag });
  }
}

// ---------------------------------------------------------------------------
async function runOnce() {
  results.length = 0;
  const live = await checkLiveness();
  const head = live ? live.head : null;
  const quorumInfo = await checkQuorum();
  await checkProposers(head, quorumInfo);
  checkRoundChanges(live ? live.producing : false);
  await checkIndexerAndApi(head);

  const critical = results.filter((r) => r.level === "CRITICAL");
  const warn = results.filter((r) => r.level === "WARN");
  const status = critical.length ? "CRITICAL" : warn.length ? "WARN" : "OK";

  if (JSON_OUT) {
    console.log(JSON.stringify({ status, checks: results }, null, 2));
  } else {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    console.log(`\n  Giggora health — ${stamp}  [${status}]`);
    console.log("  " + "-".repeat(60));
    for (const r of results) {
      const tag = r.level === "OK" ? "  ok  " : r.level === "WARN" ? " WARN " : " CRIT ";
      console.log(`  ${tag} ${r.check.padEnd(10)} ${r.message}`);
    }
    console.log("");
  }

  return critical.length ? 2 : warn.length ? 1 : 0;
}

const watch = arg("watch");
if (watch) {
  // Validated. Number("abc") is NaN and Number("0") is 0; either made
  // setTimeout fire immediately and this loop hammer the RPC node flat out.
  const seconds = Number(watch);
  if (!Number.isInteger(seconds) || seconds < 5) {
    console.error(`  --watch needs a whole number of seconds, at least 5 (got "${watch}")`);
    process.exit(1);
  }
  const every = seconds * 1000;
  for (;;) {
    await runOnce();
    await new Promise((r) => setTimeout(r, every));
  }
} else {
  process.exit(await runOnce());
}

#!/usr/bin/env node
/**
 * Giggora — schedule a QBFT consensus transition (the upgrade procedure).
 *
 * This is how Giggora changes consensus parameters WITHOUT a hard fork and
 * without restarting the chain from a new genesis. Besu reads a `transitions`
 * object from the genesis file and applies the change at the scheduled block.
 *
 * WHY THIS DOES NOT RESTART THE CHAIN. The genesis block hash is computed from
 * the genesis HEADER fields (parentHash, stateRoot, timestamp, extraData,
 * gasLimit, ...). `transitions` and `config` are client configuration, not
 * header fields, so editing them leaves the genesis hash — and therefore the
 * chain identity — untouched. Nodes restart onto the SAME chain and simply
 * behave differently from the scheduled block onward.
 *
 * THREE THINGS THAT WILL BITE YOU — all three were established the hard way on
 * a live chain, not read from documentation:
 *
 *   1. `transitions` goes INSIDE `config`, as a sibling of the `qbft` object.
 *      Some documentation shows it at the top level of the genesis file. That
 *      placement is SILENTLY IGNORED: Besu starts without error or warning and
 *      the scheduled change simply never happens. Verified by measuring block
 *      timestamps across a transition with each placement — top-level had no
 *      effect whatsoever, inside `config` worked.
 *
 *   2. STOP EVERY NODE, THEN START THEM. Not a rolling restart. Besu validates
 *      each block's timestamp gap against its OWN current block period, so
 *      while some nodes have the new period and others do not, proposals are
 *      rejected with:
 *
 *        TimestampMoreRecentThanParent: timestamp is only 6 seconds newer
 *        than parent timestamp. Minimum 8 seconds
 *
 *      Observed on this chain: block production stalled until QBFT completed a
 *      round change. It recovered on its own, but a production network should
 *      not be asked to.
 *
 *   3. Never schedule a block in the past. Besu's own documentation warns this
 *      can FORK THE NETWORK, because nodes that already passed that block
 *      disagree with nodes that have not. This script refuses to do it, and
 *      enforces a margin so there is time to stop and start every node first.
 *
 * Operational procedure:
 *   1. Run this on the shared genesis file.
 *   2. Distribute the updated genesis.json to EVERY node.
 *   3. STOP all nodes, then START all nodes — before the transition block.
 *   4. Verify with scripts/test-qbft-transition.mjs.
 *
 * Usage:
 *   node scripts/schedule-transition.mjs --in 40 --emptyblockperiodseconds 10
 *   node scripts/schedule-transition.mjs --at 5000 --blockperiodseconds 4
 *   node scripts/schedule-transition.mjs --list
 *   node scripts/schedule-transition.mjs --revert
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENESIS = join(ROOT, "blockchain", "genesis", "genesis.json");
const BACKUP = join(ROOT, "blockchain", "genesis", "genesis.json.before-transition");

/** Blocks of head-room so every node can be restarted before the change lands. */
const MIN_MARGIN = 10;

const TUNABLE = [
  "blockperiodseconds",
  "emptyblockperiodseconds",
  "blockreward",
  "miningbeneficiary",
  "validatorselectionmode",
  "validatorcontractaddress",
];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const flag = (n) => process.argv.includes(`--${n}`);

function die(msg) {
  console.error(`\n  ERROR: ${msg}\n`);
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

async function head() {
  const res = await fetch(env.RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return parseInt(j.result, 16);
}

if (!existsSync(GENESIS)) die(`no genesis at ${GENESIS}; run scripts/create-genesis.sh first`);
const genesis = JSON.parse(readFileSync(GENESIS, "utf8"));

// --- list -------------------------------------------------------------------
if (flag("list")) {
  const t = genesis.config.transitions?.qbft ?? [];
  // Warn loudly if a stale top-level block is present — it does nothing at all.
  if (genesis.transitions) {
    console.log("\n  WARNING: a top-level `transitions` key is present.");
    console.log("  Besu IGNORES it silently — no error, no warning, no effect.");
    console.log("  Transitions must live inside `config`. Re-schedule them.");
  }
  console.log(`\n  Scheduled QBFT transitions (${t.length})`);
  if (!t.length) console.log("    none");
  for (const x of t) {
    const { block, ...changes } = x;
    console.log(`    block ${block}: ${JSON.stringify(changes)}`);
  }
  let h = null;
  try {
    h = await head();
    console.log(`\n  Chain head: ${h}`);
    for (const x of t) {
      console.log(`    block ${x.block}: ${x.block <= h ? "APPLIED" : `pending (${x.block - h} blocks away)`}`);
    }
  } catch {
    console.log("\n  (chain unreachable, cannot say which have applied)");
  }
  console.log("");
  process.exit(0);
}

// --- revert -----------------------------------------------------------------
// Structural and head-aware, NOT a file restore. The old --revert copied a
// single shared backup over the live genesis. That backup was written only the
// FIRST time a transition was scheduled, so reverting a second transition also
// removed an already-in-force first one — and removing a transition the chain
// has passed forks the network (see header item 3). This removes only PENDING
// entries, and refuses to touch one the head has already crossed.
//
//   --revert            remove every transition still ahead of the head
//   --revert <block>    remove only the one scheduled at <block>
if (flag("revert")) {
  const list = genesis.config?.transitions?.qbft ?? [];
  if (!list.length) die("no transitions to revert");
  const h = await head();
  const a = arg("revert");
  const which = a !== null && /^\d+$/.test(a) ? Number(a) : null;
  const victims = list.filter((t) => (which === null ? true : t.block === which));
  if (which !== null && !victims.length) die(`no transition is scheduled at block ${which}`);
  const applied = victims.filter((t) => t.block <= h);
  if (applied.length) {
    die(
      `refusing to remove transition(s) already in force at head ${h}: ${applied.map((t) => t.block).join(", ")}.\n` +
        `  Removing a past transition FORKS THE NETWORK. Schedule a new forward transition instead.`
    );
  }
  genesis.config.transitions.qbft = list.filter((t) => !victims.includes(t));
  if (!genesis.config.transitions.qbft.length) delete genesis.config.transitions;
  writeFileSync(GENESIS, JSON.stringify(genesis, null, 2) + "\n");
  console.log(`\n  Removed pending transition(s) at block ${victims.map((t) => t.block).join(", ")}.`);
  console.log("  Restart every node (stop ALL, then start ALL) for this to take effect.\n");
  process.exit(0);
}

// --- schedule ---------------------------------------------------------------
const changes = {};
for (const k of TUNABLE) {
  const v = arg(k);
  if (v !== null) changes[k] = /^\d+$/.test(v) ? Number(v) : v;
}
if (Object.keys(changes).length === 0) {
  die(`nothing to change. Pass one or more of: ${TUNABLE.map((t) => `--${t}`).join(", ")}`);
}

const chainHead = await head();
let target;
if (arg("at")) {
  target = Number(arg("at"));
} else if (arg("in")) {
  target = chainHead + Number(arg("in"));
} else {
  die("specify --at <block> or --in <blocks-from-now>");
}

if (!Number.isSafeInteger(target) || target < 0) die(`invalid target block: ${target}`);

// Besu's documentation is explicit that a past transition block can FORK the
// network, because nodes that already passed it disagree with those that have
// not. Refuse rather than warn.
if (target <= chainHead) {
  die(
    `transition block ${target} is at or behind the chain head (${chainHead}).\n` +
      `  Besu warns this can FORK THE NETWORK. Schedule a future block.`
  );
}
if (target - chainHead < MIN_MARGIN) {
  die(
    `transition block ${target} is only ${target - chainHead} blocks ahead.\n` +
      `  Leave at least ${MIN_MARGIN} blocks so every node can be restarted first.`
  );
}

// INSIDE config, sibling of qbft. Top-level placement is silently ignored.
genesis.config.transitions ??= {};
genesis.config.transitions.qbft ??= [];

if (genesis.config.transitions.qbft.some((t) => t.block === target)) {
  die(`a transition is already scheduled at block ${target}`);
}

genesis.config.transitions.qbft.push({ block: target, ...changes });
// Besu applies them in order; keeping the array sorted makes the file readable
// and makes "what is in force at block N" obvious to a human.
genesis.config.transitions.qbft.sort((a, b) => a.block - b.block);

// Forensic copy of the genesis as it was BEFORE this particular schedule. One
// per target block, always written — the old "only if absent" single file went
// stale after the first transition and --revert then restored the wrong state.
// --revert no longer uses these files; they exist so an operator can diff.
copyFileSync(GENESIS, `${BACKUP}-${target}`);
writeFileSync(GENESIS, JSON.stringify(genesis, null, 2) + "\n");

const current = genesis.config.qbft;
console.log(`
  Transition scheduled
  --------------------
  Chain head        ${chainHead}
  Transition block  ${target}   (${target - chainHead} blocks away)

  Changes at that block:
${Object.entries(changes).map(([k, v]) => `    ${k}: ${current[k] ?? "(unset)"} -> ${v}`).join("\n")}

  Written to config.transitions.qbft — INSIDE config. A top-level 
  key is silently ignored by Besu.

  NEXT: distribute blockchain/genesis/genesis.json to every node, then STOP and
  START them all before block ${target}. Do NOT use a rolling restart: while
  nodes disagree about the block period, proposals fail timestamp validation and
  block production stalls until QBFT round-changes.

    docker compose -p giggora stop  validator-1 validator-2 validator-3 validator-4 rpc
    docker compose -p giggora start validator-1 validator-2 validator-3 validator-4 rpc

  Then verify:  node scripts/test-qbft-transition.mjs --expect ${target}
  Undo (before it lands): node scripts/schedule-transition.mjs --revert ${target}
`);

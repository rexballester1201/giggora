#!/usr/bin/env node
/**
 * Giggora — Phase 2 acceptance test.
 *
 * Tests every Phase 2 criterion against the RUNNING chain. Nothing here is
 * mocked; every number comes from JSON-RPC (brief §47.1-§47.5).
 *
 *   1. RPC reachable, chain ID correct
 *   2. Exactly N QBFT validators, matching config
 *   3. Genesis allocation matches chain.config.json exactly
 *   4. Blocks are produced at the configured period
 *   5. A real signed GIG transfer moves balances, and fees are charged
 *   6. FAULT TOLERANCE: stopping one validator does not halt the chain
 *
 * Usage:  node scripts/verify-network.mjs [--skip-fault]
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  formatEther,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_FAULT = process.argv.includes("--skip-fault");

// --- load config -------------------------------------------------------------
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const cfg = JSON.parse(
  readFileSync(join(ROOT, "blockchain", "config", "chain.config.json"), "utf8")
);

const CHAIN_ID = Number(env.CHAIN_ID);
const BLOCK_PERIOD = Number(env.BLOCK_PERIOD_SECONDS);
const EMPTY_BLOCK_PERIOD = Number(env.EMPTY_BLOCK_PERIOD_SECONDS);
const VALIDATOR_COUNT = Number(env.VALIDATOR_COUNT);
const RPC_URL = env.RPC_URL;

// Well-known DEVNET keys. Publicly published by Foundry/Anvil — zero value.
const SENDER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

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

const pub = createPublicClient({ chain: giggora, transport: http(RPC_URL) });

// --- tiny test harness -------------------------------------------------------
const results = [];
let failed = 0;

async function check(name, fn) {
  process.stdout.write(`  ${name.padEnd(46, " ")}`);
  try {
    const detail = await fn();
    results.push([name, "PASS", detail ?? ""]);
    console.log(`PASS  ${detail ?? ""}`);
  } catch (err) {
    failed++;
    results.push([name, "FAIL", err.message]);
    console.log(`FAIL\n      -> ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" }).trim();
}

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// -----------------------------------------------------------------------------
console.log(`
  Giggora :: Phase 2 acceptance test
  ==================================
  RPC ${RPC_URL}
`);

// 1. chain identity
await check("RPC reachable and chain ID correct", async () => {
  const id = await pub.getChainId();
  assert(id === CHAIN_ID, `expected chain ID ${CHAIN_ID}, got ${id}`);
  const clientVersion = await rpc("web3_clientVersion");
  return `chainId=${id}  ${clientVersion.split("/")[0]}`;
});

// 2. validator set
await check("QBFT validator set size", async () => {
  const vals = await rpc("qbft_getValidatorsByBlockNumber", ["latest"]);
  assert(
    vals.length === VALIDATOR_COUNT,
    `expected ${VALIDATOR_COUNT} validators, got ${vals.length}`
  );
  return `${vals.length} validators (tolerates ${Math.floor((vals.length - 1) / 3)} faulty)`;
});

// 3. genesis allocation is exactly what we configured
await check("Genesis allocation matches config", async () => {
  const mismatches = [];
  for (const a of cfg.supply.allocations) {
    const onChain = await pub.getBalance({ address: a.address, blockNumber: 0n });
    const expected = BigInt(a.gig) * 10n ** 18n;
    if (onChain !== expected) {
      mismatches.push(`${a.role}: expected ${a.gig} GIG, got ${formatEther(onChain)}`);
    }
  }
  assert(mismatches.length === 0, mismatches.join("; "));
  const total = cfg.supply.allocations.reduce((s, a) => s + BigInt(a.gig), 0n);
  return `${cfg.supply.allocations.length} accounts, ${total.toLocaleString("en-US")} GIG total`;
});

// 4. block production rate.
//
// NOTE: measuring an IDLE chain here would be wrong. emptyblockperiodseconds is
// 60, so with no transactions the chain deliberately produces one empty block a
// minute -- sampling for a few seconds would look "stuck" while the chain is
// perfectly healthy. blockperiodseconds (2s) governs production UNDER LOAD, so
// that is what we actually exercise: send transactions back to back and measure
// the gap between the blocks that carry them.
await check("Block production under load", async () => {
  const account = privateKeyToAccount(SENDER_PK);
  const wallet = createWalletClient({ account, chain: giggora, transport: http(RPC_URL) });

  const seen = [];
  for (let i = 0; i < 3; i++) {
    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: parseEther("1") });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
    seen.push({ number: receipt.blockNumber, ts: Number(block.timestamp) });
  }

  assert(
    seen[seen.length - 1].number > seen[0].number,
    "all transactions landed in one block; cannot measure block period"
  );

  const gaps = [];
  for (let i = 1; i < seen.length; i++) {
    const dBlocks = Number(seen[i].number - seen[i - 1].number);
    const dSecs = seen[i].ts - seen[i - 1].ts;
    if (dBlocks > 0) gaps.push(dSecs / dBlocks);
  }
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;

  // Generous upper bound: we are asserting "roughly the configured period",
  // not benchmarking. Anything near the empty-block period means transactions
  // are not triggering prompt block production.
  assert(
    avg <= BLOCK_PERIOD * 3,
    `avg block gap under load was ${avg.toFixed(2)}s, expected ~${BLOCK_PERIOD}s`
  );

  return `avg ${avg.toFixed(2)}s/block over ${seen.length} txs (target ${BLOCK_PERIOD}s)`;
});

// 4b. idle cadence — confirms emptyblockperiodseconds is actually in force.
await check("Idle chain still advances (empty blocks)", async () => {
  const start = await pub.getBlockNumber();
  const budget = (EMPTY_BLOCK_PERIOD + BLOCK_PERIOD * 2) * 1000 + 5000;
  const deadline = Date.now() + budget;
  let end = start;
  while (Date.now() < deadline) {
    await sleep(3000);
    end = await pub.getBlockNumber();
    if (end > start) break;
  }
  assert(
    end > start,
    `no empty block within ${Math.round(budget / 1000)}s (empty period is ${EMPTY_BLOCK_PERIOD}s)`
  );
  return `advanced ${start} -> ${end} (empty period ${EMPTY_BLOCK_PERIOD}s)`;
});

// 5. a real, signed value transfer
await check("Signed GIG transfer moves balances", async () => {
  const account = privateKeyToAccount(SENDER_PK);
  const wallet = createWalletClient({ account, chain: giggora, transport: http(RPC_URL) });

  const value = parseEther("1000");
  const senderBefore = await pub.getBalance({ address: account.address });
  const recipientBefore = await pub.getBalance({ address: RECIPIENT });

  assert(senderBefore > value, `sender underfunded: ${formatEther(senderBefore)} GIG`);

  const hash = await wallet.sendTransaction({ to: RECIPIENT, value });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  assert(receipt.status === "success", `transaction reverted: ${hash}`);

  const senderAfter = await pub.getBalance({ address: account.address });
  const recipientAfter = await pub.getBalance({ address: RECIPIENT });
  const fee = receipt.gasUsed * receipt.effectiveGasPrice;

  assert(
    recipientAfter - recipientBefore === value,
    `recipient delta wrong: ${formatEther(recipientAfter - recipientBefore)} GIG`
  );
  assert(
    senderBefore - senderAfter === value + fee,
    `sender delta wrong: expected ${formatEther(value + fee)}, got ${formatEther(senderBefore - senderAfter)}`
  );
  assert(fee > 0n, "gas fee was zero — min-gas-price is not being enforced");

  return `1000 GIG moved, fee ${formatEther(fee)} GIG, block ${receipt.blockNumber}`;
});

// 6. fault tolerance — the reason we chose 4 validators over 3
if (SKIP_FAULT) {
  console.log("  Fault tolerance                               SKIPPED (--skip-fault)");
} else {
  await check("Chain survives losing one validator", async () => {
    // Do NOT test this by waiting for an empty block: emptyblockperiodseconds
    // is 60, so an idle chain legitimately produces nothing for a minute and a
    // short wait would report a false HALT. Instead prove real liveness — the
    // chain must still ACCEPT AND MINE a transaction with a validator down.
    const victim = `giggora-validator-${VALIDATOR_COUNT}`;
    const account = privateKeyToAccount(SENDER_PK);
    const wallet = createWalletClient({ account, chain: giggora, transport: http(RPC_URL) });

    const before = await pub.getBlockNumber();
    docker("stop", victim);
    try {
      // Give QBFT a moment to notice the missing peer and round-change.
      await sleep(BLOCK_PERIOD * 2 * 1000 + 2000);

      const value = parseEther("5");
      const recipientBefore = await pub.getBalance({ address: RECIPIENT });
      const hash = await wallet.sendTransaction({ to: RECIPIENT, value });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });

      assert(receipt.status === "success", `transaction reverted while ${victim} was down`);
      const recipientAfter = await pub.getBalance({ address: RECIPIENT });
      assert(
        recipientAfter - recipientBefore === value,
        `balance did not move correctly while ${victim} was down`
      );

      const vals = await rpc("qbft_getValidatorsByBlockNumber", ["latest"]);
      assert(
        vals.length === VALIDATOR_COUNT,
        `validator set changed to ${vals.length} while ${victim} was down`
      );

      return `mined tx in block ${receipt.blockNumber} (was ${before}) with ${victim} down`;
    } finally {
      docker("start", victim);
    }
  });
}

// --- summary -----------------------------------------------------------------
console.log(`
  SYSTEM STATUS
  -------------`);
const status = (n, ok) => `  ${n.padEnd(20, " ")} ${ok ? "PASS" : "FAIL"}`;
const byName = Object.fromEntries(results.map((r) => [r[0], r[1] === "PASS"]));
console.log(status("Blockchain", byName["RPC reachable and chain ID correct"]));
console.log(status("Consensus", byName["QBFT validator set size"]));
console.log(status("Block production", byName["Block production under load"] && byName["Idle chain still advances (empty blocks)"]));
console.log(status("Genesis", byName["Genesis allocation matches config"]));
console.log(status("Transactions", byName["Signed GIG transfer moves balances"]));
if (!SKIP_FAULT) {
  console.log(status("Fault tolerance", byName["Chain survives losing one validator"]));
}

if (failed > 0) {
  console.log(`\n  ${failed} check(s) FAILED. Phase 2 is not complete.\n`);
  process.exit(1);
}
console.log(`\n  All checks passed. Phase 2 acceptance criteria met.\n`);

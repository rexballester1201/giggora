#!/usr/bin/env node
/**
 * Giggora — devnet load generator.
 *
 * Produces a continuous, VARIED transaction stream so the indexer has realistic
 * data to index: native transfers, ERC-20 transfers, ERC-721 mints and
 * ERC-1155 mints, all emitting different log shapes.
 *
 * Also exists for a practical reason: with emptyblockperiodseconds=60 an idle
 * chain produces one block a minute, which is far too slow to build up a block
 * range worth cross-checking. Under load the chain produces a block every
 * ~2 seconds.
 *
 * Nonces are tracked locally and transactions are fired without awaiting each
 * receipt, so a block can carry several transactions.
 *
 * Usage:
 *   node scripts/load-generator.mjs [--tps 4] [--duration 3600]
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertDevnet } from "./lib/devnet-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

const TPS = arg("tps", 4);
const DURATION_S = arg("duration", 3600);

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

// DEVNET ONLY — publicly published Anvil keys, zero value.
const SENDER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RECIPIENTS = [
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0xfe3b557e8fb62b89f4916b721be55ceb828dbd73",
];

const giggora = defineChain({
  id: Number(env.CHAIN_ID),
  name: env.CHAIN_NAME,
  nativeCurrency: {
    name: env.CURRENCY_NAME,
    symbol: env.CURRENCY_SYMBOL,
    decimals: Number(env.CURRENCY_DECIMALS),
  },
  rpcUrls: { default: { http: [env.RPC_URL] } },
});

const account = privateKeyToAccount(SENDER_PK);
const pub = createPublicClient({ chain: giggora, transport: http(env.RPC_URL) });
// Fires a continuous stream of transactions from a public key. Devnet only.
await assertDevnet(pub, { what: "load-generator.mjs" });
const wallet = createWalletClient({ account, chain: giggora, transport: http(env.RPC_URL) });

// Contracts are optional: native transfers alone still generate blocks.
let contracts = null;
const depFile = join(ROOT, "deployments", `${env.CHAIN_NETWORK}.json`);
if (existsSync(depFile)) {
  const dep = JSON.parse(readFileSync(depFile, "utf8"));
  const abiOf = (name) =>
    JSON.parse(readFileSync(join(ROOT, "contracts", "out", `${name}.sol`, `${name}.json`), "utf8"))
      .abi;
  try {
    contracts = {
      token: { address: dep.contracts.GigToken.address, abi: abiOf("GigToken") },
      nft: { address: dep.contracts.GigNFT.address, abi: abiOf("GigNFT") },
      multi: { address: dep.contracts.GigMultiToken.address, abi: abiOf("GigMultiToken") },
    };
  } catch {
    contracts = null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nonce = await pub.getTransactionCount({ address: account.address });
let sent = 0;
let errors = 0;
let nftId = 0;

console.log(
  `load-generator: chain ${env.CHAIN_ID}, ~${TPS} tx/s, ${DURATION_S}s, ` +
    `contracts=${contracts ? "yes" : "native-only"}, start nonce ${nonce}`
);

const startBlock = await pub.getBlockNumber();
const deadline = Date.now() + DURATION_S * 1000;
let lastReport = Date.now();

async function fire(kind) {
  const n = nonce++;
  const to = RECIPIENTS[n % RECIPIENTS.length];
  try {
    if (!contracts || kind === 0) {
      await wallet.sendTransaction({ to, value: parseEther("0.01"), nonce: n });
    } else if (kind === 1) {
      await wallet.writeContract({
        ...contracts.token,
        functionName: "transfer",
        args: [to, 10n ** 18n],
        nonce: n,
      });
    } else if (kind === 2) {
      await wallet.writeContract({
        ...contracts.nft,
        functionName: "safeMint",
        args: [to, `ipfs://giggora/${nftId++}`],
        nonce: n,
      });
    } else {
      await wallet.writeContract({
        ...contracts.multi,
        functionName: "mint",
        args: [to, BigInt((n % 5) + 1), 1n, "0x"],
        nonce: n,
      });
    }
    sent++;
  } catch (err) {
    errors++;
    // A nonce that fell out of sync poisons everything after it; resync.
    if (/nonce/i.test(err.message)) {
      nonce = await pub.getTransactionCount({ address: account.address });
    }
  }
}

let i = 0;
while (Date.now() < deadline) {
  const batch = [];
  for (let k = 0; k < TPS; k++) batch.push(fire(i++ % 4));
  await Promise.allSettled(batch);
  await sleep(1000);

  if (Date.now() - lastReport > 30_000) {
    const head = await pub.getBlockNumber();
    console.log(
      `  sent=${sent} errors=${errors} block=${head} (+${head - startBlock} since start)`
    );
    lastReport = Date.now();
  }
}

const endBlock = await pub.getBlockNumber();
console.log(
  `load-generator done: sent=${sent} errors=${errors} blocks ${startBlock} -> ${endBlock}`
);

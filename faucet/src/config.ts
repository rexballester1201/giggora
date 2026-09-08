/**
 * Giggora faucet — configuration and key handling.
 *
 * Loads faucet.config.json plus the environment, validates every value, and
 * refuses to start on anything nonsensical. A faucet that boots with a
 * misparsed pool size gives away the wrong amount of money silently, so all of
 * this is fail-fast rather than fail-soft.
 *
 * Node 24 runs this file directly; no build step, so nothing here may use TS
 * features that need transformation (no enums, no namespaces, no decorators).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { gigToWei } from "./rate.ts";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(HERE, "..");

function die(msg: string): never {
  console.error(`\n  faucet: ${msg}\n`);
  process.exit(1);
}

/**
 * A .env FILE if there is one, and the real environment always, with
 * process.env winning. Same contract as indexer/explorer-api — in a container
 * there is no .env and configuration arrives as environment variables.
 */
function loadEnv(): Record<string, string> {
  let fromFile: Record<string, string> = {};
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    fromFile = Object.fromEntries(
      readFileSync(envPath, "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    ) as Record<string, string>;
  }
  return { ...fromFile, ...(process.env as Record<string, string>) };
}

export const env = loadEnv();

// --- faucet.config.json ------------------------------------------------------

const CONFIG_PATH = join(HERE, "faucet.config.json");
if (!existsSync(CONFIG_PATH)) die(`missing ${CONFIG_PATH}`);
const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

function wholeGig(value: unknown, label: string): bigint {
  if (typeof value !== "string" && typeof value !== "number") {
    die(`${label} must be a whole number of GIG (string or number), got ${JSON.stringify(value)}`);
  }
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) die(`${label} must be a whole number of GIG, got "${s}"`);
  return BigInt(s);
}

function positiveInt(value: unknown, label: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    die(`${label} must be a whole number between ${min} and ${max}, got ${JSON.stringify(value)}`);
  }
  return n;
}

const poolGig = wholeGig(raw.pool?.totalGig, "pool.totalGig");
const maxDripGig = wholeGig(raw.drip?.maxGig, "drip.maxGig");
if (poolGig < maxDripGig) die(`pool.totalGig (${poolGig}) is smaller than drip.maxGig (${maxDripGig})`);
if (maxDripGig > 1000n) die(`drip.maxGig is ${maxDripGig} GIG per claim — refusing as a likely typo`);

export const config = {
  poolWei: gigToWei(poolGig),
  poolGig,
  maxDripGig,

  cooldownAddressSeconds: positiveInt(raw.cooldown?.addressSeconds, "cooldown.addressSeconds", 1, 31_536_000),
  cooldownIpSeconds: positiveInt(raw.cooldown?.ipSeconds, "cooldown.ipSeconds", 1, 31_536_000),

  // The one limit no amount of addresses, IPs or CPU gets past.
  dailyCapWei: gigToWei(wholeGig(raw.dailyCap?.gig, "dailyCap.gig")),
  dailyCapGig: wholeGig(raw.dailyCap?.gig, "dailyCap.gig"),

  powEnabled: raw.pow?.enabled !== false,
  // 32 bits would be ~4 billion hashes: minutes of browser CPU. The upper bound
  // is a guard against a config typo bricking the faucet for everyone.
  powDifficultyBits: positiveInt(raw.pow?.difficultyBits, "pow.difficultyBits", 1, 28),
  powTtlSeconds: positiveInt(raw.pow?.challengeTtlSeconds, "pow.challengeTtlSeconds", 30, 3600),

  lowBalanceWarnWei: gigToWei(wholeGig(raw.hotWallet?.lowBalanceWarnGig, "hotWallet.lowBalanceWarnGig")),
  reserveWei: gigToWei(wholeGig(raw.hotWallet?.reserveGig, "hotWallet.reserveGig")),

  port: positiveInt(env.FAUCET_PORT ?? raw.server?.port, "server.port", 1, 65535),
  host: String(env.FAUCET_HOST ?? raw.server?.host ?? "127.0.0.1"),
  recentClaimsShown: positiveInt(raw.server?.recentClaimsShown, "server.recentClaimsShown", 0, 50),
};

// --- chain -------------------------------------------------------------------

export const chain = {
  id: Number(env.CHAIN_ID),
  name: env.CHAIN_NAME ?? "Giggora",
  rpcUrl: env.RPC_URL ?? "http://localhost:8545",
  symbol: env.CURRENCY_SYMBOL ?? "GIG",
  decimals: Number(env.CURRENCY_DECIMALS ?? 18),
  explorerUrl: env.FAUCET_EXPLORER_URL ?? "http://localhost:3000",
};
if (!Number.isInteger(chain.id) || chain.id <= 0) {
  die("CHAIN_ID is not set. Run `node scripts/gen-config.mjs` or set it in the environment.");
}

export const DEVNET_CHAIN_ID = 4043;

/**
 * Anvil/Hardhat account #1. PUBLISHED — it is in this repository's README, in
 * every Foundry tutorial, and on every developer's machine.
 *
 * Account #1 rather than #0 on purpose: #0 is used by deploy-contracts.mjs and
 * load-generator.mjs, and two processes signing from one address race on the
 * nonce. The faucet needs its own sender.
 */
const PUBLISHED_DEVNET_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

/**
 * The signing key, and the rule that keeps a public key off a real chain.
 *
 * FAUCET_PRIVATE_KEY unset -> the published devnet key, and the faucet REFUSES
 *                             to run on any chain but 4043. Anything it holds
 *                             elsewhere belongs to whoever asks for it first.
 * FAUCET_PRIVATE_KEY set   -> the operator's own key, any chain.
 *
 * The chain id is checked against the NODE at startup (server.ts), not against
 * .env, because a repointed .env is exactly the mistake this guards.
 */
export function loadSigner(): { account: ReturnType<typeof privateKeyToAccount>; usingPublishedKey: boolean } {
  const supplied = env.FAUCET_PRIVATE_KEY?.trim();
  if (supplied) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(supplied)) {
      die("FAUCET_PRIVATE_KEY is set but is not a 0x-prefixed 32-byte hex key");
    }
    if (supplied.toLowerCase() === PUBLISHED_DEVNET_KEY) {
      // Setting it explicitly must not launder it into looking operator-owned.
      return { account: privateKeyToAccount(supplied as `0x${string}`), usingPublishedKey: true };
    }
    return { account: privateKeyToAccount(supplied as `0x${string}`), usingPublishedKey: false };
  }
  return {
    account: privateKeyToAccount(PUBLISHED_DEVNET_KEY as `0x${string}`),
    usingPublishedKey: true,
  };
}

/** Salt for the IP hash. Never the IP itself — see migration 006. */
export const IP_SALT = env.FAUCET_IP_SALT ?? "giggora-faucet-devnet-salt";

export { die };

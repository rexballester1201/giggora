/**
 * Giggora faucet — server.
 *
 * Fastify, run directly by Node 24's native TypeScript stripping. Serves both
 * the JSON API and the portal page, so the faucet is one process to run.
 *
 * SECURITY POSTURE — this is the only service in the repository that SPENDS
 * money in response to an anonymous request, so it is the one that matters:
 *
 *   - the signing key comes from the environment, never from a file in git, and
 *     the PUBLISHED devnet key is refused on any chain but 4043 (config.ts)
 *   - every payout is serialised and debited inside one Postgres transaction
 *     before anything is sent (db.ts), so no request can be paid twice
 *   - the recipient address is validated, and it is the ONLY thing a caller
 *     controls: no amount, no destination beyond a well-formed address, no memo
 *   - proof of work prices mass sybil claiming (pow.ts)
 *   - two independent cooldowns, per address and per source
 *   - client IPs are hashed with a salt, never stored (migration 006)
 *   - internal errors are logged in full and NEVER returned; a Postgres or RPC
 *     error would disclose schema or topology
 */

import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, formatUnits, isAddress } from "viem";

import { config, chain, env, loadSigner, IP_SALT, DEVNET_CHAIN_ID } from "./config.ts";
import { dripWei, scheduleTable, WEI_PER_GIG } from "./rate.ts";
import { issueChallenge, verify as verifyPow, hashIp } from "./pow.ts";
import {
  initState,
  readStatus,
  reserveClaim,
  settleSent,
  settleFailed,
  recentClaims,
  stalePending,
  closePool,
} from "./db.ts";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(HERE, "public");

const giggora = defineChain({
  id: chain.id,
  name: chain.name,
  nativeCurrency: { name: chain.name, symbol: chain.symbol, decimals: chain.decimals },
  rpcUrls: { default: { http: [chain.rpcUrl] } },
});

const { account, usingPublishedKey } = loadSigner();
const pub = createPublicClient({ chain: giggora, transport: http(chain.rpcUrl) });
const wallet = createWalletClient({ account, chain: giggora, transport: http(chain.rpcUrl) });

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate a recipient address and return the form to send to.
 *
 * The shape regex alone is NOT enough. Ethereum addresses are case-insensitive,
 * but a MIXED-case one carries an EIP-55 checksum, and viem refuses to send to
 * one whose checksum is wrong. Accepting it here produced an opaque
 * "the transaction could not be sent" 502 — after reserving and refunding a
 * claim — for what is really a typo in the pasted address. Catching typos is
 * the entire purpose of EIP-55, so it is checked at the boundary and reported
 * plainly.
 *
 * All-lowercase and all-uppercase carry no checksum information and are
 * accepted as-is; everything is normalised to lowercase before sending.
 */
function normalizeAddress(input: string): { ok: true; address: string } | { ok: false; message: string } {
  if (!ADDRESS_RE.test(input)) {
    return { ok: false, message: "Enter a valid address: 0x followed by 40 hex characters." };
  }
  if (/^0x0{40}$/i.test(input)) {
    return { ok: false, message: "That is the zero address — GIG sent there is destroyed." };
  }
  const body = input.slice(2);
  const mixedCase = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixedCase && !isAddress(input, { strict: true })) {
    return {
      ok: false,
      message:
        "That address fails its EIP-55 checksum, which usually means a character was mistyped. " +
        "Check it, or paste it in all lowercase to skip the check.",
    };
  }
  return { ok: true, address: input.toLowerCase() };
}

/**
 * Escape a config value before it is substituted into the portal's HTML.
 *
 * chain.config.json is trusted, but a template that inserts unescaped text into
 * markup is a cross-site-scripting hole waiting for the day somebody pastes a
 * description containing an angle bracket. Escaping costs nothing.
 */
function esc(v: string): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Payout for a given pool state, in wei. One place, used by both /status and /claim. */
const drip = (remainingWei: bigint, poolWei: bigint) => dripWei(remainingWei, poolWei, config.maxDripGig);

export async function build() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL ?? "info" },
    bodyLimit: 8 * 1024,
    // Never `true`. The per-source cooldown and the rate limiter both key on
    // req.ip; trusting an arbitrary X-Forwarded-For would let a caller rotate
    // that header past both, or pin a victim into someone else's cooldown.
    trustProxy: env.TRUSTED_PROXY_CIDR || false,
    requestTimeout: 20_000,
    maxParamLength: 128,
    frameworkErrors: (_err, _req, reply) =>
      reply.status(400).send({ error: "bad_request", message: "Invalid request" }),
  });

  // PER-ROUTE, not global. Registered with global:false and attached only to
  // the API routes below.
  //
  // A single limit across everything counted page loads against claim attempts:
  // opening the portal costs 4 requests (html, css, js, status) and the poller
  // adds one every 30s, so a shared connection tripped a 30/minute bound just by
  // reading the page. Behind carrier-grade NAT — how most people in the
  // Philippines reach the internet on mobile — that is thousands of users on one
  // address, and it locked them out of the static files as well as the faucet.
  //
  // Default keyGenerator, deliberately: it masks IPv6 to a /64, so a client
  // cannot walk its own allocation for unlimited buckets.
  await app.register(rateLimit, {
    global: false,
    timeWindow: env.FAUCET_RATE_LIMIT_WINDOW ?? "1 minute",
  });

  /** Cheap and idempotent; the portal polls it. */
  const READ_LIMIT = { config: { rateLimit: { max: Number(env.FAUCET_RATE_LIMIT_READ ?? 120) } } };
  /** Spends money. Tight — the cooldowns and daily cap are the real limits. */
  const WRITE_LIMIT = { config: { rateLimit: { max: Number(env.FAUCET_RATE_LIMIT_WRITE ?? 12) } } };

  app.setErrorHandler((err, req, reply) => {
    const status = (err as any).statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send({
        error: "rate_limited",
        message: "Too many requests. Slow down and try again shortly.",
      });
    }
    if (status >= 400 && status < 500) {
      return reply.status(status).send({ error: "bad_request", message: err.message });
    }
    req.log.error({ err }, "faucet internal error");
    return reply.status(500).send({
      error: "internal_error",
      message: "The faucet hit an internal error. It has been logged.",
    });
  });

  // --- the faucet's own view of itself --------------------------------------

  async function hotBalance(): Promise<bigint> {
    return await pub.getBalance({ address: account.address });
  }

  app.get("/api/status", READ_LIMIT, async () => {
    const s = await readStatus();
    // The REAL on-chain balance, not an assumption. A faucet whose ledger says
    // it has money while the wallet is empty is exactly the "presenting a
    // number that is not the chain" failure the project forbids.
    let balanceWei: bigint | null = null;
    let chainError: string | null = null;
    try {
      balanceWei = await hotBalance();
    } catch (err) {
      chainError = "the chain node is unreachable";
    }

    const payoutWei = drip(s.remainingWei, s.poolWei);
    const spendableWei = balanceWei === null ? null : balanceWei - config.reserveWei;

    return {
      chain: { id: chain.id, name: chain.name, symbol: chain.symbol, rpcUrl: chain.rpcUrl, explorerUrl: chain.explorerUrl },
      pool: {
        totalGig: (s.poolWei / WEI_PER_GIG).toString(),
        dispensedGig: formatUnits(s.dispensedWei, 18),
        remainingGig: formatUnits(s.remainingWei, 18),
        percentRemaining: s.poolWei === 0n ? 0 : Number((s.remainingWei * 10000n) / s.poolWei) / 100,
        claims: s.claimCount,
      },
      payout: {
        gig: formatUnits(payoutWei, 18),
        maxGig: config.maxDripGig.toString(),
        cooldownSeconds: config.cooldownAddressSeconds,
      },
      daily: {
        capGig: config.dailyCapGig.toString(),
        remainingGig: formatUnits(s.dailyRemainingWei, 18),
        exhausted: s.dailyRemainingWei < payoutWei,
      },
      // Honest about whether it can actually pay right now: the chain has to be
      // reachable, the wallet has to hold it, the pool has to have it, and
      // today's shared budget has to have room.
      dispensing:
        chainError === null &&
        spendableWei !== null &&
        spendableWei >= payoutWei &&
        payoutWei > 0n &&
        s.dailyRemainingWei >= payoutWei,
      hotWallet: {
        address: account.address,
        balanceGig: balanceWei === null ? null : formatUnits(balanceWei, 18),
        low: balanceWei !== null && balanceWei < config.lowBalanceWarnWei,
      },
      chainError,
      schedule: scheduleTable(s.poolWei, config.maxDripGig).map((r) => ({
        remainingGig: (r.remainingWei / WEI_PER_GIG).toString(),
        dripGig: r.dripGig.toString(),
      })),
      pow: { enabled: config.powEnabled, difficultyBits: config.powDifficultyBits },
      recent: await recentClaims(config.recentClaimsShown),
    };
  });

  // --- proof of work ---------------------------------------------------------

  app.get("/api/challenge", WRITE_LIMIT, async (req) => {
    const q = req.query as Record<string, unknown>;
    const address = String(q.address ?? "");
    if (!ADDRESS_RE.test(address)) {
      const e: any = new Error("address must be 0x followed by 40 hex characters");
      e.statusCode = 400;
      throw e;
    }
    if (!config.powEnabled) return { enabled: false };
    return { enabled: true, ...issueChallenge(address, config.powTtlSeconds, config.powDifficultyBits) };
  });

  // --- the claim -------------------------------------------------------------

  app.post("/api/claim", WRITE_LIMIT, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const checked = normalizeAddress(String(body.address ?? "").trim());
    if (!checked.ok) {
      return reply.status(400).send({ error: "bad_address", message: checked.message });
    }
    const address = checked.address;

    if (config.powEnabled) {
      const v = verifyPow(address, String(body.nonce ?? ""), config.powTtlSeconds, config.powDifficultyBits);
      if (!v.ok) {
        return reply.status(400).send({ error: "bad_pow", message: v.reason });
      }
    }

    // Refuse BEFORE debiting if the wallet cannot actually pay: a 'pending' row
    // for money that was never going to move is worse than a clean refusal.
    let balanceWei: bigint;
    try {
      balanceWei = await hotBalance();
    } catch {
      return reply.status(503).send({
        error: "chain_unreachable",
        message: "The faucet cannot reach the chain right now. Try again shortly.",
      });
    }

    const reserved = await reserveClaim(address, hashIp(req.ip, IP_SALT), drip);
    if (!reserved.ok) {
      const status = reserved.retryAfterSeconds ? 429 : 410;
      if (reserved.retryAfterSeconds) reply.header("retry-after", String(reserved.retryAfterSeconds));
      return reply.status(status).send({
        error: reserved.retryAfterSeconds ? "cooldown" : "empty",
        message: reserved.reason,
        retryAfterSeconds: reserved.retryAfterSeconds,
      });
    }

    const amountWei = reserved.amountWei as bigint;
    const claimId = reserved.claimId as number;

    if (balanceWei - config.reserveWei < amountWei) {
      await settleFailed(claimId, amountWei, "hot wallet balance too low");
      return reply.status(503).send({
        error: "faucet_dry",
        message: "The faucet wallet is out of GIG. An operator needs to top it up.",
      });
    }

    try {
      const hash = await wallet.sendTransaction({ to: address as `0x${string}`, value: amountWei });
      await settleSent(claimId, hash);
      req.log.info({ address, amountWei: amountWei.toString(), hash }, "faucet claim sent");
      return {
        ok: true,
        amountGig: formatUnits(amountWei, 18),
        txHash: hash,
        explorerUrl: `${chain.explorerUrl}/tx/${hash}`,
        remainingGig: formatUnits(reserved.remainingWei as bigint, 18),
        nextPayoutGig: formatUnits(drip(reserved.remainingWei as bigint, config.poolWei), 18),
        cooldownSeconds: config.cooldownAddressSeconds,
      };
    } catch (err) {
      // The ledger is refunded; nothing left the wallet.
      await settleFailed(claimId, amountWei, (err as Error).message);
      req.log.error({ err, address }, "faucet send failed");
      return reply.status(502).send({
        error: "send_failed",
        message: "The transaction could not be sent. Nothing was deducted — try again.",
      });
    }
  });

  // --- portal ----------------------------------------------------------------

  app.get("/*", async (req, reply) => {
    const url = (req.params as any)["*"] as string;
    const rel = !url || url === "" ? "index.html" : url;

    // Contain path traversal: normalise, strip leading ../, then verify the
    // resolved path is still inside PUBLIC_DIR.
    const target = join(PUBLIC_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!target.startsWith(PUBLIC_DIR) || !existsSync(target)) {
      return reply.status(404).type("text/plain").send("Not found");
    }
    // HTML is templated so the portal carries the chain's OWN name, ticker and
    // description rather than a hardcoded one. A fork edits
    // blockchain/config/chain.config.json and this page follows, with no build
    // step — the page is plain HTML and the substitution happens on the way out.
    if (extname(target) === ".html") {
      const html = (await readFile(target, "utf8"))
        .replaceAll("{{CHAIN_NAME}}", esc(chain.name))
        .replaceAll("{{CHAIN_INITIAL}}", esc(chain.name.slice(0, 1).toUpperCase()))
        .replaceAll("{{CHAIN_SYMBOL}}", esc(chain.symbol))
        .replaceAll("{{CHAIN_TAGLINE}}", esc(chain.tagline))
        .replaceAll("{{CHAIN_DESCRIPTION}}", esc(chain.description));
      return reply
        .type(TYPES[".html"])
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "strict-origin-when-cross-origin")
        .header("x-frame-options", "DENY")
        .header(
          "content-security-policy",
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"
        )
        .send(html);
    }

    return reply
      .type(TYPES[extname(target)] ?? "application/octet-stream")
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "strict-origin-when-cross-origin")
      .header("x-frame-options", "DENY")
      .header(
        "content-security-policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"
      )
      .send(await readFile(target));
  });

  return app;
}

// --- startup -----------------------------------------------------------------

const app = await build();

// The chain id comes from the NODE, never from .env — a repointed .env is
// exactly the mistake the published-key rule exists to catch.
let liveChainId: number;
try {
  liveChainId = Number(await pub.getChainId());
} catch (err) {
  console.error(`\n  faucet: cannot reach ${chain.rpcUrl} — is the chain running?\n`);
  process.exit(1);
}

if (liveChainId !== chain.id) {
  console.error(
    `\n  faucet: CHAIN_ID says ${chain.id} but the node at ${chain.rpcUrl} reports ${liveChainId}.\n`
  );
  process.exit(1);
}

if (usingPublishedKey && liveChainId !== DEVNET_CHAIN_ID) {
  console.error(
    `\n  faucet: refusing to run.\n` +
      `  No FAUCET_PRIVATE_KEY is set, so the faucet would sign with the PUBLISHED Anvil #1 key,\n` +
      `  and the node reports chain ${liveChainId}, not the devnet (${DEVNET_CHAIN_ID}).\n` +
      `  Anything that key holds on a real chain belongs to whoever asks for it first.\n` +
      `  Set FAUCET_PRIVATE_KEY to a key you generated.\n`
  );
  process.exit(1);
}

await initState(liveChainId);

const stale = await stalePending(300);
if (stale > 0) {
  console.warn(
    `  faucet: ${stale} claim(s) are 'pending' and older than 5 minutes — the process died mid-send.\n` +
      `          The pool is debited for them. Check faucet_claims and reconcile against the chain.`
  );
}

const startStatus = await readStatus();
let startBalance: bigint | null = null;
try {
  startBalance = await pub.getBalance({ address: account.address });
} catch {
  /* reported per-request by /api/status */
}

await app.listen({ port: config.port, host: config.host });

console.log(`
  Giggora faucet
  --------------
  Portal        http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}
  Chain         ${liveChainId} (${chain.name}) via ${chain.rpcUrl}

  Pool          ${config.poolGig} GIG total, ${formatUnits(startStatus.remainingWei, 18)} remaining
  Payout now    ${formatUnits(drip(startStatus.remainingWei, startStatus.poolWei), 18)} ${chain.symbol} per claim
  Daily cap     ${config.dailyCapGig} ${chain.symbol}/24h (${formatUnits(startStatus.dailyRemainingWei, 18)} left today)
                floor of ${(config.poolGig / config.dailyCapGig).toString()} days to drain the pool
  Cooldown      ${config.cooldownAddressSeconds}s per address, ${config.cooldownIpSeconds}s per source
  Proof of work ${config.powEnabled ? `${config.powDifficultyBits} bits` : "DISABLED"}

  Hot wallet    ${account.address}
                ${startBalance === null ? "(balance unavailable)" : `${formatUnits(startBalance, 18)} ${chain.symbol}`}${usingPublishedKey ? "\n                using the PUBLISHED devnet key — devnet only" : ""}
`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await closePool();
    process.exit(0);
  });
}

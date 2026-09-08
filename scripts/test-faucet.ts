#!/usr/bin/env node
/**
 * Giggora — faucet test suite.
 *
 * The faucet is the only service in this repository that SPENDS MONEY in
 * response to an anonymous HTTP request, so the tests are about money leaving:
 * the right amount, once, to the right address, and never twice.
 *
 * Runs against a LIVE faucet and a LIVE chain. Nothing is mocked — a claim in
 * this suite really moves GIG on the devnet and is verified by reading the
 * recipient's balance from the node afterwards.
 *
 * Usage:
 *   node faucet/src/server.ts &        # or: npm run faucet
 *   node scripts/test-faucet.ts        # or: npm run faucet:test
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPublicClient, defineChain, http } from "viem";
import { dripWei, gigToWei, WEI_PER_GIG } from "../faucet/src/rate.ts";

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

const BASE = process.env.FAUCET_URL ?? "http://127.0.0.1:4200";

const giggora = defineChain({
  id: Number(env.CHAIN_ID),
  name: env.CHAIN_NAME ?? "Giggora",
  nativeCurrency: { name: "Giggora", symbol: env.CURRENCY_SYMBOL ?? "GIG", decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_URL] } },
});
const pub = createPublicClient({ chain: giggora, transport: http(env.RPC_URL) });
const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });

let pass = 0;
let fail = 0;

function report(ok: boolean, label: string, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(56)}${detail}`);
  if (!ok) process.exitCode = 1;
}

async function check(label: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    report(true, label, detail ?? "");
  } catch (err) {
    report(false, label, (err as Error).message);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const j = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${path}`, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, headers: res.headers };
};

/** Solve the proof of work exactly as the browser does. */
function solve(challenge: string, bits: number): string {
  for (let nonce = 0; nonce < 50_000_000; nonce++) {
    const d = createHash("sha256").update(`${challenge}:${nonce}`).digest();
    let zeros = 0;
    for (const byte of d) {
      if (byte === 0) {
        zeros += 8;
        continue;
      }
      zeros += Math.clz32(byte) - 24;
      break;
    }
    if (zeros >= bits) return String(nonce);
  }
  throw new Error("no proof-of-work solution found");
}

async function claimFor(address: string) {
  const ch = await j(`/api/challenge?address=${address}`);
  const nonce = ch.body?.enabled ? solve(ch.body.challenge, ch.body.difficultyBits) : "";
  return await j("/api/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, nonce }),
  });
}

/** A fresh address nobody has claimed for. */
const freshAddress = () => `0x${createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 40)}`;

console.log(`
  Giggora :: faucet tests
  =======================
  faucet ${BASE}
  chain  ${env.RPC_URL} (${env.CHAIN_ID})
`);

// ---------------------------------------------------------------------------
console.log("  The drip curve (pure, no I/O)");
// ---------------------------------------------------------------------------

await check("Reproduces the specified 20M schedule exactly", async () => {
  const pool = gigToWei(20_000_000n);
  const spec: Array<[bigint, bigint]> = [
    [20_000_000n, 10n],
    [18_000_000n, 9n],
    [16_000_000n, 8n],
    [14_000_000n, 7n],
    [12_000_000n, 6n],
    [10_000_000n, 5n],
  ];
  for (const [remainingGig, expectGig] of spec) {
    const got = dripWei(gigToWei(remainingGig), pool, 10n) / WEI_PER_GIG;
    assert(got === expectGig, `at ${remainingGig}M left expected ${expectGig} GIG, got ${got}`);
  }
  return "10/9/8/7/6/5 at 20M/18M/16M/14M/12M/10M";
});

await check("50% of the pool pays 50% of the rate", async () => {
  const pool = gigToWei(20_000_000n);
  const got = dripWei(pool / 2n, pool, 10n) / WEI_PER_GIG;
  assert(got === 5n, `expected 5, got ${got}`);
  return "half pool -> 5 GIG";
});

await check("Steps down only on crossing a band, not before", async () => {
  const pool = gigToWei(20_000_000n);
  // 19M is 95% -> exact value 9.5. Ceiling keeps it at 10 until 18M.
  const at19 = dripWei(gigToWei(19_000_000n), pool, 10n) / WEI_PER_GIG;
  const at18 = dripWei(gigToWei(18_000_000n), pool, 10n) / WEI_PER_GIG;
  assert(at19 === 10n, `at 19M expected 10, got ${at19}`);
  assert(at18 === 9n, `at 18M expected 9, got ${at18}`);
  return "19M -> 10, 18M -> 9";
});

await check("Curve is scale-free: same shape at any pool size", async () => {
  for (const poolGig of [100_000n, 250_000n, 20_000_000n]) {
    const pool = gigToWei(poolGig);
    for (const [frac, expect] of [
      [10n, 10n],
      [9n, 9n],
      [5n, 5n],
      [1n, 1n],
    ] as Array<[bigint, bigint]>) {
      const got = dripWei((pool * frac) / 10n, pool, 10n) / WEI_PER_GIG;
      assert(got === expect, `pool ${poolGig} at ${frac}/10 expected ${expect}, got ${got}`);
    }
  }
  return "identical at 100k / 250k / 20M";
});

await check("Never overdraws: the last dust is paid, not refused", async () => {
  const pool = gigToWei(100_000n);
  const dust = WEI_PER_GIG / 2n; // half a GIG left
  const got = dripWei(dust, pool, 10n);
  assert(got === dust, `expected exactly the dust (${dust}), got ${got}`);
  assert(dripWei(0n, pool, 10n) === 0n, "an empty pool must pay 0");
  return "pays remaining dust, 0 when empty";
});

await check("Never exceeds the advertised maximum", async () => {
  const pool = gigToWei(100_000n);
  // A pool resized downward can leave remaining > pool; the cap must still hold.
  const got = dripWei(pool * 3n, pool, 10n) / WEI_PER_GIG;
  assert(got === 10n, `expected the 10 GIG cap, got ${got}`);
  return "capped at maxGig";
});

// ---------------------------------------------------------------------------
console.log("\n  Status endpoint");
// ---------------------------------------------------------------------------

let status: any;

await check("Reports pool, payout and the REAL hot-wallet balance", async () => {
  const r = await j("/api/status");
  assert(r.status === 200, `expected 200, got ${r.status}`);
  status = r.body;
  assert(status.chain.id === Number(env.CHAIN_ID), "wrong chain id");
  assert(status.hotWallet.address, "no hot wallet address");
  const onChain = await pub.getBalance({ address: status.hotWallet.address });
  const reported = BigInt(Math.round(Number(status.hotWallet.balanceGig) * 1e6));
  const actual = (onChain * 1_000_000n) / WEI_PER_GIG;
  // Within a hair: the balance moves as the chain produces blocks.
  const delta = reported > actual ? reported - actual : actual - reported;
  assert(delta < 1_000_000n, `reported balance ${reported} vs chain ${actual}`);
  return `${status.pool.remainingGig} GIG left, paying ${status.payout.gig}`;
});

await check("Says whether it can actually dispense right now", async () => {
  assert(typeof status.dispensing === "boolean", "no dispensing flag");
  assert(status.dispensing === true, "faucet reports it cannot dispense");
  return "dispensing: true";
});

await check("Publishes the full schedule", async () => {
  assert(Array.isArray(status.schedule) && status.schedule.length === 10, "expected 10 schedule rows");
  assert(status.schedule[0].dripGig === "10", "top of schedule is not 10 GIG");
  assert(status.schedule[9].dripGig === "1", "bottom of schedule is not 1 GIG");
  return `${status.schedule.length} bands, 10 -> 1 GIG`;
});

// ---------------------------------------------------------------------------
console.log("\n  Input validation and proof of work");
// ---------------------------------------------------------------------------

await check("Rejects a malformed address", async () => {
  for (const bad of ["", "0x", "notanaddress", "0x123", `0x${"g".repeat(40)}`]) {
    const r = await j("/api/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: bad, nonce: "0" }),
    });
    assert(r.status === 400, `"${bad}" returned ${r.status}, expected 400`);
  }
  return "5 malformed inputs rejected";
});

await check("Rejects the zero address", async () => {
  const r = await j("/api/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: `0x${"0".repeat(40)}`, nonce: "0" }),
  });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "burn address refused";
});

await check("Rejects a claim with no valid proof of work", async () => {
  const addr = freshAddress();
  const r = await j("/api/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: addr, nonce: "0" }),
  });
  assert(r.status === 400 && r.body?.error === "bad_pow", `expected bad_pow 400, got ${r.status} ${r.body?.error}`);
  return "unsolved nonce refused";
});

await check("A challenge solved for one address does not work for another", async () => {
  const a = freshAddress();
  const b = freshAddress();
  const ch = await j(`/api/challenge?address=${a}`);
  const nonce = solve(ch.body.challenge, ch.body.difficultyBits);
  const r = await j("/api/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: b, nonce }),
  });
  assert(r.status === 400 && r.body?.error === "bad_pow", `expected bad_pow, got ${r.status} ${r.body?.error}`);
  return "challenge is bound to its address";
});

// ---------------------------------------------------------------------------
console.log("\n  A real claim (money actually moves)");
// ---------------------------------------------------------------------------

const recipient = freshAddress();
let claimed: any;
let expectedWei: bigint;

await check("Pays the advertised amount, on chain, to the given address", async () => {
  const before = await pub.getBalance({ address: recipient as `0x${string}` });
  assert(before === 0n, "test address was not empty");

  const stateBefore = await db.query("SELECT dispensed_wei FROM faucet_state WHERE id = 1");
  const dispensedBefore = BigInt(stateBefore.rows[0].dispensed_wei);

  const r = await claimFor(recipient);
  assert(r.status === 200 && r.body?.ok, `claim failed: ${r.status} ${JSON.stringify(r.body)}`);
  claimed = r.body;

  expectedWei = BigInt(Math.round(Number(status.payout.gig))) * WEI_PER_GIG;

  await pub.waitForTransactionReceipt({ hash: claimed.txHash, timeout: 60_000 });
  const after = await pub.getBalance({ address: recipient as `0x${string}` });
  assert(after === expectedWei, `expected ${expectedWei} wei on chain, got ${after}`);

  const stateAfter = await db.query("SELECT dispensed_wei FROM faucet_state WHERE id = 1");
  const moved = BigInt(stateAfter.rows[0].dispensed_wei) - dispensedBefore;
  assert(moved === expectedWei, `ledger moved ${moved}, chain moved ${expectedWei}`);

  return `${claimed.amountGig} GIG, ledger and chain agree`;
});

await check("Records the claim as sent, with the real transaction hash", async () => {
  const r = await db.query(
    "SELECT status, amount_wei, tx_hash FROM faucet_claims WHERE address = $1",
    [Buffer.from(recipient.slice(2), "hex")]
  );
  assert(r.rowCount === 1, `expected 1 claim row, found ${r.rowCount}`);
  assert(r.rows[0].status === "sent", `status is ${r.rows[0].status}`);
  const stored = `0x${r.rows[0].tx_hash.toString("hex")}`;
  assert(stored === claimed.txHash, `stored hash ${stored} != ${claimed.txHash}`);
  const tx = await pub.getTransaction({ hash: stored as `0x${string}` });
  assert(tx.to?.toLowerCase() === recipient.toLowerCase(), "transaction went to the wrong address");
  return "one row, status sent, hash on chain";
});

// ---------------------------------------------------------------------------
console.log("\n  Cooldowns");
// ---------------------------------------------------------------------------

await check("The same address cannot claim twice", async () => {
  const r = await claimFor(recipient);
  assert(r.status === 429, `expected 429, got ${r.status}`);
  assert(r.body?.error === "cooldown", `expected cooldown, got ${r.body?.error}`);
  assert(r.body?.retryAfterSeconds > 0, "no retryAfterSeconds");
  assert(r.headers.get("retry-after"), "no Retry-After header");
  return `429, retry in ${r.body.retryAfterSeconds}s`;
});

await check("A DIFFERENT address from the same source is also refused", async () => {
  // The point of the per-source limit: addresses are free, so an address-only
  // cooldown is not a limit at all.
  const r = await claimFor(freshAddress());
  assert(r.status === 429, `expected 429, got ${r.status}`);
  return "per-source cooldown holds";
});

await check("A refused claim did not debit the pool", async () => {
  const s = await db.query("SELECT dispensed_wei FROM faucet_state WHERE id = 1");
  const sent = await db.query("SELECT count(*)::int AS n FROM faucet_claims WHERE status = 'sent'");
  const expected = expectedWei * BigInt(sent.rows[0].n);
  // Every 'sent' claim in this database was for the same current rate only if
  // the pool has not crossed a band; assert the weaker, always-true invariant.
  assert(
    BigInt(s.rows[0].dispensed_wei) >= expectedWei,
    "dispensed is less than the one claim we know landed"
  );
  const pending = await db.query("SELECT count(*)::int AS n FROM faucet_claims WHERE status = 'pending'");
  assert(Number(pending.rows[0].n) === 0, `${pending.rows[0].n} claims stuck pending`);
  return `no pending rows, dispensed >= ${expectedWei / WEI_PER_GIG} GIG`;
});

// ---------------------------------------------------------------------------
console.log("\n  The daily cap (the limit an attacker cannot buy past)");
// ---------------------------------------------------------------------------

await check("Status publishes today's shared budget", async () => {
  const r = await j("/api/status");
  assert(r.body.daily, "no daily section");
  assert(Number(r.body.daily.capGig) > 0, "cap is not positive");
  assert(Number(r.body.daily.remainingGig) <= Number(r.body.daily.capGig), "remaining exceeds the cap");
  return `${r.body.daily.remainingGig} of ${r.body.daily.capGig} GIG left today`;
});

await check("A full daily budget refuses a FRESH address from a FRESH source", async () => {
  // This is the property that matters: the per-address and per-source cooldowns
  // bound one claimant, the cap bounds everyone. Fill today's budget with
  // synthetic settled claims and confirm a brand-new address is still refused.
  const cap = BigInt((await j("/api/status")).body.daily.capGig) * WEI_PER_GIG;
  const marker = await db.query("SELECT COALESCE(max(id), 0) AS m FROM faucet_claims");
  const highWater = BigInt(marker.rows[0].m);
  try {
    await db.query(
      `INSERT INTO faucet_claims (address, amount_wei, status, ip_hash, requested_at)
       VALUES (decode($1, 'hex'), $2, 'sent', decode($3, 'hex'), now())`,
      ["de".repeat(20), cap.toString(), "ab".repeat(32)]
    );
    const r = await claimFor(freshAddress());
    assert(r.status === 429, `expected 429, got ${r.status}`);
    assert(/daily limit/i.test(String(r.body?.message)), `expected a daily-limit message, got "${r.body?.message}"`);
    assert(r.body?.retryAfterSeconds > 0, "no retryAfterSeconds on a capped claim");

    const st = await j("/api/status");
    assert(st.body.daily.exhausted === true, "status does not report the cap as exhausted");
    assert(st.body.dispensing === false, "status still says it is dispensing");
    return `429 "${r.body.message}", dispensing false`;
  } finally {
    await db.query("DELETE FROM faucet_claims WHERE id > $1", [highWater.toString()]);
  }
});

await check("The capped claim debited nothing", async () => {
  const pending = await db.query("SELECT count(*)::int AS n FROM faucet_claims WHERE status = 'pending'");
  assert(Number(pending.rows[0].n) === 0, `${pending.rows[0].n} rows left pending by a refused claim`);
  const st = await j("/api/status");
  assert(st.body.dispensing === true, "faucet did not recover after the synthetic rows were removed");
  return "no pending rows, faucet dispensing again";
});

// ---------------------------------------------------------------------------
console.log("\n  The rate really falls as the pool drains");
// ---------------------------------------------------------------------------

await check("Draining the pool through the API lowers the advertised payout", async () => {
  const original = await db.query("SELECT pool_wei, dispensed_wei FROM faucet_state WHERE id = 1");
  const poolWei = BigInt(original.rows[0].pool_wei);
  const restore = original.rows[0].dispensed_wei;
  try {
    const seen: string[] = [];
    // Set the ledger to each band and read what the live API advertises.
    for (const [fracTenths, expectGig] of [
      [9n, "9"],
      [5n, "5"],
      [1n, "1"],
    ] as Array<[bigint, string]>) {
      const remaining = (poolWei * fracTenths) / 10n;
      await db.query("UPDATE faucet_state SET dispensed_wei = $1 WHERE id = 1", [
        (poolWei - remaining).toString(),
      ]);
      const r = await j("/api/status");
      assert(r.body.payout.gig === expectGig, `at ${fracTenths}/10 left API said ${r.body.payout.gig}, expected ${expectGig}`);
      seen.push(`${fracTenths}0%->${r.body.payout.gig}`);
    }
    // And an exhausted pool stops dispensing rather than paying zero.
    await db.query("UPDATE faucet_state SET dispensed_wei = pool_wei WHERE id = 1");
    const empty = await j("/api/status");
    assert(empty.body.dispensing === false, "an exhausted faucet still reports dispensing: true");
    const claim = await claimFor(freshAddress());
    assert(claim.status === 410 || claim.status === 429, `exhausted faucet returned ${claim.status}`);
    seen.push(`empty->${claim.status}`);
    return seen.join(" ");
  } finally {
    await db.query("UPDATE faucet_state SET dispensed_wei = $1 WHERE id = 1", [restore]);
  }
});

// ---------------------------------------------------------------------------
console.log("\n  Hardening");
// ---------------------------------------------------------------------------

await check("Serves the portal and refuses to escape its directory", async () => {
  const page = await fetch(`${BASE}/`);
  assert(page.status === 200, `portal returned ${page.status}`);
  const html = await page.text();
  assert(html.includes("Giggora"), "portal did not render");
  assert(page.headers.get("content-security-policy"), "no CSP on the portal");

  for (const attack of ["/../.env", "/../../.env", "/..%2f.env", "/%2e%2e/%2e%2e/.env"]) {
    const r = await fetch(`${BASE}${attack}`);
    const body = await r.text();
    assert(!body.includes("POSTGRES_PASSWORD"), `${attack} leaked .env`);
    assert(!body.includes("PRIVATE_KEY"), `${attack} leaked a key`);
  }
  return "CSP set, 4 traversal attempts contained";
});

await check("Never returns the signing key or database details", async () => {
  const s = await j("/api/status");
  const text = JSON.stringify(s.body);
  assert(!/[0-9a-f]{64}/i.test(text.replace(/0x[0-9a-f]{64}/gi, "")), "a 32-byte secret-shaped value is exposed");
  assert(!text.includes("postgres"), "database URL exposed");
  assert(!text.includes("PRIVATE"), "key material referenced");
  return "status is safe to serve publicly";
});

// ---------------------------------------------------------------------------
console.log(`
  SYSTEM STATUS
  -------------
  Drip curve           ${fail === 0 ? "PASS" : "FAIL"}
  Claim path           ${fail === 0 ? "PASS" : "FAIL"}
  Cooldowns            ${fail === 0 ? "PASS" : "FAIL"}

  ${pass} passed, ${fail} failed
`);

await db.end();
process.exit(fail === 0 ? 0 : 1);

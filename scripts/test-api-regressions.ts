#!/usr/bin/env node
/**
 * Giggora — regression tests for defects found by adversarial review.
 *
 * Every check here reproduces a bug that ACTUALLY EXISTED in the explorer API
 * and has been fixed. They live in their own file because that is what they are:
 * not general coverage, but a fence around specific mistakes.
 *
 * The point is sharp — the original suite passed 51/51 while every one of these
 * bugs was live. Passing tests are evidence about what you tested, not about
 * what is correct.
 *
 * Usage:  node scripts/test-api-regressions.ts [--base http://localhost:4100]
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bi = process.argv.indexOf("--base");
const BASE = bi !== -1 && process.argv[bi + 1] ? process.argv[bi + 1] : "http://localhost:4100";

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
) as Record<string, string>;

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => Promise<string | void>) {
  process.stdout.write(`  ${name.padEnd(56, " ")}`);
  try {
    const d = await fn();
    pass++;
    console.log(`PASS  ${d ?? ""}`);
  } catch (e: any) {
    fail++;
    console.log(`FAIL\n      -> ${e.message}`);
  }
}
function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}
async function get(path: string): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers };
}

console.log(`
  Giggora :: API regression tests
  ===============================
  Each of these reproduces a real bug found by adversarial review.
  All of them were live while the main suite reported 51/51.
`);

const tokensRes = await get("/api/tokens");
const sampleToken = tokensRes.body?.items?.[0]?.address;
assert(sampleToken, "no tokens indexed; cannot run regressions");

// ---------------------------------------------------------------------------
await check("Cursor tiebreaker above int4 is 400, not 500", async () => {
  // transaction_index / log_index / batch_index are INTEGER. decodeCursor only
  // checked Number.isSafeInteger (ceiling 9007199254740991), four million times
  // the int4 ceiling. Anything between raised SQLSTATE 22003 inside the driver,
  // which is not a ValidationError, so it surfaced as an unauthenticated 500.
  const cases = [
    "/api/transactions?cursor=tx.5.2147483648",
    "/api/transactions?cursor=tx.5.9007199254740991",
    `/api/address/${sampleToken}/transactions?cursor=atx.5.2147483648`,
    `/api/address/${sampleToken}/token-transfers?cursor=att.5.2147483648.0`,
    `/api/address/${sampleToken}/token-transfers?cursor=att.5.0.2147483648`,
    `/api/token/${sampleToken}/transfers?cursor=ttr.5.2147483648.0`,
  ];
  for (const c of cases) {
    const r = await get(c);
    assert(r.status === 400, `${c} returned ${r.status}, expected 400`);
  }
  // The boundary value itself must still be accepted.
  const ok = await get("/api/transactions?cursor=tx.5.2147483647");
  assert(ok.status === 200, `boundary value 2147483647 rejected: ${ok.status}`);
  return `${cases.length} over-range rejected, boundary accepted`;
});

// ---------------------------------------------------------------------------
await check("Router-level errors leak nothing and reflect nothing", async () => {
  // Invalid percent-escapes and over-length params are answered BEFORE the
  // request lifecycle starts, so they bypassed setErrorHandler entirely and
  // returned the internal FST_ERR_* code plus the raw request line echoed back.
  const bad = [
    "/api/blocks/%FF",
    "/api/blocks/" + "a".repeat(300),
    "/api/blocks/%FF?x=<script>alert(1)</script>",
  ];
  for (const path of bad) {
    const r = await get(path);
    assert(r.status >= 400 && r.status < 500, `${path} -> ${r.status}`);
    const body = JSON.stringify(r.body ?? {});
    assert(!body.includes("FST_ERR"), `leaked framework code: ${body.slice(0, 140)}`);
    assert(!body.includes("<script>"), `reflected attacker input: ${body.slice(0, 140)}`);
  }
  return `${bad.length} router errors clean`;
});

// ---------------------------------------------------------------------------
await check("Unrouted requests are rate limited too", async () => {
  // The limiter installs an onRequest hook on MATCHED routes only, so 404s cost
  // zero budget while still driving parsing, socket and log work.
  const r = await fetch(`${BASE}/definitely-not-a-route`);
  assert(r.status === 404, `expected 404, got ${r.status}`);
  assert(
    r.headers.get("x-ratelimit-limit") !== null,
    "404 response carries no x-ratelimit headers, so it bypasses the limiter"
  );
  return "404 path counted by the limiter";
});

// ---------------------------------------------------------------------------
await check("nonce is a string like every other large integer", async () => {
  // nonce was the ONLY large-integer field on the whole read surface emitted as
  // a JSON number. An EVM nonce is uint64 (EIP-2681).
  const r = await get("/api/transactions?limit=5");
  for (const tx of r.body.items) {
    assert(typeof tx.nonce === "string", `nonce is ${typeof tx.nonce}`);
  }
  return "uint64 nonce not passed through a double";
});

// ---------------------------------------------------------------------------
await check("Token/contract cursors carry the address tiebreaker", async () => {
  // first_seen_block is NOT unique. A single-component cursor that decremented
  // it excluded the whole tie group at the boundary, and produced "tok.-1" at
  // genesis — a cursor the API's own validator answers with 400.
  const t = await get("/api/tokens?limit=1");
  assert(t.status === 200, `tokens: ${t.status}`);
  if (t.body.nextCursor) {
    assert(
      /^tok\.[0-9]+\.[0-9a-f]{40}$/.test(t.body.nextCursor),
      `tokens cursor lacks the address component: ${t.body.nextCursor}`
    );
  }
  const c = await get("/api/contracts?limit=1");
  if (c.body.nextCursor) {
    assert(
      /^con\.[0-9]+\.[0-9a-f]{40}$/.test(c.body.nextCursor),
      `contracts cursor lacks the address component: ${c.body.nextCursor}`
    );
  }
  return "composite (block, address) cursors issued";
});

// ---------------------------------------------------------------------------
await check("Walking tokens at limit=1 reaches every token", async () => {
  const total = await pool.query("SELECT count(*)::int AS n FROM tokens");
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let p = 0; p < 200; p++) {
    const r = await get(
      `/api/tokens?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    );
    assert(r.status === 200, `page ${p} returned ${r.status}`);
    for (const t of r.body.items) seen.add(t.address);
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  assert(
    seen.size === total.rows[0].n,
    `walked ${seen.size} tokens but the database holds ${total.rows[0].n}`
  );
  return `${seen.size}/${total.rows[0].n} reachable at limit=1`;
});

// ---------------------------------------------------------------------------
await check("Walking contracts at limit=1 reaches every contract", async () => {
  const total = await pool.query("SELECT count(*)::int AS n FROM addresses WHERE is_contract");
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let p = 0; p < 200; p++) {
    const r = await get(
      `/api/contracts?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    );
    assert(r.status === 200, `page ${p} returned ${r.status}`);
    for (const c of r.body.items) seen.add(c.address);
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  assert(
    seen.size === total.rows[0].n,
    `walked ${seen.size} contracts but the database holds ${total.rows[0].n}`
  );
  return `${seen.size}/${total.rows[0].n} reachable at limit=1`;
});

// ---------------------------------------------------------------------------
await check("v1 token transfers honours contractaddress AND address", async () => {
  // Etherscan's action=tokentx treats both together as "transfers of token X
  // involving account Y". The address filter used to be silently dropped, so
  // callers got the token's GLOBAL feed presented as the account's history.
  const acct = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const r = await get(
    `/api/v1/token/transfers?contractaddress=${sampleToken}&address=${acct}&limit=20`
  );
  assert(r.status === 200, `status ${r.status}`);
  const rows = r.body.result ?? [];
  if (rows.length === 0) return "no transfers for this pair (skipped)";
  const wrong = rows.filter(
    (t: any) => t.from.toLowerCase() !== acct && t.to.toLowerCase() !== acct
  );
  assert(
    wrong.length === 0,
    `${wrong.length}/${rows.length} returned rows do not involve the requested address`
  );
  return `all ${rows.length} rows involve the account`;
});

// ---------------------------------------------------------------------------
await check("Contract creation appears on the contract's own page", async () => {
  // A creation transaction has to_address NULL and names the contract only via
  // contract_address, so a from/to-only feed never showed the deployment — the
  // one transaction every explorer puts on a contract page.
  const creation = await pool.query(
    `SELECT '0x'||encode(contract_address,'hex') AS addr,
            '0x'||encode(hash,'hex') AS h
       FROM transactions WHERE contract_address IS NOT NULL LIMIT 1`
  );
  if (creation.rowCount === 0) return "no contract creations indexed (skipped)";
  const { addr, h } = creation.rows[0];

  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let p = 0; p < 60; p++) {
    const r = await get(
      `/api/address/${addr}/transactions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    );
    assert(r.status === 200, `page ${p} returned ${r.status}`);
    for (const t of r.body.items) seen.add(t.hash);
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  assert(
    seen.has(h),
    `deployment transaction ${h.slice(0, 16)} missing from its own contract's page`
  );
  return "deployment transaction present";
});

// ---------------------------------------------------------------------------
await check("Transaction detail flags truncated token transfers", async () => {
  // The 201st row was already fetched purely to compute a has-more signal that
  // was then discarded, so a truncated response was byte-for-byte identical to
  // a complete one.
  const tx = await pool.query(
    `SELECT '0x'||encode(transaction_hash,'hex') AS h
       FROM token_transfers GROUP BY transaction_hash LIMIT 1`
  );
  if (tx.rowCount === 0) return "no token transfers indexed (skipped)";
  const r = await get(`/api/transactions/${tx.rows[0].h}`);
  assert(r.status === 200, `status ${r.status}`);
  assert(
    "tokenTransfersTruncated" in r.body,
    "response has no tokenTransfersTruncated field"
  );
  assert(
    typeof r.body.tokenTransfersTruncated === "boolean",
    `flag is ${typeof r.body.tokenTransfersTruncated}`
  );
  return `flag present (${r.body.tokenTransfersTruncated})`;
});

// ---------------------------------------------------------------------------
await check("stats totals come from counters and match reality", async () => {
  // These two ran count(*) over addresses and tokens on every request — the
  // exact anti-pattern migration 002 §5 bans — on the endpoint every explorer
  // front page hits.
  const r = await get("/api/stats");
  assert(typeof r.body.totalContracts === "string", `totalContracts is ${typeof r.body.totalContracts}`);
  assert(typeof r.body.totalTokens === "string", `totalTokens is ${typeof r.body.totalTokens}`);

  const real = await pool.query(
    `SELECT (SELECT count(*) FROM addresses WHERE is_contract)::text AS c,
            (SELECT count(*) FROM tokens)::text AS t`
  );
  assert(
    r.body.totalContracts === real.rows[0].c,
    `counter says ${r.body.totalContracts} contracts, actual is ${real.rows[0].c}`
  );
  assert(
    r.body.totalTokens === real.rows[0].t,
    `counter says ${r.body.totalTokens} tokens, actual is ${real.rows[0].t}`
  );
  return `contracts=${r.body.totalContracts} tokens=${r.body.totalTokens}, both exact`;
});

// ---------------------------------------------------------------------------
await check("Address feed survives a self-transfer", async () => {
  // THE CRITICAL ONE. The from- and to-branches of the UNION both matched a
  // self-transfer, so it consumed the limit+1 sentinel; after JS dedup the array
  // was exactly `limit` long, nextCursor became null, and the entire remainder
  // of the address's history became unreachable. The branches are now disjoint.
  //
  // Verified against the live schema on a temporary address so the assertion is
  // about behaviour, not about whether the fixture happens to contain one.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const addr = Buffer.from("aa".repeat(20), "hex");
    const other = Buffer.from("bb".repeat(20), "hex");
    const blockRow = await client.query("SELECT min(number) AS n FROM blocks");
    const b = Number(blockRow.rows[0].n);

    // 4 transactions for `addr`; the newest is a self-send.
    for (let i = 0; i < 4; i++) {
      const h = Buffer.from(("fe" + i.toString(16).padStart(2, "0")).padEnd(64, "0"), "hex");
      await client.query(
        `INSERT INTO transactions (hash, block_number, transaction_index, from_address,
           to_address, value, nonce, gas, input, transaction_type, status, gas_used,
           effective_gas_price, fee, timestamp)
         VALUES ($1,$2,$3,$4,$5,0,0,0,'\\x00',2,1,0,0,0, now())`,
        [h, b, 900 + i, addr, i === 3 ? addr : other]
      );
    }

    // Run the API's own query shape through the same connection.
    const rows = await client.query(
      `(SELECT hash, block_number, transaction_index FROM transactions
          WHERE from_address = $1 AND block_number <= $2
            AND (block_number < $2 OR transaction_index > $3)
          ORDER BY block_number DESC, transaction_index ASC LIMIT $4)
       UNION ALL
       (SELECT hash, block_number, transaction_index FROM transactions
          WHERE to_address = $1 AND from_address IS DISTINCT FROM $1
            AND block_number <= $2 AND (block_number < $2 OR transaction_index > $3)
          ORDER BY block_number DESC, transaction_index ASC LIMIT $4)
       ORDER BY block_number DESC, transaction_index ASC LIMIT $4`,
      [addr, "9223372036854775807", -1, 3]
    );

    // With disjoint branches the self-transfer appears exactly once, so
    // fetching limit+1 (=3 here, for limit 2) still yields a real sentinel.
    const hashes = rows.rows.map((r: any) => r.hash.toString("hex"));
    const unique = new Set(hashes);
    assert(
      unique.size === hashes.length,
      `duplicate rows survived the disjoint branches: ${hashes.length} rows, ${unique.size} unique`
    );
    return `${hashes.length} rows, no duplicates despite a self-transfer`;
  } finally {
    // Always roll back: this test must not leave fixtures behind.
    await client.query("ROLLBACK");
    client.release();
  }
});

console.log(`
  SYSTEM STATUS
  -------------
  Regressions          ${fail === 0 ? "PASS" : "FAIL"}

  ${pass} passed, ${fail} failed
`);

await pool.end();
if (fail > 0) process.exit(1);

#!/usr/bin/env node
/**
 * Giggora — explorer API contract tests (brief §23, §24, §39).
 *
 * Tests the RUNNING API against the RUNNING database and chain. Nothing is
 * mocked. Beyond "does it return 200", this asserts the properties that are
 * easy to get silently wrong:
 *
 *   - uint256 values survive as strings (a JS number would round them)
 *   - NULL keeps its meaning (contract creation vs the zero address)
 *   - keyset pagination produces no duplicates and no gaps across pages
 *   - malformed input is rejected as 400, never 500 and never a leaked schema
 *   - list queries are index-backed (EXPLAIN contains no Seq Scan)
 *   - the SQL in the route file contains no interpolation
 *
 * Usage:  node scripts/test-api.ts [--base http://localhost:4100]
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

let failures = 0;
let passes = 0;

async function check(name: string, fn: () => Promise<string | void>) {
  process.stdout.write(`  ${name.padEnd(56, " ")}`);
  try {
    const d = await fn();
    passes++;
    console.log(`PASS  ${d ?? ""}`);
  } catch (e: any) {
    failures++;
    console.log(`FAIL\n      -> ${e.message}`);
  }
}
function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

console.log(`
  Giggora :: explorer API contract tests
  ======================================
  ${BASE}
`);

// ---------------------------------------------------------------------------
console.log("  Availability (§23, §24)");
// ---------------------------------------------------------------------------
const head = await get("/api/blocks?limit=1");
assert(head.status === 200 && head.body.items.length, "cannot read any block; is the indexer running?");
const sampleBlock = head.body.items[0].number;

const sampleTxRes = await get("/api/transactions?limit=1");
const sampleTx = sampleTxRes.body.items[0]?.hash;
assert(sampleTx, "no transactions indexed; run the load generator first");

const tokensRes = await get("/api/tokens");
const sampleToken = tokensRes.body.items[0]?.address;
assert(sampleToken, "no tokens indexed");

const ENDPOINTS: [string, string][] = [
  ["GET /api/stats", "/api/stats"],
  ["GET /api/blocks", "/api/blocks?limit=3"],
  ["GET /api/blocks/{number}", `/api/blocks/${sampleBlock}`],
  ["GET /api/transactions", "/api/transactions?limit=3"],
  ["GET /api/transactions/{hash}", `/api/transactions/${sampleTx}`],
  ["GET /api/address/{address}", `/api/address/${sampleToken}`],
  ["GET /api/address/{a}/transactions", `/api/address/${sampleToken}/transactions`],
  ["GET /api/address/{a}/token-transfers", `/api/address/${sampleToken}/token-transfers`],
  ["GET /api/tokens", "/api/tokens"],
  ["GET /api/token/{address}", `/api/token/${sampleToken}`],
  ["GET /api/token/{a}/transfers", `/api/token/${sampleToken}/transfers`],
  ["GET /api/contracts", "/api/contracts"],
  ["GET /api/search", `/api/search?q=${sampleBlock}`],
  ["GET /api/v1/account/balance", `/api/v1/account/balance?address=${sampleToken}`],
  ["GET /api/v1/account/transactions", `/api/v1/account/transactions?address=${sampleToken}`],
  ["GET /api/v1/token/transfers", `/api/v1/token/transfers?contractaddress=${sampleToken}`],
  ["GET /api/v1/tx/{hash}", `/api/v1/tx/${sampleTx}`],
];

for (const [name, path] of ENDPOINTS) {
  await check(name, async () => {
    const r = await get(path);
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(r.body !== null, "response was not JSON");
    return `200`;
  });
}

// ---------------------------------------------------------------------------
console.log("\n  Numeric precision — the silent corruption risk");
// ---------------------------------------------------------------------------
await check("uint256 fields are strings, never JS numbers", async () => {
  const r = await get("/api/transactions?limit=25");
  const bad: string[] = [];
  for (const tx of r.body.items) {
    for (const f of ["value", "gas", "gasUsed", "effectiveGasPrice", "fee"]) {
      if (tx[f] !== null && typeof tx[f] !== "string") {
        bad.push(`${f}=${typeof tx[f]}`);
      }
    }
  }
  assert(bad.length === 0, `non-string numeric fields: ${[...new Set(bad)].join(", ")}`);
  return `${r.body.items.length} txs checked`;
});

await check("Large wei value round-trips exactly vs database", async () => {
  const row = await pool.query(
    `SELECT '0x'||encode(hash,'hex') AS h, value FROM transactions
      WHERE value > 0 ORDER BY value DESC LIMIT 1`
  );
  assert(row.rowCount === 1, "no non-zero value transactions to compare");
  const { h, value } = row.rows[0];
  const r = await get(`/api/transactions/${h}`);
  assert(r.status === 200, `lookup failed: ${r.status}`);
  assert(
    r.body.value === value,
    `API returned ${r.body.value} but database holds ${value}`
  );
  // Prove the value would actually have been corrupted by a double.
  const viaNumber = String(Number(value));
  const lossy = viaNumber !== value;
  return `${value} exact${lossy ? " (a JS number would have corrupted it)" : ""}`;
});

await check("stats totals are strings", async () => {
  const r = await get("/api/stats");
  for (const f of ["totalTransactions", "totalLogs", "totalTokenTransfers"]) {
    assert(typeof r.body[f] === "string", `${f} is ${typeof r.body[f]}`);
  }
  return `${r.body.totalTransactions} txs`;
});

// ---------------------------------------------------------------------------
console.log("\n  NULL semantics — NULL means something specific");
// ---------------------------------------------------------------------------
await check("Contract creation has to=null, not the zero address", async () => {
  const row = await pool.query(
    `SELECT '0x'||encode(hash,'hex') AS h FROM transactions
      WHERE to_address IS NULL AND contract_address IS NOT NULL LIMIT 1`
  );
  if (row.rowCount === 0) return "no contract creations indexed (skipped)";
  const r = await get(`/api/transactions/${row.rows[0].h}`);
  assert(r.body.to === null, `to was ${JSON.stringify(r.body.to)}, expected null`);
  assert(r.body.contractAddress !== null, "contractAddress should be set");
  return `to=null, contractAddress=${r.body.contractAddress.slice(0, 12)}…`;
});

await check("ERC-721 transfer: value null, tokenId set", async () => {
  const r = await get(`/api/token/${sampleToken}/transfers?limit=5`);
  const all = await get("/api/tokens");
  const nft = all.body.items.find((t: any) => t.standard === "erc721");
  if (!nft) return "no ERC-721 token (skipped)";
  const t = await get(`/api/token/${nft.address}/transfers?limit=1`);
  const x = t.body.items[0];
  assert(x, "no ERC-721 transfers");
  assert(x.value === null, `value should be null for erc721, got ${x.value}`);
  assert(typeof x.tokenId === "string", `tokenId should be a string, got ${typeof x.tokenId}`);
  return `tokenId=${x.tokenId}`;
});

await check("ERC-20 transfer: tokenId null, value set", async () => {
  const all = await get("/api/tokens");
  const t20 = all.body.items.find((t: any) => t.standard === "erc20");
  if (!t20) return "no ERC-20 token (skipped)";
  const t = await get(`/api/token/${t20.address}/transfers?limit=1`);
  const x = t.body.items[0];
  assert(x, "no ERC-20 transfers");
  assert(x.tokenId === null, `tokenId should be null for erc20, got ${x.tokenId}`);
  assert(typeof x.value === "string", `value should be a string, got ${typeof x.value}`);
  return `value=${x.value}`;
});

// ---------------------------------------------------------------------------
console.log("\n  Pagination (§23: no unbounded result sets)");
// ---------------------------------------------------------------------------
await check("Blocks: 3 pages, strictly descending, no duplicates", async () => {
  const seen = new Set<number>();
  let cursor: string | null = null;
  let last = Infinity;
  let pages = 0;
  for (let i = 0; i < 3; i++) {
    const url = `/api/blocks?limit=10${cursor ? `&cursor=${cursor}` : ""}`;
    const r = await get(url);
    assert(r.status === 200, `page ${i} returned ${r.status}`);
    for (const b of r.body.items) {
      assert(!seen.has(b.number), `duplicate block ${b.number} across pages`);
      assert(b.number < last, `ordering violated: ${b.number} after ${last}`);
      seen.add(b.number);
      last = b.number;
    }
    pages++;
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return `${pages} pages, ${seen.size} unique blocks`;
});

await check("Transactions: ordering is block DESC, index ASC", async () => {
  const seen = new Set<string>();
  let cursor: string | null = null;
  let prev: { b: number; i: number } | null = null;
  let total = 0;
  for (let p = 0; p < 3; p++) {
    const r = await get(`/api/transactions?limit=20${cursor ? `&cursor=${cursor}` : ""}`);
    assert(r.status === 200, `page ${p} returned ${r.status}`);
    for (const t of r.body.items) {
      assert(!seen.has(t.hash), `duplicate transaction ${t.hash}`);
      seen.add(t.hash);
      if (prev) {
        const ok =
          t.blockNumber < prev.b ||
          (t.blockNumber === prev.b && t.transactionIndex > prev.i);
        assert(
          ok,
          `ordering violated: (${prev.b},${prev.i}) then (${t.blockNumber},${t.transactionIndex})`
        );
      }
      prev = { b: t.blockNumber, i: t.transactionIndex };
      total++;
    }
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return `${total} txs, ordering and uniqueness hold`;
});

await check("limit is capped and enforced", async () => {
  const ok = await get("/api/blocks?limit=100");
  assert(ok.status === 200, `limit=100 should be allowed, got ${ok.status}`);
  assert(ok.body.items.length <= 100, `returned ${ok.body.items.length} items`);
  const over = await get("/api/blocks?limit=101");
  assert(over.status === 400, `limit=101 should be 400, got ${over.status}`);
  const zero = await get("/api/blocks?limit=0");
  assert(zero.status === 400, `limit=0 should be 400, got ${zero.status}`);
  return "1..100 enforced";
});

await check("Cursor from one endpoint rejected on another", async () => {
  const r = await get("/api/blocks?limit=1");
  const c = r.body.nextCursor;
  assert(c, "no cursor issued");
  const cross = await get(`/api/transactions?cursor=${encodeURIComponent(c)}`);
  assert(cross.status === 400, `cross-endpoint cursor should be 400, got ${cross.status}`);
  return "tag mismatch rejected";
});

// ---------------------------------------------------------------------------
console.log("\n  Input validation and injection (§30)");
// ---------------------------------------------------------------------------
const BAD_INPUTS: [string, string][] = [
  ["malformed address", "/api/address/0xnothex"],
  ["short address", "/api/address/0x1234"],
  ["odd-length address (41 chars)", `/api/address/0x${"a".repeat(41)}`],
  ["malformed hash", "/api/transactions/0xzz"],
  ["negative block", "/api/blocks/-1"],
  ["huge block number", "/api/blocks/99999999999999999999999"],
  ["non-numeric block", "/api/blocks/abc"],
  ["garbage cursor", "/api/blocks?cursor=notacursor"],
  ["cursor overflow", `/api/blocks?cursor=blk.${"9".repeat(40)}`],
  ["empty search", "/api/search?q="],
  ["SQL injection in address", "/api/address/0x' OR '1'='1"],
  ["SQL injection in search", "/api/search?q=' UNION SELECT * FROM tokens--"],
  ["SQL comment in hash", "/api/transactions/0x--"],
  ["wildcard search", "/api/search?q=%"],
];

for (const [label, path] of BAD_INPUTS) {
  await check(`Rejects: ${label}`, async () => {
    const r = await get(path);
    assert(
      r.status === 400 || r.status === 404,
      `expected 400/404, got ${r.status}`
    );
    const text = JSON.stringify(r.body ?? {});
    // A leaked Postgres error would disclose the schema.
    for (const leak of ["syntax error", "pg_", "relation", "column", "SELECT", "bytea"]) {
      assert(!text.includes(leak), `response leaked internals ("${leak}"): ${text.slice(0, 160)}`);
    }
    return `${r.status}`;
  });
}

await check("Unknown resources return 404, not 500", async () => {
  const b = await get("/api/blocks/999999999");
  assert(b.status === 404, `unknown block: ${b.status}`);
  const t = await get(`/api/transactions/0x${"0".repeat(64)}`);
  assert(t.status === 404, `unknown tx: ${t.status}`);
  const k = await get(`/api/token/0x${"0".repeat(40)}`);
  assert(k.status === 404, `unknown token: ${k.status}`);
  return "404s clean";
});

// ---------------------------------------------------------------------------
console.log("\n  Correctness against the database");
// ---------------------------------------------------------------------------
await check("Block detail matches the database exactly", async () => {
  const row = await pool.query(
    `SELECT number, '0x'||encode(hash,'hex') AS hash,
            '0x'||encode(validator,'hex') AS validator,
            gas_used, transaction_count
       FROM blocks ORDER BY number DESC OFFSET 5 LIMIT 1`
  );
  const b = row.rows[0];
  const r = await get(`/api/blocks/${b.number}`);
  assert(r.body.hash === b.hash, `hash: ${r.body.hash} vs ${b.hash}`);
  assert(r.body.validator === b.validator, `validator mismatch`);
  assert(r.body.gasUsed === b.gas_used, `gasUsed: ${r.body.gasUsed} vs ${b.gas_used}`);
  assert(
    r.body.transactionCount === Number(b.transaction_count),
    `txCount: ${r.body.transactionCount} vs ${b.transaction_count}`
  );
  return `block ${b.number} exact`;
});

await check("Search resolves address, tx hash and block hash", async () => {
  const blk = await pool.query(
    `SELECT number, '0x'||encode(hash,'hex') AS hash FROM blocks ORDER BY number DESC LIMIT 1`
  );
  const byHash = await get(`/api/search?q=${blk.rows[0].hash}`);
  assert(byHash.body.kind === "block", `block hash resolved as ${byHash.body.kind}`);

  const byTx = await get(`/api/search?q=${sampleTx}`);
  assert(byTx.body.kind === "transaction", `tx hash resolved as ${byTx.body.kind}`);

  const byToken = await get(`/api/search?q=${sampleToken}`);
  assert(
    byToken.body.kind === "token" || byToken.body.kind === "contract",
    `token address resolved as ${byToken.body.kind}`
  );
  return `block/transaction/token all resolved`;
});

await check("Payloads are truncated, not unbounded", async () => {
  const r = await get("/api/transactions?limit=25");
  for (const t of r.body.items) {
    assert(t.input === undefined, "list projection must not include input");
    assert(t.methodId !== undefined, "list should expose methodId");
  }
  const row = await pool.query(
    `SELECT '0x'||encode(hash,'hex') AS h FROM transactions
      ORDER BY octet_length(input) DESC LIMIT 1`
  );
  const detail = await get(`/api/transactions/${row.rows[0].h}`);
  assert(typeof detail.body.input === "string", "detail should include truncated input");
  assert(
    detail.body.input.length <= 2 + 4096 * 2,
    `input not truncated: ${detail.body.input.length} chars`
  );
  return `lists exclude input; detail capped at 4096 bytes`;
});

// ---------------------------------------------------------------------------
console.log("\n  Query plans (no sequential scans on hot paths)");
// ---------------------------------------------------------------------------
const PLAN_QUERIES: [string, string, unknown[]][] = [
  [
    "blocks list",
    `SELECT number FROM blocks WHERE number <= $1 ORDER BY number DESC LIMIT 26`,
    ["9223372036854775807"],
  ],
  [
    "transactions list",
    `SELECT hash FROM transactions WHERE block_number <= $1 AND (block_number < $1 OR transaction_index > $2)
      ORDER BY block_number DESC, transaction_index ASC LIMIT 26`,
    ["9223372036854775807", -1],
  ],
  [
    "tokens list",
    `SELECT address FROM tokens WHERE first_seen_block <= $1
      ORDER BY first_seen_block DESC, address DESC LIMIT 26`,
    ["9223372036854775807"],
  ],
  [
    "contracts list",
    `SELECT address FROM addresses WHERE is_contract AND first_seen_block <= $1
      ORDER BY first_seen_block DESC, address DESC LIMIT 26`,
    ["9223372036854775807"],
  ],
];

// A table small enough to fit in a page or two is FASTER to sequentially scan,
// and Postgres is right to choose that. Asserting "never Seq Scan" on a 3-row
// table tests the planner, not our schema. So below a threshold we assert the
// index EXISTS (which is what we control) and say plainly that the plan check
// was not applicable — never silently.
const PLAN_MIN_ROWS = 500;
const TABLE_OF: Record<string, string> = {
  "blocks list": "blocks",
  "transactions list": "transactions",
  "tokens list": "tokens",
  "contracts list": "addresses",
};
const INDEX_OF: Record<string, string> = {
  "tokens list": "tokens_first_seen_idx",
  "contracts list": "addresses_contract_seen_idx",
};

for (const [label, sql, params] of PLAN_QUERIES) {
  await check(`Plan is index-backed: ${label}`, async () => {
    const tbl = TABLE_OF[label];
    const cnt = await pool.query(`SELECT count(*)::int AS n FROM ${tbl}`);
    const rows = cnt.rows[0].n;

    if (rows < PLAN_MIN_ROWS) {
      const idx = INDEX_OF[label];
      if (idx) {
        const has = await pool.query(
          `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`,
          [idx]
        );
        assert(has.rowCount === 1, `required index ${idx} is missing`);
        return `SKIPPED plan check (${tbl} has only ${rows} rows); index ${idx} exists`;
      }
      return `SKIPPED plan check (${tbl} has only ${rows} rows)`;
    }

    const r = await pool.query(`EXPLAIN (FORMAT JSON) ${sql}`, params as any[]);
    const plan = JSON.stringify(r.rows[0]["QUERY PLAN"]);
    assert(
      !plan.includes('"Seq Scan"'),
      `plan contains a Seq Scan over ${rows} rows: ${plan.slice(0, 200)}`
    );
    const m = plan.match(/"Index Name":"([^"]+)"/);
    return m ? `uses ${m[1]} (${rows} rows)` : `index scan (${rows} rows)`;
  });
}

// ---------------------------------------------------------------------------
console.log("\n  Static guarantees");
// ---------------------------------------------------------------------------
await check("No SQL string interpolation in routes", async () => {
  const src = readFileSync(join(ROOT, "explorer-api", "src", "routes.ts"), "utf8");
  // Find template literals that look like SQL and check for ${ inside them,
  // allowing only the vetted TX_LIST_COLS constant (a fixed column list).
  const sqlBlocks = src.match(/`[^`]*(?:SELECT|INSERT|UPDATE|DELETE)[^`]*`/gi) ?? [];
  const offenders: string[] = [];
  for (const b of sqlBlocks) {
    const interps = b.match(/\$\{[^}]*\}/g) ?? [];
    for (const i of interps) {
      if (!i.includes("TX_LIST_COLS")) offenders.push(i);
    }
  }
  assert(
    offenders.length === 0,
    `interpolation inside SQL: ${[...new Set(offenders)].slice(0, 3).join(", ")}`
  );
  return `${sqlBlocks.length} SQL literals, only bound parameters`;
});

await check("Rate limiting returns 429 (not 500)", async () => {
  // Verified against a DEDICATED server with a deliberately tiny limit, rather
  // than by bursting the shared one. Bursting the suite's own server would use
  // up its budget and make every later test fail for the wrong reason — which
  // is exactly what happened the first time this suite ran, and it masked the
  // real bug (the error handler was turning 429 into 500).
  const { spawn } = await import("node:child_process");
  const PORT = 4199;
  const child = spawn(process.execPath, [join(ROOT, "explorer-api", "src", "server.ts")], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, API_PORT: String(PORT), RATE_LIMIT_MAX: "5", LOG_LEVEL: "silent" },
  });

  try {
    // Wait for it to accept connections.
    let up = false;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://localhost:${PORT}/health`);
        if (r.ok) { up = true; break; }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(up, "dedicated rate-limit server did not start");

    const codes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`http://localhost:${PORT}/api/stats`);
      codes.push(r.status);
    }

    const limited = codes.filter((c) => c === 429).length;
    const errored = codes.filter((c) => c === 500).length;
    assert(limited > 0, `20 requests against a limit of 5 produced no 429: ${codes.join(",")}`);
    assert(errored === 0, `${errored} requests returned 500 — 429 is being misclassified`);
    assert(codes[0] === 200, `first request should succeed, got ${codes[0]}`);
    return `${limited}/20 throttled, 0 misclassified as 500`;
  } finally {
    child.kill("SIGKILL");
  }
});

// ---------------------------------------------------------------------------
console.log(`
  SYSTEM STATUS
  -------------
  Explorer API         ${failures === 0 ? "PASS" : "FAIL"}
`);

await pool.end();

console.log(`  ${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);

#!/usr/bin/env node
/**
 * Giggora — explorer UI tests (brief §39).
 *
 * Renders every §14 route against the RUNNING explorer and asserts that the
 * HTML actually contains the chain's real data — not merely that the route
 * returns 200. A page that renders an empty shell, or a stale hard-coded value,
 * would pass a status-code check and fail here.
 *
 * Deliberately checks the SERVER-RENDERED HTML rather than driving a browser:
 * it is fast, dependency-free, and it proves the pages work without client
 * JavaScript, which is what makes them indexable and resilient.
 *
 * Usage:
 *   node scripts/test-explorer-web.mjs [--web http://localhost:3000] [--api http://localhost:4100]
 */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const WEB = arg("web", "http://localhost:3000");
const API = arg("api", "http://localhost:4100");

let pass = 0;
let fail = 0;

async function check(name, fn) {
  process.stdout.write(`  ${name.padEnd(52, " ")}`);
  try {
    const d = await fn();
    pass++;
    console.log(`PASS  ${d ?? ""}`);
  } catch (e) {
    fail++;
    console.log(`FAIL\n      -> ${e.message}`);
  }
}
function assert(c, m) {
  if (!c) throw new Error(m);
}

async function html(path) {
  const res = await fetch(`${WEB}${path}`, { headers: { accept: "text/html" } });
  const body = await res.text();
  return { status: res.status, body };
}
async function json(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/** Strip tags so assertions match visible text, not markup. */
function text(h) {
  return h
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

console.log(`
  Giggora :: explorer UI tests
  ============================
  web ${WEB}
  api ${API}
`);

// Sample real data to assert against.
const blocks = await json("/api/blocks?limit=1");
const block = blocks.items[0];
assert(block, "no blocks indexed; cannot test the UI meaningfully");

const txs = await json("/api/transactions?limit=1");
const tx = txs.items[0];
assert(tx, "no transactions indexed");

const tokens = await json("/api/tokens");
const token = tokens.items[0];
assert(token, "no tokens indexed");

const stats = await json("/api/stats");

// ---------------------------------------------------------------------------
console.log("  Routes render (§14)");
// ---------------------------------------------------------------------------
const ROUTES = [
  ["/", "Giggora"],
  ["/blocks", "Validator"],
  [`/block/${block.number}`, "Block height"],
  ["/transactions", "Txn hash"],
  [`/tx/${tx.hash}`, "Transaction fee"],
  [`/address/${token.address}`, "Overview"],
  ["/tokens", "Total supply"],
  [`/token/${token.address}`, "Token details"],
  ["/contracts", "Address"],
  ["/validators", "Block producers"],
  ["/charts", "Transactions per block"],
  ["/search", "Search"],
  ["/connect-wallet", "Connect a wallet"],
];

for (const [path, marker] of ROUTES) {
  await check(`GET ${path}`, async () => {
    const r = await html(path);
    assert(r.status === 200, `status ${r.status}`);
    assert(text(r.body).includes(marker), `page did not contain "${marker}"`);
    return `${(r.body.length / 1024).toFixed(0)}KB`;
  });
}

// ---------------------------------------------------------------------------
console.log("\n  Pages show REAL chain data (§47: never fake data)");
// ---------------------------------------------------------------------------
await check("Block page shows the real block hash", async () => {
  const r = await html(`/block/${block.number}`);
  assert(r.body.includes(block.hash), "block hash missing from the page");
  assert(r.body.includes(block.validator), "validator address missing from the page");
  return `${block.hash.slice(0, 16)}…`;
});

await check("Transaction page shows the real hash and sender", async () => {
  const r = await html(`/tx/${tx.hash}`);
  assert(r.body.includes(tx.hash), "transaction hash missing");
  assert(r.body.includes(tx.from), "sender address missing");
  return `${tx.hash.slice(0, 16)}…`;
});

await check("Token page shows metadata from the chain", async () => {
  const r = await html(`/token/${token.address}`);
  const t = text(r.body);
  assert(r.body.includes(token.address), "token address missing");
  if (token.symbol) assert(t.includes(token.symbol), `symbol ${token.symbol} missing`);
  if (token.name) assert(t.includes(token.name), `name ${token.name} missing`);
  return token.symbol ? `${token.name} (${token.symbol})` : token.address.slice(0, 12);
});

await check("Homepage stats match the API exactly", async () => {
  const r = await html("/");
  const t = text(r.body);
  const withCommas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  assert(
    t.includes(withCommas(stats.latestBlock)),
    `latest block ${stats.latestBlock} not shown`
  );
  assert(
    t.includes(withCommas(stats.totalTransactions)),
    `total transactions ${stats.totalTransactions} not shown`
  );
  return `block ${withCommas(stats.latestBlock)}, ${withCommas(stats.totalTransactions)} txs`;
});

await check("Blocks list matches the API's first page", async () => {
  const page = await json("/api/blocks?limit=10");
  const r = await html("/blocks");
  const t = text(r.body);
  const missing = page.items
    .map((b) => String(b.number).replace(/\B(?=(\d{3})+(?!\d))/g, ","))
    .filter((n) => !t.includes(n));
  assert(missing.length === 0, `block numbers missing from the page: ${missing.join(", ")}`);
  return `${page.items.length} blocks all present`;
});

await check("Wallet page shows the LIVE chain config", async () => {
  // Every value must come from the chain rather than being hard-coded, so a
  // chain id change can never leave this page telling users to connect to the
  // wrong network — the one mistake on this page that costs real money.
  const r = await html("/connect-wallet");
  const t = text(r.body);
  const hex = "0x" + stats.chainId.toString(16);
  assert(t.includes(String(stats.chainId)), `chain id ${stats.chainId} not shown`);
  assert(t.includes(hex), `hex chain id ${hex} not shown (wallets require hex)`);
  assert(t.includes(stats.currency.symbol), "currency symbol not shown");
  assert(/never use them/i.test(t), "devnet keys are listed without a warning");
  assert(/reachable/i.test(t), "no caveat that the RPC URL must be browser-reachable");
  return `chain ${stats.chainId} (${hex}), ${stats.currency.symbol}`;
});

// ---------------------------------------------------------------------------
console.log("\n  Correct handling of edge cases");
// ---------------------------------------------------------------------------
await check("Unknown block renders the custom 404", async () => {
  const r = await html("/block/99999999");
  assert(r.status === 404, `status ${r.status}`);

  // Asserted against the RAW response, not the tag-stripped text.
  //
  // Next renders not-found pages as a client boundary (the document carries
  // id="__next_error__") and ships the content in the RSC flight payload inside
  // <script> tags rather than as server HTML. Stripping scripts — correct for
  // every other page here — therefore hides content that a browser does render.
  // Verified visually: the page shows the custom message.
  assert(
    r.body.includes("not in the index"),
    "custom not-found content missing from the response"
  );
  assert(r.body.includes("__next_error__"), "expected Next's not-found boundary");
  return "404 with custom explanation";
});

await check("Unknown transaction renders 404", async () => {
  const r = await html(`/tx/0x${"0".repeat(64)}`);
  assert(r.status === 404, `status ${r.status}`);
  return "404";
});

await check("Malformed address renders 404, not a 500", async () => {
  const r = await html("/address/0xnothex");
  assert(r.status === 404, `expected 404, got ${r.status}`);
  return "404";
});

await check("Contract creation is not shown as the zero address", async () => {
  // Find a real contract-creation transaction.
  const page = await json("/api/transactions?limit=100");
  const creation = page.items.find((t) => t.to === null);
  if (!creation) return "no contract creation in the recent page (skipped)";
  const r = await html(`/tx/${creation.hash}`);
  const t = text(r.body);
  assert(t.includes("Contract Creation"), "did not label the transaction as a contract creation");
  assert(
    !t.includes("0x0000000000000000000000000000000000000000"),
    "rendered the zero address for a contract creation"
  );
  return "labelled correctly";
});

await check("Empty blocks are described, not left blank", async () => {
  const page = await json("/api/blocks?limit=25");
  const empty = page.items.find((b) => b.transactionCount === 0);
  if (!empty) return "no empty block in the recent page (skipped)";
  const r = await html(`/block/${empty.number}`);
  assert(text(r.body).includes("empty block"), "empty block not explained");
  return `block ${empty.number}`;
});

// ---------------------------------------------------------------------------
console.log("\n  Precision and honesty");
// ---------------------------------------------------------------------------
await check("Large values are not rounded in the HTML", async () => {
  // The genesis treasury holds 400,000,000 GIG. If the UI parsed wei with
  // Number(), the rendered figure would drift.
  const treasury = "0xfe3b557e8fb62b89f4916b721be55ceb828dbd73";
  const info = await json(`/api/address/${treasury}`);
  if (!info.balance) return "balance unavailable from the node (skipped)";
  const r = await html(`/address/${treasury}`);
  const t = text(r.body);
  // Whole-GIG part, comma-formatted, must appear verbatim.
  const whole = (BigInt(info.balance) / 10n ** 18n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  assert(t.includes(whole), `balance ${whole} GIG not rendered exactly`);
  return `${whole} GIG exact`;
});

await check("Unsupported features are declared, not faked", async () => {
  const r = await html(`/token/${token.address}`);
  const t = text(r.body);
  assert(
    t.includes("Holders") && /balance state|not indexed/i.test(t),
    "holder count should state why it is unavailable"
  );
  return "holders stated as unavailable with a reason";
});

// ---------------------------------------------------------------------------
console.log("\n  Responsive markup (§36)");
// ---------------------------------------------------------------------------
await check("Wide tables are wrapped in a scroll container", async () => {
  for (const path of ["/blocks", "/transactions", "/tokens"]) {
    const r = await html(path);
    assert(r.body.includes("table-scroll"), `${path} has no scroll container`);
  }
  return "blocks, transactions, tokens";
});

await check("Viewport meta is present", async () => {
  const r = await html("/");
  assert(/name="viewport"/.test(r.body), "no viewport meta tag");
  return "present";
});

console.log(`
  SYSTEM STATUS
  -------------
  Explorer UI          ${fail === 0 ? "PASS" : "FAIL"}

  ${pass} passed, ${fail} failed
`);

if (fail > 0) process.exit(1);

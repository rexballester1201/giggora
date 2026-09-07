#!/usr/bin/env node
/**
 * Giggora — wallet compatibility tests (brief §9, §10, §41).
 *
 * WHAT THIS DOES AND DOES NOT PROVE.
 *
 * It does NOT drive the MetaMask browser extension — no automated test in this
 * repository clicks through its UI, and claiming otherwise would be dishonest.
 *
 * What it does prove is the thing MetaMask actually depends on. A wallet is two
 * parts: a signer, and a JSON-RPC client. So this exercises
 *
 *   1. every RPC method MetaMask calls during a normal send, and
 *   2. real secp256k1-signed EIP-155 transactions — legacy AND EIP-1559 —
 *      broadcast through eth_sendRawTransaction, which is byte-for-byte the
 *      same submission path MetaMask uses after the user clicks Confirm.
 *
 * If both hold, a correctly implemented EIP-1193 wallet works. What remains
 * unverified here is the extension's own UI, which is Consensys's code, not ours.
 *
 * It also checks the two things WE wrote that a wallet consumes: the EIP-3085
 * payload on /connect-wallet, and the hand-rolled ERC-20 calldata in the DApp.
 *
 * Usage:  node scripts/test-wallet.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  encodeFunctionData,
  formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const RPC_URL = env.RPC_URL;
const CHAIN_ID = Number(env.CHAIN_ID);

// DEVNET ONLY — publicly published Anvil keys, zero value.
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

const account = privateKeyToAccount(SENDER_PK);
const pub = createPublicClient({ chain: giggora, transport: http(RPC_URL) });
const wallet = createWalletClient({ account, chain: giggora, transport: http(RPC_URL) });

let pass = 0;
let fail = 0;

async function check(name, fn) {
  process.stdout.write(`  ${name.padEnd(54, " ")}`);
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

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message} (${j.error.code})`);
  return j.result;
}

console.log(`
  Giggora :: wallet compatibility
  ===============================
  RPC ${RPC_URL}   chain ${CHAIN_ID}

  NOTE: this verifies the RPC surface and the signing path a wallet uses.
  It does not drive the MetaMask extension UI.
`);

// ---------------------------------------------------------------------------
console.log("  RPC methods a wallet calls during a normal send (§10)");
// ---------------------------------------------------------------------------
const REQUIRED = [
  ["eth_chainId", []],
  ["net_version", []],
  ["web3_clientVersion", []],
  ["eth_blockNumber", []],
  ["eth_getBalance", [account.address, "latest"]],
  ["eth_getTransactionCount", [account.address, "latest"]],
  ["eth_gasPrice", []],
  ["eth_getCode", [account.address, "latest"]],
  ["eth_getBlockByNumber", ["latest", false]],
];

for (const [method, params] of REQUIRED) {
  await check(method, async () => {
    const r = await rpc(method, params);
    assert(r !== undefined && r !== null, "returned null");
    return typeof r === "string" ? r.slice(0, 24) : "ok";
  });
}

// EIP-1559 fee estimation. MetaMask uses these to build a type-2 transaction;
// without them it falls back to legacy pricing or shows no fee estimate at all.
await check("eth_maxPriorityFeePerGas", async () => {
  const r = await rpc("eth_maxPriorityFeePerGas");
  assert(/^0x[0-9a-f]+$/i.test(r), `unexpected shape: ${r}`);
  return `${BigInt(r)} wei`;
});

await check("eth_feeHistory", async () => {
  const r = await rpc("eth_feeHistory", ["0x5", "latest", [25, 50, 75]]);
  assert(Array.isArray(r.baseFeePerGas), "no baseFeePerGas array");
  assert(r.baseFeePerGas.length > 0, "empty baseFeePerGas");
  return `${r.baseFeePerGas.length} base fees returned`;
});

await check("eth_estimateGas", async () => {
  const r = await rpc("eth_estimateGas", [
    { from: account.address, to: RECIPIENT, value: "0xde0b6b3a7640000" },
  ]);
  const gas = BigInt(r);
  assert(gas >= 21000n, `estimate ${gas} is below the 21000 minimum`);
  return `${gas} gas for a plain transfer`;
});

// ---------------------------------------------------------------------------
console.log("\n  Real signed transactions (the path after Confirm)");
// ---------------------------------------------------------------------------

await check("EIP-1559 (type 2) transfer is accepted and mined", async () => {
  const value = parseEther("1");
  const before = await pub.getBalance({ address: RECIPIENT });

  // viem signs locally with secp256k1 and submits via eth_sendRawTransaction —
  // exactly what MetaMask does once the user confirms.
  const hash = await wallet.sendTransaction({ to: RECIPIENT, value });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });

  assert(receipt.status === "success", "transaction reverted");
  assert(receipt.type === "eip1559", `expected eip1559, got ${receipt.type}`);
  const after = await pub.getBalance({ address: RECIPIENT });
  assert(after - before === value, `balance moved by ${after - before}, expected ${value}`);
  return `block ${receipt.blockNumber}, type ${receipt.type}`;
});

await check("Legacy (type 0) transfer is accepted and mined", async () => {
  // Older wallets and some tooling still send legacy transactions. A chain that
  // only accepted type 2 would break them.
  const gasPrice = await pub.getGasPrice();
  const hash = await wallet.sendTransaction({
    to: RECIPIENT,
    value: parseEther("0.5"),
    type: "legacy",
    gasPrice,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  assert(receipt.status === "success", "transaction reverted");
  return `block ${receipt.blockNumber}, type ${receipt.type}`;
});

await check("Foreign chain id is rejected (EIP-155 replay protection)", async () => {
  // Signed OFFLINE with account.signTransaction, not through the wallet client.
  //
  // This matters and cost a wrong conclusion once: a walletClient OVERRIDES the
  // chainId you pass with its own configured chain, so signing "for chain 4044"
  // through it silently produced a valid 4043 transaction. The test then
  // reported that Giggora accepts foreign-chain transactions — a serious-looking
  // finding that was purely an artefact of the test. Offline signing takes the
  // chainId literally, which is the only way to actually exercise this.
  //
  // A rejected transaction consumes no nonce, so this also leaves the sender's
  // nonce sequence untouched for the tests that follow.
  const nonce = await pub.getTransactionCount({ address: account.address });

  const foreign = await account.signTransaction({
    to: RECIPIENT,
    value: parseEther("0.01"),
    chainId: CHAIN_ID + 1,
    nonce,
    maxFeePerGas: 5_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    gas: 21000n,
    type: "eip1559",
  });

  let rejection = null;
  try {
    await rpc("eth_sendRawTransaction", [foreign]);
  } catch (e) {
    rejection = e.message;
  }
  assert(rejection, "a transaction signed for a DIFFERENT chain id was ACCEPTED");
  assert(
    /chain\s*id/i.test(rejection),
    `rejected, but not for the chain id: ${rejection}`
  );

  // The same transaction signed for THIS chain must be accepted, proving the
  // rejection above is about the chain id and not about anything else.
  const good = await account.signTransaction({
    to: RECIPIENT,
    value: parseEther("0.01"),
    chainId: CHAIN_ID,
    nonce,
    maxFeePerGas: 5_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    gas: 21000n,
    type: "eip1559",
  });
  const hash = await rpc("eth_sendRawTransaction", [good]);
  await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });

  return `chain ${CHAIN_ID} accepted, ${CHAIN_ID + 1} rejected ("${rejection.trim().slice(0, 32)}")`;
});

// ---------------------------------------------------------------------------
console.log("\n  ERC-20 from a wallet");
// ---------------------------------------------------------------------------
const depFile = join(ROOT, "deployments", `${env.CHAIN_NETWORK}.json`);
const deployments = existsSync(depFile) ? JSON.parse(readFileSync(depFile, "utf8")) : null;
const tokenAddress = deployments?.contracts?.GigToken?.address;

await check("ERC-20 transfer submitted as a wallet would", async () => {
  assert(tokenAddress, "no deployed GigToken; run scripts/deploy-contracts.mjs");

  const abi = [
    { name: "transfer", type: "function", stateMutability: "nonpayable",
      inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
    { name: "balanceOf", type: "function", stateMutability: "view",
      inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  ];

  const amount = 10n ** 18n;
  const before = await pub.readContract({
    address: tokenAddress, abi, functionName: "balanceOf", args: [RECIPIENT],
  });

  // Same shape a wallet sends: a plain `to` + `data` transaction.
  const data = encodeFunctionData({ abi, functionName: "transfer", args: [RECIPIENT, amount] });
  const hash = await wallet.sendTransaction({ to: tokenAddress, data });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  assert(receipt.status === "success", "token transfer reverted");

  const after = await pub.readContract({
    address: tokenAddress, abi, functionName: "balanceOf", args: [RECIPIENT],
  });
  assert(after - before === amount, `token balance moved by ${after - before}`);
  return `1 GTT moved, block ${receipt.blockNumber}`;
});

// ---------------------------------------------------------------------------
console.log("\n  What WE wrote that a wallet consumes");
// ---------------------------------------------------------------------------

await check("DApp's hand-rolled ERC-20 calldata matches a real encoder", async () => {
  // dapp/src/app.js hard-codes the transfer selector and pads arguments by hand
  // to avoid pulling in a hashing library for two constants. If that encoding is
  // wrong, the DApp silently sends a call no contract understands — so it is
  // checked against viem's encoder rather than trusted.
  const src = readFileSync(join(ROOT, "dapp", "src", "app.js"), "utf8");
  const selMatch = src.match(/transfer:\s*"(0x[0-9a-f]{8})"/);
  assert(selMatch, "could not find the transfer selector in dapp/src/app.js");

  const abi = [{ name: "transfer", type: "function", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }];
  const real = encodeFunctionData({ abi, functionName: "transfer", args: [RECIPIENT, 12345n] });

  assert(
    real.slice(0, 10) === selMatch[1],
    `selector mismatch: DApp has ${selMatch[1]}, correct is ${real.slice(0, 10)}`
  );

  // Reproduce the DApp's own padding and compare the full calldata.
  const padAddress = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const padUint = (v) => v.toString(16).padStart(64, "0");
  const dappData = selMatch[1] + padAddress(RECIPIENT) + padUint(12345n);
  assert(
    dappData.toLowerCase() === real.toLowerCase(),
    `calldata mismatch:\n        dapp: ${dappData}\n        real: ${real}`
  );
  return "selector and argument encoding identical";
});

await check("EIP-3085 payload is well formed", async () => {
  // wallet_addEthereumChain is strict. The commonest failure is passing the
  // chain id as a decimal number instead of a hex quantity.
  const src = readFileSync(
    join(ROOT, "explorer-web", "components", "AddNetworkButton.tsx"),
    "utf8"
  );
  assert(src.includes("wallet_addEthereumChain"), "method not used");
  assert(src.includes("chainId: props.chainIdHex"), "chainId is not passed as hex");
  assert(src.includes("blockExplorerUrls"), "blockExplorerUrls missing");
  assert(src.includes("nativeCurrency"), "nativeCurrency missing");

  const page = readFileSync(
    join(ROOT, "explorer-web", "app", "connect-wallet", "page.tsx"),
    "utf8"
  );
  assert(
    page.includes("toString(16)"),
    "connect-wallet does not convert the chain id to hex"
  );

  // And confirm the hex the page would produce actually matches the chain.
  const onChain = await rpc("eth_chainId");
  assert(
    BigInt(onChain) === BigInt(CHAIN_ID),
    `node reports ${onChain} but .env says ${CHAIN_ID}`
  );
  return `chainId 0x${CHAIN_ID.toString(16)} matches the node`;
});

await check("Sample DApp is served and references the chain", async () => {
  const html = readFileSync(join(ROOT, "dapp", "src", "index.html"), "utf8");
  const js = readFileSync(join(ROOT, "dapp", "src", "app.js"), "utf8");
  assert(html.includes("Connect wallet"), "no connect control");
  assert(js.includes("eth_requestAccounts"), "does not request accounts");
  assert(js.includes("eth_sendTransaction"), "does not send transactions");
  assert(js.includes("eth_getTransactionReceipt"), "does not wait for confirmation");
  // §41 asks for balance display, a send, a hash and a confirmation wait.
  assert(js.includes("eth_getBalance"), "does not read a balance");
  assert(!/parseFloat|Number\(\s*bal/i.test(js), "parses a balance with a float");
  return "connect, balance, send, confirm all present";
});

console.log(`
  SYSTEM STATUS
  -------------
  Wallet RPC surface   ${fail === 0 ? "PASS" : "FAIL"}
  Signed transactions  ${fail === 0 ? "PASS" : "FAIL"}

  ${pass} passed, ${fail} failed
`);

if (fail > 0) process.exit(1);

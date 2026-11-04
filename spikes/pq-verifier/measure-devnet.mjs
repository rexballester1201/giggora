// Giggora PQ-verifier spike: measure the verifier on the LIVE devnet (Besu, Cancun).
//
// Deploys the Keccak helper, the verifier and one key blob with the published Anvil #0
// key, then:
//   * eth_call verify() on an accept case and a reject case: Besu must agree with Foundry;
//   * sends both as real transactions and reads gasUsed: the whole cost on this chain,
//     cold accounts, 21,000 base and calldata included.
// scripts/lib/devnet-guard.mjs refuses to run against anything but the devnet.
//
// Usage: node measure-devnet.mjs   (after: node make-fixtures.mjs && bash run.sh)

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  numberToHex,
  size,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertDevnet } from "../../scripts/lib/devnet-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const RPC_URL = process.env.RPC_URL ?? env.RPC_URL;

// DEVNET ONLY. Anvil account #0, a publicly published key with no value.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const chain = defineChain({
  id: Number(env.CHAIN_ID),
  name: env.CHAIN_NAME,
  nativeCurrency: { name: env.CURRENCY_NAME, symbol: env.CURRENCY_SYMBOL, decimals: Number(env.CURRENCY_DECIMALS) },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
await assertDevnet(pub, { what: "spikes/pq-verifier/measure-devnet.mjs" });
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });

const VERIFY_ABI = [
  {
    type: "function",
    name: "verify",
    stateMutability: "view",
    inputs: [
      { name: "pkBlob", type: "address" },
      { name: "message", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "accepted", type: "bool" }],
  },
];

const [helper, blobs, key, msgs, sigs, expect, labels] = decodeAbiParameters(
  [
    { type: "bytes" }, { type: "bytes[]" }, { type: "uint256[]" }, { type: "bytes[]" },
    { type: "bytes[]" }, { type: "bool[]" }, { type: "string[]" },
  ],
  `0x${readFileSync(join(HERE, "fixtures", "cases.bin")).toString("hex")}`,
);
const artifact = JSON.parse(readFileSync(join(HERE, "out", "MLDSA44Verifier.sol", "MLDSA44Verifier.json"), "utf8"));

const pick = (label) => {
  const i = labels.indexOf(label);
  if (i < 0) throw new Error(`fixture case not found: ${label}`);
  return i;
};
const ACCEPT = pick("fresh key 0, |M| = 32");
const REJECT = pick("fresh key 0, |M| = 32, modified signature - z");
if (key[ACCEPT] !== key[REJECT]) throw new Error("the two cases must share a key");

/** PUSH2 len, DUP1, PUSH1 12, PUSH1 0, CODECOPY, PUSH1 0, RETURN, then the runtime. */
const rawInit = (runtime) => concat(["0x61", numberToHex(size(runtime), { size: 2 }), "0x80600c6000396000f3", runtime]);

async function send(label, tx) {
  const hash = await wallet.sendTransaction(tx);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label}: transaction ${hash} ${r.status}`);
  console.log(`  ${label.padEnd(26)} gasUsed ${String(r.gasUsed).padStart(9)}  block ${r.blockNumber}`);
  return r;
}

/** Cancun intrinsic gas: 21,000 plus 16 per non-zero and 4 per zero calldata byte. */
function intrinsic(data) {
  const b = Buffer.from(data.slice(2), "hex");
  let g = 21000n;
  for (const x of b) g += x === 0 ? 4n : 16n;
  return g;
}

console.log(`\n  RPC ${RPC_URL}, chain ${await pub.getChainId()}, head ${await pub.getBlockNumber()}\n`);
console.log("  Deployments");
const h = await send("helper (Keccak-f1600)", { data: rawInit(helper) });
const v = await send("verifier", {
  data: concat([artifact.bytecode.object, encodeAbiParameters([{ type: "address" }], [h.contractAddress])]),
});
const pk = await send("one key blob", { data: rawInit(blobs[Number(key[ACCEPT])]) });

const call = (i) =>
  encodeFunctionData({ abi: VERIFY_ABI, functionName: "verify", args: [pk.contractAddress, msgs[i], sigs[i]] });

console.log("\n  eth_call verdicts (Besu's EVM, not Foundry's)");
for (const i of [ACCEPT, REJECT]) {
  const got = await pub.readContract({
    address: v.contractAddress,
    abi: VERIFY_ABI,
    functionName: "verify",
    args: [pk.contractAddress, msgs[i], sigs[i]],
  });
  const ok = got === expect[i];
  console.log(`  ${ok ? "ok  " : "FAIL"} ${labels[i]}: ${got} (expected ${expect[i]})`);
  if (!ok) process.exitCode = 1;
}

console.log("\n  verify() as a real transaction");
for (const [name, i] of [["accept", ACCEPT], ["reject", REJECT]]) {
  const data = call(i);
  const r = await send(`verify, ${name}`, { to: v.contractAddress, data });
  const base = intrinsic(data);
  console.log(`  ${"".padEnd(26)} = ${base} intrinsic (21,000 + ${size(data)} B calldata) + ${r.gasUsed - base} execution`);
}

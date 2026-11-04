// Giggora PQ-verifier spike: real ML-DSA-44 signatures for test/PQVaultIntegration.t.sol.
//
// Signs, with @noble/post-quantum, everything two PQVaults need on chain 4043:
//   * U, a personal vault (key K0, threshold 1), deployed first by DEPLOYER;
//   * T, a treasury vault (keys K0, K1, K2, threshold 2), deployed second.
// Their addresses follow from DEPLOYER's nonce, so the vault digests can be computed here
// exactly as contracts/src/pq/PQVault.sol computes them, and the test checks that both
// sides agree. That agreement is what an off-chain signing tool depends on.
//
// Usage: bash fetch.sh && node make-vault-fixtures.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, keccak256, toBytes } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, "vendor", "evm-ml-dsa-verifier");
const PYTHON = process.env.PYTHON || "python";

const die = (msg) => {
  console.error(`make-vault-fixtures: ${msg}`);
  process.exit(1);
};
const hex = (u8) => Buffer.from(u8).toString("hex");
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const det = (label, n) =>
  Uint8Array.from(createHash("shake256", { outputLength: n }).update(`giggora-pq-spike/${label}`).digest());
const addr = (n) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

// --- the scenario: must match test/PQVaultIntegration.t.sol -------------------------------
const CHAIN_ID = 4043n; // Giggora devnet
const DEADLINE = 2_000_000_000n;
const DEPLOYER = addr(0xde90);
const BOB = addr(0xb0b);
const KEYS = [0, 1, 2].map((i) => addr(0xc0de0000 + i)); // where the test places the key blobs
const U = getContractAddress({ from: DEPLOYER, nonce: 0n });
const T = getContractAddress({ from: DEPLOYER, nonce: 1n });
const ETHER = 10n ** 18n;

// --- PQVault's digests, written out independently of the contract ---------------------------
const OPERATION_TYPEHASH = keccak256(
  toBytes(
    "PQVault.Operation(uint256 chainId,address vault,uint256 nonce,uint256 deadline,address target,uint256 value,bytes32 dataHash)",
  ),
);
const KEY_TYPEHASH = keccak256(toBytes("PQVault.Key(uint256 chainId,address vault,address key)"));
const opDigest = (vault, nonce, target, value, data) =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" },
        { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" },
      ],
      [OPERATION_TYPEHASH, CHAIN_ID, vault, nonce, DEADLINE, target, value, keccak256(data)],
    ),
  );
const keyDigest = (vault, key) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }],
      [KEY_TYPEHASH, CHAIN_ID, vault, key],
    ),
  );

// --- keys and signing -------------------------------------------------------------------------
const secret = [0, 1, 2].map((k) => ml_dsa44.keygen(det(`key/${k}`, 32)));
/** Sign the 32 digest bytes as the ML-DSA message, empty context, deterministic; check it. */
function sign(k, digest) {
  const msg = bytes(digest);
  const sig = ml_dsa44.sign(msg, secret[k].secretKey, { extraEntropy: false });
  if (!ml_dsa44.verify(sig, msg, secret[k].publicKey)) die(`noble rejected its own signature for key ${k}`);
  return `0x${hex(sig)}`;
}

function blobOf(pk) {
  const r = spawnSync(PYTHON, ["-I", join(VENDOR, "prepare", "prepare.py")], { input: hex(pk), encoding: "utf8" });
  if (r.error) die(`cannot run ${PYTHON}: ${r.error.message}`);
  if (r.status !== 0) die(`prepare.py: ${r.stderr.trim()}`);
  const blob = r.stdout.trim();
  if (blob.length !== 2 * 20545) die(`prepare.py returned ${blob.length / 2} bytes`);
  return `0x${blob}`;
}

// --- what each vault needs ------------------------------------------------------------------------
const proofsU = [sign(0, keyDigest(U, KEYS[0]))];
const proofsT = [0, 1, 2].map((k) => sign(k, keyDigest(T, KEYS[k])));

const dU0 = opDigest(U, 0n, BOB, 1n * ETHER, "0x"); // U pays Bob 1 GIG
const dT0 = opDigest(T, 0n, BOB, 2n * ETHER, "0x"); // T pays Bob 2 GIG, signed by K0 and K2

// T rotates to keys [K1, K2] with threshold 1, signed by K0 and K1; each new key proves possession.
const SET_KEYS_ABI = [
  {
    type: "function",
    name: "setKeys",
    stateMutability: "nonpayable",
    inputs: [
      { name: "newKeys", type: "address[]" },
      { name: "newThreshold", type: "uint256" },
      { name: "proofs", type: "bytes[]" },
    ],
    outputs: [],
  },
];
const setKeysData = encodeFunctionData({
  abi: SET_KEYS_ABI,
  functionName: "setKeys",
  args: [[KEYS[1], KEYS[2]], 1n, [proofsT[1], proofsT[2]]],
});
const dT1 = opDigest(T, 1n, T, 0n, setKeysData);
const dT2 = opDigest(T, 2n, BOB, ETHER / 2n, "0x"); // after the rotation K2 alone pays Bob 0.5 GIG

const fixture = {
  helper: `0x${readFileSync(join(VENDOR, "helpers", "f1600_170.hex"), "utf8").replace(/\s+/g, "")}`,
  blobs: secret.map((s) => blobOf(s.publicKey)),
  proofsU,
  proofsT,
  sigU0: sign(0, dU0),
  sigsT0: [sign(0, dT0), sign(2, dT0)],
  setKeysData,
  sigsT1: [sign(0, dT1), sign(1, dT1)],
  sigT2: sign(2, dT2),
  digests: [dU0, dT0, dT1, dT2, keyDigest(U, KEYS[0]), keyDigest(T, KEYS[0]), keyDigest(T, KEYS[1]), keyDigest(T, KEYS[2])],
};

const encoded = encodeAbiParameters(
  [
    {
      type: "tuple",
      components: [
        { name: "helper", type: "bytes" },
        { name: "blobs", type: "bytes[]" },
        { name: "proofsU", type: "bytes[]" },
        { name: "proofsT", type: "bytes[]" },
        { name: "sigU0", type: "bytes" },
        { name: "sigsT0", type: "bytes[]" },
        { name: "setKeysData", type: "bytes" },
        { name: "sigsT1", type: "bytes[]" },
        { name: "sigT2", type: "bytes" },
        { name: "digests", type: "bytes32[]" },
      ],
    },
  ],
  [fixture],
);
mkdirSync(join(HERE, "fixtures"), { recursive: true });
writeFileSync(join(HERE, "fixtures", "vault.bin"), Buffer.from(encoded.slice(2), "hex"));
console.log(`vaults: U ${U}, T ${T} (from ${DEPLOYER}, nonces 0 and 1)`);
console.log(`wrote fixtures/vault.bin (${((encoded.length - 2) / 2 / 1e3).toFixed(0)} KB): 3 key blobs, 4 proofs, 8 operation signatures`);

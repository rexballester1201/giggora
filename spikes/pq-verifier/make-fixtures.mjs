// Giggora PQ-verifier spike: build fixtures/cases.bin for test/VerifierSpike.t.sol.
//
// Three independent parties have to agree before a case is written:
//   * NIST's ACVP ML-DSA-44 vectors (cache/, pinned by fetch.sh)
//   * @noble/post-quantum, the signer a Giggora vault would use (pinned in package.json)
//   * the verifier under test, which only meets the cases inside Foundry
// noble must reproduce every NIST sigGen signature byte for byte and match every NIST
// sigVer verdict. If it does not, this script stops instead of writing fixtures, and
// every expected verdict written below is noble's own answer, never an assumption.
//
// The verifier implements pure ML-DSA-44 with an EMPTY context string, so a signature
// made with any other context, or with HashML-DSA, must be rejected.
//
// Usage: bash fetch.sh && node make-fixtures.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { encodeAbiParameters, keccak256 } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, "vendor", "evm-ml-dsa-verifier");
const PREPARE = join(VENDOR, "prepare", "prepare.py");
const HELPER_HEX = join(VENDOR, "helpers", "f1600_170.hex");
// F1600_CODEHASH in vendor/evm-ml-dsa-verifier/src/MLDSA44Verifier.sol
const F1600_CODEHASH = "0x4afb4435879cdf8e50474c7aab2bc3a679caed432550ad6dba64f509309a817b";
const PK_BLOB_SIZE = 20545;
const PYTHON = process.env.PYTHON || "python";

const die = (msg) => {
  console.error(`make-fixtures: ${msg}`);
  process.exit(1);
};
const hex = (u8) => Buffer.from(u8).toString("hex");
const bytes = (h) => Uint8Array.from(Buffer.from(h ?? "", "hex"));
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const EMPTY = new Uint8Array(0);
/** Deterministic pseudo-random bytes, so the fixtures are identical on every run. */
const det = (label, n) =>
  n === 0
    ? EMPTY
    : Uint8Array.from(createHash("shake256", { outputLength: n }).update(`giggora-pq-spike/${label}`).digest());

/** noble as the oracle. A malformed signature makes noble throw; that is a rejection. */
function nobleVerify(sig, msg, pk, context = EMPTY) {
  try {
    return ml_dsa44.verify(sig, msg, pk, { context });
  } catch {
    return false;
  }
}

// --- public keys -> prepared blobs (prepare.py, run once per distinct key) ------------
const blobs = [];
const blobIndex = new Map();
function keyIndex(pk) {
  const k = hex(pk);
  if (blobIndex.has(k)) return blobIndex.get(k);
  const r = spawnSync(PYTHON, ["-I", PREPARE], { input: k, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error) die(`cannot run ${PYTHON}: ${r.error.message}`);
  if (r.status !== 0) die(`prepare.py rejected a key: ${r.stderr.trim()}`);
  const blob = bytes(r.stdout.trim());
  if (blob.length !== PK_BLOB_SIZE) die(`prepare.py returned ${blob.length} bytes, expected ${PK_BLOB_SIZE}`);
  blobIndex.set(k, blobs.length);
  blobs.push(blob);
  return blobs.length - 1;
}

// --- cases ------------------------------------------------------------------------------
const cases = [];
function add(label, pk, msg, sig, expect) {
  const oracle = nobleVerify(sig, msg, pk);
  if (oracle !== expect) die(`${label}: expected ${expect}, but noble says ${oracle}`);
  cases.push({ key: keyIndex(pk), msg, sig, expect, label });
}

/** ACVP's four sigVer mutation classes, applied to a known-good signature. */
function mutations(msg, sig) {
  const flip = (u8, i, bit) => {
    const c = Uint8Array.from(u8);
    c[i] ^= bit;
    return c;
  };
  return [
    ["modified message", msg.length ? flip(msg, 0, 0x01) : Uint8Array.of(0x00), sig],
    ["modified signature - commitment", msg, flip(sig, 7, 0x01)],
    ["modified signature - z", msg, flip(sig, 32 + 1000, 0x04)],
    ["modified signature - hint", msg, flip(sig, 2336 + 3, 0x01)],
  ];
}

const load = (name) => JSON.parse(readFileSync(join(HERE, "cache", `${name}.json`), "utf8"));
const mlDsa44 = (j) => j.testGroups.filter((g) => g.parameterSet === "ML-DSA-44");
const sigGen = load("ML-DSA-sigGen-FIPS204");
const sigVer = load("ML-DSA-sigVer-FIPS204");

// 1. NIST sigGen, external interface, pure: deterministic and hedged groups.
let sigGenReproduced = 0;
for (const g of mlDsa44(sigGen).filter((g) => g.signatureInterface === "external" && g.preHash === "pure")) {
  for (const t of g.tests) {
    const pk = bytes(t.pk);
    const sk = bytes(t.sk);
    const msg = bytes(t.message);
    const ctx = bytes(t.context);
    const official = bytes(t.signature);
    const tag = `NIST sigGen tg${g.tgId} tc${t.tcId}`;

    const mine = ml_dsa44.sign(msg, sk, { context: ctx, extraEntropy: g.deterministic ? false : bytes(t.rnd) });
    if (!same(mine, official)) die(`noble did not reproduce ${tag}`);
    sigGenReproduced++;

    // NIST's own signature: valid for this verifier only when NIST signed with an empty context.
    add(`${tag}: official signature, context ${ctx.length} B`, pk, msg, official, ctx.length === 0);
    // The same official key and message, re-signed with an empty context: must accept.
    const resigned = ml_dsa44.sign(msg, sk, { extraEntropy: false });
    add(`${tag}: re-signed, empty context`, pk, msg, resigned, true);
    for (const [what, m, s] of mutations(msg, resigned)) add(`${tag}: re-signed, ${what}`, pk, m, s, false);
  }
}

// 2. NIST sigVer, external interface: pure (official verdicts) and preHash (must never pass as pure).
let sigVerMatched = 0;
for (const g of mlDsa44(sigVer).filter((g) => g.signatureInterface === "external")) {
  for (const t of g.tests) {
    const pk = bytes(t.pk);
    const msg = bytes(t.message);
    const sig = bytes(t.signature);
    const ctx = bytes(t.context);
    const tag = `NIST sigVer tg${g.tgId} tc${t.tcId} (${g.preHash}${t.reason ? `, ${t.reason}` : ""})`;
    if (g.preHash === "pure") {
      const own = nobleVerify(sig, msg, pk, ctx);
      if (own !== t.testPassed) die(`noble disagrees with NIST on ${tag}: NIST ${t.testPassed}, noble ${own}`);
      sigVerMatched++;
      add(`${tag}, context ${ctx.length} B`, pk, msg, sig, t.testPassed === true && ctx.length === 0);
    } else {
      add(`${tag}: HashML-DSA signature checked as pure`, pk, msg, sig, false);
    }
  }
}

// 3. Fresh keys over message lengths on SHAKE-256 block edges. mu = H(tr || 0x00 || 0x00 || M)
//    has a 66 + |M| byte preimage and a 136-byte rate; |M| = 734 is the one length the verifier
//    routes through its lane-level fallback (an 800-byte preimage).
const LENGTHS = [0, 1, 32, 69, 70, 71, 205, 206, 733, 734, 735, 1024, 4096];
for (let k = 0; k < 3; k++) {
  const { publicKey, secretKey } = ml_dsa44.keygen(det(`key/${k}`, 32));
  for (const n of LENGTHS) {
    const msg = det(`msg/${k}/${n}`, n);
    const sig = ml_dsa44.sign(msg, secretKey, { extraEntropy: n % 2 ? det(`rnd/${k}/${n}`, 32) : false });
    add(`fresh key ${k}, |M| = ${n}`, publicKey, msg, sig, true);
    if (n === 32) {
      for (const [what, m, s] of mutations(msg, sig)) add(`fresh key ${k}, |M| = ${n}, ${what}`, publicKey, m, s, false);
    }
  }
}

// 4. Malformed input and the wrong key.
{
  const k0 = ml_dsa44.keygen(det("key/0", 32));
  const k1 = ml_dsa44.keygen(det("key/1", 32));
  const m = det("msg/malformed", 32);
  const good = ml_dsa44.sign(m, k0.secretKey, { extraEntropy: false });
  add("malformed: signature one byte short", k0.publicKey, m, good.slice(0, 2419), false);
  add("malformed: signature one byte long", k0.publicKey, m, Uint8Array.from([...good, 0]), false);
  add("malformed: empty signature", k0.publicKey, m, EMPTY, false);
  add("malformed: all-zero signature", k0.publicKey, m, new Uint8Array(2420), false);
  add("wrong key: valid signature checked against another key", k1.publicKey, m, good, false);
  add("control: the same signature against its own key", k0.publicKey, m, good, true);
}

// --- the Keccak helper: pinned by the verifier's own code hash; opcodes surveyed ---------------
const helper = bytes(readFileSync(HELPER_HEX, "utf8").replace(/\s+/g, "").replace(/^0x/i, ""));
if (keccak256(`0x${hex(helper)}`) !== F1600_CODEHASH) die("helpers/f1600_170.hex does not match the code hash the verifier pins");

// Linear sweep; PUSH immediates are skipped. A true Keccak permutation needs no calls, no storage,
// no logs and no opcode newer than Cancun.
const CANCUN = new Set([
  ...range(0x00, 0x0b), ...range(0x10, 0x1d), 0x20, ...range(0x30, 0x3f), ...range(0x40, 0x4a),
  ...range(0x50, 0x5f), ...range(0x60, 0x7f), ...range(0x80, 0x8f), ...range(0x90, 0x9f), ...range(0xa0, 0xa4),
  ...range(0xf0, 0xf5), 0xfa, 0xfd, 0xfe, 0xff,
]);
const WATCH = {
  0x54: "SLOAD", 0x55: "SSTORE", 0x5c: "TLOAD", 0x5d: "TSTORE", 0xa0: "LOG0", 0xa1: "LOG1", 0xa2: "LOG2", 0xa3: "LOG3",
  0xa4: "LOG4", 0xf0: "CREATE", 0xf1: "CALL", 0xf2: "CALLCODE", 0xf4: "DELEGATECALL", 0xf5: "CREATE2",
  0xfa: "STATICCALL", 0xff: "SELFDESTRUCT", 0x56: "JUMP", 0x57: "JUMPI", 0xfe: "INVALID",
};
function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
const seen = new Map();
for (let i = 0; i < helper.length; i++) {
  const op = helper[i];
  seen.set(op, (seen.get(op) ?? 0) + 1);
  if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
}
const watched = Object.fromEntries([...seen].filter(([op]) => WATCH[op]).map(([op, n]) => [WATCH[op], n]));
const notCancun = [...seen.keys()].filter((op) => !CANCUN.has(op)).map((op) => `0x${op.toString(16).padStart(2, "0")}`);

// --- write -------------------------------------------------------------------------------
const encoded = encodeAbiParameters(
  [
    { type: "bytes" }, { type: "bytes[]" }, { type: "uint256[]" }, { type: "bytes[]" },
    { type: "bytes[]" }, { type: "bool[]" }, { type: "string[]" },
  ],
  [
    `0x${hex(helper)}`,
    blobs.map((b) => `0x${hex(b)}`),
    cases.map((c) => BigInt(c.key)),
    cases.map((c) => `0x${hex(c.msg)}`),
    cases.map((c) => `0x${hex(c.sig)}`),
    cases.map((c) => c.expect),
    cases.map((c) => c.label),
  ],
);
const summary = {
  nist: {
    sigGenSignaturesReproducedByNoble: sigGenReproduced,
    sigVerVerdictsMatchedByNoble: sigVerMatched,
  },
  keys: blobs.length,
  cases: cases.length,
  mustAccept: cases.filter((c) => c.expect).length,
  mustReject: cases.filter((c) => !c.expect).length,
  helper: { bytes: helper.length, codeHashMatchesVerifier: true, watchedOpcodes: watched, opcodesNewerThanCancun: notCancun },
};
mkdirSync(join(HERE, "fixtures"), { recursive: true });
writeFileSync(join(HERE, "fixtures", "cases.bin"), Buffer.from(encoded.slice(2), "hex"));
writeFileSync(join(HERE, "fixtures", "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote fixtures/cases.bin (${((encoded.length - 2) / 2 / 1e6).toFixed(2)} MB)`);

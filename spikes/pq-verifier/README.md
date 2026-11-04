# Spike: post-quantum signatures in a Giggora contract

**The question.** Can a Giggora contract verify post-quantum signatures (ML-DSA-44,
NIST FIPS 204) today, without forking Besu? Does it give the right answer on
Giggora's Cancun EVM, and what does it cost?

**The answer (2026-11-04).** Yes. Compiled for Cancun, Fireblocks Labs' verifier got
**all 267 cases right** and fits the contract size limit with no source change. One
verification of a 32-byte message costs **about 1.23M gas**, roughly 0.0012 GIG at
Giggora's fixed 1 gwei. The measurement on Besu itself is still pending (see the
end of this README).

**Why it matters.** This is step one of the "post-quantum vaults" option: an opt-in
contract wallet that moves funds only with both the owner's MetaMask account and an
ML-DSA signature. Everything else in that design depends on the verifier being correct
and affordable.

## What is tested

| Piece | What | Pinned |
|---|---|---|
| Verifier | Fireblocks Labs' [`evm-ml-dsa-verifier`](https://github.com/fireblocks-labs/evm-ml-dsa-verifier), MIT, **unaudited research code** | commit `cca262b` |
| Signer | [`@noble/post-quantum`](https://www.npmjs.com/package/@noble/post-quantum), MIT, what a vault's signing tool would use | `0.7.1`, lockfile |
| Oracle | NIST ACVP ML-DSA sigGen and sigVer vectors | ACVP-Server `975de31`, SHA-256 |

The verifier's own repo targets the Osaka EVM. Here it is compiled for **Cancun**,
Giggora's hardfork, with every other compiler setting unchanged
([foundry.toml](foundry.toml)). That is the one thing its authors did not test.

## Run it

```bash
bash fetch.sh                # pinned verifier, NIST vectors and noble, each verified
node make-fixtures.mjs       # 267 cases; every expected verdict cross-checked against NIST and noble
node make-vault-fixtures.mjs # real signatures for the PQVault integration test
bash run.sh                  # Foundry in the repo's pinned Docker image: verdicts, gas, deployment costs
node measure-devnet.mjs  # the same verifier on the live devnet (Besu), cold, as real transactions
```

Without Docker, any Foundry v1.5.1 runs the same suite with `forge test -vv --gas-report`.
v1.5.1 is the revision [`scripts/forge.sh`](../../scripts/forge.sh) pins (`b0a9dd9c`).
The results below came from that route, inside Ubuntu (WSL), because Docker Desktop
was broken that day. `run.sh` itself has not been run yet. `measure-devnet.mjs` signs
with the published Anvil key and refuses any chain but the devnet
([`scripts/lib/devnet-guard.mjs`](../../scripts/lib/devnet-guard.mjs)).

## The cases

The verifier implements pure ML-DSA-44 with an **empty context string**, so a signature
made with any other context, or with HashML-DSA, must be rejected. Every expected
verdict is noble's own answer, and noble is checked against NIST first. A disagreement
stops `make-fixtures.mjs` instead of producing fixtures.

| Source | Cases | Expected |
|---|---:|---|
| NIST sigGen (external, pure; deterministic and hedged): the official signatures | 30 | accept the 3 made with an empty context, reject the 27 made with a non-empty one |
| The same 30 NIST keys and messages, re-signed by noble with an empty context | 30 | accept |
| ACVP's four mutation classes (message, commitment, z, hint) on each of those | 120 | reject |
| NIST sigVer (external, pure): the official cases | 15 | reject (the 3 valid ones all carry a non-empty context) |
| NIST sigVer (HashML-DSA) | 15 | reject: must never pass as pure |
| Fresh keys, 13 message lengths on SHAKE-256 block edges, including the verifier's 734-byte fallback path | 39 | accept |
| The four mutation classes on the 32-byte fresh-key cases | 12 | reject |
| Malformed signatures (one byte short, one byte long, empty, all zero), the wrong key, and a control | 6 | reject 5, accept the control |
| **Total** | **267** | **73 accept, 194 reject** |

## Results

Measured 2026-11-04: Foundry v1.5.1 (`b0a9dd9c`), solc 0.8.30, `evm_version = "cancun"`,
via-IR, 10,000 optimizer runs.

**Correctness: 267 of 267.** Every case gave the expected verdict, 73 accepted and 194
rejected. That covers:

- every official NIST signature and verdict
- ACVP's four mutation classes on 33 good signatures
- signatures made with a non-empty context or with HashML-DSA, all rejected
- malformed signatures and the wrong key
- the verifier's 734-byte fallback path

**It fits on Cancun unchanged.** The Cancun build is 24,032 bytes, the same as its
Osaka build, and 544 bytes under the EIP-170 limit. No source change was needed, and
no opcode newer than Cancun is involved.

**noble agrees with NIST exactly.** It reproduced all 30 NIST sigGen signatures byte for
byte, deterministic and hedged, and matched all 15 NIST sigVer verdicts. That validates
the signer a vault would use, not only the verifier.

**The Keccak helper is what the verifier expects.** `helpers/f1600_170.hex` (21,622
bytes) matches the code hash `MLDSA44Verifier` pins and re-checks on every call.
Its opcodes include no call, storage access, log, contract creation or self-destruct,
and nothing newer than Cancun. It has 3 `JUMPI` and 2 `JUMP`: its dispatcher loop
around straight-line code.

**Gas per verification.** These are warm calls from a contract. A real transaction adds
about 7,500 for three cold accounts, plus 21,000 and the calldata.

| Message | Gas |
|---:|---:|
| 0 B | 1,227,111 |
| **32 B**: what a vault would sign (a digest of the operation) | **1,227,457** |
| 70 B: first extra SHAKE-256 block | 1,270,166 |
| 734 B: the verifier's fallback path | 1,446,498 |
| 1,024 B | 1,560,677 |
| 4,096 B | 2,471,840 |

The cheapest acceptance was 1,226,211 gas, within 0.1% of the 1,226,311 Fireblocks
publishes from its Osaka build, so the Cancun build costs the same in practice. Each
further 136 bytes of message adds about 41,500 gas. A malformed signature is rejected
early (from 6,433 gas). A well-formed wrong signature costs a full verification.

**One-time costs.** These are CREATE gas; a transaction adds 21,000 and the calldata.

| Deployment | Gas | At Giggora's 1 gwei |
|---|---:|---:|
| Keccak helper (once per chain) | 4,362,733 | 0.0044 GIG |
| Verifier (once per chain) | 4,848,525 | 0.0048 GIG |
| One key's prepared blob (once per key) | 4,146,982 | 0.0041 GIG |

**What it means for the vault design.**

- **Sign a fixed 32-byte digest of the operation, never the raw call data.** That keeps
  every approval at the 1.23M floor, whatever the action. A 30M-gas block then holds
  about 24 approvals.
- **On Giggora, gas is not the blocker.** The real gaps are an independent audit,
  validating each key blob when it is registered, and the helper's unreproducible
  origin (below).

## PQVault, end to end

[`contracts/src/pq/PQVault.sol`](../../contracts/src/pq/PQVault.sol) is the vault this
spike was for. Its logic is unit-tested in the contracts project with a stand-in verifier
(30 tests in [`contracts/test/PQVault.t.sol`](../../contracts/test/PQVault.t.sol)). Here
it runs against the real verifier, with real ML-DSA-44 signatures from noble
([`make-vault-fixtures.mjs`](make-vault-fixtures.mjs),
[`test/PQVaultIntegration.t.sol`](test/PQVaultIntegration.t.sol)), on chain id 4043.
All 4 tests pass:

- **The digests noble signed are the ones the contract checks**, for every operation and
  every key proof. Any off-chain signing tool has to compute them the same way.
- **A personal vault** (one key) pays once and refuses the replay.
- **A treasury vault** (2 of 3):
  - pays with two of its three keys;
  - rotates to two new keys with threshold 1, each new key proving it can sign;
  - pays again under the new set.
- **Real signatures are refused** on another vault, on chain id 4042, and with one bit
  flipped.

| Measured (Foundry, from the test contract) | Gas | At 1 gwei |
|---|---:|---:|
| Deploy a personal vault (1 key proof) | 2,639,850 | 0.0026 GIG |
| Deploy a treasury vault (3 key proofs) | 5,279,399 | 0.0053 GIG |
| Execute 1 of 1 (a GIG payment) | 1,370,650 | 0.0014 GIG |
| Execute 2 of 3 | 2,641,370 | 0.0026 GIG |
| Rotate keys (2 signatures + 2 proofs) | 5,139,192 | 0.0051 GIG |

An operation costs about 1.23M gas per signature it needs, plus 80,000 to 140,000 for the
vault and the payment itself. On top of those come the one-time costs: each key's blob
(4.15M gas) and the shared helper and verifier. The test places key blobs with
`vm.etch`, so their deployment is not in these figures.

## Still pending

`measure-devnet.mjs` runs the same verifier on Besu, the client Giggora actually runs,
as real transactions with cold accounts. The devnet runs in Docker, so this waits until
Docker Desktop is working again.

## Known limits

- **The verifier is unaudited.** Its authors say so, and an independent audit comes
  before it guards anything of value.
- **`helpers/f1600_core.hex` cannot be rebuilt from anything in its repo.** Its
  generator was not kept (see the verifier's `helpers/README.md`). The blob that
  actually runs is rebuilt from it and pinned by code hash, and the authors test it
  against an independent Keccak. That is behavioural evidence, not provenance.
- **Foundry measures warm calls.** A real transaction starts with cold accounts, about
  7,500 gas more for the verifier, the helper and the key (EIP-2929).
  `measure-devnet.mjs` measures the real, cold transaction.
- **The key blob must be validated when a key is registered** (the verifier's
  `docs/SAFETY.md` §3): the verifier cannot tell a well-formed blob from one that was
  not derived from a genuine key. The vault design must do that check. This spike
  does not test registration.

# Giggora — Architecture

**Status:** Phase 1 signed off. **Phases 2-7 complete and verified.**
Phase 2: 7/7 network. Phase 3: 28/28 contract unit, 12/12 on-chain.
Phase 4: 8/8 indexer over 1000 blocks, SIGKILL recovery, Blockscout cross-check.
Phase 5: 51/51 API + 12/12 regressions. Phase 6: 28/28 UI. Phase 7: 19/19 wallet.
Remaining: Phase 8 (deployment).
**Date:** 2026-09-07
**Scope:** Implements Phase 1 of the project brief (`Build a Custom EVM Blockchain + Block Explorer.md`).

---

## 1. What Giggora is

Giggora is a general-purpose, fast, low-cost, EVM-compatible Layer-1 blockchain. It provides an
independent platform for digital assets, smart contracts, and decentralized applications, so that
developers can deploy Ethereum-compatible applications and tokens without depending on Ethereum,
BSC, or Polygon. It has its own native currency (GIG) for transaction fees, its own validator
network, and its own block explorer.

| Property | Value |
|---|---|
| Chain name | Giggora |
| Native currency | GIG |
| Symbol | GIG |
| Decimals | 18 |
| Address format | `0x…` (EIP-55 checksummed) |
| Transaction format | Ethereum-compatible (legacy + EIP-2930 + EIP-1559) |
| Independence | Fully sovereign after genesis. No settlement layer, no parent chain. |

**Non-goals for the MVP** (brief §44): bridges, cross-chain messaging, rollups, ZK, staking
marketplace, governance DAO, DEX, NFT marketplace, wallet app, mobile app.

---

## 2. Foundation evaluation

The brief (§2) requires evaluating currently maintained EVM clients and choosing the simplest
actively maintained foundation. This section records what was verified on 2026-09-07, not
received wisdom.

### 2.1 The headline finding

**The standard "geth + Clique PoA" tutorial path is dead.** This is the most important result of
the evaluation, because it is what almost every guide reaches for first.

- In go-ethereum, Clique has been **deprecated since v1.14**.
- In Hyperledger Besu, Clique was **removed outright in v26.4.0** — "Clique consensus has been
  removed. Besu can no longer start or mine on pure Clique networks."
- Besu removed the remaining **PoW mining infrastructure in v26.7.0**.
- `puppeth`, the genesis wizard used by most older tutorials, was removed from geth years ago.

Any plan built on Clique would require pinning to an EOL release on day one, which the brief
explicitly forbids. Ruled out.

### 2.2 Candidates assessed

| Candidate | Verdict | Evidence |
|---|---|---|
| **Besu + QBFT** | **SELECTED** | Latest stable **26.8.1**. QBFT actively maintained — fixes shipped in both 26.8.0 and 26.8.1. Docs updated 2026-08-13. Apache 2.0. |
| geth + Clique | Rejected | Deprecated since geth v1.14; removed in Besu 26.4.0. EOL path. |
| geth post-merge (PoS) | Rejected | Requires a full consensus client (Lighthouse/Prysm) alongside every node. Far more moving parts for a 4-validator network. Violates §5 "simplest safe mechanism". |
| Polygon Edge | Rejected | **Discontinued by Polygon Labs (announced Dec 2023)** in favour of Polygon CDK. Was the ideal architectural fit; is now abandonware. Exactly the trap §2 warns about. |
| Polygon CDK | Rejected | ZK-powered **L2** that settles to Ethereum. Contradicts §1 sovereignty. |
| OP Stack / op-geth | Rejected | Very actively maintained, but an **L2**. Requires an L1 to settle to. Contradicts §1 sovereignty. |
| Avalanche subnet-evm | Rejected (viable runner-up) | Etna (Dec 2024) made Avalanche L1s genuinely sovereign and cut launch cost >99%; real institutional adoption. But validators pay a continuous AVAX fee (~1.3 AVAX/month) and the chain lives inside the Avalanche ecosystem — "independent" becomes qualified. Adds an external economic dependency Giggora does not need. |
| Cosmos EVM | Rejected (viable runner-up) | Apache 2.0, stewarded by ICF/Interchain Labs, sovereign L1s are their 2026 focus, CometBFT gives instant finality. **But:** a critical Cosmos EVM flaw was exploited 20–25 Aug 2026 across six chains, ~$5.72M drained, three chains halted. Also not EVM-native — an EVM module over CometBFT, with historically rough tooling edges. Too much risk without deep Cosmos expertise. |
| GoQuorum | Rejected | **No longer maintained by Consensys.** Official guidance is migration to Besu. |

### 2.3 Why Besu + QBFT

Every requirement in brief §5 maps onto a first-class QBFT feature. This is not a compromise fit:

| §5 requirement | QBFT mechanism |
|---|---|
| Small validator set | Designed for it. `n = 3f + 1`. |
| Predictable block production | `blockperiodseconds` — minimum block time, default 1. |
| Fast finality | **Immediate, absolute finality.** No reorgs. |
| No mining hardware, no PoW | BFT voting. Zero PoW. |
| Easy local development | `besu operator generate-blockchain-config` emits genesis + all validator keys in one command. |
| Easy multi-node deployment | Official Docker images; bootnode + enode topology. |
| Easy validator add/remove | `qbft_proposeValidatorVote` / `qbft_discardValidatorVote` — live voting, no restart. |
| Room for future decentralization | `validatorcontractaddress` — swap header voting for an on-chain validator contract via `transitions`, no hard fork. |

Three further decisive properties:

1. **Absolute finality deletes an entire subsystem.** With no reorgs possible, the indexer
   (§22) needs no reorg handling, no rollback, no orphan tracking. That is a large slice of the
   hardest code in the project, removed by a consensus choice.
2. **`transitions` is a built-in upgrade mechanism** — with real caveats, established by
   testing it rather than by reading about it (`scripts/test-qbft-transition.mjs`, 11/11).
   Block time, block reward, mining beneficiary and validator-selection method can each be
   changed on a live chain: the genesis hash is unchanged, history is intact, and the chain
   keeps its identity. The brief listed an upgrade procedure as a deliverable (§50.19) but
   never designed one — this is it. Three things the documentation did not make clear:

   - **`transitions` must sit INSIDE `config`.** Placed at the top level of the genesis file
     it is *silently ignored* — Besu starts with no error, no warning, and the scheduled
     change simply never happens. Measured both ways; top-level had no effect at all.
   - **The change applies at NODE RESTART, not at the scheduled block.** Verified: a
     transition scheduled for block 1748 was already in force at block 1731. So an upgrade
     cannot be staged in advance and left to land on its own — every node must be cycled in
     one maintenance window, and the `block` field behaves more like a floor than a trigger.
   - **Stop every node, then start them. Never a rolling restart.** Besu validates each
     block's timestamp gap against its *own* current block period, so while nodes disagree,
     proposals are rejected with `TimestampMoreRecentThanParent` and block production stalls
     until QBFT round-changes. Observed on this chain; it recovered unaided, but a production
     network should not be asked to.

   This is weaker than "schedule it and forget it", but it is still a genuine no-hard-fork
   upgrade path, and it is now tested rather than assumed.
3. **Tokenomics are natively configurable**, satisfying §11 with no custom contracts:
   `blockreward` (Wei per block) and `miningbeneficiary` (defaults to the block proposer).

**Accepted cost:** Besu is Java/JVM, not Go. The brief (§43) suggested a "Go-based EVM client if
that is the selected foundation" but explicitly says not to impose technologies blindly. The JVM
costs roughly 2–4 GB RAM per node versus geth's ~1 GB. At 4 validators this is irrelevant; it
becomes a line item only at large validator counts. Maintenance status outranks language
preference here.

**Governance note:** the Besu repository has moved from `hyperledger/besu` to `besu-eth/besu`,
still under LF Decentralized Trust. Shipping releases confirm active maintenance, but pin image
tags and watch the org.

**Security note:** CertiK disclosed five Besu vulnerabilities (minor→major), advisories published
2026-08-14, fixed in 26.7.1. That is evidence of a working disclosure process, not a reason to
avoid Besu — but it makes a patch-tracking policy mandatory (§11).

---

## 3. Consensus design

**QBFT**, header-based validator selection for the MVP.

- Validators take turns proposing; a round commits once a supermajority signs.
- Byzantine tolerance: `n = 3f + 1`. **4 validators tolerate 1 faulty node. 3 tolerate 0.**
- Finality is immediate. A committed block is final.

**Decision: launch with 4 validators, not 3.** The brief (§5) says "start with 3 validators in
development." Three gives `f = 0` — one crashed validator halts the chain. Four is the smallest
set with real fault tolerance, at the cost of one container. This is the one place the plan
deliberately departs from the brief.

Path to decentralization, no hard fork required:

```
Phase A (MVP)      header-based voting, 4 known validators
                            |
                     transitions block
                            v
Phase B (later)    validatorcontractaddress -> on-chain validator contract
                            |
                            v
Phase C (future)   staking / permissionless validator entry
```

---

## 4. Chain parameters

Chain IDs were verified against the `ethereum-lists/chains` registry (the data source behind
chainlist.org) on 2026-09-07. All three are **unregistered and free**, so MetaMask users will not
hit a collision:

| Network | Chain ID | Network ID | Purpose |
|---|---|---|---|
| Giggora Mainnet | **4041** | 4041 | Reserved. Not launched in MVP. |
| Giggora Testnet | **4042** | 4042 | Public testnet. |
| Giggora Devnet | **4043** | 4043 | Local docker-compose network. |

> Do not use 1337 or 31337 — they collide with geth `--dev` and Hardhat/Anvil.

Initial parameters. All configurable, none hard-coded:

| Parameter | MVP value | Notes |
|---|---|---|
| `blockperiodseconds` | 2 | Within the 1–3s target (§4). |
| `emptyblockperiodseconds` | 60 | Avoids ~43,200 empty blocks/day on an idle chain. |
| `requesttimeoutseconds` | 4 | Convention: 2× block period. |
| `epochlength` | 30000 | Default. Do not change on a live network. |
| Block gas limit | 30,000,000 | Matches Ethereum mainnet; familiar to developers. |
| `blockreward` | 0 at genesis | Pre-mine only initially; raise later via `transitions`. |
| `miningbeneficiary` | unset | Defaults to block proposer. |
| EIP-1559 base fee | enabled, **fixed** | `fixedBaseFee: true`. Without it the base fee decays on empty blocks below `min-gas-price`, and wallets then underpay the floor — transactions are accepted and silently never mined. |
| Hardfork | **Cancun** | Required in practice: OpenZeppelin 5.6 emits `mcopy`, a Cancun opcode, so a Shanghai chain cannot compile current OpenZeppelin. Works on non-PoS QBFT only because the EIP-4788 beacon-roots contract is pre-deployed in genesis at `0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02`. |
| Min gas price | 1 gwei | **Not zero** — a zero-gas chain is trivially spammable. Must equal `baseFeePerGas` when `fixedBaseFee` is on; the generator enforces this. |
| Initial supply | 1,000,000,000 GIG | Genesis `alloc`. Decided — see §13. Generator verifies allocations sum exactly. |

---

## 5. Network architecture

```
   MetaMask / DApps / ethers.js / viem
              |
              v
      [ reverse proxy: TLS, rate limiting ]
              |
              v
      +--------------------+
      |     RPC node       |   full node, non-validator, holds no keys
      |   JSON-RPC + WS    |   the ONLY publicly exposed node
      +--------------------+
              |
   ...........|.......... P2P (private, firewalled) ...........
   .          |                                               .
   .   +------+------+------+------+                          .
   .   |      |      |      |      |                          .
   .  val-1 val-2  val-3  val-4                               .
   .   (QBFT validators — never publicly reachable)           .
   ............................................................
              |
              | WebSocket newHeads + JSON-RPC
              v
      +--------------------+
      |      Indexer       |  checkpointed, idempotent, restartable
      +--------------------+
              |
              v
      +--------------------+
      |     PostgreSQL     |  not exposed publicly
      +--------------------+
              |
              v
      +--------------------+
      |    Explorer API    |  pagination, validation, rate limiting
      +--------------------+
              |
              v
      +--------------------+
      |    Explorer UI     |  Giggora-branded
      +--------------------+
```

**Key security property:** validators are never publicly reachable. All public traffic terminates
at the RPC node, which holds no validator keys. The `ADMIN`, `DEBUG`, and `MINER` RPC namespaces
are disabled on the public node (§10, §30).

---

## 6. Explorer and indexer strategy — the pivotal recommendation

The brief specifies building the indexer (§21–22), explorer API (§23–24), contract verification
(§19), and token detection (§20) from scratch. Built properly, that is the largest and riskiest
part of this project — Blockscout represents roughly a decade of work by a funded team.

**Recommendation: a two-track approach.**

**Track 1 — Blockscout as ground truth, stood up early (Phase 4).**
Blockscout is open source, self-hostable via Docker, and already supports 1000+ EVM chains.
Pointing it at Giggora is configuration, not development. It buys, immediately:

- a working, correct explorer while the custom one is still being built;
- **contract verification** — the biggest tar pit in the brief (multi-version solc, metadata
  hashes, library linking, constructor args, optimizer and via-IR permutations);
- token detection for ERC-20/721/1155;
- and most valuably, **a reference implementation to diff the custom indexer against.** Any
  disagreement between Giggora's indexer and Blockscout on the same block is a bug in one of
  them. That is an exceptionally strong correctness test, and it is free.

**Track 2 — the custom Giggora explorer (Phases 5–6).**
The original indexer, API, and Next.js UI required by §13–§27, built against the same chain, with
Track 1 as the oracle. This is where Giggora's brand and developer experience live.

Contract verification is delegated to Blockscout/Sourcify in the MVP rather than reimplemented.

This ordering means a working explorer exists at Phase 4 instead of Phase 6, and the
highest-risk subsystem is de-risked by a known-good comparison. **If the goal is primarily to
learn by building the indexer, Track 1 is dropped — but the project gets materially riskier.**

---

## 7. Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Blockchain client | **Hyperledger Besu 26.8.x** (pinned) | §2. |
| Consensus | **QBFT** | §3. |
| Contracts | **Solidity + OpenZeppelin** | Audited standard ERC-20/721/1155. |
| Contract tooling | **Foundry** | Fast, native fuzzing, single binary. |
| Indexer | **TypeScript + viem** | Stronger types and smaller footprint than ethers v6 for indexing. |
| Database | **PostgreSQL 16** | Per §21. |
| Migrations | **Drizzle** or raw SQL | Explicit, reviewable DDL. |
| Explorer API | **Fastify (TypeScript)** | Fast, schema-validated. |
| Explorer UI | **Next.js (App Router) + Tailwind** | §35 requirements; SSR for hash and address pages. |
| Reference explorer | **Blockscout** (self-hosted) | §6. |
| Orchestration | **Docker Compose** | Per §32. No Kubernetes (§33). |
| Reverse proxy | **Caddy** | Automatic HTTPS. |

One language across indexer, API, and UI means shared types for addresses, hashes, and receipts;
one toolchain; one dependency graph. A Go indexer would be marginally faster and cost a
maintainer.

---

## 8. Repository structure

```
giggora/
  blockchain/
    config/            chain.yaml, network.yaml   <- single source of truth
    genesis/           qbftConfigFile.json, generated genesis.json
    scripts/           create-genesis.sh, add-validator.sh
    keys/              .gitignored. NEVER committed.
  contracts/           Foundry project: GigToken, GigNFT, GigMultiToken
  indexer/src/         ingest, decode, checkpoint
  explorer-api/src/    routes, validation, rate limiting
  explorer-web/src/    Next.js UI
  dapp/src/            sample wallet DApp (§41)
  database/migrations/
  docker/
  scripts/
  docs/                architecture.md + the §37 set
  tests/e2e/           the §40 end-to-end flow
  docker-compose.yml
  Makefile
  .env.example
```

Configuration flows one way: `blockchain/config/chain.yaml` → genesis generation → `.env` → every
service. Chain ID, name, symbol, and RPC URL are read from config everywhere, never written as
literals (§3).

---

## 9. Lifecycles

**Transaction:** wallet signs (chainId 4043 inside the signature — EIP-155 replay protection) →
`eth_sendRawTransaction` on the RPC node → mempool → gossiped to validators → proposer includes
it → QBFT round → **final on commit, no confirmations needed** → receipt available.

**Block:** proposer selected round-robin → assembles from mempool → QBFT prepare/commit
supermajority → sealed and final → `newHeads` fires.

**Indexing:** `newHeads` WebSocket → fetch block plus receipts → decode logs against known ABIs →
write block, transactions, receipts, logs, and token transfers in **one database transaction**,
advancing `last_processed_block` within that same transaction. Restart resumes from the checkpoint
and backfills any gap. Idempotent via `ON CONFLICT DO NOTHING` on primary keys. **No reorg
handling required** — QBFT finality is absolute.

**Verification:** user submits source and compiler settings → Blockscout/Sourcify compiles →
compares against deployed bytecode → on match, source and ABI are stored, and the Giggora explorer
renders Read/Write Contract tabs from that ABI.

---

## 10. Implementation phases

Each phase has a binary acceptance test. Nothing is marked PASS without a passing test (§46, §50).

| Phase | Deliverable | Acceptance criteria |
|---|---|---|
| **1** | This document | Signed off. |
| **2** | Chain running | **COMPLETE 2026-09-07.** 4 validators produce blocks; killing 1 does **not** halt the chain; `eth_chainId` returns 4043; GIG transfers change balances; ~2s blocks under load. All 7 checks in `scripts/verify-network.mjs` pass. |
| **3** | Contracts | **COMPLETE 2026-09-07.** ERC-20/721/1155 deploy via Foundry (28 unit tests pass); deployed to devnet with on-chain log shapes verified; `scripts/deploy-contracts.mjs` reproduces it on demand. |
| **4** | Blockscout + indexer | **COMPLETE 2026-09-07.** Blockscout indexes the chain and serves its API. Custom indexer verified field-by-field against RPC, and agrees with Blockscout on blocks, hashes, validators, gas and every transaction hash. `kill -9` mid-index survives with zero gaps, zero duplicates, no lost progress; re-indexing is a no-op. |
| **5** | Explorer API | **COMPLETE 2026-09-07.** All §23 and §24 endpoints, keyset-paginated and validated. 51/51 contract tests: uint256 precision preserved end to end, NULL semantics preserved, no duplicate/skipped rows across pages, injection and malformed input rejected as 400, list query plans index-backed, rate limiting returns 429. |
| **6** | Explorer UI | **COMPLETE 2026-09-07.** All §14 routes render real chain data server-side. Search resolves address/tx/block/token via the API. Homepage blocks and transactions update live without reload. Verified at 375px: document scrollWidth stays 375 while wide tables scroll in-container. Dark/light themes complete. 26/26 UI tests. |
| **7** | Wallet + DApp | **COMPLETE 2026-09-07.** /connect-wallet serves the live chain config with an EIP-3085 add-network button. Sample DApp (dependency-free EIP-1193) connects, reads a balance, sends GIG and ERC-20, and waits for confirmation. 19/19 wallet tests: every RPC method a wallet calls, real signed legacy AND type-2 transactions via eth_sendRawTransaction, and EIP-155 replay protection (chain 4044 rejected, 4043 accepted). Does NOT drive the MetaMask extension UI. |
| **8** | Deployment | Testnet (4042) live on a VPS with TLS, firewall, backups, monitoring. |

**The full §40 end-to-end test runs in CI from Phase 4 onward.** This is the structural defence
against §47's "never fake blockchain functionality": if the E2E test passes against a real chain,
the data cannot be mocked.

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **A chain with no users** | **Highest** | Not a technical risk and not solvable by this document. A general-purpose L1 competes with dozens of established chains for developers and independent validators. The technology is achievable; adoption is the hard part. Recommend defining a launch application before mainnet (4041). |
| Validator key compromise | High | Keys never committed, never baked into images, never exposed via RPC. Env/secret-mounted. Rotation documented. |
| Besu CVEs | High | Five disclosed in 2026. Subscribe to advisories; pin image tags; document a patch SLA. |
| Public RPC abuse | High | Only the RPC node is exposed; ADMIN/DEBUG/MINER namespaces off; reverse-proxy rate limiting; per-key limits (§24). |
| Validator liveness | Medium | 4 validators tolerate 1 loss. Alert on missed proposals. |
| JVM resource use | Medium | Size VPS at roughly 4 GB per validator. |
| Indexer drift | Medium | Blockscout cross-check (§6). |
| Scope overrun | Medium | Phase gating; verification delegated rather than rebuilt. |
| State growth | Low now | Bounded on a low-traffic chain. Revisit pruning before mainnet. |
| Token launch legality | **Unassessed** | A genesis allocation and treasury for a native coin is securities-adjacent in many jurisdictions. Needs counsel before mainnet — not before devnet. Flagged, not solved. |
| Quantum (secp256k1) | Long-dated | See §14. Inherited from EVM compatibility, not caused by any choice here. Not the binding constraint, but it belonged in this table and was missing. |

---

## 12. Complexity estimate

| Phase | Effort |
|---|---|
| 1 Architecture | done |
| 2 Blockchain | 1–1.5 weeks |
| 3 Contracts | 0.5 week |
| 4 Blockscout + indexer | 2–3 weeks |
| 5 Explorer API | 1.5–2 weeks |
| 6 Explorer UI | 3–4 weeks |
| 7 Wallet + DApp | 1 week |
| 8 Deployment | 1–1.5 weeks |
| **Total** | **~11–15 focused weeks** |

Phase 2 — the actual blockchain — is the least risky part. **The explorer UI is the largest single
cost.** Building the verification stack from scratch instead of delegating it would add an
estimated 4–6 weeks and carry the highest defect risk in the project.

---

## 13. Decisions — signed off 2026-09-07

1. **Validator count: 4.** Three gives zero fault tolerance (`f = 0`); four tolerates one
   faulty or crashed validator. Deliberate departure from brief §5. **APPROVED.**
2. **Blockscout as ground truth plus a custom Giggora UI on top** (§6). Contract verification is
   delegated to Blockscout/Sourcify for the MVP rather than reimplemented. **APPROVED.**
3. **Initial GIG supply: 1,000,000,000 GIG** (18 decimals). Genesis allocation:
   | Allocation | Share | Amount |
   |---|---|---|
   | Treasury | 40% | 400,000,000 GIG |
   | Ecosystem / grants | 30% | 300,000,000 GIG |
   | Team | 20% | 200,000,000 GIG |
   | Dev / faucet accounts | 10% | 100,000,000 GIG |
   **APPROVED.** Devnet uses well-known throwaway keys; testnet and mainnet require a real key
   ceremony (§11).
4. **Block reward at genesis: 0.** Pre-mine only, raised later via `transitions` if an emission
   schedule is wanted. **APPROVED.**
5. **MVP target is Devnet 4043.** Testnet 4042 at Phase 8. Mainnet 4041 stays reserved and
   unlaunched until there is an application and independent validators. **APPROVED.**

Phase 1 is complete. Phase 2 is authorised to begin.

---

## 14. Post-quantum exposure

Not in the original brief, and worth stating plainly because the answer is
uncomfortable: **Giggora is not quantum-resistant, and cannot be without ceasing
to be EVM-compatible.** It inherits Ethereum's exposure exactly — no better, no
worse. That is a consequence of §1, not an oversight.

### What is exposed

| Component | Algorithm | Status under a CRQC |
|---|---|---|
| Account signatures | secp256k1 ECDSA | **Broken by Shor's algorithm** |
| QBFT validator block signing | secp256k1 | **Broken by Shor's algorithm** |
| keccak256 hashing | keccak256 | Fine. Grover halves it to ~128-bit, still ample |
| RPC transport (TLS) | see below | Already hybrid-PQ, for free |

Hashing is *not* the problem, despite how often it is lumped in.

One nuance is often overstated: an address is `keccak256(pubkey)[12:]`, so an
account that has **never spent** keeps its public key behind a hash. That
protection disappears the moment it sends a transaction. On Giggora the
load generator alone has sent tens of thousands of transactions from the dev
accounts, and validators sign *every block* — so in practice every key that
matters is already exposed. Address hashing buys nothing for active accounts.

### Current state (verified 2026-09-07)

- **Besu has no post-quantum support.** secp256k1 for transactions, elliptic-curve
  keys for QBFT validator authentication. Nothing PQ anywhere in the client.
- **Ethereum has a real roadmap.** Vitalik Buterin's February 2026 roadmap plus
  the Ethereum Foundation's PQ hub (March 2026, 10+ client teams, weekly interop
  devnets) cover: `leanXMSS` hash-based signatures replacing BLS for validators;
  `leanVM`, a minimal zkVM aggregating those larger signatures (~250x
  compression); and **EIP-8141**, account-abstraction *signature agility*, under
  consideration for the Hegota fork in H2 2026. Initial protocol upgrades are
  targeted for **2029**.

### Decision: inherit, do not invent

**Giggora must not ship its own post-quantum signature scheme.** Any custom
algorithm breaks MetaMask and every EVM tool, which destroys the single property
the chain exists to provide. A "quantum-resistant Giggora" that no wallet can
talk to is worth less than nothing.

EIP-8141's per-account signature agility is the right shape precisely because it
is opt-in and preserves compatibility. Being EVM-compatible means Giggora
inherits it when Besu ships it — an argument *for* the Besu choice, not against.

**This is not the binding constraint.** No CRQC exists, there is no mainnet, no
value is at risk, and Ethereum's own timeline is 2029. The binding constraint
remains the one named at the top of §11: no application and no independent
validators.

### What is actually actionable

| Action | Status |
|---|---|
| Hybrid PQ TLS on the RPC endpoint | **Free.** Caddy (Go 1.24+) negotiates `X25519MLKEM768` by default. Phase 8 gets it without work. |
| Exercise the upgrade mechanism | **Done** — `scripts/test-qbft-transition.mjs`. Any future migration depends on it, and it had never been tested. |
| Validator key rotation runbook | **Done** — `docs/validator-rotation.md`. Rotation is the one PQ mitigation available to a small permissioned validator set. |
| Track EIP-8141 / leanXMSS | Ongoing. Watch Besu releases; do nothing bespoke. |

**Do not** describe Giggora as quantum-resistant. It is not, and neither is
Ethereum.

---

## Sources

Verified 2026-09-07.

- [Besu changelog (releases, Clique removal in 26.4.0, PoW removal in 26.7.0, QBFT fixes in 26.8.x)](https://github.com/hyperledger/besu/blob/main/CHANGELOG.md)
- [Besu QBFT tutorial](https://docs.besu-eth.org/private-networks/tutorials/qbft)
- [Besu QBFT configuration reference](https://docs.besu-eth.org/private-networks/how-to/configure/consensus/qbft)
- [go-ethereum private networks (Clique deprecation)](https://geth.ethereum.org/docs/fundamentals/private-network)
- [Polygon Labs: discontinuing Polygon Edge](https://polygon.technology/blog/polygon-labs-to-focus-contributions-on-polygon-cdk-discontinues-contributions-for-edge)
- [GoQuorum migration guidance](https://docs.goquorum.consensys.io/deploy/upgrade/migration)
- [Cosmos Stack roadmap 2026](https://cosmos.network/blog/the-cosmos-stack-roadmap-2026)
- [Cosmos EVM security incident, Aug 2026](https://crypto.news/cosmos-evm-chains-told-to-halt-after-security-incident/)
- [Avalanche Etna: sovereign L1s](https://www.avax.network/about/blog/etna-enhancing-the-sovereignty-of-avalanche-l1-networks)
- [Blockscout documentation](https://docs.blockscout.com/)
- [ethereum-lists/chains registry (chain ID verification)](https://github.com/ethereum-lists/chains)
- [Besu security advisories, Aug 2026](https://www.crowdfundinsider.com/2026/08/300884-open-source-ethereum-execution-client-hyperledger-besu-resolves-security-vulnerability/)

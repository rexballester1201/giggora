# CLAUDE.md — Giggora

Guidance for Claude Code (and any future agent) working in this repository.

**Status: SHELVED 2026-09-07.** All 8 phases complete and verified. The devnet is
real and runs on one desktop. **Mainnet (chain ID 4041) is not launched and
should not be** until the open decisions below are settled.

---

## 1. What this is

Giggora is an independent, EVM-compatible Layer-1 blockchain with its own native
currency (**GIG**), validator network, and block explorer. It is sovereign after
genesis: no settlement layer, no parent chain, no bridge.

| Property | Value |
|---|---|
| Client | Hyperledger Besu 26.8.1 |
| Consensus | QBFT — Byzantine fault tolerant, **absolute finality, no reorgs** |
| Hardfork | Cancun |
| Native currency | GIG, 18 decimals, 1,000,000,000 total supply |
| Chain IDs | **4041** mainnet (reserved, unlaunched) · **4042** testnet · **4043** devnet |
| Block period | 2s under load · 300s when idle (`emptyblockperiodseconds`) |
| Devnet genesis hash | `0xf3e9fad05dc32b4a341f148f3c5b705c6c6e78a35f517986203f9d007b7c7fd6` |

**Absolute finality is load-bearing in the design.** Because QBFT cannot reorg,
the indexer has no reorg handling, no rollback, no orphan tracking. That is a
large slice of the hardest code in any explorer, deleted by a consensus choice.
Do not "add reorg support" — it would be dead code built on a false premise.

---

## 2. Non-negotiable constraints

These come from the project brief and have been honoured throughout. Breaking
one is a defect regardless of what else the change achieves.

- **Never commit private keys, mnemonics, passwords, API keys or DB credentials.**
  Use `.env.example`. Besu names validator keys literally `key` with no
  extension, so a `*.key` glob does **not** match them — the explicit
  `blockchain/nodes/` and `**/key` rules in `.gitignore` are what actually
  protect them. This was nearly shipped once; four validator keys were staged
  before being caught.
- **Never expose validator private keys through any API.**
- **Never expose unrestricted admin RPC publicly.** `ADMIN`, `DEBUG` and `MINER`
  namespaces are disabled everywhere.
- **Do not expose database ports publicly.**
- **Never fake blockchain functionality or present mock data as real chain
  data.** The explorer reads a database, and when that database is stale it
  says so (see `explorer-web/components/Staleness.tsx`).
- **Never silently ignore errors.**

---

## 3. Repository layout

```
blockchain/config/chain.config.json   SINGLE SOURCE OF TRUTH
blockchain/genesis/                   generated genesis + qbftConfigFile
blockchain/nodes/                     validator keys + chain data (GITIGNORED)
database/migrations/                  001-004, all idempotent
indexer/src/                          crash-safe chain indexer
explorer-api/src/                     Fastify API
explorer-web/                         Next.js 15 App Router UI
dapp/                                 dependency-free EIP-1193 sample DApp
deploy/{validator,rpc,explorer,firewall}/   production topology (NEVER PROVISIONED)
docs/                                 architecture, deployment, runbooks
scripts/                              everything operational
```

**`chain.config.json` is the single source of truth.** Everything else is
generated:

```
chain.config.json → gen-config.mjs → .env + qbftConfigFile.json
                  → besu operator generate-blockchain-config → genesis.json + keys
                  → docker-compose.yml → running network
```

Never hand-edit `.env`, `qbftConfigFile.json` or `genesis.json`. Change
`chain.config.json` and regenerate. The generator **verifies allocations sum to
the declared total supply** and refuses to emit a mismatched genesis.

---

## 4. Things that will bite you

Every item was hit and fixed for real. They are all load-bearing — "simplifying"
one breaks the system in a way that is genuinely hard to diagnose.

### Chain

1. **Cancun works ONLY because EIP-4788 beacon-roots is pre-deployed.** Cancun
   system-calls the beacon-roots contract every block; on a non-PoS chain that
   address is empty and Besu logs `Invalid system call address` forever. The
   genesis pre-deploys it at `0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02`.
   Cancun is not optional: **OpenZeppelin 5.6 emits `mcopy`**, a Cancun opcode,
   so a Shanghai chain cannot compile current OpenZeppelin at all.

2. **`fixedBaseFee: true` is mandatory.** Without it the EIP-1559 base fee decays
   ~12.5% per empty block, drops below `min-gas-price`, and because
   `eth_maxPriorityFeePerGas` returns 0 here, wallets estimate *under* the node's
   floor. Transactions are then accepted into the pool and **silently never
   mined** — MetaMask spins forever with no error. `gen-config.mjs` refuses to
   build a genesis where `baseFeePerGas` and `minGasPriceWei` disagree.

3. **Enode URLs need IP literals, not hostnames.** A DNS name is rejected with
   `Invalid ip address` and every node using that bootnode crash-loops. Hence
   static IPs in `docker-compose.yml`.

4. **Set `--p2p-host` explicitly with `--nat-method=NONE`.** Otherwise Besu's
   Docker NAT manager advertises `enode://…@0.0.0.0:30303`, peers cannot dial
   back, and the bootnode sits at 0 peers while everything stalls.

5. **Discovery alone does not form a mesh — `static-nodes.json` does.** It must
   list every *other* node and never itself; Besu rejects a self-reference.

### QBFT upgrades (`scripts/schedule-transition.mjs`)

Established by testing, not documentation. All three surprised us:

6. **`transitions` must sit INSIDE `config`.** At the top level it is *silently
   ignored* — no error, no warning, the change simply never happens.
7. **It applies at NODE RESTART, not at the scheduled block.** Verified twice: a
   transition scheduled for 1748 was in force at 1731; one scheduled for 2131
   took effect at 2092. The `block` field behaves like a floor, not a trigger.
8. **Stop every node, then start them. Never a rolling restart.** While nodes
   disagree about the block period, proposals fail timestamp validation with
   `TimestampMoreRecentThanParent` and production stalls until round-changes.

### Docker

9. **`tmpfs: /tmp` MUST include `exec`.** Besu extracts JNI libraries to
   `java.io.tmpdir` and `dlopen()`s them. Docker mounts tmpfs `noexec` by
   default, and every validator crash-loops with
   `UnsatisfiedLinkError: libckzg4844jni.so: failed to map segment from shared
   object` — which reads like a corrupt file, not a mount option.
10. **Besu leaks its native libraries to `/tmp` on every start** and never
    cleans up. 15 MB per rocksdb copy; 456 MB per node after a day of restarts.
    It is a **per-restart** leak, not per-block. The tmpfs is the fix.
11. **Logging is fixed at container CREATION.** `docker compose start` does not
    apply a changed `logging:` block — you must recreate. Verify with
    `docker inspect -f '{{.HostConfig.LogConfig.Config}}'`; `map[]` means no cap.
12. **`.dockerignore` is security-critical.** The build context is the repo
    ROOT, so without it `blockchain/nodes/` (validator private keys) and `.env`
    are sent into the context and can land in an image layer. Layers survive
    later deletion and images get pushed.

### Services

13. **`.env` is optional; `process.env` wins.** The indexer and API originally
    *required* the file and crash-looped with `ENOENT: /app/.env` in containers.
14. **The API needs the CHAIN, not just the database.** It reads live balances
    and code from the node because a cached balance is a wrong balance. Missing
    `RPC_URL` kills it at import with "No URL was provided to the Transport."
15. **`API_BASE` resolves per-runtime.** `NEXT_PUBLIC_*` is inlined into *both*
    bundles, so a single `NEXT_PUBLIC_API_BASE ?? API_BASE` makes the server use
    the browser's address. Server uses the private address, browser the public.
16. **The rate limiter trips test suites run back-to-back**, and the suites
    crash on 429 instead of reporting it. Space runs ~60s apart or you will
    chase phantom regressions. This bit us twice.

### Found by the 2026-09-07 security audit (all fixed; every one verified)

17. **`rate_limit` is NOT a Caddy directive.** It is the third-party plugin
    `mholt/caddy-ratelimit`; the stock `caddy:2-alpine` image fails to start on
    it with `unrecognized directive`, taking the whole explorer or RPC down.
    Rate limiting lives in the explorer API. Verify any Caddyfile change with
    `caddy validate` against the stock image before deploying.
18. **The indexer heartbeat is UPDATE-only, never INSERT.** `getCheckpoint()`
    treats "no row" as "start at genesis". An INSERT-on-heartbeat created the row
    with `last_processed_block = 0` before block 0 committed, so the next start
    began at block 1 and **block 0 was skipped permanently**.
19. **`NEXT_PUBLIC_API_BASE` is an ORIGIN, no path.** The web client appends
    `/api/...` itself; a value ending in `/api/v1` made every browser-side call
    hit `/api/v1/api/...` and 404 while server rendering looked fine.
20. **`TRUSTED_PROXY_CIDR` must be a fact, not a guess.** `deploy/explorer`
    pins the compose subnet (`10.230.0.0/24`) and Caddy's address
    (`10.230.0.10`) so the default `/32` is exact. Wrong, every client collapses
    into ONE rate-limit bucket that a single attacker exhausts for everyone.
21. **Scripts that sign with the public Anvil key refuse non-devnet chains.**
    `scripts/lib/devnet-guard.mjs` asks the NODE for `eth_chainId` (not `.env`,
    which is exactly what would be wrong) and exits unless it is 4043.
    `GIGGORA_ALLOW_NON_DEVNET=1` overrides, loudly.
22. **`gen-config.mjs` refuses a PUBLIC network genesis** that funds known dev
    accounts or lacks `consensus.validators` (ceremony public keys). Before
    this, switching `activeNetwork` to mainnet handed 100% of supply to keys in
    every tutorial and minted the validator set on the operator's laptop.
23. **`create-genesis.sh` refuses to delete existing keys without `--force`.**
    It used to `rm -rf blockchain/nodes/` on every run — the running chain's
    identity and history — and the `--keep-keys` flag its header promised was
    never implemented. Copied keys are now `chmod 600`.
24. **`schedule-transition.mjs --revert` is structural and head-aware.** It
    removes only PENDING transitions and refuses one the head has crossed
    (removing a past transition forks the network). The old file-restore put
    back a stale backup and could remove an in-force transition.
25. **Receipts are fetched with bounded concurrency (16).** One `Promise.all`
    over a full block exceeded Besu's `--rpc-http-max-active-connections` (80)
    and turned that block into a crash-restart loop.
26. **Token metadata writes fail CLOSED.** A `name()` returning a NUL byte made
    the UPDATE fail; the row was never stamped, stayed first in the pending
    batch, and wedged metadata for every later token. Strings are NUL-stripped
    and the row is stamped even when the write fails.
27. **`/api/v1/token/transfers?contractaddress&address` is two indexed branches**
    (migration 005), not `from = X OR to = X`, which had no covering index and
    scanned every transfer of the token per request.
28. **Next's `redirect()` THROWS.** It must not be inside a catch-all `try`, or
    the redirect is swallowed — the search page "worked" and went nowhere.
29. **The sample DApp takes NO network config from the query string.** A
    `?rpc=&chainId=` override was a phishing primitive straight into
    `wallet_addEthereumChain`.

---

## 5. Conventions

- **Node 24 native TypeScript type-stripping.** No build step for the indexer or
  API — `node indexer/src/index.ts` runs the source. No tsc, no bundler.
- **Keyset pagination only.** No `OFFSET`, no `count(*)` on request paths —
  totals come from indexer-maintained counters. Cursors are tagged (`blk.1243`).
- **BYTEA** for hashes and addresses; **NUMERIC(78,0)** for uint256, always
  returned as **strings** (they exceed 2^53).
- **Migrations are idempotent** (`IF NOT EXISTS` / `CREATE OR REPLACE`) so
  re-running is always safe. Verified by running them twice.
- **The indexer writes block rows and its checkpoint in ONE transaction**, so a
  `kill -9` at any instant resumes correctly. `ON CONFLICT DO NOTHING`
  everywhere, which keeps counters correct when a range is re-indexed.
- Explorer UI is Next.js 15 App Router, server components, Tailwind 4.

---

## 6. Commands

```bash
npm run stack          # EVERYTHING: chain + indexer + API + UI (containers)
npm run stack:down     # stop it
docker compose up -d   # chain only (explorer services are behind a profile)
npm run verify         # network acceptance test
npm run test:all       # full sweep
npm run monitor        # health: exit 0 ok / 1 warn / 2 critical
npm run backup         # config + genesis + schema (NOT keys, NOT chain data)
npm run contracts:test # Foundry, needs the 622 MB image
```

Run the explorer **either** in containers **or** on the host, never both — they
bind the same ports (3000, 4100).

---

## 7. Verified state

Every number measured, not estimated.

| Suite | Result |
|---|---|
| Network acceptance | 7/7 |
| Contracts (Foundry) | 49/49 + 12/12 on-chain |
| Indexer (over 1000 blocks, SIGKILL-tested) | 8/8 |
| Explorer API | 51/51 |
| API regressions | 12/12 |
| Explorer UI | 28/28 |
| Wallet compatibility | 19/19 |
| QBFT transitions | 11/11 |

**Resource use per validator** (`--profile=ENTERPRISE`):

| | Idle | Under 10 tx/s |
|---|---|---|
| RAM | 284–359 MB | 314–359 MB (barely moves) |
| CPU | 2–4% of a core | 20–57% of a core |

RAM is not the constraint; CPU under sustained load is.

**Disk**: 3,889 bytes/transaction · 43 KB/block at ~11 tx · 9 MB/day logs
(load-independent — Besu's logging is periodic, not per-block). Idle ≈ 4 GB/yr;
1 tx/s sustained ≈ 123 GB/yr. Disk is driven by **use**, not uptime.

**Quorum loss, induced for real**: stopping 2 of 4 validators produced 0 blocks
in 50s under load. Every container stayed *healthy* throughout — a process check
sees nothing wrong. A ~3 minute outage cost ~**7 minutes** of downtime, because
after quorum returned the validators sat in round-change deadlock (split across
rounds 4/5/6) for ~4 more minutes. **Round-change backoff is exponential, so
recovery time grows with outage length.**

---

## 8. Deployed on the devnet

| Contract | Address | Standard |
|---|---|---|
| GigToken (GTT) | `0x5fbdb2315678afecb367f032d93f642f64180aa3` | ERC-20 |
| GigNFT (GIGNFT) | `0xe7f1725e7734ce288f8367e1bb143e90bb3f0512` | ERC-721 |
| GigMultiToken (GIGMT) | `0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0` | ERC-1155 |

---

## 9. Open decisions — do not inherit these by accident

1. **The fee market.** `fixedBaseFee` fixed a real bug but does so by *removing
   the fee market*: the base fee no longer responds to demand. On a congested
   mainnet there is no price signal and the mempool backs up until Besu drops
   transactions at its 4096 default. Either keep it and raise txpool limits, or
   restore EIP-1559 with a `min-gas-price` low enough that a decayed base fee
   still clears it.
2. **Validator count and hosting.** 7 for mainnet, not 4 — seven tolerates two
   failures, four tolerates one, and five buys nothing (efficient sizes are
   `n = 3f+1`). On **separate hosts, providers and regions**.
3. **A real key ceremony**, on the validator hosts themselves. A key generated
   on a shared machine is not a production key.

---

## 10. What does not exist

- **Any application.** Nothing uses this chain.
- **Independent validators.** All four run on one desktop. "Tolerates 1 faulty
  validator" is true of the algorithm and operationally meaningless here. Moving
  to four VPSes owned by the same person changes uptime, not decentralisation.
- **A provisioned deployment.** `deploy/` encodes topology and security posture.
  It has never been run against a real host.
- **A redeployed `GigNFT`.** The devnet instance at `0xe7f1…0512` predates the
  audit's URI-before-mint ordering fix; source and chain differ for that one
  contract until `npm run contracts:deploy` is run again.
- **Bridges, cross-chain, rollups, ZK, staking, governance, DEX, NFT
  marketplace, wallet app, mobile app.** All explicit non-goals for the MVP.

---

## 11. Regulatory note (Philippines)

Not legal advice, but it shapes what is safe to build. Writing and running this
software is unregulated. **Selling, offering or distributing tokens** is not:
SEC MC No. 4 & 5, s. 2025 require CASP registration (₱100M paid-up capital), and
BSP's moratorium on new VASP licences — in place since 1 Sep 2022 — was extended
**indefinitely** from 1 Sep 2025.

Practical consequence: keep it a **testnet with explicitly valueless tokens**,
say so in the README, and ship the software rather than a token. Also note the
Data Privacy Act (RA 10173) right to erasure is incompatible with on-chain
immutability — store hashes and pointers, never personal data.

---

## 12. Working style that fits this repo

- **Measure, don't assume.** Nearly every number in these docs replaced a guess
  that was wrong — including an 8 GB RAM spec that was ~8× oversized, and a
  "Docker writes the chain to C:" diagnosis that was simply false.
- **Test the failure case, not just the happy path.** The staleness banner, the
  backup verifier and the quorum monitor were all only trustworthy after being
  made to fire against a real induced failure.
- **A monitor that cries wolf gets ignored.** The rounds check was correlated
  with liveness precisely because it fired CRITICAL on a healthy chain.
- **Commit messages carry the reasoning.** They are the design record here;
  `git log` is worth reading before changing anything load-bearing.

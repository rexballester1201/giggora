# Giggora

An independent, EVM-compatible Layer-1 blockchain with its own native currency (**GIG**),
validator network, and block explorer.

Giggora is a general-purpose, fast, low-cost chain for digital assets, smart contracts, and
decentralized applications. Developers deploy Ethereum-compatible contracts and tokens without
depending on Ethereum, BSC, or Polygon.

| | |
|---|---|
| Consensus | QBFT (Byzantine fault tolerant, immediate finality) |
| Client | [Hyperledger Besu](https://github.com/hyperledger/besu) 26.8.1 |
| Block time | 2 seconds |
| Native currency | GIG (18 decimals) |
| Total supply | 1,000,000,000 GIG |
| Devnet chain ID | 4043 |

> **Status: all 8 phases COMPLETE.** Chain verified (7/7), contracts deployed (28/28 unit +
> 12/12 on-chain), indexer crash-tested over 1000 blocks (8/8), explorer API (51/51 + 12/12
> regressions), explorer UI (28/28), wallet compatibility (19/19), and production deployment
> topology, monitoring, backups and runbooks.
>
> The devnet is real and running. **Mainnet is not launched** and should not be until the
> open items in [docs/deployment.md](docs/deployment.md) are settled — 7 validators on
> separate hosts, a real key ceremony, and the fee-market decision.
> See [docs/architecture.md](docs/architecture.md) for the full plan.

---

## 📕 Shelved 2026-09-07 — start here

This project is complete and paused, not abandoned. Before touching anything:

| Read | For |
|---|---|
| **[RUN.md](RUN.md)** | **Starting, pausing and stopping it** — the day-to-day commands |
| `run.bat` / `stop.bat` | Windows: double-click to start or stop the whole stack |
| **[HANDOVER.md](HANDOVER.md)** | What state this is in, what is unfinished, the decisions still open |
| **[DEPLOY.md](DEPLOY.md)** | Running it — local, measured hardware specs, production, incidents |
| **[CLAUDE.md](CLAUDE.md)** | Architecture, conventions, and the 16 gotchas that will otherwise cost you a day |
| **[giggora-dossier.html](giggora-dossier.html)** | All three in one offline, printable page (`npm run docs` rebuilds it) |

---

## Prerequisites

- **Docker Desktop**, running
- **Node.js** 20 or newer
- **Bash** (Git Bash on Windows)

`make` is optional — every target has a script equivalent.

---

## Quick start

```bash
npm install
bash scripts/create-genesis.sh
bash scripts/start-network.sh
node scripts/verify-network.mjs
```

That generates a genesis and four validator keys, starts four validators plus one RPC node, and
runs the acceptance test against the live chain.

To tear everything down and start clean:

```bash
docker compose down -v && rm -rf blockchain/nodes blockchain/genesis/networkFiles
```

---

## Connect MetaMask

| Field | Value |
|---|---|
| Network name | Giggora Devnet |
| RPC URL | `http://localhost:8545` |
| Chain ID | `4043` |
| Currency symbol | `GIG` |
| Block explorer | `http://localhost:3000` (see below) |

**Devnet test accounts.** These private keys are published by Foundry/Anvil and Besu. They are
public knowledge and hold no real value. **Never use them on testnet or mainnet.**

| Account | Address | Private key | Balance |
|---|---|---|---|
| Anvil #0 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` | 50,000,000 GIG |
| Anvil #1 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` | 25,000,000 GIG |
| Anvil #2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` | 25,000,000 GIG |

Treasury, ecosystem, and team allocations use the standard Besu dev accounts — see
[`blockchain/config/chain.config.json`](blockchain/config/chain.config.json).

---

## Running the explorer

The chain alone needs nothing else. The explorer is three more processes —
indexer, API, UI — and there are two ways to run them.

**Containers (one command):**

```bash
npm run stack
```

That is `docker compose --profile explorer up -d --build`: chain, indexer, API
and UI together, on http://localhost:3000 with the API on 4100. It builds the
same images `deploy/explorer/` uses, so the devnet exercises what a real
deployment would ship.

They sit behind a compose **profile** rather than running by default: the two
images cost ~800 MB, and on Docker Desktop that lands in a virtual disk that
never shrinks. Someone who only wants a chain to point MetaMask at should not
pay for an explorer they did not ask for. Plain `docker compose up -d` stays
chain-only.

**On the host (for editing the code):**

```bash
node indexer/src/index.ts
```

```bash
node explorer-api/src/server.ts
```

```bash
npm run web:dev
```

Run one way or the other, never both — they bind the same ports.

**If the explorer shows old numbers**, the indexer is not running. The page says
so itself: it carries a banner reading "This page may be out of date" whenever
the indexer has not checked in for 30 seconds. It is reading a database, not the
chain, and it will not pretend otherwise.

---

## Configuration

**`blockchain/config/chain.config.json` is the single source of truth.** Everything else is
generated from it:

```
chain.config.json
      |
      |  scripts/gen-config.mjs
      v
qbftConfigFile.json  +  .env
      |
      |  besu operator generate-blockchain-config
      v
genesis.json  +  validator keys
      |
      v
docker-compose.yml  ->  running network
```

Never hand-edit `.env`, `qbftConfigFile.json`, or `genesis.json`. Change `chain.config.json` and
re-run `bash scripts/create-genesis.sh`.

The generator **verifies that allocations sum to the declared total supply** and refuses to emit a
genesis if they do not.

---

## Commands

| Script | npm | make | Does |
|---|---|---|---|
| `node scripts/gen-config.mjs` | `npm run config` | `make config` | Regenerate `.env` + `qbftConfigFile.json` |
| `bash scripts/create-genesis.sh` | `npm run genesis` | `make genesis` | Full genesis + validator keys |
| `bash scripts/start-network.sh` | `npm start` | `make start` | Start the devnet |
| — | `npm stop` | `make stop` | Stop, keep chain data |
| `node scripts/verify-network.mjs` | `npm run verify` | `make test` | Acceptance test |
| — | `npm run clean` | `make clean` | Delete all chain data and keys |
| `bash scripts/setup-contracts.sh` | `npm run setup:contracts` | `make setup-contracts` | Install OpenZeppelin + forge-std |
| `bash scripts/forge.sh build` | `npm run contracts:build` | `make contracts` | Compile contracts |
| `bash scripts/forge.sh test` | `npm run contracts:test` | `make contracts-test` | Foundry test suite |
| `node scripts/deploy-contracts.mjs` | `npm run contracts:deploy` | `make deploy-contract` | Deploy + verify on chain |
| — | `npm run stack` | `make stack` | **Everything**: chain + indexer + API + explorer UI |
| — | `npm run stack:down` | `make stack-down` | Stop the whole stack |
| — | `npm run stack:logs` | `make stack-logs` | Follow explorer logs |

---

## Network layout

```
  MetaMask / DApps                    Ports
        |                             -----
        v                             8545  RPC HTTP   (public)
   giggora-rpc  ......................8546  RPC WS     (public)
        |  (no validator key)
        |  p2p
   +----+----+----+----+
   |    |    |    |    |              8551-8554  validator debug RPC
  val-1 ... val-4                                (bound to 127.0.0.1)
  (hold signing keys, never public)   30303 p2p  (internal only)
```

Validators are never publicly reachable. The RPC node holds no validator key, and the `ADMIN`,
`DEBUG`, and `MINER` RPC namespaces are disabled everywhere.

---

## Things that will bite you

Every item here was hit and fixed during Phase 2. They are all load-bearing — if you
"simplify" one away, the chain breaks in a way that is genuinely hard to diagnose.

**1. Cancun works, but ONLY because the beacon-roots contract is pre-deployed.**
Giggora runs Cancun. On a non-PoS chain that normally fails: Cancun system-calls the EIP-4788
beacon-roots contract every block, and if that address is empty Besu logs
`Invalid system call address` forever. The genesis therefore pre-deploys the contract at
`0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02`, which is the documented fix for private networks.
`gen-config.mjs` refuses to build a Cancun genesis without it.

Cancun is not a luxury here — **OpenZeppelin 5.6 emits `mcopy`, a Cancun opcode**, so a
Shanghai-only chain cannot compile current OpenZeppelin at all. Contracts must match the chain:

```toml
evm_version = "cancun"
```

**2. `fixedBaseFee: true` is mandatory, and it is subtle.**
Without it the EIP-1559 base fee decays ~12.5% per empty block. On an idle chain it drops below
`min-gas-price`, and because `eth_maxPriorityFeePerGas` returns `0` here, wallets estimate a
`maxFeePerGas` *under* the node's floor. Transactions are then accepted into the pool and
**silently never mined** — MetaMask just spins forever. `fixedBaseFee` pins the base fee at
`baseFeePerGas`, so `baseFee == minGasPrice` and estimates always clear the floor.
`zeroBaseFee` would also "fix" it, but makes gas free and the chain trivially spammable.
`gen-config.mjs` refuses to build a genesis where the two values disagree.

**3. Enode URLs need IP addresses, not hostnames.**
`enode://…@giggora-validator-1:30303` is rejected with `Invalid ip address`, and every node
using that bootnode crash-loops. Hence the static IPs in `docker-compose.yml`.

**4. Set `--p2p-host` explicitly, with `--nat-method=NONE`.**
Left alone, Besu's Docker NAT manager advertises `enode://…@0.0.0.0:30303`. Peers cannot dial
back, and the bootnode ends up with **0 peers** while everything stalls.

**5. Peer discovery alone does not form a mesh here — `static-nodes.json` does.**
With discovery only, every node connects to the bootnode and to nobody else. QBFT validators
cannot exchange prepare/commit messages and the chain sticks at block 1.
`create-genesis.sh` writes a `static-nodes.json` into each node's data directory listing every
*other* node (never itself — self-references are rejected).

**6. An idle chain looks broken but isn't.**
`emptyblockperiodseconds` is 60, so with no transactions you get one block a minute. The 2-second
block period applies **under load**. Do not conclude the chain is halted from a 10-second sample —
send a transaction instead. Both `verify-network.mjs` checks are written this way.

**7. Besu's `generate-blockchain-config` exits 1 on success.**
It reports `Output directory already exists` against a genuinely absent directory while writing
correct output. `create-genesis.sh` therefore validates the artifacts (genesis chain ID, extraData,
key count) instead of trusting the exit code — and still fails hard on any *other* error.

**8. Clique is dead — do not follow older tutorials.**
Clique PoA has been deprecated in go-ethereum since v1.14 and was removed outright in Besu
26.4.0. `puppeth` no longer exists. Any guide using either is EOL. Giggora uses QBFT.

---

## Contracts

Sample ERC-20 / ERC-721 / ERC-1155 contracts live in [`contracts/`](contracts/), built with
Foundry (run via Docker — no local install needed) and OpenZeppelin 5.6.1.

```bash
bash scripts/setup-contracts.sh      # OpenZeppelin + forge-std (pinned)
bash scripts/forge.sh test           # 28 unit tests
node scripts/deploy-contracts.mjs    # deploy to devnet + verify on-chain logs
```

| Contract | Standard | Symbol | Notes |
|---|---|---|---|
| `GigToken` | ERC-20 | GTT | Burnable, owner-mintable, 1,000,000 initial supply |
| `GigNFT` | ERC-721 | GIGNFT | Enumerable + URI storage, so the explorer can list collections |
| `GigMultiToken` | ERC-1155 | GIGMT | Supply-tracking, plus non-standard `name`/`symbol` for token detection |

Deployed addresses are recorded in `deployments/<network>.json`.

The deploy script does more than deploy: it reads the emitted logs back off the chain and asserts
their exact shape — ERC-20 `Transfer` has 3 topics with the value in `data`, ERC-721 `Transfer`
has 4 topics with empty `data`. That distinction is exactly what the Phase 4 indexer will use to
tell the two standards apart.

---

## Indexer

The indexer reads blocks, transactions, receipts and logs from the RPC node into
PostgreSQL, decoding ERC-20/721/1155 transfers as it goes.

```bash
docker compose up -d postgres        # start the database
bash scripts/db-migrate.sh           # apply schema
node indexer/src/index.ts --once     # catch up to the chain head, then exit
node indexer/src/index.ts            # follow the head continuously
node indexer/src/index.ts --status   # how far behind are we?
```

Written in TypeScript and run directly by Node 24's native type stripping — no build step.

**What makes it crash-safe.** A block's rows and the checkpoint advance inside a *single*
database transaction, so `last_processed_block` can never be ahead of the data it
describes. A `kill -9` at any instant rolls back cleanly and the next start resumes
exactly where it stopped. Every insert is `ON CONFLICT DO NOTHING`, so re-indexing a
range is a no-op rather than a duplicate-key crash.

**There is deliberately no reorg handling.** QBFT has absolute finality, so a committed
block can never be replaced. This removes what is normally the hardest part of writing an
indexer. If Giggora ever moves to probabilistic finality this assumption breaks, and
blocks would need a canonical/orphaned flag.

### Verification

```bash
node scripts/verify-indexer.ts          # compare the database against the RPC node
node scripts/test-indexer-recovery.ts   # SIGKILL mid-write, verify clean recovery
node scripts/crosscheck-blockscout.ts   # diff against an independent implementation
```

Three layers, deliberately: the RPC node is canonical truth, the recovery test proves
durability, and Blockscout catches the kind of error a single implementation would make
consistently in both its writer and its reader.

### Blockscout

Blockscout runs alongside as an independent cross-check, in its own database:

```bash
docker compose -f docker-compose.yml -f docker-compose.blockscout.yml up -d blockscout
```

Its API is then at `http://localhost:4000/api/v2/blocks`.

Two settings are non-obvious and were both required to make it index at all:

- **`ETHEREUM_JSONRPC_WS_URL` is required** even with `ETHEREUM_JSONRPC_TRANSPORT: http`.
  Without it the realtime fetcher never establishes a chain head, and `block_catchup`
  logs `Index already caught up` with a null range forever — it looks perfectly healthy
  while indexing nothing at all.
- **Besu needs the `TXPOOL` namespace enabled.** Otherwise Blockscout's pending-transaction
  fetcher gets `Method not enabled`, interprets it as the whole node being down, and flaps
  between fallback URLs.

### A schema difference worth knowing

For ERC-1155 **batch** transfers the two indexers disagree by design:

| | Giggora | Blockscout |
|---|---|---|
| Rows per batch log | one **per token id** | one **per log** |
| Ids / amounts | separate rows, keyed by `batch_index` | `token_ids` / `amounts` arrays |

Ours is normalised so "every transfer of token id X" is an indexed lookup instead of an
array scan. Neither is wrong, so `crosscheck-blockscout.ts` compares at log granularity.
This surfaced as a real off-by-one before it was understood — the cross-check earning its
keep on its first run.

---

## Explorer API

Read-only HTTP API over the indexed data. Fastify, run directly by Node 24 — no build step.

```bash
node explorer-api/src/server.ts      # http://localhost:4100
node scripts/test-api.ts             # 51 contract tests against the running API
```

All §23 routes (`/api/stats`, `/api/blocks`, `/api/transactions`, `/api/address/...`,
`/api/tokens`, `/api/contracts`, `/api/search`) plus the §24 Etherscan-shaped public
surface under `/api/v1/`.

### Four decisions that carry the design

**Keyset pagination, never OFFSET, and no total counts.** OFFSET makes Postgres
materialise and discard every skipped row, so cost grows linearly with page depth and one
crawler can saturate the pool; it is also unstable, because a new block shifts every row
and consecutive pages then duplicate or skip entries. `count(*)` over transactions is an
unbounded sequential scan, so exact totals come from counters the indexer maintains inside
its own per-block transaction.

**Sentinel defaults instead of `IS NULL` cursors.** The obvious
`($1::bigint IS NULL OR number <= $1)` cannot be extracted as an index start condition, so
the *uncursored first page* — the most requested page of all — silently degrades to a full
index scan while cursored pages look fine. Substituting the maximum of the key domain keeps
the predicate `number <= $1`, with an identical plan on page 1 and page 100,000.

**Address feeds are `UNION ALL`, never `from = $1 OR to = $1`.** The OR makes Postgres
BitmapOr both indexes and then sort *every* transaction touching the address to return 25
rows — a disk-spilling sort reachable from a 42-character URL. Two independently bounded
index scans are unioned instead, and self-transfers are de-duplicated in JS over the tiny
result.

**No response schemas.** Fastify serialises with `fast-json-stringify`, which *coerces* to
the declared type. A wei field declared `number` would be silently rounded through a double,
downstream of pg returning it correctly and of every other safeguard. Omitting the schema
means plain `JSON.stringify` and no coercion — every uint256 leaves as a string, and a test
asserts it.

### What the API will not pretend to know

The schema holds no balance state, so token holdings and holder counts are not derivable.
Those fields return `null` with an explicit reason rather than a slow, wrong number
aggregated from transfer history. Native balance is read from the node.

---

## Explorer UI

```bash
npm --prefix explorer-web install
npm --prefix explorer-web run build
npm --prefix explorer-web run start     # http://localhost:3000
node scripts/test-explorer-web.mjs      # 26 tests against the running UI
```

Next.js App Router + Tailwind 4. All §14 routes: `/`, `/blocks`, `/block/[number]`,
`/transactions`, `/tx/[hash]`, `/address/[address]`, `/tokens`, `/token/[address]`,
`/contracts`, `/validators`, `/charts`, `/search`.

Point it at a different API with `NEXT_PUBLIC_API_BASE` (browser) and `API_BASE` (server).

### What the UI refuses to invent

The brief asks for holder counts, token holdings and validator uptime. **None of those are
derivable from the indexed data**, so the UI says so in place of each one rather than
showing a plausible number. Summing transfer history to guess a balance would be both
unbounded and wrong — it misses the genesis allocation and gas spend entirely. An explorer
that displays a confident wrong balance is worse than one that admits the gap.

Validator statistics *are* shown, because §27 explicitly permits deriving them from indexed
blocks — but from a bounded recent window, never a full-table aggregate behind an anonymous
page load.

### Precision, in the last mile

Every wei value is formatted with **BigInt arithmetic**, never `Number()`. The whole stack
has been built to keep uint256 intact; parsing it into a double in the render layer would
throw that away at the final step. A test asserts the treasury balance renders exactly.

### Responsive (§36)

Verified at 375px: the document's `scrollWidth` stays exactly 375 while wide tables scroll
inside their own container — the page body never scrolls horizontally. Dark and light
themes are both complete palettes, applied before first paint so there is no flash.

---

## Wallets and the sample DApp

Giggora is a standard EVM chain, so MetaMask and any other EIP-1193 wallet work without
a plugin or a fork.

```bash
# network config, one-click add, devnet test keys
http://localhost:3000/connect-wallet

# sample DApp: connect, balance, send GIG, send ERC-20, wait for confirmation
node dapp/serve.mjs                # http://localhost:3001

node scripts/test-wallet.mjs       # 19 wallet compatibility tests
```

The DApp is deliberately **dependency-free** — raw EIP-1193, no web3 library, no bundler.
What it demonstrates is the *chain*; a framework in the middle would obscure that.

### What the wallet tests actually prove

They do **not** drive the MetaMask extension UI, and this repository does not claim to.
A wallet is two things — a signer and a JSON-RPC client — so the tests cover both parts
Giggora is responsible for:

- every RPC method a wallet calls during a send, including `eth_feeHistory` and
  `eth_maxPriorityFeePerGas`, without which a wallet cannot build an EIP-1559 fee;
- **real secp256k1-signed transactions**, legacy *and* type-2, broadcast through
  `eth_sendRawTransaction` — byte-for-byte the submission path MetaMask uses after the
  user clicks Confirm;
- **EIP-155 replay protection**: a transaction signed for chain 4044 is rejected with
  `Wrong chainId`, while the identical transaction signed for 4043 is accepted.

What remains unverified here is Consensys's extension UI, which is not our code.

### One trap worth recording

viem's `walletClient` **silently overrides the `chainId` you pass** with its own
configured chain. The first version of the replay-protection test signed "for chain 4044"
through the client, got a valid 4043 transaction back, and reported that Giggora accepts
foreign-chain transactions — an alarming finding that was purely an artefact of the test.
Signing offline with `account.signTransaction` takes the chain id literally, and is the
only way to actually exercise this.

---

## Security

- Validator keys live in `blockchain/nodes/*/key`, are gitignored, and are never baked into an
  image or exposed over RPC.
- `.env` is generated and contains no secrets.
- The minimum gas price is deliberately non-zero — a zero-gas chain is trivially spammable.
- Devnet keys are public knowledge. Testnet and mainnet require a real key ceremony.

Full detail in [docs/architecture.md](docs/architecture.md) §11.

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — foundation evaluation, consensus design,
  network architecture, phase plan, risks, and complexity estimate.

---

## Licence

Not yet chosen.

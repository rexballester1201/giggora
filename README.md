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

> **Status: Phases 1-4 of 8 COMPLETE.** Chain running and verified (7/7 network checks),
> ERC-20/721/1155 contracts deployed (28/28 unit tests, 12/12 on-chain checks), and the
> indexer is running, crash-tested under SIGKILL, and cross-checked against Blockscout.
> The explorer API and explorer UI are not yet built.
> See [docs/architecture.md](docs/architecture.md) for the full plan.

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
| Block explorer | *(not yet — Phase 4)* |

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

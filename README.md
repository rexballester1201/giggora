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

> **Status: Phase 2 of 8 COMPLETE.** The chain, genesis, and local network are implemented,
> running, and verified end to end by `node scripts/verify-network.mjs` (7/7 checks).
> The indexer, explorer API, and explorer UI are not yet built.
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

**1. Contracts must target Shanghai, not Cancun.**
Giggora runs the Shanghai fork. `cancunTime` on a QBFT chain makes Besu attempt EIP-4788
beacon-root system calls that only exist on a proof-of-stake chain, producing
`Invalid system call address` errors every block. Shanghai still gives you `PUSH0`, which
Solidity ≥0.8.20 emits by default. In `foundry.toml`:

```toml
evm_version = "shanghai"
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

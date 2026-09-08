# Running Giggora

Start, pause, stop. Every command here was run against this machine before it
was written down.

**Docker Desktop must be running first.** Everything else is one command.

---

## Start everything

**Windows: double-click `run.bat`.** It starts Docker Desktop for you if it is
not already running, waits for the engine, brings everything up, waits until the
websites actually answer, prints the addresses and opens the explorer. Stop with
`stop.bat`.

Or, from a terminal:

```bash
npm run stack
```

That brings up **ten containers**: four validators, an RPC node, Postgres, the
database migrations, the indexer, the explorer API, the explorer UI and the
faucet. Migrations run automatically and are idempotent, so it is safe every
time.

First run takes a few minutes (it builds two images). After that, ~40 seconds.

| | |
|---|---|
| **Explorer** | http://localhost:3000 |
| **Faucet** | http://localhost:4200 |
| JSON-RPC | http://localhost:8545 |
| Explorer API | http://localhost:4100 |

All four bind to **localhost only** — nothing is reachable from your network.

### Chain only, no websites

```bash
docker compose up -d
```

Six containers instead of ten. The explorer and faucet sit behind a compose
*profile* because their two images cost ~800 MB, and on Docker Desktop that
lands in a virtual disk that never shrinks. Use this if you only want something
to point MetaMask at.

---

## Pause and resume

**Pause** — containers stop, nothing is deleted, chain data and faucet ledger
are kept:

```bash
npm run stack:stop
```

**Resume** — picks up exactly where it left off:

```bash
npm run stack:start
```

Verified: the chain continued from block 2280 to 2281 rather than restarting,
and the faucet's ledger still showed its 2 claims and 20 GIG dispensed.

Resuming takes ~40 seconds. The chain needs a moment to re-form consensus — the
explorer may briefly show stale data and says so on the page rather than
pretending otherwise.

---

## Stop

**Stop and remove the containers.** Your chain data, database and validator keys
all survive; `npm run stack` rebuilds the containers around them:

```bash
npm run stack:down
```

Use this when you are done for a while. It frees the memory; pausing does not.

### Deleting everything (destructive)

```bash
docker compose --profile explorer down -v
```

The `-v` also deletes the **Postgres volume**: every indexed block, every faucet
claim, the whole database. The chain itself survives (it lives in
`blockchain/nodes/`), and re-running the indexer rebuilds the database from it.

To delete the **chain** as well — including the validator private keys, which
cannot be recovered:

```bash
npm run clean
```

---

## Check on it

```bash
npm run stack:status
```

```bash
npm run monitor
```

`monitor` is the useful one. It exits `0` ok, `1` warning, `2` critical, and
checks the things a process check misses — quorum, whether any validator has
stopped proposing, round-change escalation, and whether the indexer has fallen
behind. **QBFT does not degrade; it stops.** Below quorum every container still
reports healthy while no blocks are produced, which is exactly why this exists.

Logs:

```bash
npm run stack:logs
```

```bash
docker compose logs -f validator-1
```

---

## First time, or after `npm run clean`

Only needed if `blockchain/genesis/genesis.json` does not exist:

```bash
npm install
```

```bash
bash scripts/create-genesis.sh
```

```bash
npm run stack
```

`create-genesis.sh` **refuses to run if validator keys already exist**, because
regenerating a genesis would delete the running chain's identity and history.
Pass `--force` only if you genuinely mean to start a new chain.

---

## Connect a wallet

| Field | Value |
|---|---|
| Network name | Giggora Devnet |
| RPC URL | `http://localhost:8545` |
| Chain ID | `4043` |
| Currency symbol | `GIG` |
| Block explorer | `http://localhost:3000` |

Or open http://localhost:3000/connect-wallet and click the button. Then get GIG
from the faucet at http://localhost:4200.

---

## When something looks wrong

**The explorer shows old numbers.** The indexer is not running or has fallen
behind. The page tells you so itself with a banner — it reads a database, not
the chain, and will not pretend the two agree. `npm run stack:status` will show
whether `giggora-indexer` is up.

**"API unreachable" on the explorer.** The API container is down. Check
`docker logs giggora-api`.

**No new blocks.** Check `npm run monitor`. If it says quorum is lost, at least
three of the four validators must be running. **Recovery takes longer than the
outage** — a 3-minute outage cost about 7 minutes, because the validators
re-converge through round changes with exponential backoff. Wait ten minutes
before intervening; restarting nodes to "help" resets their progress and makes
it worse. Full procedure in [docs/runbook-quorum-loss.md](docs/runbook-quorum-loss.md).

**Docker itself will not start** (Windows). `scripts/fix-docker.ps1` clears the
stale socket reparse points that cause it.

**Ports already in use.** Something else is on 3000, 4100, 4200, 8545 or 5433.
The faucet and explorer can also be run directly on the host (`npm run faucet`,
`npm run web:dev`) — but run them *either* in containers *or* on the host, never
both, because they bind the same ports.

---

## Every command

| Command | Does |
|---|---|
| **`run.bat`** | **Start everything** (double-click; starts Docker Desktop if needed) |
| **`stop.bat`** | **Stop everything** (removes containers; deletes nothing) |
| `npm run stack` | Start everything (chain + explorer + faucet) |
| `npm run stack:stop` | **Pause** — keeps containers and data |
| `npm run stack:start` | Resume from a pause |
| `npm run stack:down` | Stop and remove containers; data kept |
| `npm run stack:status` | What is running |
| `npm run stack:logs` | Follow indexer / API / web logs |
| `docker compose up -d` | Chain only, no websites |
| `npm run monitor` | Health check; exit 0 / 1 / 2 |
| `npm run verify` | Network acceptance test |
| `npm run test:all` | Full test sweep |
| `npm run faucet:test` | Faucet tests (needs the stack up) |
| `npm run backup` | Back up genesis, config and schema |
| `npm run clean` | **Delete the chain and all keys** |

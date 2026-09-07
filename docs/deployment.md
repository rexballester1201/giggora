# Deployment

How to run Giggora somewhere other than one developer laptop.

The devnet `docker-compose.yml` at the repo root deliberately runs everything on
one machine. That is right for development and wrong for anything else — see
[`deploy/README.md`](../deploy/README.md) for the split-by-role topology this
document assumes.

---

## Prerequisites per host

| Role | vCPU | RAM | Disk | Public |
|---|---|---|---|---|
| Validator | 2 | 8 GB | 100 GB SSD | **none** |
| RPC node | 4 | 8 GB | 200 GB SSD | 443 only |
| Explorer | 4 | 8 GB | 200 GB SSD | 443 only |

RAM is sized for the JVM. Besu on Java wants 4 GB of heap comfortably; 8 GB of
host memory leaves room for the OS and page cache. This is the accepted cost of
the Besu choice (architecture.md §2.3).

Disk grows with chain length. Monitor it — a validator that runs out of disk
stops, and enough of those is a quorum loss.

---

## 1. Key ceremony

Do this first and do it properly, because it is the one step that cannot be
redone later without a validator rotation.

```bash
# ON EACH VALIDATOR HOST, not on a shared machine
docker run --rm -v "$PWD/data:/data" hyperledger/besu:26.8.1 \
  --data-path=/data public-key export-address --to=/data/address
```

Rules:

- A key generated on a shared machine is **not** a production key. It has been on
  a filesystem you do not fully control.
- `chmod 600`, owned by the user the container runs as.
- Never in git, never in an image layer, never in a backup that leaves the host.
  `scripts/backup.sh` deliberately excludes them.
- Record the **addresses** (public) centrally; they go into the genesis.

---

## 2. Genesis

Generate once, distribute everywhere, byte-identical.

```bash
bash scripts/create-genesis.sh
sha256sum blockchain/genesis/genesis.json
```

Copy that file to every node and verify the hash matches on each. A differing
genesis means a different chain, and the symptom is a chain that never forms
consensus while every node looks healthy.

Before generating a **mainnet** genesis, settle these — they are permanent:

- chain ID **4041** (reserved, verified free)
- initial supply and allocation (architecture.md §13.3)
- `blockperiodseconds`, `emptyblockperiodseconds`
- `blockreward` — 0 at genesis is the current decision
- validator set (**7** for mainnet, not 4)
- `fixedBaseFee` — keep it, or accept a live fee market? See §"Fee market" below.

---

## 3. Validators

One per host, from `deploy/validator/`:

```bash
cp deploy/validator/.env.example .env     # edit per host
cp <genesis.json> <static-nodes.json> <key> .
sudo PEERS="10.0.0.12 10.0.0.13 10.0.0.14 10.0.0.20" \
     SSH_FROM="203.0.113.5" \
     bash deploy/firewall/validator-ufw.sh
docker compose up -d
```

**Bring up all validators before expecting blocks.** Below quorum nothing
happens, which looks like failure and is not.

`static-nodes.json` must list every *other* node — never itself; Besu rejects a
self-reference. `scripts/create-genesis.sh` generates these correctly.

---

## 4. RPC node and TLS

```bash
cp deploy/rpc/.env.example .env           # set PUBLIC_HOSTNAME, ACME_EMAIL
sudo PEERS="10.0.0.11 10.0.0.12 10.0.0.13 10.0.0.14" \
     SSH_FROM="203.0.113.5" \
     bash deploy/firewall/rpc-ufw.sh
docker compose up -d
```

Caddy obtains certificates automatically. Test against the ACME staging endpoint
first (commented in the Caddyfile) to avoid rate limits.

**Post-quantum TLS comes free here.** Caddy is Go-based and Go 1.24+ negotiates
the `X25519MLKEM768` hybrid key exchange by default, so RPC sessions are already
protected against harvest-now-decrypt-later. Verify:

```bash
openssl s_client -connect rpc.giggora.example:443 -groups X25519MLKEM768 </dev/null 2>&1 | grep -i "group\|Negotiated"
```

This protects the **transport only**. The chain's secp256k1 signatures are not
post-quantum (architecture.md §14). Do not conflate the two, and do not describe
Giggora as quantum-resistant on the strength of its TLS.

---

## 5. Explorer stack

Postgres, migrations, indexer, API, web — from `deploy/explorer/`. Postgres must
not be publicly reachable (brief §32); it listens on the private network only.

```bash
bash scripts/db-migrate.sh
node indexer/src/index.ts          # or as a service unit
node explorer-api/src/server.ts
npm --prefix explorer-web run build && npm --prefix explorer-web run start
```

Set `TRUSTED_PROXY_CIDR` to Caddy's address on the API. Left unset behind a proxy
every request appears to come from the proxy and the rate limiter collapses into
one global bucket; set to `true` it becomes client-controlled and the limiter is
decorative.

---

## 6. Monitoring

```bash
# every minute, per host
* * * * * cd /opt/giggora && node scripts/monitor-chain.mjs --json >> /var/log/giggora-health.log 2>&1
```

Exit codes: `0` ok, `1` warn, `2` critical. Alert on `2`; review `1` daily.

Alert on these specifically, because a process check catches none of them:

- **quorum** — fires before liveness, roughly two minutes of warning
- **proposers** — a validator in the set that has stopped producing
- **rounds** — escalation, correlated with liveness so recovery churn does not page anyone
- **indexer lag** — the explorer serving stale data while looking healthy

Besu also exposes Prometheus metrics on `127.0.0.1:9545` (`--metrics-enabled`, set
in the deploy compose files). Scrape over the private network; never expose it.

---

## 7. Backups

```bash
bash scripts/backup.sh --with-index
bash scripts/backup.sh --verify backups/<timestamp>
```

**Verify every backup.** An unverified backup is a hope, not a backup — the
verifier parses the genesis rather than checking the file exists, and an earlier
version of it reported a perfectly good backup as corrupt because of a path bug.

What is deliberately *not* backed up, and why, is documented in the header of
`scripts/backup.sh`. The short version: validator keys go out of band and
encrypted; Besu chain data re-syncs from peers and is a cache.

---

## 8. Upgrades

| Change | Procedure |
|---|---|
| Besu version | Pin the new tag, cycle **one node at a time**, verify it rejoins |
| Consensus parameters | `scripts/schedule-transition.mjs` — read its caveats first |
| Validator set | `docs/validator-rotation.md` — add before removing |
| Explorer / indexer / API | Ordinary rolling deploys; they hold no consensus state |

Consensus parameter changes require stopping **every** node together, not a
rolling restart. Rolling restarts cause `TimestampMoreRecentThanParent` stalls
while nodes disagree about the block period.

---

## Fee market: a decision still open

`fixedBaseFee` is currently on. It fixed a real bug — the EIP-1559 base fee
decayed below `min-gas-price` on an idle chain, wallets then underpaid the floor,
and transactions were accepted into the mempool and silently never mined.

But it fixes it by **removing the fee market**: the base fee no longer responds
to demand. On a devnet that is free. On a mainnet with real congestion there is
no price signal to prioritise transactions, and the mempool simply backs up until
Besu drops transactions at its 4096 default.

Decide before mainnet:

- **Keep `fixedBaseFee`** — predictable, simple, no congestion pricing. Raise
  `txpool` limits and monitor depth.
- **Restore EIP-1559 dynamics** — set `min-gas-price` low enough that a decayed
  base fee still clears it, so the original bug cannot recur.

Do not inherit this by accident.

---

## Known-good state

Everything below was measured on the running devnet, not assumed:

| Property | Value |
|---|---|
| Block period under load | ~2.0s |
| Empty-block period (idle) | 60s |
| Proposer distribution | even (25/24/25/26 per 100 blocks) |
| Quorum loss (2 of 4 down) | chain halts, 0 blocks |
| Recovery after quorum restore | minutes, exponential round-change backoff |
| Indexer throughput | ~15 blocks/s catching up |

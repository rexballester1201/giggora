# DEPLOY — Giggora

The single entry point for running Giggora, from a laptop to a real network.

Depth lives in [`docs/deployment.md`](docs/deployment.md),
[`deploy/README.md`](deploy/README.md),
[`docs/runbook-quorum-loss.md`](docs/runbook-quorum-loss.md) and
[`docs/validator-rotation.md`](docs/validator-rotation.md). This file is the map.

> **Nothing here has been provisioned against a real host.** The compose files,
> Caddyfile and firewall rules encode topology and security posture. They are a
> reasoned starting point, not evidence of a deployment.

---

## 1. Local — the whole stack

```bash
npm install
bash scripts/create-genesis.sh
npm run stack
```

That generates a genesis and four validator keys, then brings up chain, indexer,
API and explorer UI in containers.

| Service | URL |
|---|---|
| Explorer UI | http://localhost:3000 |
| Explorer API | http://localhost:4100 |
| JSON-RPC | http://localhost:8545 |
| JSON-RPC (WS) | ws://localhost:8546 |

```bash
npm run verify        # network acceptance test, 7/7 expected
npm run monitor       # health; exit 0 ok / 1 warn / 2 critical
npm run stack:down    # stop everything
```

**Chain only** (no explorer, much lighter):

```bash
docker compose up -d
```

The explorer services sit behind a compose profile deliberately — the two images
cost ~800 MB and land in a virtual disk that never shrinks.

**Run the explorer in containers OR on the host, never both** — they bind the
same ports (3000, 4100). On the host, for editing code:

```bash
node indexer/src/index.ts
```

```bash
node explorer-api/src/server.ts
```

```bash
npm run web:dev
```

### Connect MetaMask

| Field | Value |
|---|---|
| Network name | Giggora Devnet |
| RPC URL | `http://localhost:8545` |
| Chain ID | `4043` |
| Currency symbol | `GIG` |
| Block explorer | `http://localhost:3000` |

Devnet accounts use published Anvil/Besu dev keys. They are public knowledge and
hold no value. **Never use them on testnet or mainnet.**

### Deploying a contract via Remix

Point MetaMask at Giggora, then use **Injected Provider – MetaMask**.

**Set EVM version to `cancun`** in Advanced Configurations. Giggora is a Cancun
chain; newer compilers default to Prague and emit opcodes the validators do not
implement. It fails in a way that looks like a Remix bug rather than a config
one.

---

## 2. Hardware, measured

Not estimated from documentation — measured on a running chain with
`--profile=ENTERPRISE`, the same flag `deploy/` uses.

| | Idle | Under 10 tx/s |
|---|---|---|
| RAM per validator | 284–359 MB | 314–359 MB (barely moves) |
| CPU per validator | 2–4% of a core | 20–57% of a core |

**RAM is not the constraint. CPU under sustained load is.**

### What to provision

| Role | vCPU | RAM | Disk | Public |
|---|---|---|---|---|
| Validator | 2 | 4 GB | 80 GB SSD | **none** |
| RPC node | 4 | 4 GB | 160 GB SSD | 443 only |
| Explorer | 4 | 8 GB | 200 GB SSD | 443 only |

4 GB rather than the observed ~350 MB, deliberately: the JVM sizes its heap from
available memory, so a 2 GB host shrinks the heap and can spend its time in GC
under load it would otherwise absorb. And memory grows with **state**, not block
count — 2,000 blocks holding a few contracts is not a state size.

### Disk growth

| | Measured |
|---|---|
| Per transaction | 3,889 bytes |
| Per block (~11 tx) | 43 KB |
| Besu logs at INFO | 9 MB/day, **independent of load** |

| Usage | Per day | Per year |
|---|---|---|
| Idle | ~11 MB | ~4 GB |
| 1 tx/s sustained | 337 MB | ~123 GB |
| 10 tx/s sustained | 3.4 GB | ~1.2 TB |

Disk is driven by **use**, not uptime. Cap the logs — they grow whether or not
anyone uses the chain, and on Docker they land in a virtual disk that never
shrinks.

### Cost, for reference

| Provider | Plan | Specs | Price |
|---|---|---|---|
| Contabo | Cloud VPS 4 | 4 vCPU, 8 GB, 100 GB SSD | ~€5.50/mo |
| Hetzner | CX33 | 4 vCPU, 8 GB, 80 GB NVMe | ~€8.49/mo |
| DigitalOcean | General Purpose | 8 GB | ~$63/mo |

7 validators + RPC + explorer ≈ **€50–80/month** at the first two.

---

## 3. Production topology

Split by role. The devnet's four-validators-on-one-box layout gives the
*appearance* of fault tolerance while sharing a kernel, a disk and a blast
radius.

```
                       Internet
                          │  443 only
                   ┌──────┴──────┐
                   │    Caddy    │  TLS, rate limit, hybrid PQ key exchange
                   └──────┬──────┘
                          │ 127.0.0.1
                   ┌──────┴──────┐
                   │  RPC node   │  holds NO validator key → cannot propose
                   └──────┬──────┘
                          │ p2p 30303, allow-listed to validator IPs only
      ┌───────────┬───────┴───────┬───────────┐
  validator-1  validator-2   validator-3  validator-4      ... 7 for mainnet
   host A        host B         host C       host D
   (never reachable from the internet)

   explorer host: Postgres + indexer + API + web → reads the RPC node
```

### Sizing

| n | Quorum | Survives down | Survives byzantine |
|---|---|---|---|
| 4 | 3 | 1 | 1 |
| **7** | **5** | **2** | **2** |
| 10 | 7 | 3 | 3 |

**Use 7 for mainnet.** Five buys nothing over four — efficient sizes are
`n = 3f+1`. Spread across **different providers and regions**; several VPSes
from one provider in one region is a correlated failure, not independent ones.

---

## 4. Order of deployment

1. **Key ceremony** — generate keys **on each validator host**, not on a shared
   machine. `chmod 600`. Never in git, never in an image layer, never in a
   backup that leaves the host. Record the *addresses* centrally; they go into
   the genesis. This is the one step that cannot be redone without a rotation.

2. **Genesis** — generate once, distribute byte-identical, verify the hash on
   every node.

   ```bash
   bash scripts/create-genesis.sh && sha256sum blockchain/genesis/genesis.json
   ```

   A differing genesis means a different chain, and the symptom is a network
   that never forms consensus while every node looks healthy.

   Settle these first — they are permanent: chain ID **4041**, initial supply and
   allocation, `blockperiodseconds` / `emptyblockperiodseconds`, `blockreward`
   (0 at genesis is the current decision), the validator set, and the fee-market
   question below.

3. **Validators** — one per host, from `deploy/validator/`. **Bring up all of
   them before expecting blocks**; below quorum nothing happens, which looks
   like failure and is not.

4. **RPC node** — `deploy/rpc/`. Joins as a non-validator, syncs, serves.

5. **Caddy** — TLS in front of the RPC node. Test against the ACME *staging*
   endpoint first to avoid rate limits.

6. **Explorer stack** — `deploy/explorer/`. Postgres must not be publicly
   reachable. Set `TRUSTED_PROXY_CIDR` to Caddy's address: unset, every request
   appears to come from the proxy and the rate limiter collapses into one global
   bucket; set to `true`, it becomes client-controlled and decorative.

7. **Monitoring** — one-minute timer, per host.

### Firewall

```bash
sudo PEERS="10.0.0.12 10.0.0.13 10.0.0.14 10.0.0.20" SSH_FROM="203.0.113.5" \
  bash deploy/firewall/validator-ufw.sh
```

Validators accept p2p only from each other and the RPC node. Nothing else, from
anywhere.

### Post-quantum TLS comes free

Caddy is Go-based, and Go 1.24+ negotiates the `X25519MLKEM768` hybrid key
exchange by default, so RPC and explorer sessions already resist
harvest-now-decrypt-later.

```bash
openssl s_client -connect rpc.giggora.example:443 -groups X25519MLKEM768 </dev/null 2>&1 | grep -i "group\|Negotiated"
```

**This protects the transport only.** The chain's secp256k1 signatures are not
post-quantum. Do not describe Giggora as quantum-resistant on the strength of
its TLS.

---

## 5. Monitoring

```bash
* * * * * cd /opt/giggora && node scripts/monitor-chain.mjs --json >> /var/log/giggora-health.log 2>&1
```

Exit `0` ok, `1` warn, `2` critical. **Alert on 2**; review 1 daily.

Alert on these specifically, because a process check catches none of them:

- **quorum** — fires ~2 minutes before liveness does
- **proposers** — a validator still in the set that has stopped producing
- **rounds** — escalation, correlated with liveness so recovery churn does not page
- **indexer lag** — the explorer serving stale data while looking healthy

Besu also exposes Prometheus metrics on `127.0.0.1:9545`. Scrape over the
private network; never expose it.

---

## 6. Backups

```bash
bash scripts/backup.sh --with-index
bash scripts/backup.sh --verify backups/<timestamp>
```

**Verify every backup.** An unverified backup is a hope — the verifier parses
the genesis rather than checking the file exists, and an earlier version of it
reported a perfectly good backup as corrupt because of a path bug.

Deliberately **not** backed up: validator private keys (a key that travels to a
backup server has a second attack surface — back them up out of band, encrypted)
and Besu chain data (a cache that re-syncs from peers).

---

## 7. Upgrades

| Change | Procedure |
|---|---|
| Besu version | Pin the new tag, cycle **one node at a time**, verify it rejoins |
| Consensus parameters | `scripts/schedule-transition.mjs` — read its caveats first |
| Validator set | `docs/validator-rotation.md` — add before removing |
| Explorer / indexer / API | Ordinary rolling deploys; they hold no consensus state |

**Consensus parameter changes require stopping every node together.** A rolling
restart causes `TimestampMoreRecentThanParent` stalls while nodes disagree about
the block period. And the change applies at **restart**, not at the scheduled
block — the `block` field is a floor, not a trigger.

---

## 8. When it breaks

**QBFT does not degrade. It stops.** Below quorum, block production is exactly
zero and every container stays healthy. Full procedure in
[`docs/runbook-quorum-loss.md`](docs/runbook-quorum-loss.md); the essentials:

- **Restore quorum. That is the whole fix.** Start enough validators to reach
  `ceil(2n/3)`.
- **Then wait — expect recovery to take longer than the outage.** A ~3 minute
  quorum loss cost ~7 minutes of downtime; the validators sat in round-change
  deadlock for ~4 minutes after quorum returned. Backoff is exponential.
- **Do not restart nodes to "help".** Every restart resets that node's progress.
  Wait at least 10 minutes after quorum is restored before intervening further.
- **You cannot vote out a dead validator without quorum** —
  `qbft_proposeValidatorVote` needs a majority of the current set. You cannot
  shrink your way out. Prevention matters more than recovery.
- **You cannot roll back.** QBFT finality is absolute.

---

## 9. Before mainnet — unresolved

**The fee market.** `fixedBaseFee` is on. It fixed a real bug (base fee decayed
below `min-gas-price`, wallets underpaid, transactions accepted and silently
never mined) but removes congestion pricing entirely. Either keep it and raise
txpool limits, or restore EIP-1559 with a low enough `min-gas-price` that the
original bug cannot recur. **Do not inherit this by accident.**

**Seven validators on separate providers**, and **a real key ceremony**.

**Regulatory (Philippines).** Running the software is unregulated; selling,
offering or distributing tokens is not. SEC MC No. 4 & 5, s. 2025 require CASP
registration (₱100M paid-up capital), and BSP's moratorium on new VASP licences
has been extended indefinitely since 1 September 2025. Keep it a testnet with
explicitly valueless tokens and say so plainly, or take advice before issuing
anything.

# Giggora production deployment

The devnet `docker-compose.yml` at the repo root runs **all four validators plus
everything else on one machine**. That is correct for development and wrong for
anything else: it gives the *appearance* of fault tolerance while sharing a
kernel, a disk, a power supply and a blast radius. One host failure takes the
whole validator set, and QBFT does not degrade — below quorum it stops.

This directory splits the stack by role so each part can live where it belongs.

```
deploy/
  validator/    ONE validator per host. No public ports. Holds signing keys.
  rpc/          Public JSON-RPC behind Caddy (TLS). Holds NO validator key.
  explorer/     Postgres + indexer + API + web UI.
  firewall/     ufw rulesets per role.
```

## Topology

```
                       Internet
                          │
                    443 (TLS only)
                          │
                   ┌──────┴──────┐
                   │    Caddy    │  HTTPS, rate limit, hybrid PQ TLS
                   └──────┬──────┘
                          │ 127.0.0.1
                   ┌──────┴──────┐
                   │  RPC node   │  no validator key → cannot propose
                   └──────┬──────┘
                          │ p2p 30303, allow-listed to validator IPs only
      ┌───────────┬───────┴───────┬───────────┐
      │           │               │           │
  validator-1 validator-2    validator-3 validator-4
   host A       host B          host C      host D
   (never reachable from the internet)

   explorer host: Postgres + indexer + API + web  →  reads the RPC node
```

**Validators are never publicly reachable.** They accept p2p only from each other
and from the RPC node. Nothing else, from anywhere.

## Sizing

From `docs/architecture.md` §3 and measured on the devnet:

| n | Quorum | Survives down | Survives byzantine |
|---|---|---|---|
| 4 | 3 | 1 | 1 |
| **7** | **5** | **2** | **2** |
| 10 | 7 | 3 | 3 |

**Use 7 for a real mainnet, not 4.** Four has no margin: lose two and the chain
halts until an operator intervenes. Five buys nothing over four — the next real
step is seven. Efficient sizes are `n = 3f+1`.

Spread them across **different providers and regions**. Four VPSes from one
provider in one region is a correlated failure, not four independent ones.

## Recovery is slower than the outage

Measured on the devnet, not assumed. A ~3 minute quorum loss cost about **7
minutes of total downtime**: after quorum was restored the validators sat in
round-change deadlock, split across rounds, for roughly four more minutes before
converging. QBFT's round-change timeout backs off exponentially, so the longer
the outage runs, the longer recovery takes.

Plan capacity so quorum loss does not happen, rather than planning to recover
from it quickly. See `docs/runbook-quorum-loss.md`.

## Order of deployment

1. **Key ceremony** — generate validator keys on their own hosts. A key that has
   ever existed on a shared machine is not a production key.
2. **Genesis** — `bash scripts/create-genesis.sh` once, then distribute the same
   `genesis.json` to every node. It must be byte-identical everywhere.
3. **Validators** — bring up all of them before expecting blocks. Below quorum
   nothing happens, which looks like a failure and is not.
4. **RPC node** — joins as a non-validator, syncs, serves.
5. **Caddy** — TLS in front of the RPC node.
6. **Explorer stack** — Postgres, migrations, indexer, API, web.
7. **Monitoring** — `scripts/monitor-chain.mjs` on a timer, per host.

## What is and is not verified here

The compose files, Caddyfile and firewall rules in this directory are **written
but not deployed** — this repository has no VPS to provision. They encode the
topology decisions and the security posture, and they are the starting point for
a real deployment, not evidence of one.

What *is* verified, on the running devnet:

- quorum loss halts the chain, and the monitor detects it (exit code 2)
- recovery after quorum restore takes minutes, with round-change escalation
- the QBFT upgrade path works, with the caveats in `scripts/schedule-transition.mjs`
- validator rotation is documented in `docs/validator-rotation.md`

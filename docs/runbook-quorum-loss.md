# Runbook: chain halted / quorum loss

The most likely serious incident on a QBFT chain. Every number here was measured
on the Giggora devnet, not estimated.

---

## Recognising it

**QBFT does not degrade. It stops.** There is no partial availability, no
read-only mode, no slower blocks. Below quorum, block production is exactly zero
until an operator intervenes.

What it looks like:

| Signal | Reading |
|---|---|
| `eth_blockNumber` | frozen, unchanging |
| Validator containers | **all healthy** — this is the trap |
| `net_peerCount` | often normal |
| Logs | `RoundChangeManager` messages, round number climbing |
| `scripts/monitor-chain.mjs` | `CRIT quorum` then `CRIT liveness`, exit 2 |

A process-level health check will report everything fine. That is precisely why
`scripts/monitor-chain.mjs` exists and why it checks quorum before liveness — it
catches the *cause* about two minutes before the *symptom*.

```bash
node scripts/monitor-chain.mjs        # exit 0 ok, 1 warn, 2 critical
```

---

## Diagnosis

**1. How many validators can actually be reached?**

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}' \
  https://rpc.giggora.example
```

Compare the set size against how many are responding. Quorum is `ceil(2n/3)`:

| n | Quorum | Halts when this many are down |
|---|---|---|
| 4 | 3 | 2 |
| 7 | 5 | 3 |
| 10 | 7 | 4 |

**2. Is it quorum, or is it something else?**

Quorum loss is the common cause but not the only one. Check for:

- `Invalid block header: timestamp is only N seconds newer than parent` —
  **configuration disagreement**, not node loss. Nodes have different
  `blockperiodseconds`, usually after a partial or rolling restart. Fix by making
  the genesis identical everywhere and cycling **all** nodes together.
- `World state not available for block` — database corruption on a node. Remove
  that node's chain data and let it re-sync; do not touch the others.
- Clock skew. QBFT validates timestamps; badly skewed clocks reject valid blocks.
  Verify NTP on every validator.

---

## Recovery

**Restore quorum. That is the whole fix.** Start enough validators that the
number reachable is at least `ceil(2n/3)`.

```bash
# on each downed validator host
docker compose up -d
docker compose logs -f --tail 50
```

### Then wait — and expect it to take longer than the outage

This is the part that surprises people, measured on the devnet:

> A **~3 minute** quorum loss cost roughly **7 minutes** of total downtime.
> After quorum was restored, the validators sat in round-change deadlock —
> split across rounds 4, 5 and 6 — for about **four more minutes** before
> converging and producing a block.

QBFT's round-change timeout backs off **exponentially**. The longer the chain
sits below quorum, the higher the round number climbs, and the longer each node
waits before trying again. Recovery time grows with outage length.

During this window you will see, on a chain that is going to recover on its own:

```
RoundChangeManager | BFT round summary (quorum = 3)
RoundChangeManager | Address: 0x590ade…  Round: 4
RoundChangeManager | Address: 0xf52076…  Round: 4
RoundChangeManager | Address: 0x2e35da…  Round: 5
RoundChangeManager | Address: 0x2660e4…  Round: 5   (Local node)
```

Validators split across rounds, no round holding quorum. **This is normal
convergence, not a stuck chain.** Do not start restarting nodes to "help" — every
restart resets that node's progress and lengthens the outage.

**Wait at least 10 minutes after quorum is restored before intervening further.**

---

## If it does not recover

Only after a genuine wait:

1. **Confirm all validators are on the same genesis.** Compare hashes, not file
   sizes:
   ```bash
   sha256sum genesis.json    # must be identical on every host
   ```
   Also confirm the chain agrees:
   ```bash
   curl -s -X POST -H 'Content-Type: application/json' \
     --data '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["0x0",false],"id":1}' \
     http://127.0.0.1:8545 | grep -o '"hash":"0x[0-9a-f]*"'
   ```
   A differing genesis hash means these are **different chains** and no amount of
   restarting will help.

2. **Check peer connectivity.** A firewall change can partition validators that
   are all individually healthy:
   ```bash
   curl -s -X POST -H 'Content-Type: application/json' \
     --data '{"jsonrpc":"2.0","method":"net_peerCount","params":[],"id":1}' \
     http://127.0.0.1:8545
   ```
   Each validator should see every other one. Confirm `static-nodes.json` lists
   the right addresses and that ufw still allows p2p between them.

3. **Stop everything, then start everything.** Not a rolling restart — that is
   what causes configuration-disagreement stalls in the first place.

4. **Last resort: a validator whose data is corrupt.** Remove only that node's
   chain data and let it re-sync from peers. Its signing key is untouched.
   ```bash
   docker compose down
   rm -rf ./data/database ./data/caches
   docker compose up -d
   ```
   Never do this on more than one node at a time, and never on enough nodes to
   drop below quorum.

---

## What you cannot do

- **You cannot roll back.** QBFT finality is absolute; committed blocks are
  permanent. There is no reorg to recover through.
- **You cannot lower the quorum.** It is derived from the validator set size, not
  configured. The only way to change it is to change the set — which itself
  requires a quorum to vote.
- **You cannot vote out a dead validator without quorum.**
  `qbft_proposeValidatorVote` needs a majority of the *current* set. If you are
  below quorum you cannot shrink your way out. This is the trap that makes
  prevention matter more than recovery.

---

## Prevention

In rough order of value:

1. **Separate hosts, separate providers, separate regions.** Four validators on
   one machine is one failure, not four. This is the single largest improvement
   available.
2. **Run 7, not 4, on mainnet.** Seven tolerates two failures; four tolerates
   one. Five buys nothing over four — the efficient sizes are `n = 3f+1`.
3. **Alert on `monitor-chain.mjs` exit 2**, on a one-minute timer per host. It
   flags quorum loss before liveness trips.
4. **Alert on a validator that stops proposing** while still in the set. That is
   how a chain slides toward quorum loss, and the monitor's `proposers` check
   catches it.
5. **Never restart validators in a rolling fashion** for a config change. Stop
   all, then start all.
6. **Keep clocks synchronised.** NTP on every validator, monitored.

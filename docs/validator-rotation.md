# Validator rotation runbook

How to add, remove and replace Giggora validators on a **running** chain, without
a hard fork and without restarting from genesis.

This matters beyond routine operations: rotating keys is the only mitigation a
small permissioned validator set has against key compromise — including the
long-dated quantum exposure in [architecture.md §14](architecture.md). A rotation
procedure that has never been rehearsed is not a procedure.

---

## How QBFT validator voting works

The validator set lives in each block's `extraData`, not in the genesis file.
Existing validators vote it up or down through JSON-RPC:

| Method | Effect |
|---|---|
| `qbft_proposeValidatorVote(address, true)` | vote to **add** `address` |
| `qbft_proposeValidatorVote(address, false)` | vote to **remove** `address` |
| `qbft_discardValidatorVote(address)` | withdraw this node's vote |
| `qbft_getValidatorsByBlockNumber("latest")` | current validator set |
| `qbft_getPendingVotes` | votes this node has cast |

A change lands once **more than half** the current validators have cast the same
vote. With four validators that is three. Votes are per-node, so the same call
must be made on each validator's own RPC — there is no central switch.

Nothing here requires a restart, a genesis edit, or downtime.

---

## Sizing: why the order of operations matters

QBFT tolerates `f` faulty nodes where `n = 3f + 1`:

| Validators | Tolerates | Notes |
|---|---|---|
| 3 | 0 | one crash halts the chain |
| 4 | 1 | Giggora's default |
| 5 | 1 | no gain over 4 |
| 7 | 2 | next real step up |

**Always add before removing.** Going 4 → 3 → 4 passes through a set with zero
fault tolerance; going 4 → 5 → 4 never does. The intermediate state is short but
a crash during it stops the chain.

---

## Rotating a validator key

Replacing validator N's key, on a live chain.

### 1. Generate the new key

```bash
docker run --rm -v "$PWD/blockchain/nodes/validator-new:/data" \
  hyperledger/besu:26.8.1 --data-path=/data public-key export-address \
  --to=/data/address
```

Record the address. Its private key must never leave that host.

### 2. Start the new node (not yet a validator)

Add it to `docker-compose.yml` with its own static IP and a `static-nodes.json`
listing the existing nodes. It will sync and follow the chain as a plain full
node — it simply will not propose blocks.

Confirm it is caught up before proceeding:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://localhost:<new-node-rpc>
```

A node that is behind will be voted in and then immediately miss its proposal
slots, which looks exactly like a validator failure.

### 3. Vote it in

On **each** existing validator (ports 8551–8554 on the devnet):

```bash
for p in 8551 8552 8553 8554; do
  curl -s -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"qbft_proposeValidatorVote",
             "params":["0xNEW_VALIDATOR_ADDRESS", true],"id":1}' \
    http://localhost:$p
done
```

Confirm:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}' \
  http://localhost:8545
```

The set should now have five members. **Wait for the new node to actually
propose a block before continuing** — that is the only proof it is working, and
it is the whole point of adding before removing.

### 4. Vote the old one out

```bash
for p in 8551 8552 8553 8554 <new-node-port>; do
  curl -s -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"qbft_proposeValidatorVote",
             "params":["0xOLD_VALIDATOR_ADDRESS", false],"id":1}' \
    http://localhost:$p
done
```

Verify the set is back to four and the old address is gone.

### 5. Decommission

Stop the old node, then **destroy its key material** — a retired validator key is
still a valid signing key for every block it ever signed, and on a chain with
absolute finality that history is permanent.

```bash
docker compose stop validator-old
shred -u blockchain/nodes/validator-old/key    # or the platform equivalent
```

---

## Verifying a rotation

```bash
# set membership
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}' \
  http://localhost:8545

# who is actually producing blocks
curl -s "http://localhost:4100/api/blocks?limit=50" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      const c={};for(const b of JSON.parse(d).items) c[b.validator]=(c[b.validator]||0)+1;
      console.log(c)})"
```

Membership and *production* are different things. A validator can be in the set
and silently never propose — check both. The explorer's `/validators` page shows
the same distribution over a recent window.

---

## If a validator key is compromised

1. **Vote it out immediately** — do not wait for a replacement. Dropping 4 → 3
   costs fault tolerance; leaving a hostile signer in the set costs safety, and
   safety wins.
2. Bring up a replacement and vote it in, restoring `n = 4`.
3. Assume every block that key signed is suspect. QBFT finality means they cannot
   be reorged out; a compromise is a governance problem, not a technical one.
4. Rotate the remaining keys too if the compromise vector could have reached them.

---

## What this does *not* cover

- **Changing the signature algorithm.** Rotation replaces a secp256k1 key with
  another secp256k1 key. It does not make the chain post-quantum; see
  [architecture.md §14](architecture.md).
- **Consensus parameters** (block period, rewards, beneficiary) — those go
  through `scripts/schedule-transition.mjs`, which has its own caveats and *does*
  require stopping every node.
- **Moving to an on-chain validator contract** (`validatorselectionmode:
  contract`), the Phase B step in §3's decentralisation path. That is a
  transition, not a rotation.

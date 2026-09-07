# HANDOVER — Giggora

**Date:** 2026-09-07 · **Status:** SHELVED, complete and working · **Author:** built with Claude Code

For whoever picks this up next — including the person who wrote it, six months
from now.

---

## The one-paragraph version

Giggora is a working, independent EVM Layer-1 blockchain with its own currency
(GIG), a 4-validator QBFT network, ERC-20/721/1155 contracts, a crash-safe
indexer, a REST API, a block explorer UI, wallet support and a sample DApp.
Everything is built, tested and committed across 16 commits. It runs on one
desktop. **Nothing uses it, and no one else runs a validator.** The technology
is finished; the adoption problem is untouched. Mainnet has never been launched
and the chain ID for it (4041) is reserved but unused.

---

## What you are inheriting

### It genuinely works

Not a prototype. The chain produces blocks, contracts deploy and execute, the
indexer survives `kill -9`, the API serves every documented endpoint, the UI
renders real chain data, and MetaMask connects. Test totals:

| Suite | Result |
|---|---|
| Network acceptance | 7/7 |
| Contracts (Foundry unit) | 49/49 |
| Contracts (on-chain) | 12/12 |
| Indexer (1000+ blocks, SIGKILL) | 8/8 |
| Explorer API | 51/51 |
| API regressions | 12/12 |
| Explorer UI | 28/28 |
| Wallet compatibility | 19/19 |
| QBFT transitions | 11/11 |

Devnet at shelving time: **block 2,143 · 22,578 transactions · 4 tokens**.

### One command starts everything

```bash
npm run stack
```

Chain, indexer, API and explorer UI, in containers. UI on `localhost:3000`, API
on `localhost:4100`, RPC on `localhost:8545`. `npm run stack:down` stops it.

The explorer services sit behind a compose **profile**, so plain
`docker compose up -d` gives you the chain alone. That is deliberate: the two
explorer images cost ~800 MB and land in a virtual disk that never shrinks.

---

## What is NOT done

Be clear-eyed about this; it is most of the remaining work and none of it is code.

1. **No application.** Nothing runs on this chain. That is the real gap, and it
   is not a technical one.
2. **No independent validators.** All four are on one desktop. QBFT "tolerates
   one faulty validator" is true of the algorithm and meaningless here — one
   power cut takes all four. Moving them to four VPSes *you* own and pay for
   changes uptime, **not** decentralisation. It stays one operator's chain.
3. **Mainnet never launched.** Chain ID 4041 is reserved and unused.
4. **`deploy/` was never provisioned.** The compose files, Caddyfile and ufw
   rules encode the topology and security posture. They have never touched a
   real host. Treat them as a well-reasoned starting point, not evidence.
5. **The devnet `GigNFT` instance is pre-audit.** A 2026-09-07 security audit
   (9 finders, 22 confirmed findings, all fixed — see `CLAUDE.md` §4 items
   17–29 and the commit) reordered `safeMint` to set the URI before the
   external `onERC721Received` call. The contract on chain at `0xe7f1…0512`
   is the earlier bytecode; redeploy to align source and chain.
6. **Test suites crash on HTTP 429** instead of reporting it. Run them ~60s
   apart or the API's own rate limiter produces phantom failures. This cost real
   debugging time twice.

---

## Three decisions someone must make before mainnet

Documented but deliberately not decided. Do not inherit them by accident.

### 1. The fee market

`fixedBaseFee: true` is currently on. It fixed a genuine bug — the EIP-1559 base
fee decayed below `min-gas-price` on an idle chain, wallets then underpaid the
floor, and transactions were accepted into the mempool and **silently never
mined**. MetaMask just spun.

But it fixes it by **removing the fee market**. The base fee no longer responds
to demand, so on a congested mainnet there is no price signal to prioritise
transactions and the mempool backs up until Besu drops them at its 4096 default.

Either keep it (and raise txpool limits and monitor depth), or restore EIP-1559
dynamics with a `min-gas-price` low enough that a decayed base fee still clears
it, so the original bug cannot recur.

### 2. Validator count and hosting

**Seven, not four**, and on separate hosts, providers and regions. Seven
tolerates two failures; four tolerates one; five buys nothing over four, because
efficient sizes are `n = 3f + 1`.

This matters more than it sounds. Quorum loss was induced for real: stopping 2
of 4 validators produced **zero blocks in 50 seconds under load**, and every
container reported *healthy* the whole time.

### 3. A real key ceremony

Generate validator keys **on the validator hosts themselves**. A key that has
existed on a shared machine is not a production key. This is the one step that
cannot be redone later without a validator rotation.

---

## Things that will surprise you

Ordered by how much time they will cost if you do not know them.

**QBFT does not degrade — it stops.** Below quorum, block production is exactly
zero. No partial availability, no read-only mode, no slower blocks. Every
container stays healthy. A process-level health check reports everything fine.
That is precisely why `scripts/monitor-chain.mjs` exists and checks quorum
*before* liveness — it catches the cause about two minutes before the symptom.

**Recovery takes longer than the outage.** A ~3 minute quorum loss cost about
**7 minutes** of total downtime. After quorum was restored the validators sat in
round-change deadlock — split across rounds 4, 5 and 6 — for roughly four more
minutes before converging. The round-change timeout backs off **exponentially**,
so the longer the outage, the longer the recovery. During that window, do not
restart nodes to "help": every restart resets that node's progress.

**You cannot vote out a dead validator without quorum.**
`qbft_proposeValidatorVote` needs a majority of the *current* set. Below quorum
you cannot shrink your way out. This is the trap that makes prevention matter
more than recovery.

**Consensus config changes apply at node RESTART, not at the scheduled block**,
and require stopping *all* nodes together — never a rolling restart. Verified
twice by accident: transitions scheduled for blocks 1748 and 2131 took effect at
1731 and 2092.

**Everything in `docs/` with a number in it was measured**, not estimated. An
earlier version of `docs/deployment.md` specified 8 GB RAM per validator on the
reasoning that "the JVM wants 4 GB of heap". Measurement said **~350 MB**. That
number would have driven a purchase.

---

## Where the bodies are buried

Full list in `CLAUDE.md` §4. The ones most likely to waste a day:

- **`tmpfs: /tmp` must include `exec`** or every validator crash-loops with what
  looks like a corrupt library file. Besu `dlopen()`s what it extracts there.
- **`fixedBaseFee` and the beacon-roots pre-deploy are both load-bearing.**
  Remove either and the chain breaks in a way that does not point at the cause.
- **Enodes need IP literals**, not hostnames.
- **Docker fixes logging at container creation** — `docker compose start` will
  not apply a changed `logging:` block. Check with `docker inspect`; `map[]`
  means no cap is in effect.
- **`.gitignore` must keep `blockchain/nodes/` and `**/key`.** Besu names
  validator keys literally `key`, with no extension, so `*.key` does not match
  them. Four private keys were once staged for commit before this was caught.

---

## Resuming work

```bash
docker compose up -d                # chain only
npm run verify                      # 7/7 expected
npm run stack                       # add indexer + API + UI
npm run monitor                     # should be all-ok, exit 0
```

If the explorer shows old numbers, the indexer is not running — the page says so
itself with a banner rather than quietly serving stale data.

Read `git log` before changing anything load-bearing. The commit messages carry
the reasoning, including what was tried and rejected; they are the design record
for this project, not a changelog.

---

## Honest assessment

The engineering is sound and unusually well-verified for a project this size —
failure modes were induced deliberately rather than reasoned about, and several
confident claims were disproven by testing and corrected in place.

But **a blockchain with no users is a distributed database with extra steps.**
Every remaining question is about adoption, governance and jurisdiction, not
code. The most promising direction identified is not "who will use my chain"
but **"which parties already need a shared record and do not trust each
other?"** — consortium use cases where the validator set *is* the value:
credential verification, procurement transparency, permit issuance,
election-results publishing (the transparency layer, emphatically **not** vote
casting or counting).

Regulatory reality also constrains the obvious path: BSP's moratorium on new
VASP licences is indefinite, and SEC CASP registration requires ₱100M paid-up
capital. Shipping software is unregulated; issuing a token to the public is not.

Shelving this at a genuinely finished state, rather than half-built, was the
right call.

# Giggora faucet

A portal that hands out GIG on the Giggora **test network** — for anyone trying
the chain, not only developers. The tokens have no monetary value and are not
for sale.

It starts with everything else:

```bash
npm run stack
```

Portal on http://localhost:4200. To run it alone on the host instead (for
editing), `npm run faucet` — but not both at once, they bind the same port.
Tests: `npm run faucet:test`, 24 of them against a live faucet and a live chain.

---

## What one claim is actually for

Measured on this chain, at its 1 gwei floor:

| One claim of | Contract deployments | ERC-20 transfers | Plain transfers |
|---|---|---|---|
| **1 GIG** | 1,006 | 19,230 | 47,619 |
| **10 GIG** | **10,065** | 192,307 | 476,190 |

Worth holding onto when reading the sizing section. For a developer this is the
whole story — one claim removes the chicken-and-egg problem (you cannot call a
contract without gas) and they never need another. For an early adopter simply
holding or moving GIG, 10 GIG is 476,190 transfers: also far more than one
person will use.

The pool is therefore sized by **how many people you want to reach**, not by
what each of them needs.

---

## The drip curve

The payout tracks the fraction of the pool that is left:

```
rate = ceil(maxGig × remaining / total),  capped at maxGig
```

Scale-free, so it produces the same shaped schedule at any pool size. With the
20,000,000 GIG pool it was originally specified against, it is exactly:

| Remaining | Pays |
|---|---|
| 20,000,000 | 10 GIG |
| 18,000,000 | 9 GIG |
| 16,000,000 | 8 GIG |
| 14,000,000 | 7 GIG |
| 12,000,000 | 6 GIG |
| **10,000,000 (50%)** | **5 GIG (50%)** |
| … down to 2,000,000 | 1 GIG |

**Ceiling, not rounding.** At 19M of 20M the exact value is 9.5; ceiling keeps
the payout at 10 until the pool genuinely reaches 18M, which is what "18M left,
the faucet gives 9" means. Every payout is a whole GIG.

The last claimer gets the remaining dust rather than being refused, and the
faucet stops rather than paying zero.

---

## Pool size, and the thing it is NOT

The pool is **20,000,000 GIG** — the total the faucet will ever hand out, which
is also the denominator of the curve above, which is why every worked example
lines up (18M left pays 9, 10M left pays 5).

**This is an accounting ceiling, not a balance.** It is the single most important
distinction in operating this thing, because the two are easy to conflate:

```
  cold key, offline              hot key, on the web server
  ┌──────────────────┐  tops up  ┌──────────────────┐
  │  the allocation  │ ────────> │  working float   │ ──> claimants
  └──────────────────┘           └──────────────────┘
     20,000,000 GIG                  ~5,000 GIG
     the pool ceiling                what a breach costs
```

The faucet signs from a key that lives on an internet-facing server. Whatever
that key can reach is what an attacker gets on the day the server is
compromised. Parking 20,000,000 GIG — 2% of total supply — behind it would make
the faucet the single largest security exposure on the chain, larger than the
validators.

Nothing about the 20M ceiling requires that. Fund the hot wallet with days of
expected demand, top it up, and a breach costs the float rather than the pool.
The faucet reports its real on-chain balance on `/api/status` and refuses
claims it cannot pay rather than queuing them.

### What 20,000,000 GIG reaches

| | |
|---|---|
| Share of total supply | 2% |
| Claims at the opening 10 GIG rate | 2,000,000 |
| People reached, if each claims once | up to 2,000,000 |
| Days for one address to drain it alone | ~244,000 (669 years) |

The binding constraint on a pool this size is not how many people want GIG — it
is **how fast it can be farmed**, because addresses are free and IP addresses
are cheap. That is what the four limits below are for, and why the hot-wallet
float above matters more than the ceiling does.

There is also a framing consequence worth knowing. A gas tap with valueless
tokens is plainly a developer utility; a decreasing-rate distribution of 2% of
supply to the public reads more like a token distribution event, and under SEC
MC No. 4 & 5, s. 2025 the distribution of crypto-assets in the Philippines is
regulated while a testnet utility is not. This runs on the **test network** with
tokens that have no value, which the portal states plainly, and that is the
basis on which it is safe as built.

To halve it, set `pool.totalGig` to `"10000000"`; the curve rescales itself
(10 GIG at 10M left, 5 at 5M).

## Limits, and what each one is actually worth

Four layers. Only one survives a funded attacker, and it is worth being clear
about which:

| Layer | Default | What it actually stops |
|---|---|---|
| **Daily cap** | **20,000 GIG / 24h** | **Everyone, together. No number of addresses, IPs or CPUs gets past it.** |
| Per address | 24 hours | An honest person claiming twice. Not an attacker — addresses are free. |
| Per source | 5 minutes | Casual scripting from one connection. Rented IPs defeat it. |
| Proof of work | 19 bits (~2.6s on a phone) | Drive-by automation. Priced in seconds, not dollars. |

### Why the daily cap is the real defence

The per-IP cooldown is the limit people reach for first, and it is the one an
attacker simply buys past. Cloud IPv4 addresses cost a dollar or two a month:

| Rented IPs | Cost/month | Drains 20M without a cap | With a 20,000/day cap |
|---|---|---|---|
| 1,000 | ~$2,000 | 83 days | **1,000 days, and only if nobody else claims** |
| 10,000 | ~$20,000 | 8 days | **1,000 days** |

The cap turns "how much can they buy" into "how long will they wait", and
pool divided by daily cap is a hard floor on the pool's life — 1,000 days here.

Its honest cost: it is a **shared** budget. A farmer claiming early in the day
consumes part of what real users could have had. It bounds the damage; it does
not aim it.

### Why the per-IP cooldown is only 5 minutes

Most people in the Philippines reach the internet through **carrier-grade NAT**
on mobile, where thousands of subscribers share one public address. A 24-hour
per-IP lock would hand the faucet to whoever claimed first on each carrier and
turn everyone else away — the opposite of reaching ordinary people. Five minutes
slows a script without punishing a shared connection.

On a network where one address really is one person, raising it to 24 hours
makes farming meaningfully harder. Do not do that for a public, mobile audience.

The same reasoning applies to the HTTP rate limiter: it is attached per route,
not globally, so loading the page never spends the claim budget. A single global
limit locked shared connections out of the static files as well as the faucet.

### Why proof of work is not set higher

Measured on this project's own implementation:

| Bits | Mid-range phone | Attacker, native code |
|---|---|---|
| 19 (default) | ~2.6s | ~0.8s |
| 20 | 5.1s | 1.7s |
| 22 | **20.5s** | 6.6s |

Difficulty is mostly a tax on ordinary users. An attacker uses batched or GPU
hashing and pays less than even that ratio suggests, and what dominates their
budget is IP addresses, not CPU. Re-measure on a real phone before raising it.

Proof of work was chosen over a captcha deliberately: no third-party service, no
vendor key, no personal data, and it works with nothing but JavaScript.

### None of this is sybil-proof

Nothing short of identity is, and identity has costs of its own — a phone or
social check would make you a processor of personal data under RA 10173. What
these four layers achieve is a bound on the *rate* of loss, not prevention. If
one-person-one-claim genuinely matters, the honest answer is proof of personhood
or a pre-registered allowlist, not a better rate limiter.

**Client IPs are never stored.** The per-source limit compares a salted SHA-256
(`FAUCET_IP_SALT`) — the same rate limit with nothing to retain, and nothing to
erase under RA 10173.

---

## Funding it

**The hot wallet should hold a working float, not the pool.**

```
cold key (offline)  ──── tops up ────>  hot key (on the web server)
   the allocation                          a few thousand GIG
```

The pool size in the config is an accounting ceiling — the most the faucet will
ever dispense. It is not a balance that has to sit in one account. Fund the hot
wallet with days of expected demand and top it up; the faucet reports its real
on-chain balance on `/api/status` and refuses to accept claims it cannot pay
rather than queuing them.

On the devnet the signer defaults to the **published Anvil #1 key**, which is
safe there and refused everywhere else — the faucet asks the *node* for its chain
id at startup and exits if it is not 4043. Set `FAUCET_PRIVATE_KEY` to run
anywhere real. Account #1 rather than #0 on purpose: `deploy-contracts.mjs` and
`load-generator.mjs` sign from #0, and two processes on one address race on the
nonce.

---

## Why it is a service and not a contract

A faucet contract would need the claimer to already hold gas to call it, which is
the exact problem the faucet exists to solve. So it has to be an off-chain
service that signs and sends, and the claimer needs nothing but an address.

The cost is that the faucet is trusted infrastructure: it holds a key, and its
cooldowns live in Postgres rather than on chain. That is the right trade for a
testnet utility, and it is why the accounting below is careful.

---

## How a claim cannot be paid twice

Every claim takes `SELECT … FOR UPDATE` on the single `faucet_state` row, which
serialises the whole faucet. That lock is doing more than it looks: without it,
two concurrent requests for the same address both read "no recent claim" before
either writes one, and both are paid.

The pool is debited and a `pending` row written **before** anything is sent, in
one transaction. Then the transaction is sent, then the row is settled. A crash
in between leaves a debited `pending` row — the faucet under-reports what it has
rather than paying twice, and says so at startup. A send that fails refunds the
ledger, so a node hiccup does not permanently shrink the pool.

A faucet handles a few claims a second at most, so serialising costs nothing and
removes an entire class of double-spend.

---

## Configuration

`faucet.config.json` is the single source of truth for economics and limits;
every value is validated at startup and a nonsensical one refuses to boot.
Secrets live only in the environment — see `.env.example`.

| Key | Default | |
|---|---|---|
| `pool.totalGig` | `100000` | Total ever dispensed; also the curve's denominator |
| `drip.maxGig` | `10` | Payout at a full pool |
| `dailyCap.gig` | `20000` | Shared 24h budget — the strongest limit here |
| `cooldown.addressSeconds` | `86400` | Per recipient |
| `cooldown.ipSeconds` | `300` | Per source (hashed); short for carrier-grade NAT |
| `pow.difficultyBits` | `19` | ~2.6s on a phone; each bit doubles it |
| `hotWallet.reserveGig` | `1` | Never spent — the send needs its own gas |
| `server.host` | `127.0.0.1` | Loopback; put Caddy in front for anything public |

Resizing the pool rescales the schedule and is logged loudly. The faucet refuses
a pool smaller than what has already been dispensed.

---

## Deploying it publicly

Put it behind Caddy like the explorer, and set `TRUSTED_PROXY_CIDR` to Caddy's
address — unset, every request appears to come from the proxy and the per-source
cooldown collapses into one global bucket; set to `true`, it trusts a client
header and becomes decorative.

Do **not** use `rate_limit` in the Caddyfile. It is the third-party
`mholt/caddy-ratelimit` plugin, not a Caddy built-in, and the stock
`caddy:2-alpine` image refuses to start on it.

---

## What this does not do

- **No sybil resistance beyond cost.** See above. It is a testnet.
- **No captcha, no accounts, no KYC.** Deliberate.
- **No automatic reconciliation of stale `pending` rows.** They are reported at
  startup; deciding whether the money left needs the chain, and guessing wrong
  either double-pays or loses the record.
- **No queue.** If the wallet cannot pay, the claim is refused with a reason
  rather than accepted and held.

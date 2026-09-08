-- Giggora — GIG faucet (migration 006).
--
-- Two tables. The design constraint that shapes both is that a faucet is a
-- system that GIVES AWAY MONEY on an anonymous public endpoint, so the
-- accounting has to survive concurrency and crashes without ever paying twice.
--
--   faucet_state   ONE row (id = 1). Holds the pool size and how much has been
--                  dispensed. Every claim takes SELECT ... FOR UPDATE on this
--                  row, which serialises the whole faucet. That is deliberate:
--                  it also makes the per-address and per-IP cooldown checks
--                  safe, because without it two concurrent requests for the
--                  same address both read "no recent claim" and both pay out.
--                  A faucet handles a few claims a second at most; serialising
--                  costs nothing and removes an entire class of double-spend.
--
--   faucet_claims  One row per claim attempt, written BEFORE the transaction is
--                  sent and settled after. A crash between the two leaves a
--                  'pending' row with the pool already debited — conservative:
--                  the faucet may under-report what it has, never over-pay.
--
-- IP ADDRESSES ARE NOT STORED. Rate limiting needs to compare requests from the
-- same source, not to know the source, so only a salted SHA-256 of the IP is
-- kept (FAUCET_IP_SALT). Retaining raw IPs would make this a personal-data
-- store under the Data Privacy Act (RA 10173), whose right to erasure sits
-- badly with an append-only claim log. A hash gives the same rate limit with
-- nothing to erase.
--
-- Idempotent, like every migration here.

CREATE TABLE IF NOT EXISTS faucet_state (
    id             smallint      PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    chain_id       bigint        NOT NULL,
    -- Total the faucet may ever dispense, and the running total it has.
    -- NUMERIC(78,0) because these are wei and exceed 2^53 (project convention).
    pool_wei       numeric(78,0) NOT NULL,
    dispensed_wei  numeric(78,0) NOT NULL DEFAULT 0,
    CONSTRAINT faucet_state_dispensed_sane CHECK (dispensed_wei >= 0 AND dispensed_wei <= pool_wei),
    created_at     timestamptz   NOT NULL DEFAULT now(),
    updated_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS faucet_claims (
    id            bigserial     PRIMARY KEY,
    -- 20 raw bytes, never a 0x string (project convention).
    address       bytea         NOT NULL,
    amount_wei    numeric(78,0) NOT NULL,
    -- pending: debited, not yet sent. sent: on chain. failed: refunded.
    status        text          NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'sent', 'failed')),
    tx_hash       bytea,
    -- Salted SHA-256 of the client IP. See the note above: never the IP itself.
    ip_hash       bytea,
    error         text,
    requested_at  timestamptz   NOT NULL DEFAULT now(),
    settled_at    timestamptz
);

-- Cooldown lookups: "the newest non-failed claim for this address / source".
-- Partial, because a failed send must not burn the claimer's cooldown and so is
-- never consulted.
CREATE INDEX IF NOT EXISTS faucet_claims_address_idx
    ON faucet_claims (address, requested_at DESC)
    WHERE status <> 'failed';

CREATE INDEX IF NOT EXISTS faucet_claims_ip_idx
    ON faucet_claims (ip_hash, requested_at DESC)
    WHERE status <> 'failed';

-- The public "recent claims" feed on the portal, and operator triage.
CREATE INDEX IF NOT EXISTS faucet_claims_recent_idx
    ON faucet_claims (requested_at DESC);

-- Stale 'pending' rows are the only state needing manual attention: the process
-- died between debiting the pool and sending. Kept cheap to find.
CREATE INDEX IF NOT EXISTS faucet_claims_pending_idx
    ON faucet_claims (requested_at)
    WHERE status = 'pending';

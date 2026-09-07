-- Giggora — finish the counter work migration 002 started.
--
-- 002 §5 added counters for transactions/logs/token_transfers and stated the
-- rule plainly: count(*) on a growing table is an unbounded sequential scan and
-- "must never sit behind a request". But /api/stats still called
--
--     SELECT count(*) FROM addresses WHERE is_contract
--     SELECT count(*) FROM tokens
--
-- on every request, so the two remaining totals violated the rule the same
-- migration had just written down. Measured on a 2,000,000-address /
-- 200,000-token replica: ~71ms and ~5,271 buffer reads per /api/stats call,
-- against 0.05ms and 4 buffers for a properly bounded page query on the same
-- table — and growing linearly with chain age, behind the single endpoint every
-- explorer front page hits.

ALTER TABLE indexer_state ADD COLUMN IF NOT EXISTS total_contracts BIGINT NOT NULL DEFAULT 0;
ALTER TABLE indexer_state ADD COLUMN IF NOT EXISTS total_tokens    BIGINT NOT NULL DEFAULT 0;

-- One-off backfill, offline, exactly as 002 did. Acceptable once; never per request.
UPDATE indexer_state
   SET total_contracts = (SELECT count(*) FROM addresses WHERE is_contract),
       total_tokens    = (SELECT count(*) FROM tokens)
 WHERE id = 1
   AND total_contracts = 0
   AND total_tokens = 0;

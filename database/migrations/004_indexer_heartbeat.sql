-- Giggora — indexer heartbeat and chain head (migration 004).
--
-- WHY THIS EXISTS
--
-- The explorer could not tell the difference between "this is the chain" and
-- "this is what the chain looked like when the indexer last ran". /api/stats
-- returned latestBlock from `blocks` and lastIndexedBlock from indexer_state,
-- but BOTH come from the database, so they agree even when the indexer has
-- been dead for hours. The UI then renders stale numbers with no way to know
-- they are stale, which is exactly what brief §47 forbids.
--
-- Detecting that needs one fact the database did not have: what the CHAIN's
-- head was, according to the indexer, the last time it looked.
--
-- updated_at alone is not enough either. The indexer's loop skips the database
-- entirely when it is caught up and idle, so a healthy idle indexer and a dead
-- one both go stale. The indexer now writes a heartbeat every poll whether or
-- not there is a block to index, which makes the three states distinguishable:
--
--   fresh updated_at, head == last_processed   -> alive, caught up
--   fresh updated_at, head >  last_processed   -> alive, catching up
--   stale updated_at                           -> not running
--
-- Idempotent, like every migration here.

ALTER TABLE indexer_state
  ADD COLUMN IF NOT EXISTS chain_head_block bigint;

COMMENT ON COLUMN indexer_state.chain_head_block IS
  'Chain head as of the indexer''s last poll. NULL until the indexer has run '
  'once since this migration. Compare against last_processed_block for lag, '
  'and updated_at for liveness.';

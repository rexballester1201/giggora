-- Giggora — indexes and counters required by the explorer API.
--
-- Every item here was identified by reading 001_initial.sql against the actual
-- query shapes the API needs. Each one turns a sequential scan or a sort into a
-- bounded index range scan.

-- ---------------------------------------------------------------------------
-- 1. tokens list ordering
-- ---------------------------------------------------------------------------
-- tokens had only tokens_pkey(address). "newest tokens first" was therefore a
-- sequential scan plus a sort of the whole table on every request.
CREATE INDEX IF NOT EXISTS tokens_first_seen_idx
    ON tokens (first_seen_block DESC, address DESC);

-- ---------------------------------------------------------------------------
-- 2. contracts list ordering
-- ---------------------------------------------------------------------------
-- addresses_contract_idx is ON addresses (is_contract) WHERE is_contract — a
-- partial index with NO ordering column, so /api/contracts had to read every
-- contract's heap tuple and sort to return 25 rows. This adds the ordering
-- columns so the same partial predicate can be walked in order.
CREATE INDEX IF NOT EXISTS addresses_contract_seen_idx
    ON addresses (first_seen_block DESC, address DESC)
    WHERE is_contract;

-- ---------------------------------------------------------------------------
-- 3. blocks-by-validator ordering
-- ---------------------------------------------------------------------------
-- blocks_validator_idx is (validator) alone. "blocks proposed by X, newest
-- first" scanned ~1/N of the block table and sorted it, growing linearly with
-- chain length. With only 4 validators that is ~25% of all blocks per request.
CREATE INDEX IF NOT EXISTS blocks_validator_number_idx
    ON blocks (validator, number DESC);

-- ---------------------------------------------------------------------------
-- 4. token transfer ordering by chain position
-- ---------------------------------------------------------------------------
-- The PK is (transaction_hash, log_index, batch_index), which is unique but NOT
-- in chain order. Paginating "latest transfers" needs a positional key.
--
-- log_index is block-scoped in JSON-RPC, so (block_number, log_index,
-- batch_index) is both unique and in execution order. batch_index is essential:
-- decode.ts expands one ERC-1155 TransferBatch log into one row per token id
-- sharing (transaction_hash, log_index), so a cursor without it would silently
-- drop every id after the first.
CREATE INDEX IF NOT EXISTS tt_position_idx
    ON token_transfers (block_number DESC, log_index ASC, batch_index ASC);

CREATE INDEX IF NOT EXISTS tt_token_position_idx
    ON token_transfers (token_address, block_number DESC, log_index ASC, batch_index ASC);

CREATE INDEX IF NOT EXISTS tt_from_position_idx
    ON token_transfers (from_address, block_number DESC, log_index ASC, batch_index ASC);

CREATE INDEX IF NOT EXISTS tt_to_position_idx
    ON token_transfers (to_address, block_number DESC, log_index ASC, batch_index ASC);

-- ---------------------------------------------------------------------------
-- 5. running totals
-- ---------------------------------------------------------------------------
-- /api/stats needs total transaction and address counts. count(*) on those
-- tables is an unbounded sequential scan: at explorer scale it exceeds the
-- statement timeout, and caching it with a short TTL bounds cost by time, not
-- by the scan's own duration, so it eventually always times out.
--
-- Instead the indexer maintains exact counters incrementally inside the SAME
-- per-block transaction that writes the rows, so they cannot drift from the
-- data even across a crash.
ALTER TABLE indexer_state ADD COLUMN IF NOT EXISTS total_transactions BIGINT NOT NULL DEFAULT 0;
ALTER TABLE indexer_state ADD COLUMN IF NOT EXISTS total_logs BIGINT NOT NULL DEFAULT 0;
ALTER TABLE indexer_state ADD COLUMN IF NOT EXISTS total_token_transfers BIGINT NOT NULL DEFAULT 0;

-- Backfill once for a database indexed before this migration existed. These
-- scans are acceptable exactly once, offline; they must never sit behind a
-- request.
UPDATE indexer_state
   SET total_transactions   = (SELECT count(*) FROM transactions),
       total_logs           = (SELECT count(*) FROM logs),
       total_token_transfers= (SELECT count(*) FROM token_transfers)
 WHERE id = 1
   AND total_transactions = 0
   AND total_logs = 0
   AND total_token_transfers = 0;

-- ---------------------------------------------------------------------------
-- 6. token metadata staleness
-- ---------------------------------------------------------------------------
-- The Phase 4 indexer only ever wrote (address, standard, first_seen_block), so
-- name/symbol/decimals/total_supply were NULL for every token forever — four of
-- the exact fields brief §20 requires. This column lets a metadata fetcher find
-- rows it has not yet resolved without scanning the whole table.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS metadata_fetched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS tokens_pending_metadata_idx
    ON tokens (first_seen_block)
    WHERE metadata_fetched_at IS NULL;

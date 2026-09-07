-- Giggora — per-account token history indexes (migration 005).
--
-- /api/v1/token/transfers?contractaddress=X&address=Y is "transfers of token X
-- involving account Y" — the call a wallet makes for a per-token history. The
-- query was
--
--     token_address = $1 AND (from_address = $2 OR to_address = $2)
--
-- and migration 002 indexes from_address and to_address each on their own, never
-- together with token_address. Postgres therefore had no index it could range on
-- for that predicate: it scanned EVERY transfer of the token and filtered by
-- account. On a busy token that is an unbounded scan per request, and enough
-- concurrent requests pin every connection in the pool.
--
-- The route now runs two disjoint branches (from = Y, and to = Y with from <> Y)
-- unioned, each bounded by its own LIMIT. These two indexes make each branch a
-- single index range scan whose order matches the keyset cursor exactly.
--
-- Idempotent, like every migration here.

CREATE INDEX IF NOT EXISTS tt_token_from_position_idx
    ON token_transfers (token_address, from_address, block_number DESC, log_index ASC, batch_index ASC);

CREATE INDEX IF NOT EXISTS tt_token_to_position_idx
    ON token_transfers (token_address, to_address, block_number DESC, log_index ASC, batch_index ASC);

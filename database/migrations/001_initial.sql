-- Giggora indexer schema (brief §21).
--
-- Storage choices worth knowing before you change anything:
--
-- * Hashes and addresses are BYTEA, not TEXT. An address is 20 bytes instead of
--   42, a hash 32 instead of 66. On a chain that will accumulate millions of
--   rows that roughly halves both table and index size. The cost is that every
--   query boundary must encode/decode hex, so ALL of that is centralised in
--   indexer/src/hex.ts — there should be exactly one place to get it wrong.
--   Readable views are provided at the bottom for humans with psql.
--
-- * Big integers (wei values, gas) are NUMERIC(78,0). uint256 does not fit in
--   BIGINT, and 78 digits covers the full range. Never use float here.
--
-- * There is NO reorg handling anywhere in this schema, deliberately. QBFT has
--   absolute finality, so a committed block can never be replaced. If Giggora
--   ever moves to a probabilistic-finality consensus, this assumption breaks
--   and blocks would need a canonical/orphaned flag.

-- ---------------------------------------------------------------------------
-- blocks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blocks (
    number              BIGINT       PRIMARY KEY,
    hash                BYTEA        NOT NULL UNIQUE,
    parent_hash         BYTEA        NOT NULL,
    timestamp           TIMESTAMPTZ  NOT NULL,
    validator           BYTEA        NOT NULL,   -- miner/proposer
    gas_used            NUMERIC(78,0) NOT NULL,
    gas_limit           NUMERIC(78,0) NOT NULL,
    base_fee_per_gas    NUMERIC(78,0),
    transaction_count   INTEGER      NOT NULL,
    size                BIGINT,
    state_root          BYTEA        NOT NULL,
    receipts_root       BYTEA        NOT NULL,
    transactions_root   BYTEA        NOT NULL,
    extra_data          BYTEA,
    indexed_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS blocks_timestamp_idx  ON blocks (timestamp DESC);
CREATE INDEX IF NOT EXISTS blocks_validator_idx  ON blocks (validator);

-- ---------------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
    hash                     BYTEA        PRIMARY KEY,
    block_number             BIGINT       NOT NULL REFERENCES blocks(number) ON DELETE CASCADE,
    transaction_index        INTEGER      NOT NULL,
    from_address             BYTEA        NOT NULL,
    to_address               BYTEA,                   -- NULL for contract creation
    value                    NUMERIC(78,0) NOT NULL,
    nonce                    BIGINT       NOT NULL,
    gas                      NUMERIC(78,0) NOT NULL,
    gas_price                NUMERIC(78,0),
    max_fee_per_gas          NUMERIC(78,0),
    max_priority_fee_per_gas NUMERIC(78,0),
    input                    BYTEA        NOT NULL,
    transaction_type         SMALLINT     NOT NULL,
    -- receipt fields
    status                   SMALLINT     NOT NULL,   -- 1 success, 0 reverted
    gas_used                 NUMERIC(78,0) NOT NULL,
    effective_gas_price      NUMERIC(78,0) NOT NULL,
    cumulative_gas_used      NUMERIC(78,0),
    contract_address         BYTEA,                   -- set when this deployed a contract
    fee                      NUMERIC(78,0) NOT NULL,  -- gas_used * effective_gas_price
    timestamp                TIMESTAMPTZ  NOT NULL,   -- denormalised from block
    indexed_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tx_block_number_idx  ON transactions (block_number DESC, transaction_index);
CREATE INDEX IF NOT EXISTS tx_from_idx          ON transactions (from_address, block_number DESC);
CREATE INDEX IF NOT EXISTS tx_to_idx            ON transactions (to_address, block_number DESC);
CREATE INDEX IF NOT EXISTS tx_timestamp_idx     ON transactions (timestamp DESC);
CREATE INDEX IF NOT EXISTS tx_contract_addr_idx ON transactions (contract_address)
    WHERE contract_address IS NOT NULL;

-- ---------------------------------------------------------------------------
-- logs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logs (
    transaction_hash BYTEA   NOT NULL REFERENCES transactions(hash) ON DELETE CASCADE,
    log_index        INTEGER NOT NULL,
    block_number     BIGINT  NOT NULL,
    address          BYTEA   NOT NULL,
    topic0           BYTEA,
    topic1           BYTEA,
    topic2           BYTEA,
    topic3           BYTEA,
    data             BYTEA   NOT NULL,
    PRIMARY KEY (transaction_hash, log_index)
);

-- topic0 + address is the access pattern for "all Transfer events for token X".
CREATE INDEX IF NOT EXISTS logs_address_topic0_idx ON logs (address, topic0, block_number DESC);
CREATE INDEX IF NOT EXISTS logs_topic0_idx         ON logs (topic0, block_number DESC);
CREATE INDEX IF NOT EXISTS logs_block_idx          ON logs (block_number DESC);

-- ---------------------------------------------------------------------------
-- token transfers (decoded from logs)
-- ---------------------------------------------------------------------------
-- One row per token movement. ERC-1155 batch transfers expand to one row per id,
-- which is why (transaction_hash, log_index) alone is not unique here and
-- batch_index completes the key.
CREATE TABLE IF NOT EXISTS token_transfers (
    transaction_hash BYTEA        NOT NULL,
    log_index        INTEGER      NOT NULL,
    batch_index      INTEGER      NOT NULL DEFAULT 0,
    block_number     BIGINT       NOT NULL,
    token_address    BYTEA        NOT NULL,
    standard         TEXT         NOT NULL CHECK (standard IN ('erc20','erc721','erc1155')),
    from_address     BYTEA        NOT NULL,
    to_address       BYTEA        NOT NULL,
    value            NUMERIC(78,0),   -- amount (erc20/erc1155); NULL for erc721
    token_id         NUMERIC(78,0),   -- NULL for erc20
    timestamp        TIMESTAMPTZ  NOT NULL,
    PRIMARY KEY (transaction_hash, log_index, batch_index),
    FOREIGN KEY (transaction_hash, log_index) REFERENCES logs(transaction_hash, log_index)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tt_token_idx  ON token_transfers (token_address, block_number DESC);
CREATE INDEX IF NOT EXISTS tt_from_idx   ON token_transfers (from_address, block_number DESC);
CREATE INDEX IF NOT EXISTS tt_to_idx     ON token_transfers (to_address, block_number DESC);
CREATE INDEX IF NOT EXISTS tt_block_idx  ON token_transfers (block_number DESC);

-- ---------------------------------------------------------------------------
-- tokens (contract metadata, filled in by detection)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tokens (
    address        BYTEA PRIMARY KEY,
    standard       TEXT  NOT NULL CHECK (standard IN ('erc20','erc721','erc1155')),
    name           TEXT,
    symbol         TEXT,
    decimals       SMALLINT,
    total_supply   NUMERIC(78,0),
    first_seen_block BIGINT NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- addresses
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS addresses (
    address          BYTEA PRIMARY KEY,
    is_contract      BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen_block BIGINT  NOT NULL,
    last_seen_block  BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS addresses_contract_idx ON addresses (is_contract) WHERE is_contract;

-- ---------------------------------------------------------------------------
-- indexer checkpoint (brief §22)
-- ---------------------------------------------------------------------------
-- Single-row table. last_processed_block is advanced IN THE SAME TRANSACTION
-- that writes a block's data, which is what makes the indexer crash-safe: the
-- checkpoint can never be ahead of the data it claims to describe.
CREATE TABLE IF NOT EXISTS indexer_state (
    id                   SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_processed_block BIGINT   NOT NULL,
    chain_id             BIGINT   NOT NULL,
    started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- human-readable views (psql convenience; the API does not use these)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_blocks AS
SELECT
    number,
    '0x' || encode(hash, 'hex')      AS hash,
    timestamp,
    '0x' || encode(validator, 'hex') AS validator,
    transaction_count,
    gas_used
FROM blocks;

CREATE OR REPLACE VIEW v_transactions AS
SELECT
    '0x' || encode(hash, 'hex')         AS hash,
    block_number,
    '0x' || encode(from_address, 'hex') AS from_address,
    CASE WHEN to_address IS NULL THEN NULL ELSE '0x' || encode(to_address, 'hex') END AS to_address,
    value,
    status,
    fee,
    timestamp
FROM transactions;

CREATE OR REPLACE VIEW v_token_transfers AS
SELECT
    '0x' || encode(transaction_hash, 'hex') AS transaction_hash,
    block_number,
    standard,
    '0x' || encode(token_address, 'hex')    AS token_address,
    '0x' || encode(from_address, 'hex')     AS from_address,
    '0x' || encode(to_address, 'hex')       AS to_address,
    value,
    token_id,
    timestamp
FROM token_transfers;

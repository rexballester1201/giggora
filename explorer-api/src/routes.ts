/**
 * Giggora explorer API — routes (brief §23, §24, §26).
 *
 * Conventions applied uniformly to every endpoint:
 *
 *   - All SQL is parameterised. No user value is ever concatenated into SQL
 *     text; hex is converted to a Buffer in JS and bound as $n.
 *
 *   - NO response schemas are declared. This is deliberate: Fastify serialises
 *     with fast-json-stringify, which COERCES values to the declared type. A wei
 *     field declared "number" would be silently rounded through a double,
 *     downstream of pg returning it correctly as a string and of every other
 *     safeguard. Omitting the schema means plain JSON.stringify and no coercion.
 *     Every uint256 leaves this file as a string.
 *
 *   - `input` and `data` are NEVER selected in a list projection, and are
 *     truncated in SQL on detail routes. A bounded row count is not a bounded
 *     byte count: contract-creation calldata is 24KB+ and log data is unbounded.
 *
 *   - NULL carries meaning and is preserved, never coerced: to_address NULL
 *     means contract creation (not the zero address), token_transfers.value NULL
 *     means ERC-721, token_id NULL means ERC-20.
 */

import type { FastifyInstance } from "fastify";
import { query, queryOne, addressToBytes, hashToBytes, bytesToHex, env } from "./db.ts";
import {
  ValidationError,
  parseAddress,
  parseHash,
  parseBlockNumber,
  parsePage,
  classifySearch,
} from "./validate.ts";
import {
  MAX_BIGINT,
  MIN_TIEBREAK,
  encodeCursor,
  decodeCursor,
  buildPage,
  escapeLike,
} from "./pagination.ts";
import { createPublicClient, defineChain, http } from "viem";

const chain = defineChain({
  id: Number(env.CHAIN_ID),
  name: env.CHAIN_NAME,
  nativeCurrency: {
    name: env.CURRENCY_NAME,
    symbol: env.CURRENCY_SYMBOL,
    decimals: Number(env.CURRENCY_DECIMALS),
  },
  rpcUrls: { default: { http: [env.RPC_URL] } },
});
const rpc = createPublicClient({ chain, transport: http(env.RPC_URL) });

// ---------------------------------------------------------------------------
// row mappers — the single place BYTEA becomes hex and NUMERIC stays a string
// ---------------------------------------------------------------------------

function mapBlock(r: any) {
  return {
    number: Number(r.number),
    hash: bytesToHex(r.hash),
    parentHash: bytesToHex(r.parent_hash),
    timestamp: r.timestamp,
    validator: bytesToHex(r.validator),
    gasUsed: r.gas_used,
    gasLimit: r.gas_limit,
    baseFeePerGas: r.base_fee_per_gas,
    transactionCount: Number(r.transaction_count),
    size: r.size === null ? null : Number(r.size),
    stateRoot: r.state_root ? bytesToHex(r.state_root) : undefined,
    receiptsRoot: r.receipts_root ? bytesToHex(r.receipts_root) : undefined,
    transactionsRoot: r.transactions_root ? bytesToHex(r.transactions_root) : undefined,
  };
}

function mapTx(r: any) {
  return {
    hash: bytesToHex(r.hash),
    blockNumber: Number(r.block_number),
    transactionIndex: Number(r.transaction_index),
    from: bytesToHex(r.from_address),
    // NULL means contract creation, NOT the zero address.
    to: bytesToHex(r.to_address),
    value: r.value,
    nonce: Number(r.nonce),
    gas: r.gas,
    gasUsed: r.gas_used,
    effectiveGasPrice: r.effective_gas_price,
    fee: r.fee,
    status: Number(r.status),
    type: Number(r.transaction_type),
    contractAddress: bytesToHex(r.contract_address),
    timestamp: r.timestamp,
    // Four bytes of calldata gives the UI the method selector and the true
    // payload size without carrying any of the payload itself.
    methodId: r.method_id ? bytesToHex(r.method_id) : null,
    inputSize: r.input_size === undefined ? undefined : Number(r.input_size),
  };
}

function mapTransfer(r: any) {
  return {
    transactionHash: bytesToHex(r.transaction_hash),
    logIndex: Number(r.log_index),
    batchIndex: Number(r.batch_index),
    blockNumber: Number(r.block_number),
    tokenAddress: bytesToHex(r.token_address),
    standard: r.standard,
    from: bytesToHex(r.from_address),
    to: bytesToHex(r.to_address),
    // NULL value means ERC-721; NULL tokenId means ERC-20. Preserved, not zeroed.
    value: r.value,
    tokenId: r.token_id,
    timestamp: r.timestamp,
    tokenName: r.name ?? undefined,
    tokenSymbol: r.symbol ?? undefined,
    tokenDecimals: r.decimals === null || r.decimals === undefined ? undefined : Number(r.decimals),
  };
}

function mapToken(r: any) {
  return {
    address: bytesToHex(r.address),
    standard: r.standard,
    name: r.name,
    symbol: r.symbol,
    decimals: r.decimals === null ? null : Number(r.decimals),
    totalSupply: r.total_supply,
    firstSeenBlock: Number(r.first_seen_block),
  };
}

// Column lists. `input` is excluded from every list projection on purpose.
const TX_LIST_COLS = `
  hash, block_number, transaction_index, from_address, to_address, value, nonce,
  gas, gas_used, effective_gas_price, fee, status, transaction_type,
  contract_address, timestamp,
  substring(input from 1 for 4) AS method_id,
  octet_length(input) AS input_size`;

export async function registerRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // §23 GET /api/stats
  // -------------------------------------------------------------------------
  app.get("/api/stats", async () => {
    // Totals come from indexer-maintained counters, never count(*).
    const state = await queryOne(
      `SELECT last_processed_block, chain_id, total_transactions, total_logs,
              total_token_transfers, updated_at
         FROM indexer_state WHERE id = 1`
    );
    const head = await queryOne(
      `SELECT number, timestamp, gas_used, gas_limit, base_fee_per_gas
         FROM blocks ORDER BY number DESC LIMIT 1`
    );
    // Bounded: the index makes this 100 rows, not a scan.
    const recent = await query(
      `SELECT timestamp FROM blocks ORDER BY number DESC LIMIT 100`
    );

    let avgBlockTimeSeconds: number | null = null;
    if (recent.length > 1) {
      const newest = new Date(recent[0].timestamp).getTime();
      const oldest = new Date(recent[recent.length - 1].timestamp).getTime();
      avgBlockTimeSeconds = (newest - oldest) / 1000 / (recent.length - 1);
    }

    const contracts = await queryOne(
      `SELECT count(*)::int AS n FROM addresses WHERE is_contract`
    );
    const tokens = await queryOne(`SELECT count(*)::int AS n FROM tokens`);

    return {
      chainId: Number(env.CHAIN_ID),
      chainName: env.CHAIN_NAME,
      currency: { name: env.CURRENCY_NAME, symbol: env.CURRENCY_SYMBOL, decimals: Number(env.CURRENCY_DECIMALS) },
      latestBlock: head ? Number(head.number) : null,
      lastIndexedBlock: state ? Number(state.last_processed_block) : null,
      // Strings: these are counters that will exceed 2^53 on a busy chain.
      totalTransactions: state ? String(state.total_transactions) : "0",
      totalLogs: state ? String(state.total_logs) : "0",
      totalTokenTransfers: state ? String(state.total_token_transfers) : "0",
      totalContracts: contracts ? contracts.n : 0,
      totalTokens: tokens ? tokens.n : 0,
      averageBlockTimeSeconds: avgBlockTimeSeconds,
      gasLimit: head ? head.gas_limit : null,
      baseFeePerGas: head ? head.base_fee_per_gas : null,
    };
  });

  // -------------------------------------------------------------------------
  // §23 GET /api/blocks   (keyset on number DESC)
  // -------------------------------------------------------------------------
  app.get("/api/blocks", async (req) => {
    const q = req.query as Record<string, unknown>;
    const { limit, cursor } = parsePage(q);
    const key = decodeCursor(cursor, "blk", 1);
    // Sentinel: max bigint keeps "number <= $1" as an index start condition.
    const from = key ? key[0] : MAX_BIGINT;

    let rows;
    if (q.validator !== undefined) {
      const validator = parseAddress(q.validator, "validator");
      rows = await query(
        `SELECT number, hash, parent_hash, timestamp, validator, gas_used, gas_limit,
                base_fee_per_gas, transaction_count, size
           FROM blocks
          WHERE validator = $1 AND number <= $2
          ORDER BY number DESC
          LIMIT $3`,
        [addressToBytes(validator), from, limit + 1]
      );
    } else {
      rows = await query(
        `SELECT number, hash, parent_hash, timestamp, validator, gas_used, gas_limit,
                base_fee_per_gas, transaction_count, size
           FROM blocks
          WHERE number <= $1
          ORDER BY number DESC
          LIMIT $2`,
        [from, limit + 1]
      );
    }

    const page = buildPage(rows, limit, (r) => encodeCursor("blk", [Number(r.number) - 1]));
    return { items: page.items.map(mapBlock), nextCursor: page.nextCursor };
  });

  // -------------------------------------------------------------------------
  // §23 GET /api/blocks/:number
  // -------------------------------------------------------------------------
  app.get("/api/blocks/:number", async (req, reply) => {
    const { number } = req.params as { number: string };
    const n = parseBlockNumber(number, "number");

    const block = await queryOne(
      `SELECT number, hash, parent_hash, timestamp, validator, gas_used, gas_limit,
              base_fee_per_gas, transaction_count, size, state_root, receipts_root,
              transactions_root
         FROM blocks WHERE number = $1`,
      [n]
    );
    if (!block) return reply.status(404).send({ error: "not_found", message: "No such block" });

    // §16 says "display all transactions within the block", but a 30M-gas block
    // can hold well over a thousand. The first page is embedded and the rest is
    // paginated through /api/transactions?block=N.
    const txs = await query(
      `SELECT ${TX_LIST_COLS} FROM transactions
        WHERE block_number = $1
        ORDER BY transaction_index ASC
        LIMIT 51`,
      [n]
    );

    return {
      ...mapBlock(block),
      transactions: txs.slice(0, 50).map(mapTx),
      transactionsTruncated: txs.length > 50,
    };
  });

  // -------------------------------------------------------------------------
  // §23 GET /api/transactions
  //
  // Ordering is block_number DESC, transaction_index ASC — matching
  // tx_block_number_idx (block_number DESC, transaction_index), a MIXED
  // direction index. The intuitive DESC,DESC has no scan direction on that
  // index and forces a sort of the whole match set.
  //
  // A row comparison cannot express a mixed-direction boundary, so the keyset
  // predicate is "<= plus OR": the "<=" is the index start condition and the OR
  // is a residual filter that can only discard rows inside the boundary block.
  // -------------------------------------------------------------------------
  app.get("/api/transactions", async (req) => {
    const q = req.query as Record<string, unknown>;
    const { limit, cursor } = parsePage(q);
    const key = decodeCursor(cursor, "tx", 2);
    const kb = key ? key[0] : MAX_BIGINT;
    const ki = key ? key[1] : MIN_TIEBREAK;

    if (q.block !== undefined) {
      const b = parseBlockNumber(q.block, "block");
      const rows = await query(
        `SELECT ${TX_LIST_COLS} FROM transactions
          WHERE block_number = $1 AND transaction_index > $2
          ORDER BY transaction_index ASC
          LIMIT $3`,
        [b, key ? key[1] : MIN_TIEBREAK, limit + 1]
      );
      const page = buildPage(rows, limit, (r) =>
        encodeCursor("tx", [Number(r.block_number), Number(r.transaction_index)])
      );
      return { items: page.items.map(mapTx), nextCursor: page.nextCursor };
    }

    const rows = await query(
      `SELECT ${TX_LIST_COLS} FROM transactions
        WHERE block_number <= $1 AND (block_number < $1 OR transaction_index > $2)
        ORDER BY block_number DESC, transaction_index ASC
        LIMIT $3`,
      [kb, ki, limit + 1]
    );
    const page = buildPage(rows, limit, (r) =>
      encodeCursor("tx", [Number(r.block_number), Number(r.transaction_index)])
    );
    return { items: page.items.map(mapTx), nextCursor: page.nextCursor };
  });

  // -------------------------------------------------------------------------
  // §23 GET /api/transactions/:hash
  // -------------------------------------------------------------------------
  app.get("/api/transactions/:hash", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const h = parseHash(hash, "hash");

    const tx = await queryOne(
      `SELECT hash, block_number, transaction_index, from_address, to_address, value,
              nonce, gas, gas_price, max_fee_per_gas, max_priority_fee_per_gas,
              transaction_type, status, gas_used, effective_gas_price,
              cumulative_gas_used, contract_address, fee, timestamp,
              substring(input from 1 for 4) AS method_id,
              octet_length(input) AS input_size,
              -- Truncated in SQL so a 24KB deploy payload never crosses the wire.
              substring(input from 1 for 4096) AS input_head
         FROM transactions WHERE hash = $1`,
      [hashToBytes(h)]
    );
    if (!tx) return reply.status(404).send({ error: "not_found", message: "No such transaction" });

    const logs = await query(
      `SELECT log_index, address, topic0, topic1, topic2, topic3,
              substring(data from 1 for 2048) AS data_head,
              octet_length(data) AS data_size
         FROM logs WHERE transaction_hash = $1
         ORDER BY log_index ASC LIMIT 201`,
      [hashToBytes(h)]
    );

    const transfers = await query(
      `SELECT tt.transaction_hash, tt.log_index, tt.batch_index, tt.block_number,
              tt.token_address, tt.standard, tt.from_address, tt.to_address,
              tt.value, tt.token_id, tt.timestamp,
              tk.name, tk.symbol, tk.decimals
         FROM token_transfers tt
         LEFT JOIN tokens tk ON tk.address = tt.token_address
        WHERE tt.transaction_hash = $1
        ORDER BY tt.log_index ASC, tt.batch_index ASC LIMIT 201`,
      [hashToBytes(h)]
    );

    const head = await queryOne(`SELECT max(number) AS n FROM blocks`);

    return {
      ...mapTx(tx),
      confirmations: head ? Number(head.n) - Number(tx.block_number) + 1 : null,
      gasPrice: tx.gas_price,
      maxFeePerGas: tx.max_fee_per_gas,
      maxPriorityFeePerGas: tx.max_priority_fee_per_gas,
      cumulativeGasUsed: tx.cumulative_gas_used,
      input: bytesToHex(tx.input_head),
      inputTruncated: Number(tx.input_size) > 4096,
      logs: logs.slice(0, 200).map((l: any) => ({
        logIndex: Number(l.log_index),
        address: bytesToHex(l.address),
        topics: [l.topic0, l.topic1, l.topic2, l.topic3].filter(Boolean).map(bytesToHex),
        data: bytesToHex(l.data_head),
        dataTruncated: Number(l.data_size) > 2048,
      })),
      logsTruncated: logs.length > 200,
      tokenTransfers: transfers.slice(0, 200).map(mapTransfer),
    };
  });

  // -------------------------------------------------------------------------
  // §23 GET /api/address/:address
  // -------------------------------------------------------------------------
  app.get("/api/address/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    const a = parseAddress(address, "address");
    const bytes = addressToBytes(a);

    const row = await queryOne(
      `SELECT address, is_contract, first_seen_block, last_seen_block
         FROM addresses WHERE address = $1`,
      [bytes]
    );

    // The schema holds NO balance state, so the balance must come from the node.
    // Summing token_transfers would be both unbounded and wrong (it misses
    // genesis allocation and gas spend).
    let balance: string | null = null;
    let balanceError: string | null = null;
    try {
      balance = (await rpc.getBalance({ address: a as `0x${string}` })).toString();
    } catch {
      balanceError = "node_unavailable";
    }

    const token = await queryOne(
      `SELECT address, standard, name, symbol, decimals, total_supply, first_seen_block
         FROM tokens WHERE address = $1`,
      [bytes]
    );

    if (!row && balance === null) {
      return reply.status(404).send({ error: "not_found", message: "No such address" });
    }

    return {
      address: a,
      isContract: row ? row.is_contract : false,
      balance,
      balanceError,
      firstSeenBlock: row ? Number(row.first_seen_block) : null,
      lastSeenBlock: row ? Number(row.last_seen_block) : null,
      token: token ? mapToken(token) : null,
      // Honest about what the schema cannot serve (brief §18 asks for holdings).
      tokenHoldings: null,
      tokenHoldingsUnavailable:
        "Balance state is not indexed; holdings require a balances table (not in this MVP)",
    };
  });

  // -------------------------------------------------------------------------
  // §23 GET /api/address/:address/transactions
  //
  // NEVER "WHERE from_address = $1 OR to_address = $1 ORDER BY ... LIMIT n".
  // Postgres BitmapOrs tx_from_idx and tx_to_idx then sorts EVERY transaction
  // touching the address to return 25 rows — for a hot address that is a
  // disk-spilling sort reachable from a 42-character URL.
  //
  // Two independently bounded index scans, UNION ALL'd, then ordered over at
  // most 2*(limit+1) rows.
  // -------------------------------------------------------------------------
  app.get("/api/address/:address/transactions", async (req) => {
    const { address } = req.params as { address: string };
    const a = parseAddress(address, "address");
    const bytes = addressToBytes(a);
    const { limit, cursor } = parsePage(req.query as Record<string, unknown>);
    const key = decodeCursor(cursor, "atx", 2);
    const kb = key ? key[0] : MAX_BIGINT;
    const ki = key ? key[1] : MIN_TIEBREAK;

    const rows = await query(
      `(
         SELECT ${TX_LIST_COLS} FROM transactions
          WHERE from_address = $1
            AND block_number <= $2 AND (block_number < $2 OR transaction_index > $3)
          ORDER BY block_number DESC, transaction_index ASC
          LIMIT $4
       )
       UNION ALL
       (
         SELECT ${TX_LIST_COLS} FROM transactions
          WHERE to_address = $1
            AND block_number <= $2 AND (block_number < $2 OR transaction_index > $3)
          ORDER BY block_number DESC, transaction_index ASC
          LIMIT $4
       )
       ORDER BY block_number DESC, transaction_index ASC
       LIMIT $4`,
      [bytes, kb, ki, limit + 1]
    );

    // A self-transfer appears in both branches. Deduplicate in JS over this tiny
    // set rather than with SQL UNION, which would hash the full wide row.
    const seen = new Set<string>();
    const deduped = rows.filter((r: any) => {
      const k = r.hash.toString("hex");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const page = buildPage(deduped, limit, (r: any) =>
      encodeCursor("atx", [Number(r.block_number), Number(r.transaction_index)])
    );
    return { items: page.items.map(mapTx), nextCursor: page.nextCursor };
  });

  // -------------------------------------------------------------------------
  // GET /api/address/:address/token-transfers
  // -------------------------------------------------------------------------
  app.get("/api/address/:address/token-transfers", async (req) => {
    const { address } = req.params as { address: string };
    const a = parseAddress(address, "address");
    const bytes = addressToBytes(a);
    const { limit, cursor } = parsePage(req.query as Record<string, unknown>);
    const key = decodeCursor(cursor, "att", 3);
    const kb = key ? key[0] : MAX_BIGINT;
    const kl = key ? key[1] : MIN_TIEBREAK;
    const kx = key ? key[2] : MIN_TIEBREAK;

    const rows = await query(
      `(
         SELECT tt.*, tk.name, tk.symbol, tk.decimals FROM token_transfers tt
           LEFT JOIN tokens tk ON tk.address = tt.token_address
          WHERE tt.from_address = $1
            AND tt.block_number <= $2
            AND (tt.block_number < $2 OR (tt.log_index, tt.batch_index) > ($3,$4))
          ORDER BY tt.block_number DESC, tt.log_index ASC, tt.batch_index ASC
          LIMIT $5
       )
       UNION ALL
       (
         SELECT tt.*, tk.name, tk.symbol, tk.decimals FROM token_transfers tt
           LEFT JOIN tokens tk ON tk.address = tt.token_address
          WHERE tt.to_address = $1
            AND tt.block_number <= $2
            AND (tt.block_number < $2 OR (tt.log_index, tt.batch_index) > ($3,$4))
          ORDER BY tt.block_number DESC, tt.log_index ASC, tt.batch_index ASC
          LIMIT $5
       )
       ORDER BY block_number DESC, log_index ASC, batch_index ASC
       LIMIT $5`,
      [bytes, kb, kl, kx, limit + 1]
    );

    const seen = new Set<string>();
    const deduped = rows.filter((r: any) => {
      const k = `${r.transaction_hash.toString("hex")}.${r.log_index}.${r.batch_index}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const page = buildPage(deduped, limit, (r: any) =>
      encodeCursor("att", [Number(r.block_number), Number(r.log_index), Number(r.batch_index)])
    );
    return { items: page.items.map(mapTransfer), nextCursor: page.nextCursor };
  });

  // -------------------------------------------------------------------------
  // §23 GET /api/tokens
  // -------------------------------------------------------------------------
  app.get("/api/tokens", async (req) => {
    const q = req.query as Record<string, unknown>;
    const { limit, cursor } = parsePage(q);
    const key = decodeCursor(cursor, "tok", 1);
    const from = key ? key[0] : MAX_BIGINT;

    if (q.standard !== undefined) {
      const s = String(q.standard);
      if (!["erc20", "erc721", "erc1155"].includes(s)) {
        throw new ValidationError("standard must be erc20, erc721 or erc1155");
      }
      const rows = await query(
        `SELECT address, standard, name, symbol, decimals, total_supply, first_seen_block
           FROM tokens WHERE standard = $1 AND first_seen_block <= $2
          ORDER BY first_seen_block DESC, address DESC LIMIT $3`,
        [s, from, limit + 1]
      );
      const page = buildPage(rows, limit, (r: any) => encodeCursor("tok", [Number(r.first_seen_block) - 1]));
      return { items: page.items.map(mapToken), nextCursor: page.nextCursor };
    }

    const rows = await query(
      `SELECT address, standard, name, symbol, decimals, total_supply, first_seen_block
         FROM tokens WHERE first_seen_block <= $1
        ORDER BY first_seen_block DESC, address DESC LIMIT $2`,
      [from, limit + 1]
    );
    const page = buildPage(rows, limit, (r: any) => encodeCursor("tok", [Number(r.first_seen_block) - 1]));
    return { items: page.items.map(mapToken), nextCursor: page.nextCursor };
  });

  // -------------------------------------------------------------------------
  // §23 GET /api/token/:address  (+ its transfers)
  // -------------------------------------------------------------------------
  app.get("/api/token/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    const a = parseAddress(address, "address");
    const token = await queryOne(
      `SELECT address, standard, name, symbol, decimals, total_supply, first_seen_block
         FROM tokens WHERE address = $1`,
      [addressToBytes(a)]
    );
    if (!token) return reply.status(404).send({ error: "not_found", message: "No such token" });

    return {
      ...mapToken(token),
      // §20 wants holder counts; there is no balance state to derive them from,
      // and aggregating a token's entire transfer history per request is not a
      // valid substitute. Say so rather than returning a slow wrong number.
      holders: null,
      holdersUnavailable: "Holder counts require balance state, which is not indexed in this MVP",
    };
  });

  app.get("/api/token/:address/transfers", async (req) => {
    const { address } = req.params as { address: string };
    const a = parseAddress(address, "address");
    const { limit, cursor } = parsePage(req.query as Record<string, unknown>);
    const key = decodeCursor(cursor, "ttr", 3);
    const kb = key ? key[0] : MAX_BIGINT;
    const kl = key ? key[1] : MIN_TIEBREAK;
    const kx = key ? key[2] : MIN_TIEBREAK;

    const rows = await query(
      `SELECT tt.*, tk.name, tk.symbol, tk.decimals FROM token_transfers tt
         LEFT JOIN tokens tk ON tk.address = tt.token_address
        WHERE tt.token_address = $1
          AND tt.block_number <= $2
          AND (tt.block_number < $2 OR (tt.log_index, tt.batch_index) > ($3,$4))
        ORDER BY tt.block_number DESC, tt.log_index ASC, tt.batch_index ASC
        LIMIT $5`,
      [addressToBytes(a), kb, kl, kx, limit + 1]
    );
    const page = buildPage(rows, limit, (r: any) =>
      encodeCursor("ttr", [Number(r.block_number), Number(r.log_index), Number(r.batch_index)])
    );
    return { items: page.items.map(mapTransfer), nextCursor: page.nextCursor };
  });

  // -------------------------------------------------------------------------
  // §23 GET /api/contracts
  // -------------------------------------------------------------------------
  app.get("/api/contracts", async (req) => {
    const { limit, cursor } = parsePage(req.query as Record<string, unknown>);
    const key = decodeCursor(cursor, "con", 1);
    const from = key ? key[0] : MAX_BIGINT;

    const rows = await query(
      `SELECT a.address, a.first_seen_block, a.last_seen_block,
              t.standard, t.name, t.symbol
         FROM addresses a
         LEFT JOIN tokens t ON t.address = a.address
        WHERE a.is_contract AND a.first_seen_block <= $1
        ORDER BY a.first_seen_block DESC, a.address DESC
        LIMIT $2`,
      [from, limit + 1]
    );

    const page = buildPage(rows, limit, (r: any) => encodeCursor("con", [Number(r.first_seen_block) - 1]));
    return {
      items: page.items.map((r: any) => ({
        address: bytesToHex(r.address),
        firstSeenBlock: Number(r.first_seen_block),
        lastSeenBlock: Number(r.last_seen_block),
        tokenStandard: r.standard ?? null,
        name: r.name ?? null,
        symbol: r.symbol ?? null,
        // Verification is delegated to Blockscout/Sourcify in this MVP.
        verified: false,
      })),
      nextCursor: page.nextCursor,
    };
  });

  // -------------------------------------------------------------------------
  // §26 GET /api/search — universal search
  //
  // A 32-byte hash is ambiguous between a transaction and a block hash by shape
  // alone, so the database decides.
  // -------------------------------------------------------------------------
  app.get("/api/search", async (req) => {
    const q = req.query as Record<string, unknown>;
    const { kind, value } = classifySearch(q.q);

    if (kind === "block_number") {
      const b = await queryOne(`SELECT number FROM blocks WHERE number = $1`, [Number(value)]);
      return b
        ? { kind: "block", value: Number(b.number), path: `/api/blocks/${Number(b.number)}` }
        : { kind: "none", value: null, path: null };
    }

    if (kind === "address") {
      const bytes = addressToBytes(value);
      const token = await queryOne(`SELECT address FROM tokens WHERE address = $1`, [bytes]);
      if (token) return { kind: "token", value, path: `/api/token/${value}` };
      const addr = await queryOne(
        `SELECT address, is_contract FROM addresses WHERE address = $1`,
        [bytes]
      );
      if (addr) {
        return {
          kind: addr.is_contract ? "contract" : "address",
          value,
          path: `/api/address/${value}`,
        };
      }
      // Unknown to the index but still a valid address — the node may know it.
      return { kind: "address", value, path: `/api/address/${value}` };
    }

    // 32-byte hash: transaction or block?
    const bytes = hashToBytes(value);
    const tx = await queryOne(`SELECT hash FROM transactions WHERE hash = $1`, [bytes]);
    if (tx) return { kind: "transaction", value, path: `/api/transactions/${value}` };
    const blk = await queryOne(`SELECT number FROM blocks WHERE hash = $1`, [bytes]);
    if (blk) return { kind: "block", value: Number(blk.number), path: `/api/blocks/${Number(blk.number)}` };
    return { kind: "none", value: null, path: null };
  });

  // -------------------------------------------------------------------------
  // §24 public API — Etherscan-shaped surface
  // -------------------------------------------------------------------------
  app.get("/api/v1/account/balance", async (req) => {
    const q = req.query as Record<string, unknown>;
    const a = parseAddress(q.address, "address");
    try {
      const bal = await rpc.getBalance({ address: a as `0x${string}` });
      return { status: "1", message: "OK", result: bal.toString() };
    } catch {
      return { status: "0", message: "NOTOK", result: "node unavailable" };
    }
  });

  app.get("/api/v1/account/transactions", async (req) => {
    const q = req.query as Record<string, unknown>;
    const a = parseAddress(q.address, "address");
    const { limit, cursor } = parsePage(q);
    const key = decodeCursor(cursor, "atx", 2);
    const kb = key ? key[0] : MAX_BIGINT;
    const ki = key ? key[1] : MIN_TIEBREAK;

    const rows = await query(
      `(
         SELECT ${TX_LIST_COLS} FROM transactions
          WHERE from_address = $1
            AND block_number <= $2 AND (block_number < $2 OR transaction_index > $3)
          ORDER BY block_number DESC, transaction_index ASC LIMIT $4
       ) UNION ALL (
         SELECT ${TX_LIST_COLS} FROM transactions
          WHERE to_address = $1
            AND block_number <= $2 AND (block_number < $2 OR transaction_index > $3)
          ORDER BY block_number DESC, transaction_index ASC LIMIT $4
       )
       ORDER BY block_number DESC, transaction_index ASC LIMIT $4`,
      [addressToBytes(a), kb, ki, limit + 1]
    );

    const seen = new Set<string>();
    const deduped = rows.filter((r: any) => {
      const k = r.hash.toString("hex");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const page = buildPage(deduped, limit, (r: any) =>
      encodeCursor("atx", [Number(r.block_number), Number(r.transaction_index)])
    );

    return {
      status: "1",
      message: "OK",
      // Etherscan's isError is the INVERSION of status — the easiest silent bug
      // in the whole compatibility layer.
      result: page.items.map((r: any) => ({
        ...mapTx(r),
        isError: Number(r.status) === 1 ? "0" : "1",
      })),
      nextCursor: page.nextCursor,
    };
  });

  app.get("/api/v1/token/transfers", async (req) => {
    const q = req.query as Record<string, unknown>;
    const { limit, cursor } = parsePage(q);
    const key = decodeCursor(cursor, "ttr", 3);
    const kb = key ? key[0] : MAX_BIGINT;
    const kl = key ? key[1] : MIN_TIEBREAK;
    const kx = key ? key[2] : MIN_TIEBREAK;

    if (q.contractaddress === undefined && q.address === undefined) {
      throw new ValidationError("either contractaddress or address is required");
    }

    let rows;
    if (q.contractaddress !== undefined) {
      const a = parseAddress(q.contractaddress, "contractaddress");
      rows = await query(
        `SELECT tt.*, tk.name, tk.symbol, tk.decimals FROM token_transfers tt
           LEFT JOIN tokens tk ON tk.address = tt.token_address
          WHERE tt.token_address = $1 AND tt.block_number <= $2
            AND (tt.block_number < $2 OR (tt.log_index, tt.batch_index) > ($3,$4))
          ORDER BY tt.block_number DESC, tt.log_index ASC, tt.batch_index ASC LIMIT $5`,
        [addressToBytes(a), kb, kl, kx, limit + 1]
      );
    } else {
      const a = parseAddress(q.address, "address");
      rows = await query(
        `(
           SELECT tt.*, tk.name, tk.symbol, tk.decimals FROM token_transfers tt
             LEFT JOIN tokens tk ON tk.address = tt.token_address
            WHERE tt.from_address = $1 AND tt.block_number <= $2
              AND (tt.block_number < $2 OR (tt.log_index, tt.batch_index) > ($3,$4))
            ORDER BY tt.block_number DESC, tt.log_index ASC, tt.batch_index ASC LIMIT $5
         ) UNION ALL (
           SELECT tt.*, tk.name, tk.symbol, tk.decimals FROM token_transfers tt
             LEFT JOIN tokens tk ON tk.address = tt.token_address
            WHERE tt.to_address = $1 AND tt.block_number <= $2
              AND (tt.block_number < $2 OR (tt.log_index, tt.batch_index) > ($3,$4))
            ORDER BY tt.block_number DESC, tt.log_index ASC, tt.batch_index ASC LIMIT $5
         )
         ORDER BY block_number DESC, log_index ASC, batch_index ASC LIMIT $5`,
        [addressToBytes(a), kb, kl, kx, limit + 1]
      );
    }

    const seen = new Set<string>();
    const deduped = rows.filter((r: any) => {
      const k = `${r.transaction_hash.toString("hex")}.${r.log_index}.${r.batch_index}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const page = buildPage(deduped, limit, (r: any) =>
      encodeCursor("ttr", [Number(r.block_number), Number(r.log_index), Number(r.batch_index)])
    );
    return { status: "1", message: "OK", result: page.items.map(mapTransfer), nextCursor: page.nextCursor };
  });

  app.get("/api/v1/tx/:hash", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const h = parseHash(hash, "hash");
    const tx = await queryOne(
      `SELECT ${TX_LIST_COLS} FROM transactions WHERE hash = $1`,
      [hashToBytes(h)]
    );
    if (!tx) {
      return reply.status(404).send({ status: "0", message: "NOTOK", result: "transaction not found" });
    }
    return {
      status: "1",
      message: "OK",
      result: { ...mapTx(tx), isError: Number(tx.status) === 1 ? "0" : "1" },
    };
  });
}

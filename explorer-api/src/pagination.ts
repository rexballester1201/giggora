/**
 * Giggora explorer API — keyset pagination.
 *
 * OFFSET is not used anywhere, and no endpoint returns a total count. Both
 * decisions are deliberate and both are about behaviour at explorer scale:
 *
 *   OFFSET makes Postgres materialise and discard every skipped row. At tens of
 *   millions of transactions, a deep page reads millions of index entries to
 *   return 25 rows, so cost grows linearly with page depth and a single crawler
 *   can saturate the pool. It is also unstable: a new block shifts every row, so
 *   consecutive pages silently duplicate or skip entries.
 *
 *   count(*) over transactions/logs/token_transfers is an unbounded sequential
 *   scan. Exact totals come from counters the indexer maintains inside its own
 *   per-block transaction (migration 002) instead.
 *
 * THE SENTINEL TRICK. The obvious way to make a cursor optional is
 * "($1::bigint IS NULL OR number <= $1)". Postgres cannot extract an OR-NULL
 * predicate as an index start condition, so the UNCURSORED first page silently
 * degrades to a full index scan while cursored pages look fine — the worst kind
 * of performance bug, because page 1 is the most requested page of all.
 *
 * Instead, when no cursor is given we substitute the MAXIMUM of the key domain.
 * The predicate is then always "key <= $1", which is a real index start
 * condition with an identical plan on page 1 and page 100,000.
 */

import { ValidationError } from "./validate.ts";

/** Maximum bigint — the sentinel for a descending primary key. */
export const MAX_BIGINT = "9223372036854775807";
/** Sentinel for an ASCENDING tiebreaker compared with ">". -1 is vacuously true. */
export const MIN_TIEBREAK = -1;

/**
 * Every 20-byte address is <= 0xff..ff, so this is the true maximum of the
 * address domain and therefore a valid first-page sentinel for a descending
 * (block, address) row comparison.
 */
export const MAX_ADDRESS = "f".repeat(40);

/**
 * Per-column upper bounds for cursor components.
 *
 * These are NOT decoration. A cursor component is bound into a predicate that
 * compares against a specific column type, and Postgres infers the parameter
 * type from that comparison. transaction_index, log_index and batch_index are
 * INTEGER (int4), so a component above 2147483647 raises SQLSTATE 22003
 * ("value out of range for type integer") deep inside the driver — which is not
 * a ValidationError and therefore surfaced as a 500.
 *
 * Number.isSafeInteger alone accepts up to 9007199254740991, i.e. four million
 * times the int4 ceiling, so `?cursor=tx.5.2147483648` was an unauthenticated
 * remote 500 on eight endpoints. Bounding each component to its own column's
 * domain turns that into a clean 400.
 */
export const MAX_INT4 = 2147483647;
export const MAX_INT8 = 9223372036854775807n;

export interface Cursor {
  tag: string;
  parts: number[];
}

const DIGITS = /^[0-9]+$/;

/**
 * Encode a cursor as "<tag>.<k1>.<k2>...".
 *
 * Deliberately human-readable rather than an opaque blob: a cursor appearing in
 * an access log or a bug report can be read directly. It is safe to expose
 * because it carries POSITION, not authority — every component is re-validated
 * and range-checked on the way back in, and it grants no access that the
 * endpoint would not otherwise give.
 */
export function encodeCursor(tag: string, parts: (number | string)[]): string {
  return [tag, ...parts.map(String)].join(".");
}

/**
 * Decode and strictly validate a cursor.
 *
 * The tag must match the route that issued it, so a cursor cannot be replayed
 * against an endpoint whose sort key has a different arity — which would
 * otherwise bind the wrong number of parameters or compare the wrong columns.
 */
/**
 * Decode and strictly validate a numeric cursor.
 *
 * `bounds` gives the maximum for each component, in order, matching the domain
 * of the column it will be compared against. Omitting it defaults every
 * component to the int8 domain, which is only correct for BIGINT columns.
 */
export function decodeCursor(
  raw: string | null,
  tag: string,
  arity: number,
  bounds?: number[]
): number[] | null {
  if (raw === null || raw === "") return null;
  if (raw.length > 96) throw new ValidationError("cursor is malformed");

  const bits = raw.split(".");
  if (bits[0] !== tag) throw new ValidationError("cursor does not belong to this endpoint");
  if (bits.length !== arity + 1) throw new ValidationError("cursor is malformed");

  const parts: number[] = [];
  for (let i = 1; i < bits.length; i++) {
    const b = bits[i];
    if (!DIGITS.test(b)) throw new ValidationError("cursor is malformed");
    const n = Number(b);
    if (!Number.isSafeInteger(n)) throw new ValidationError("cursor is out of range");
    // Bound against the TARGET COLUMN's domain, not merely JS safe-integer.
    const max = bounds?.[i - 1];
    if (max !== undefined && n > max) throw new ValidationError("cursor is out of range");
    parts.push(n);
  }
  return parts;
}

/**
 * Composite (block, address) cursor for feeds ordered by a NON-UNIQUE block
 * column with an address tiebreaker.
 *
 * This exists because the obvious shortcut — store only the block and page with
 * `block <= lastBlock - 1` — is wrong whenever the sort key is not unique. The
 * decrement excludes the ENTIRE tie group at that block, not just the rows
 * already delivered, so every token or contract sharing a first_seen_block with
 * the last row of a page is skipped and unreachable by any later page. Several
 * contracts deployed in one block is the normal case, not an edge case.
 *
 * It also removes a second bug: with a boundary row at block 0 the decrement
 * produced "con.-1", a cursor the API's own validator rejects with 400.
 */
export function encodeAddrCursor(tag: string, block: number | string, addressHex: string): string {
  return `${tag}.${block}.${addressHex.replace(/^0x/, "").toLowerCase()}`;
}

export function decodeAddrCursor(
  raw: string | null,
  tag: string
): { block: number; address: string } | null {
  if (raw === null || raw === "") return null;
  if (raw.length > 96) throw new ValidationError("cursor is malformed");

  const bits = raw.split(".");
  if (bits[0] !== tag) throw new ValidationError("cursor does not belong to this endpoint");
  if (bits.length !== 3) throw new ValidationError("cursor is malformed");
  if (!DIGITS.test(bits[1])) throw new ValidationError("cursor is malformed");
  if (!/^[0-9a-f]{40}$/.test(bits[2])) throw new ValidationError("cursor is malformed");

  const block = Number(bits[1]);
  if (!Number.isSafeInteger(block)) throw new ValidationError("cursor is out of range");
  return { block, address: bits[2] };
}

/**
 * Build the bound parameters for a keyset predicate, substituting sentinels
 * when there is no cursor.
 */
export function keysetParams(cursor: number[] | null, defaults: (string | number)[]): (string | number)[] {
  if (cursor === null) return defaults;
  return cursor;
}

/**
 * Standard page envelope.
 *
 * `nextCursor` is derived by fetching limit+1 rows and popping the extra — that
 * extra row is the ONLY "is there more" signal, and it costs one index entry
 * rather than a count.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function buildPage<T>(
  rows: T[],
  limit: number,
  makeCursor: (row: T) => string
): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: makeCursor(items[items.length - 1]) };
}

/**
 * Escape LIKE wildcards in a user-supplied term.
 *
 * Parameterisation stops injection but NOT wildcards: a bound value of '%'
 * matches every row, turning a search box into a full table scan. Must be used
 * with ESCAPE '\' in the query.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

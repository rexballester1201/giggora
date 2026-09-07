/**
 * Giggora explorer API — input validation (brief §23, §30).
 *
 * Every value that reaches a SQL query passes through here first. Validation is
 * whitelist-based: a parameter is rejected unless it matches an exact expected
 * shape. Nothing is coerced silently, because a silent coercion is how a
 * malformed address turns into a query that returns the wrong account's data.
 *
 * Note this is defence in depth, not the primary injection defence — all SQL is
 * parameterised in db.ts and user input is never concatenated into SQL text.
 * These checks exist to reject bad input early with a clear 400 rather than
 * letting it reach the database at all.
 */

export class ValidationError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;
const DIGITS = /^[0-9]+$/;
// Tagged cursor shape: a lowercase tag, then one or more dot-separated digit
// groups — e.g. "blk.1243", "tx.900.3", "ttr.900.12.0".
// The dot is escaped deliberately: an unescaped "." matches any character and
// would accept "blk_1243" or worse.
const CURSOR_SHAPE = /^[a-z]{2,5}(?:\.[0-9]{1,20})+$/;

/** Guard against memory/CPU abuse before any pattern matching happens. */
function assertShortString(v: unknown, field: string, max = 128): string {
  if (typeof v !== "string") throw new ValidationError(`${field} must be a string`);
  if (v.length > max) throw new ValidationError(`${field} is too long (max ${max} characters)`);
  return v;
}

export function parseAddress(v: unknown, field = "address"): string {
  const s = assertShortString(v, field, 42);
  if (!HEX_ADDRESS.test(s)) {
    throw new ValidationError(`${field} must be a 0x-prefixed 20-byte hex address`);
  }
  // Lowercase for storage comparison. Checksum casing is display-only; comparing
  // a checksummed string against stored bytes would never match.
  return s.toLowerCase();
}

export function parseHash(v: unknown, field = "hash"): string {
  const s = assertShortString(v, field, 66);
  if (!HEX_HASH.test(s)) {
    throw new ValidationError(`${field} must be a 0x-prefixed 32-byte hex hash`);
  }
  return s.toLowerCase();
}

/**
 * Block numbers are validated as digit strings before BigInt conversion.
 *
 * Number() is deliberately avoided: it accepts "1e9", "0x10", " 12 ", "Infinity"
 * and NaN-producing junk, any of which would reach the query as something the
 * caller did not write.
 */
export function parseBlockNumber(v: unknown, field = "number"): number {
  const s = assertShortString(v, field, 20);
  if (!DIGITS.test(s)) throw new ValidationError(`${field} must be a non-negative integer`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new ValidationError(`${field} is out of range`);
  return n;
}

export interface Page {
  limit: number;
  cursor: string | null;
}

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 25;

/**
 * Pagination parameters.
 *
 * limit is hard-capped: an unbounded list endpoint is both a DoS vector and a
 * violation of brief §23 ("Do not return enormous datasets").
 */
export function parsePage(q: Record<string, unknown>): Page {
  let limit = DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    const s = assertShortString(q.limit, "limit", 10);
    if (!DIGITS.test(s)) throw new ValidationError("limit must be a positive integer");
    limit = Number(s);
    if (limit < 1) throw new ValidationError("limit must be at least 1");
    if (limit > MAX_LIMIT) throw new ValidationError(`limit may not exceed ${MAX_LIMIT}`);
  }

  let cursor: string | null = null;
  if (q.cursor !== undefined && q.cursor !== "") {
    // Coarse shape check only. Cursors are TAGGED ("blk.1243", "tx.900.3"), so
    // a digits-only rule here would reject every cursor this API issues.
    // decodeCursor() does the precise work: it knows the expected tag and
    // arity for the specific route and range-checks each component.
    const s = assertShortString(q.cursor, "cursor", 96);
    if (!CURSOR_SHAPE.test(s)) throw new ValidationError("cursor is malformed");
    cursor = s;
  }

  return { limit, cursor };
}

export type SearchKind = "address" | "hash" | "block_number";

/**
 * Classify a universal search term (brief §26).
 *
 * A 32-byte hash is ambiguous between a transaction hash and a block hash by
 * shape alone, so this only reports "hash" — the route must then probe the
 * database to decide which it is. Length is the ONLY reliable discriminator
 * available without a lookup.
 */
export function classifySearch(v: unknown): { kind: SearchKind; value: string } {
  const s = assertShortString(v, "q", 128).trim();
  if (s.length === 0) throw new ValidationError("q must not be empty");

  if (HEX_ADDRESS.test(s)) return { kind: "address", value: s.toLowerCase() };
  if (HEX_HASH.test(s)) return { kind: "hash", value: s.toLowerCase() };
  if (DIGITS.test(s)) {
    const n = Number(s);
    if (!Number.isSafeInteger(n)) throw new ValidationError("block number is out of range");
    return { kind: "block_number", value: s };
  }

  throw new ValidationError(
    "q must be a 0x address, a 0x transaction or block hash, or a block number"
  );
}

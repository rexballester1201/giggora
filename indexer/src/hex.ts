/**
 * Hex <-> Buffer conversion.
 *
 * The database stores hashes and addresses as BYTEA. This module is the ONLY
 * place that converts between that and the 0x-prefixed hex the RPC and the
 * outside world use, so there is exactly one place to get it wrong.
 *
 * Addresses are stored lower-cased/raw bytes, never EIP-55 checksummed —
 * checksumming is a display concern and would break equality comparisons.
 */

export type Hex = `0x${string}`;

/** 0x-hex -> Buffer. Returns null for null/undefined so NULL columns round-trip. */
export function toBytes(hex: string | null | undefined): Buffer | null {
  if (hex === null || hex === undefined) return null;
  const s = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (s.length === 0) return Buffer.alloc(0);
  if (s.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  if (!/^[0-9a-fA-F]*$/.test(s)) throw new Error(`non-hex characters: ${hex}`);
  return Buffer.from(s, "hex");
}

/** Buffer -> 0x-hex. */
export function toHexString(buf: Buffer | null | undefined): Hex | null {
  if (buf === null || buf === undefined) return null;
  return `0x${buf.toString("hex")}` as Hex;
}

/**
 * bigint -> string for NUMERIC(78,0) columns.
 *
 * Values are passed to Postgres as strings, never as JS numbers: uint256 far
 * exceeds Number.MAX_SAFE_INTEGER and a silent precision loss here would
 * corrupt balances.
 */
export function toNumeric(v: bigint | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v.toString();
}

/** Unix seconds (bigint from RPC) -> Date for TIMESTAMPTZ. */
export function toTimestamp(unixSeconds: bigint | number): Date {
  return new Date(Number(unixSeconds) * 1000);
}

/** Extract the low 20 bytes of a 32-byte log topic as an address. */
export function topicToAddress(topic: string): Buffer {
  const b = toBytes(topic);
  if (!b || b.length !== 32) throw new Error(`expected 32-byte topic, got ${topic}`);
  return b.subarray(12);
}

/** Decode a 32-byte word of log data at word index `i` as a bigint. */
export function wordAt(data: string, i: number): bigint {
  const s = data.startsWith("0x") ? data.slice(2) : data;
  const start = i * 64;
  const word = s.slice(start, start + 64);
  if (word.length < 64) throw new Error(`data too short for word ${i}`);
  return BigInt(`0x${word}`);
}

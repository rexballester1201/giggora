/**
 * Giggora explorer API — database access and the hex/BYTEA boundary.
 *
 * This module exists because the schema stores hashes and addresses as BYTEA
 * (20/32 raw bytes) while the outside world speaks 0x-prefixed hex. That
 * conversion is the single most dangerous place in the API:
 *
 *   - it is where naive string interpolation creeps into SQL, and
 *   - it is where uint256 precision is silently lost if a value is ever
 *     touched by a JS number.
 *
 * So both concerns are handled here, once, and nowhere else:
 *
 *   1. EVERY query goes through query()/queryOne(), which take parameterised
 *      SQL only. Values are passed as $1..$n placeholders — the hex string is
 *      converted to a Buffer in JS and handed to pg as a bound parameter, so
 *      user input never becomes SQL text.
 *
 *   2. NUMERIC(78,0) columns are read as strings. node-postgres is explicitly
 *      configured below not to parse them into JS numbers, because uint256 far
 *      exceeds Number.MAX_SAFE_INTEGER and the corruption would be silent.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// pg type parsing
// ---------------------------------------------------------------------------
// OID 1700 = NUMERIC. By default node-postgres returns it as a JS string
// already, but we pin it explicitly so a future dependency change cannot
// silently start returning numbers and corrupt balances.
pg.types.setTypeParser(1700, (v: string) => v);
// OID 20 = INT8/BIGINT. Block numbers fit in a double today, but returning
// strings and converting deliberately is safer than assuming they always will.
pg.types.setTypeParser(20, (v: string) => v);

/**
 * Configuration, from a .env FILE if there is one and from the real
 * environment always.
 *
 * The file is a developer-machine convenience. In a container there is no
 * .env - configuration arrives as actual environment variables - and
 * requiring the file made this process crash on startup with
 *   ENOENT: no such file or directory, open '/app/.env'
 * the moment .dockerignore (correctly) stopped shipping secrets into images.
 *
 * process.env wins over the file: the ordinary 12-factor precedence, where an
 * explicitly exported variable is a deliberate act and a checked-in default
 * is not.
 */
function loadEnv(): Record<string, string> {
  let fromFile: Record<string, string> = {};
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    fromFile = Object.fromEntries(
      readFileSync(envPath, "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    ) as Record<string, string>;
  }
  return { ...fromFile, ...(process.env as Record<string, string>) };
}
export const env = loadEnv();

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL,
  max: Number(process.env.API_POOL_SIZE ?? 10),
  // Fail fast rather than hanging a request forever on a saturated pool.
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30_000,
  // A single runaway query must not pin a connection indefinitely.
  statement_timeout: 15_000,
});

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(sql, params);
  return r.rows as T[];
}

export async function queryOne<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows.length ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// hex <-> BYTEA
// ---------------------------------------------------------------------------

// Hex conversion is NOT reimplemented here. indexer/src/hex.ts is the single
// place that converts between 0x-hex and BYTEA, and duplicating it is exactly
// the failure its own header warns about. These are thin, length-checked
// wrappers over it.
import { toBytes, toHexString } from "../../indexer/src/hex.ts";

/**
 * Convert validated 0x-hex to a Buffer for a bound query parameter, asserting
 * the resulting byte length.
 *
 * The length assertion is not redundant with validation. Buffer.from(hex,'hex')
 * silently stops at the first invalid pair, so a 41-character "address" yields
 * a perfectly valid 20-byte Buffer that matches no row — a misleading 404
 * instead of a 400. Gating length on the STRING and asserting it on the BUFFER
 * closes that gap from both sides.
 */
export function hexToBytes(hex: string, expectedBytes?: number): Buffer {
  const buf = toBytes(hex);
  if (!buf) throw new Error("hex value is required");
  if (expectedBytes !== undefined && buf.length !== expectedBytes) {
    throw new Error(`expected ${expectedBytes} bytes, got ${buf.length}`);
  }
  return buf;
}

/** 20-byte address for a bound parameter. */
export function addressToBytes(hex: string): Buffer {
  return hexToBytes(hex, 20);
}

/** 32-byte hash for a bound parameter. */
export function hashToBytes(hex: string): Buffer {
  return hexToBytes(hex, 32);
}

/** Buffer -> 0x-hex, or null. */
export function bytesToHex(b: Buffer | null | undefined): string | null {
  return toHexString(b as Buffer | null | undefined);
}

/**
 * EIP-55 checksummed address for display.
 *
 * Storage and comparison always use lowercase raw bytes; checksumming is a
 * presentation concern only. Applying it before a comparison would break
 * equality, so it is never used on the query side.
 */
export function toChecksumAddress(addr: string, keccak: (s: string) => string): string {
  const lower = addr.toLowerCase().replace(/^0x/, "");
  const hash = keccak(lower).replace(/^0x/, "");
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

export async function closePool(): Promise<void> {
  await pool.end();
}

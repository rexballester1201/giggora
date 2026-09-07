/**
 * Giggora — token metadata resolution (brief §20).
 *
 * The Phase 4 indexer only ever wrote (address, standard, first_seen_block), so
 * name, symbol, decimals and total_supply were NULL for every token forever —
 * four of the exact fields §20 requires the explorer to display.
 *
 * This resolves them by calling the contract. Design notes:
 *
 *   - It runs OUTSIDE the per-block transaction. A slow or reverting eth_call
 *     must never hold a write transaction open or stall block ingestion.
 *   - Every call is individually tolerated. `name()` and `symbol()` are optional
 *     in ERC-20 and absent from the ERC-1155 standard entirely, so a revert is
 *     expected and normal, not an error.
 *   - metadata_fetched_at is stamped even when every call fails, so a contract
 *     that does not implement these is not retried forever.
 */

import type pg from "pg";
import { toHexString } from "./hex.ts";

const MINIMAL_ABI = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/** Best-effort single call. Returns null instead of throwing. */
async function tryCall(rpc: any, address: string, functionName: string): Promise<any> {
  try {
    return await rpc.readContract({ address, abi: MINIMAL_ABI, functionName });
  } catch {
    return null;
  }
}

/**
 * Resolve metadata for up to `limit` tokens that have never been resolved.
 * Returns how many rows were updated.
 */
export async function resolvePendingTokenMetadata(
  pool: pg.Pool,
  rpc: any,
  limit = 25
): Promise<number> {
  const pending = await pool.query(
    `SELECT address, standard FROM tokens
      WHERE metadata_fetched_at IS NULL
      ORDER BY first_seen_block
      LIMIT $1`,
    [limit]
  );

  let updated = 0;

  for (const row of pending.rows) {
    const address = toHexString(row.address);
    if (!address) continue;

    const [name, symbol, decimals, totalSupply] = await Promise.all([
      tryCall(rpc, address, "name"),
      tryCall(rpc, address, "symbol"),
      // decimals is meaningful for ERC-20 only; 721/1155 have no such concept.
      row.standard === "erc20" ? tryCall(rpc, address, "decimals") : Promise.resolve(null),
      tryCall(rpc, address, "totalSupply"),
    ]);

    await pool.query(
      `UPDATE tokens
          SET name = $2,
              symbol = $3,
              decimals = $4,
              total_supply = $5,
              metadata_fetched_at = now(),
              updated_at = now()
        WHERE address = $1`,
      [
        row.address,
        // Strings from a hostile contract are bounded before storage.
        typeof name === "string" ? name.slice(0, 256) : null,
        typeof symbol === "string" ? symbol.slice(0, 64) : null,
        typeof decimals === "number" || typeof decimals === "bigint" ? Number(decimals) : null,
        totalSupply === null || totalSupply === undefined ? null : totalSupply.toString(),
      ]
    );
    updated++;
  }

  return updated;
}

/**
 * Refresh total_supply for tokens already resolved.
 *
 * Supply changes on every mint and burn, so unlike name/symbol/decimals it is
 * not resolve-once. Kept separate and deliberately cheap.
 */
export async function refreshTokenSupplies(pool: pg.Pool, rpc: any, limit = 25): Promise<number> {
  const rows = await pool.query(
    `SELECT address FROM tokens
      WHERE metadata_fetched_at IS NOT NULL
      ORDER BY updated_at ASC
      LIMIT $1`,
    [limit]
  );

  let updated = 0;
  for (const row of rows.rows) {
    const address = toHexString(row.address);
    if (!address) continue;
    const supply = await tryCall(rpc, address, "totalSupply");
    if (supply === null || supply === undefined) continue;
    await pool.query(
      `UPDATE tokens SET total_supply = $2, updated_at = now() WHERE address = $1`,
      [row.address, supply.toString()]
    );
    updated++;
  }
  return updated;
}

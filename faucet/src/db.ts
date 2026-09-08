/**
 * Giggora faucet — database access.
 *
 * The whole point of this file is the claim transaction. A faucet is an
 * anonymous endpoint that gives away money, so the two things that must be
 * impossible are paying the same claimant twice and paying out more than the
 * pool. Both are enforced here, by Postgres, not by application-level care.
 */

import pg from "pg";
import { config, env } from "./config.ts";

// uint256 as strings, never doubles (project convention). NUMERIC and INT8 both
// exceed 2^53 and pg would otherwise hand back a lossy Number.
pg.types.setTypeParser(1700, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: Number(env.FAUCET_POOL_SIZE ?? 5),
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 10_000,
});

export async function closePool(): Promise<void> {
  await pool.end();
}

export function addressToBytes(address: string): Buffer {
  return Buffer.from(address.toLowerCase().replace(/^0x/, ""), "hex");
}

export function bytesToAddress(b: Buffer | null): string | null {
  return b ? `0x${b.toString("hex")}` : null;
}

/**
 * Create the state row if absent, and reconcile the pool size with the config.
 *
 * Resizing the pool rescales the drip curve, so it is loud rather than silent.
 * `dispensed` is never touched: it is a record of money that actually left.
 */
export async function initState(chainId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      "SELECT chain_id, pool_wei, dispensed_wei FROM faucet_state WHERE id = 1 FOR UPDATE"
    );

    if (existing.rowCount === 0) {
      await client.query(
        "INSERT INTO faucet_state (id, chain_id, pool_wei, dispensed_wei) VALUES (1, $1, $2, 0)",
        [chainId, config.poolWei.toString()]
      );
      console.log(`  faucet: initialised pool at ${config.poolGig} GIG for chain ${chainId}`);
      await client.query("COMMIT");
      return;
    }

    const row = existing.rows[0];

    // A faucet ledger from another chain would carry over cooldowns and a
    // dispensed total that mean nothing here. Refuse rather than mix them.
    if (Number(row.chain_id) !== chainId) {
      await client.query("ROLLBACK");
      throw new Error(
        `faucet_state was written for chain ${row.chain_id} but this faucet is on ${chainId}. ` +
          `Point at the right chain, or use a fresh database.`
      );
    }

    if (BigInt(row.pool_wei) !== config.poolWei) {
      const dispensed = BigInt(row.dispensed_wei);
      if (config.poolWei < dispensed) {
        await client.query("ROLLBACK");
        throw new Error(
          `pool.totalGig would be ${config.poolGig} GIG but ${dispensed / 10n ** 18n} GIG has ` +
            `already been dispensed. Refusing to set a pool smaller than what has left.`
        );
      }
      console.log(
        `  faucet: POOL RESIZED ${BigInt(row.pool_wei) / 10n ** 18n} -> ${config.poolGig} GIG. ` +
          `The drip schedule has been rescaled; dispensed (${dispensed / 10n ** 18n} GIG) is unchanged.`
      );
      await client.query("UPDATE faucet_state SET pool_wei = $1, updated_at = now() WHERE id = 1", [
        config.poolWei.toString(),
      ]);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface FaucetStatus {
  poolWei: bigint;
  dispensedWei: bigint;
  remainingWei: bigint;
  claimCount: number;
  spentTodayWei: bigint;
  dailyRemainingWei: bigint;
}

export async function readStatus(): Promise<FaucetStatus> {
  const s = await pool.query("SELECT pool_wei, dispensed_wei FROM faucet_state WHERE id = 1");
  if (s.rowCount === 0) throw new Error("faucet_state row is missing — run initState first");
  const poolWei = BigInt(s.rows[0].pool_wei);
  const dispensedWei = BigInt(s.rows[0].dispensed_wei);
  const c = await pool.query("SELECT count(*)::int AS n FROM faucet_claims WHERE status = 'sent'");
  const d = await pool.query(
    `SELECT COALESCE(sum(amount_wei), 0)::numeric(78,0) AS total
       FROM faucet_claims
      WHERE status <> 'failed' AND requested_at > now() - interval '24 hours'`
  );
  const spentTodayWei = BigInt(d.rows[0].total);
  const dailyRemainingWei = config.dailyCapWei - spentTodayWei;
  return {
    poolWei,
    dispensedWei,
    remainingWei: poolWei - dispensedWei,
    claimCount: Number(c.rows[0].n),
    spentTodayWei,
    dailyRemainingWei: dailyRemainingWei > 0n ? dailyRemainingWei : 0n,
  };
}

export interface ReserveResult {
  ok: boolean;
  reason?: string;
  retryAfterSeconds?: number;
  claimId?: number;
  amountWei?: bigint;
  remainingWei?: bigint;
}

/**
 * Reserve a claim: check the cooldowns, debit the pool, write a pending row.
 *
 * SERIALISED on the single faucet_state row. That lock is doing more work than
 * it looks: without it, two concurrent requests for the same address both read
 * "no recent claim" before either writes one, and both are paid. Taking the
 * lock first makes the cooldown reads below happen one claim at a time.
 *
 * Returns without sending anything. The caller sends the transaction and then
 * calls settle() — so a crash in between leaves a debited 'pending' row, which
 * under-reports the pool rather than paying twice.
 */
export async function reserveClaim(
  address: string,
  ipHash: Buffer,
  computeDrip: (remainingWei: bigint, poolWei: bigint) => bigint
): Promise<ReserveResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const s = await client.query(
      "SELECT pool_wei, dispensed_wei FROM faucet_state WHERE id = 1 FOR UPDATE"
    );
    if (s.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "faucet is not initialised" };
    }

    const poolWei = BigInt(s.rows[0].pool_wei);
    const dispensedWei = BigInt(s.rows[0].dispensed_wei);
    const remainingWei = poolWei - dispensedWei;

    if (remainingWei <= 0n) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "the faucet is empty — the whole pool has been dispensed" };
    }

    const addrBytes = addressToBytes(address);

    const amountWei = computeDrip(remainingWei, poolWei);
    if (amountWei <= 0n) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "the faucet is empty" };
    }

    // ORDER MATTERS: the GLOBAL limit is checked before the per-claimant ones.
    //
    // When the faucet is closed for the day, "you have already claimed
    // recently" is a misleading answer — it implies that a different address
    // would work, and it would not. The reason that applies to everyone is the
    // true and complete reason, so it is the one reported.
    //
    // DAILY CAP — the only limit here a funded attacker cannot buy past.
    // Addresses are free and IP addresses are cheap, so the per-address and
    // per-source cooldowns bound one claimant, not the total. This bounds the
    // total, and therefore how fast the pool can drain: at least
    // pool / dailyCap days no matter who is asking.
    //
    // Read inside the same FOR UPDATE transaction so concurrent claims cannot
    // both see room under the cap.
    const spent = await client.query(
      `SELECT COALESCE(sum(amount_wei), 0)::numeric(78,0) AS total
         FROM faucet_claims
        WHERE status <> 'failed' AND requested_at > now() - interval '24 hours'`
    );
    const spentToday = BigInt(spent.rows[0].total);
    if (spentToday + amountWei > config.dailyCapWei) {
      // When the next window opens: 24h after the oldest claim still counted.
      const oldest = await client.query(
        `SELECT extract(epoch FROM (now() - min(requested_at)))::bigint AS age
           FROM faucet_claims
          WHERE status <> 'failed' AND requested_at > now() - interval '24 hours'`
      );
      const age = Number(oldest.rows[0]?.age ?? 0);
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: `the faucet has reached its daily limit of ${config.dailyCapGig} GIG`,
        retryAfterSeconds: Math.max(60, Math.ceil(86400 - age)),
      };
    }

    // Per-claimant cooldowns. 'failed' rows are excluded by the partial
    // indexes: a send that errored must not burn the claimer's turn.
    const cooldowns: Array<[string, string, unknown, number]> = [
      ["address", "address = $1", addrBytes, config.cooldownAddressSeconds],
      ["source", "ip_hash = $1", ipHash, config.cooldownIpSeconds],
    ];

    for (const [label, where, value, seconds] of cooldowns) {
      const r = await client.query(
        `SELECT extract(epoch FROM (now() - max(requested_at)))::bigint AS age
           FROM faucet_claims
          WHERE ${where} AND status <> 'failed'`,
        [value]
      );
      const age = r.rows[0]?.age === null || r.rows[0]?.age === undefined ? null : Number(r.rows[0].age);
      if (age !== null && age < seconds) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          reason:
            label === "address"
              ? "this address has already claimed recently"
              : "this connection has already claimed recently",
          retryAfterSeconds: Math.max(1, Math.ceil(seconds - age)),
        };
      }
    }

    const ins = await client.query(
      `INSERT INTO faucet_claims (address, amount_wei, status, ip_hash)
       VALUES ($1, $2, 'pending', $3) RETURNING id`,
      [addrBytes, amountWei.toString(), ipHash]
    );

    await client.query(
      "UPDATE faucet_state SET dispensed_wei = dispensed_wei + $1, updated_at = now() WHERE id = 1",
      [amountWei.toString()]
    );

    await client.query("COMMIT");
    return {
      ok: true,
      claimId: Number(ins.rows[0].id),
      amountWei,
      remainingWei: remainingWei - amountWei,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The transaction landed. */
export async function settleSent(claimId: number, txHash: string): Promise<void> {
  await pool.query(
    "UPDATE faucet_claims SET status = 'sent', tx_hash = $2, settled_at = now() WHERE id = $1",
    [claimId, Buffer.from(txHash.replace(/^0x/, ""), "hex")]
  );
}

/**
 * The send failed. Refund the LEDGER (not the chain — nothing left it) so a
 * node hiccup does not permanently shrink the pool, and record why.
 */
export async function settleFailed(claimId: number, amountWei: bigint, error: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      "UPDATE faucet_claims SET status = 'failed', error = $2, settled_at = now() WHERE id = $1 AND status = 'pending'",
      [claimId, error.slice(0, 500)]
    );
    // Only refund if this call is the one that moved it out of 'pending';
    // otherwise a retry would credit the pool twice.
    if (r.rowCount === 1) {
      await client.query(
        "UPDATE faucet_state SET dispensed_wei = dispensed_wei - $1, updated_at = now() WHERE id = 1",
        [amountWei.toString()]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function recentClaims(limit: number): Promise<
  Array<{ address: string; amountWei: string; txHash: string | null; requestedAt: string }>
> {
  if (limit <= 0) return [];
  const r = await pool.query(
    `SELECT address, amount_wei, tx_hash, requested_at
       FROM faucet_claims
      WHERE status = 'sent'
      ORDER BY requested_at DESC
      LIMIT $1`,
    [limit]
  );
  return r.rows.map((row: any) => ({
    address: bytesToAddress(row.address) as string,
    amountWei: String(row.amount_wei),
    txHash: bytesToAddress(row.tx_hash),
    requestedAt: new Date(row.requested_at).toISOString(),
  }));
}

/**
 * Claims debited but never settled — the process died mid-send. Reported at
 * startup rather than cleaned up automatically: deciding whether the money left
 * needs the chain, and guessing wrong either double-pays or loses the record.
 */
export async function stalePending(olderThanSeconds: number): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM faucet_claims
      WHERE status = 'pending' AND requested_at < now() - make_interval(secs => $1)`,
    [olderThanSeconds]
  );
  return Number(r.rows[0].n);
}

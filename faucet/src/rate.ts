/**
 * Giggora faucet — the drip-rate curve.
 *
 * Pure functions, no I/O, no database, no clock. This is the one piece of the
 * faucet that decides how much money leaves, so it is kept isolated and is
 * exhaustively tested by scripts/test-faucet.ts.
 *
 * THE RULE
 *
 *   The payout tracks the fraction of the pool that is left.
 *
 *     rate = ceil(maxGig * remaining / total), capped at maxGig
 *
 *   With total = 20,000,000 GIG and maxGig = 10 that is exactly the schedule
 *   this was specified as:
 *
 *     20,000,000 left -> 10 GIG      12,000,000 left -> 6 GIG
 *     18,000,000 left ->  9 GIG      10,000,000 left -> 5 GIG   (50% -> 50%)
 *     16,000,000 left ->  8 GIG       ...
 *     14,000,000 left ->  7 GIG       up to 2,000,000 left -> 1 GIG
 *
 *   The formula is scale-free: it produces the same shaped curve for any pool
 *   size, so the pool can be resized without redesigning the schedule.
 *
 * WHY CEILING RATHER THAN ROUNDING
 *
 *   The payout is always a whole GIG, and it only steps down once the pool has
 *   genuinely crossed a band. At 19,000,000 of 20,000,000 the exact value is
 *   9.5; ceiling keeps it at 10 until the pool actually reaches 18,000,000,
 *   which is what "18M left, the faucet gives 9" means. Rounding would have
 *   stepped down at 19M.
 *
 * ARITHMETIC
 *
 *   BigInt throughout, and the ceiling is taken in whole GIG rather than in
 *   wei. Doing it in wei would hand out 9.5 GIG at 19M — mathematically the
 *   same curve, but not whole units, and not what was asked for.
 */

export const WEI_PER_GIG = 10n ** 18n;

export function gigToWei(gig: bigint | number | string): bigint {
  return BigInt(gig) * WEI_PER_GIG;
}

/** Whole GIG, truncated. For display only — never for accounting. */
export function weiToGigFloor(wei: bigint): bigint {
  return wei / WEI_PER_GIG;
}

/**
 * How much the faucet pays out right now.
 *
 * @param remainingWei  pool total minus everything dispensed so far
 * @param poolWei       the pool total (the curve's denominator)
 * @param maxGig        payout at a full pool, in whole GIG
 * @returns             payout in wei; 0n when the faucet is empty
 */
export function dripWei(remainingWei: bigint, poolWei: bigint, maxGig: bigint): bigint {
  if (remainingWei <= 0n) return 0n;
  if (poolWei <= 0n || maxGig <= 0n) return 0n;

  // ceil(maxGig * remaining / pool), in whole GIG.
  const numerator = maxGig * remainingWei;
  let gig = (numerator + poolWei - 1n) / poolWei;

  // A pool that has been resized upward mid-life can leave remaining > pool;
  // the cap keeps the advertised maximum honest either way.
  if (gig > maxGig) gig = maxGig;
  if (gig < 1n) gig = 1n;

  const wei = gig * WEI_PER_GIG;

  // The final claims must not overdraw. If fewer than one whole GIG is left,
  // the last claimer gets exactly the dust rather than being refused.
  return wei > remainingWei ? remainingWei : wei;
}

/**
 * The schedule as a human-readable table, for the portal and the README.
 * Rows are the points where the payout changes, newest (fullest) first.
 */
export function scheduleTable(
  poolWei: bigint,
  maxGig: bigint
): Array<{ remainingWei: bigint; dripGig: bigint }> {
  const rows: Array<{ remainingWei: bigint; dripGig: bigint }> = [];
  for (let g = maxGig; g >= 1n; g--) {
    // Highest remaining balance that still pays exactly g GIG, i.e. the top of
    // band g: floor(pool * g / maxGig).
    const remainingWei = (poolWei * g) / maxGig;
    rows.push({ remainingWei, dripGig: g });
  }
  return rows;
}

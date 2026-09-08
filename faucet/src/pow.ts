/**
 * Giggora faucet — proof of work.
 *
 * WHY THIS EXISTS
 *
 * A per-address cooldown is not a limit. Addresses are free: a script generates
 * ten thousand of them in a second and claims from each. A per-IP cooldown is
 * better but falls to any cloud account or proxy pool.
 *
 * Proof of work does not stop a determined attacker either — nothing short of
 * identity does — but it changes the units. Draining a 100,000 GIG pool at
 * 10 GIG a claim needs 10,000 claims; at 20 bits (~1M hashes, a second or two
 * of browser CPU) that is hours of dedicated compute rather than one HTTP loop.
 * For a human clicking a button once it is invisible.
 *
 * Chosen over a captcha deliberately: no third-party service, no vendor key, no
 * personal data, and it works with JavaScript alone.
 *
 * STATELESS CHALLENGES
 *
 * The challenge is an HMAC of (address, time bucket) under a server secret, so
 * nothing is stored and there is no challenge table to clean up or to fill. It
 * is bound to the ADDRESS, so one solved challenge buys exactly one address —
 * an attacker cannot solve once and spray. It expires with the time bucket.
 */

import { createHmac, createHash, randomBytes } from "node:crypto";

/** Regenerated per process. A restart invalidates outstanding challenges,
 *  which costs a claimer one retry and costs an attacker their precompute. */
const SECRET = process.env.FAUCET_POW_SECRET
  ? Buffer.from(process.env.FAUCET_POW_SECRET, "utf8")
  : randomBytes(32);

/**
 * The challenge for an address in the current window.
 *
 * Two buckets are valid at any moment (current and previous) so a claimer who
 * starts solving just before a boundary is not rejected for being slow.
 */
function challengeFor(address: string, bucket: number): string {
  return createHmac("sha256", SECRET)
    .update(`${address.toLowerCase()}:${bucket}`)
    .digest("hex");
}

function bucketNow(ttlSeconds: number): number {
  return Math.floor(Date.now() / 1000 / ttlSeconds);
}

export function issueChallenge(
  address: string,
  ttlSeconds: number,
  difficultyBits: number
): { challenge: string; difficultyBits: number; expiresInSeconds: number } {
  const bucket = bucketNow(ttlSeconds);
  const elapsed = Math.floor(Date.now() / 1000) % ttlSeconds;
  return {
    challenge: challengeFor(address, bucket),
    difficultyBits,
    expiresInSeconds: ttlSeconds - elapsed,
  };
}

/** Leading zero BITS of a digest — the difficulty measure. */
export function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export function solutionMeets(challenge: string, nonce: string, difficultyBits: number): boolean {
  const digest = createHash("sha256").update(`${challenge}:${nonce}`).digest();
  return leadingZeroBits(digest) >= difficultyBits;
}

/**
 * Verify a submitted solution.
 *
 * Accepts the current or previous bucket, and re-derives the challenge from the
 * address rather than trusting the one the client echoes back — otherwise a
 * client could invent its own easy challenge and solve that.
 */
export function verify(
  address: string,
  nonce: string,
  ttlSeconds: number,
  difficultyBits: number
): { ok: true } | { ok: false; reason: string } {
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 64) {
    return { ok: false, reason: "malformed proof of work nonce" };
  }
  const now = bucketNow(ttlSeconds);
  for (const bucket of [now, now - 1]) {
    if (solutionMeets(challengeFor(address, bucket), nonce, difficultyBits)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "proof of work is invalid or expired — request a new challenge" };
}

/** Salted hash of a client address. See migration 006: the IP is never stored. */
export function hashIp(ip: string, salt: string): Buffer {
  return createHash("sha256").update(`${salt}:${ip}`).digest();
}

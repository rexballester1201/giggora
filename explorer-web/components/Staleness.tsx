/**
 * Giggora explorer — staleness banner (brief §47).
 *
 * The explorer reads a database, not the chain. Every number on the page is
 * therefore "what the chain looked like when the indexer last ran", and if the
 * indexer stops, the page keeps rendering those numbers indefinitely with no
 * outward sign that anything is wrong. Showing old chain data as if it were
 * current is exactly what §47 forbids, so this component exists to say so.
 *
 * Two independent signals, because neither is sufficient alone:
 *
 *   indexerStaleSeconds  how long since the indexer proved it was alive. It
 *                        heartbeats every poll even when caught up, so this
 *                        growing means the PROCESS is gone.
 *
 *   indexerLagBlocks     how far behind it is while still running.
 *
 * A dead indexer reports lag 0 — it stops updating the head it is compared
 * against, so both sides freeze together. Measured: with the indexer killed and
 * the chain 30 blocks further on, lag read 0 while staleness read 90s. Staleness
 * is the signal that catches the case that actually happens.
 */

const STALE_AFTER_S = 30; // the indexer polls every 1s; 30s is unambiguous
const LAG_WARN_BLOCKS = 5;

function ago(seconds: number): string {
  if (seconds < 90) return `${seconds}s ago`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export function StalenessBanner({
  staleSeconds,
  lagBlocks,
  lastIndexedBlock,
  chainHeadBlock,
}: {
  staleSeconds: number | null;
  lagBlocks: number | null;
  lastIndexedBlock: number | null;
  chainHeadBlock: number | null;
}) {
  // null is "unknown", not "healthy" — but an unknown is not evidence of a
  // problem either, so say nothing rather than cry wolf.
  if (staleSeconds === null) return null;

  const dead = staleSeconds > STALE_AFTER_S;
  const behind = !dead && lagBlocks !== null && lagBlocks > LAG_WARN_BLOCKS;
  if (!dead && !behind) return null;

  const style = dead
    ? { border: "1px solid #f5c2c7", background: "#fff5f5", color: "#842029" }
    : { border: "1px solid #ffe69c", background: "#fffbf0", color: "#664d03" };

  return (
    <div className="rounded-lg px-4 py-3 text-sm" style={style} role="status">
      {dead ? (
        <>
          <strong>This page may be out of date.</strong> The indexer last
          reported {ago(staleSeconds)}, so everything below is the chain as of
          block {lastIndexedBlock ?? "—"} — not necessarily the current head.
          <div className="mt-1 text-xs">
            Start it with <code className="mono">node indexer/src/index.ts</code>
          </div>
        </>
      ) : (
        <>
          <strong>Catching up.</strong> The indexer is {lagBlocks} block
          {lagBlocks === 1 ? "" : "s"} behind
          {chainHeadBlock !== null ? ` (head ${chainHeadBlock.toLocaleString()})` : ""}. Recent
          blocks and transactions may not appear yet.
        </>
      )}
    </div>
  );
}

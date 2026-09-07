"use client";

/**
 * Live-updating homepage lists (brief §25).
 *
 * New blocks and transactions appear without a manual refresh. Polling every
 * 4 seconds against a 2-second block period: simple to operate, and the API
 * responses for the first page are cheap keyset scans.
 *
 * Rows are keyed by hash so React reuses DOM for unchanged entries and only the
 * genuinely new rows animate in.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { API_BASE, formatUnits, shorten, timeAgo, type Block, type Transaction } from "@/lib/api";

function useLive<T>(path: string, ms = 4000) {
  const [items, setItems] = useState<T[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
        if (!res.ok) throw new Error();
        const j = await res.json();
        if (alive) {
          setItems(j.items ?? []);
          setErr(false);
        }
      } catch {
        if (alive) setErr(true);
      }
    }
    poll();
    const id = setInterval(poll, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [path, ms]);

  return { items, err };
}

function Loading() {
  return (
    <div className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-dim)" }}>
      Loading…
    </div>
  );
}

export function LiveBlocks() {
  const { items, err } = useLive<Block>("/api/blocks?limit=8");
  if (err) return <div className="px-4 py-8 text-center text-sm" style={{ color: "var(--fail)" }}>API unreachable</div>;
  if (!items) return <Loading />;
  if (!items.length)
    return <div className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-dim)" }}>No blocks yet</div>;

  return (
    <ul>
      {items.map((b) => (
        <li key={b.hash} className="flex items-center justify-between gap-3 px-4 py-2.5" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="min-w-0">
            <Link href={`/block/${b.number}`} className="mono text-sm font-semibold">
              #{b.number.toLocaleString()}
            </Link>
            <div className="text-xs" style={{ color: "var(--text-dim)" }}>
              {timeAgo(b.timestamp)}
            </div>
          </div>
          <div className="min-w-0 text-right">
            <div className="text-xs" style={{ color: "var(--text-dim)" }}>
              Validator
            </div>
            <Link href={`/address/${b.validator}`} className="mono text-xs">
              {shorten(b.validator, 8, 6)}
            </Link>
          </div>
          <div className="shrink-0 text-right">
            <span className="badge badge-neutral tabular-nums">{b.transactionCount} txn</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LiveTransactions() {
  const { items, err } = useLive<Transaction>("/api/transactions?limit=8");
  if (err) return <div className="px-4 py-8 text-center text-sm" style={{ color: "var(--fail)" }}>API unreachable</div>;
  if (!items) return <Loading />;
  if (!items.length)
    return <div className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-dim)" }}>No transactions yet</div>;

  return (
    <ul>
      {items.map((t) => (
        <li key={t.hash} className="flex items-center justify-between gap-3 px-4 py-2.5" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="min-w-0">
            <Link href={`/tx/${t.hash}`} className="mono text-sm">
              {shorten(t.hash, 10, 6)}
            </Link>
            <div className="text-xs" style={{ color: "var(--text-dim)" }}>
              {timeAgo(t.timestamp)}
            </div>
          </div>
          <div className="min-w-0 text-xs" style={{ color: "var(--text-dim)" }}>
            <div className="truncate">
              From <Link href={`/address/${t.from}`} className="mono">{shorten(t.from, 6, 4)}</Link>
            </div>
            <div className="truncate">
              To{" "}
              {t.to ? (
                <Link href={`/address/${t.to}`} className="mono">{shorten(t.to, 6, 4)}</Link>
              ) : (
                <span className="badge badge-neutral">Creation</span>
              )}
            </div>
          </div>
          <div className="shrink-0 text-right text-xs tabular-nums">
            {formatUnits(t.value, 18, 4)} GIG
          </div>
        </li>
      ))}
    </ul>
  );
}

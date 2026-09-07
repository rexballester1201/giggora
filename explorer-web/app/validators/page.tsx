/**
 * Validators (brief §27).
 *
 * Statistics are derived from indexed blocks, which is exactly what §27 permits
 * for the MVP: "some statistics may be derived directly from indexed blocks".
 * Uptime and rewards are NOT shown, because nothing in the schema supports them
 * and a fabricated number would be worse than an absent one.
 */

import Link from "next/link";
import { api, API_BASE, formatCount, timeAgo, shorten } from "@/lib/api";
import { Card, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

interface ValidatorRow {
  validator: string;
  blocksProduced: number;
  lastBlock: number;
  lastSeen: string;
}

/**
 * Aggregate over a bounded recent window.
 *
 * Deliberately NOT a full-table GROUP BY: that would grow linearly with chain
 * length behind an anonymous page load. A recent sample answers "who is
 * producing blocks right now", which is the question this page exists for.
 */
const WINDOW = 1000;

async function recentValidators(): Promise<{ rows: ValidatorRow[]; sampled: number } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/blocks?limit=100`, { next: { revalidate: 10 } });
    if (!res.ok) return null;
    const first = await res.json();

    let items = first.items as any[];
    let cursor = first.nextCursor as string | null;
    // Walk a bounded number of pages; never the whole chain.
    for (let p = 0; p < 9 && cursor && items.length < WINDOW; p++) {
      const r = await fetch(`${API_BASE}/api/blocks?limit=100&cursor=${encodeURIComponent(cursor)}`, {
        next: { revalidate: 10 },
      });
      if (!r.ok) break;
      const j = await r.json();
      items = items.concat(j.items);
      cursor = j.nextCursor;
    }

    const by = new Map<string, ValidatorRow>();
    for (const b of items) {
      const cur = by.get(b.validator);
      if (cur) {
        cur.blocksProduced++;
        if (b.number > cur.lastBlock) {
          cur.lastBlock = b.number;
          cur.lastSeen = b.timestamp;
        }
      } else {
        by.set(b.validator, {
          validator: b.validator,
          blocksProduced: 1,
          lastBlock: b.number,
          lastSeen: b.timestamp,
        });
      }
    }
    return {
      rows: [...by.values()].sort((a, b) => b.blocksProduced - a.blocksProduced),
      sampled: items.length,
    };
  } catch {
    return null;
  }
}

export default async function ValidatorsPage() {
  const data = await recentValidators();

  if (!data) {
    return (
      <Card title="Validators">
        <Empty>Could not reach the explorer API.</Empty>
      </Card>
    );
  }

  const total = data.rows.reduce((s, r) => s + r.blocksProduced, 0);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Validators</h1>
      <Card title={`Block producers (last ${formatCount(data.sampled)} blocks)`}>
        {data.rows.length === 0 ? (
          <Empty>No blocks indexed yet.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr>
                  <th className="px-4 py-2 text-left">Validator</th>
                  <th className="px-4 py-2 text-right">Blocks produced</th>
                  <th className="px-4 py-2 text-right">Share</th>
                  <th className="px-4 py-2 text-right">Last block</th>
                  <th className="px-4 py-2 text-left">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((v) => (
                  <tr key={v.validator}>
                    <td className="px-4 py-2">
                      <Link href={`/address/${v.validator}`} className="mono text-xs">
                        {shorten(v.validator, 14, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{v.blocksProduced}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {total ? ((v.blocksProduced / total) * 100).toFixed(1) : "0.0"}%
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link href={`/block/${v.lastBlock}`} className="mono text-xs">
                        {v.lastBlock.toLocaleString()}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-xs" style={{ color: "var(--text-dim)" }}>
                      {timeAgo(v.lastSeen)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-4 py-3 text-xs" style={{ color: "var(--text-dim)", borderTop: "1px solid var(--border)" }}>
          QBFT rotates the proposer, so an even share across validators is the healthy
          state. Uptime and rewards are not shown: nothing in the indexed data supports
          them, and an invented figure would be worse than none.
        </div>
      </Card>
    </div>
  );
}

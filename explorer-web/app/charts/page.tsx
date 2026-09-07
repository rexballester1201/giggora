/**
 * Charts (brief §14).
 *
 * Rendered as inline SVG from indexed blocks — no charting dependency, and no
 * client JavaScript needed to see the data.
 */

import { API_BASE, formatCount } from "@/lib/api";
import { Card, Empty, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Point {
  number: number;
  txs: number;
  gasUsed: number;
  timestamp: string;
}

async function recentBlocks(): Promise<Point[] | null> {
  try {
    const res = await fetch(`${API_BASE}/api/blocks?limit=100`, { next: { revalidate: 10 } });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.items as any[])
      .map((b) => ({
        number: b.number,
        txs: b.transactionCount,
        // Gas fits comfortably in a double at these magnitudes; it is only ever
        // used here for pixel geometry, never displayed as an exact value.
        gasUsed: Number(b.gasUsed),
        timestamp: b.timestamp,
      }))
      .reverse();
  } catch {
    return null;
  }
}

function Sparkline({
  points,
  accessor,
  label,
  color,
}: {
  points: Point[];
  accessor: (p: Point) => number;
  label: string;
  color: string;
}) {
  const W = 720;
  const H = 160;
  const PAD = 8;
  const values = points.map(accessor);
  const max = Math.max(1, ...values);
  const step = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;

  const bars = points.map((p, i) => {
    const v = accessor(p);
    const h = Math.max(1, ((H - PAD * 2) * v) / max);
    return { x: PAD + i * step, y: H - PAD - h, h, v, n: p.number };
  });

  return (
    <div className="px-4 py-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs tabular-nums" style={{ color: "var(--text-dim)" }}>
          peak {formatCount(max)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: "160px" }}
        role="img"
        aria-label={`${label} across the last ${points.length} blocks`}
      >
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--border)" strokeWidth="1" />
        {bars.map((b, i) => (
          <rect
            key={i}
            x={b.x - Math.max(1, step / 2 - 0.5)}
            y={b.y}
            width={Math.max(1.5, step - 1)}
            height={b.h}
            fill={color}
            opacity={0.85}
          >
            <title>{`Block ${b.n.toLocaleString()}: ${formatCount(b.v)}`}</title>
          </rect>
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-xs" style={{ color: "var(--text-dim)" }}>
        <span className="mono">#{points[0]?.number.toLocaleString()}</span>
        <span className="mono">#{points[points.length - 1]?.number.toLocaleString()}</span>
      </div>
    </div>
  );
}

export default async function ChartsPage() {
  const points = await recentBlocks();

  if (!points || points.length === 0) {
    return (
      <Card title="Charts">
        <Empty>No block data available.</Empty>
      </Card>
    );
  }

  const totalTx = points.reduce((s, p) => s + p.txs, 0);
  const spanSecs =
    (new Date(points[points.length - 1].timestamp).getTime() -
      new Date(points[0].timestamp).getTime()) /
    1000;
  const tps = spanSecs > 0 ? totalTx / spanSecs : 0;
  const avgBlockTime = points.length > 1 ? spanSecs / (points.length - 1) : 0;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Charts</h1>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Blocks sampled" value={points.length} />
        <Stat label="Transactions" value={formatCount(totalTx)} sub="in sample" />
        <Stat label="Throughput" value={`${tps.toFixed(2)} tps`} sub="across sample" />
        <Stat label="Avg block time" value={`${avgBlockTime.toFixed(2)}s`} />
      </div>

      <Card title="Transactions per block">
        <Sparkline points={points} accessor={(p) => p.txs} label="Transactions" color="var(--brand)" />
      </Card>

      <Card title="Gas used per block">
        <Sparkline points={points} accessor={(p) => p.gasUsed} label="Gas used" color="var(--accent)" />
      </Card>

      <p className="text-xs" style={{ color: "var(--text-dim)" }}>
        Sampled from the most recent {points.length} indexed blocks. On an idle chain the
        empty-block period is 60s, so throughput here reads low until the chain is under load.
      </p>
    </div>
  );
}

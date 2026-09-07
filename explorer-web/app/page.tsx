/**
 * Giggora explorer — homepage (brief §15).
 *
 * Network statistics, latest blocks and latest transactions, all read from the
 * explorer API. The lists refresh themselves (§25) without a page reload.
 */

import Link from "next/link";
import { api, formatCount, formatUnits, toGwei } from "@/lib/api";
import { Card, Stat, Empty } from "@/components/ui";
import { LiveBlocks, LiveTransactions } from "@/components/Live";
import { StalenessBanner } from "@/components/Staleness";

export const dynamic = "force-dynamic";

export default async function Home() {
  let stats = null;
  let error: string | null = null;
  try {
    stats = await api.stats();
  } catch (e: any) {
    error = e?.message ?? "The explorer API is unreachable";
  }

  if (error || !stats) {
    return (
      <Card title="Network">
        <Empty>
          Could not reach the explorer API. Start it with{" "}
          <code className="mono">node explorer-api/src/server.ts</code>.
          <div className="mt-2 text-xs">{error}</div>
        </Empty>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <StalenessBanner
        staleSeconds={stats.indexerStaleSeconds}
        lagBlocks={stats.indexerLagBlocks}
        lastIndexedBlock={stats.lastIndexedBlock}
        chainHeadBlock={stats.chainHeadBlock}
      />

      <section>
        <h1 className="mb-1 text-lg font-semibold">
          {stats.chainName} <span style={{ color: "var(--text-dim)" }}>Explorer</span>
        </h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          Chain ID {stats.chainId} · Native currency {stats.currency.symbol}
        </p>
      </section>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Latest block" value={formatCount(stats.latestBlock)} />
        <Stat
          label="Transactions"
          value={formatCount(stats.totalTransactions)}
          sub="total indexed"
        />
        <Stat
          label="Block time"
          value={stats.averageBlockTimeSeconds ? `${stats.averageBlockTimeSeconds.toFixed(1)}s` : "—"}
          sub="last 100 blocks"
        />
        <Stat label="Base fee" value={`${toGwei(stats.baseFeePerGas)} gwei`} />
        <Stat label="Contracts" value={formatCount(stats.totalContracts)} />
        <Stat label="Tokens" value={formatCount(stats.totalTokens)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Latest blocks"
          action={
            <Link href="/blocks" className="text-xs">
              View all →
            </Link>
          }
        >
          <LiveBlocks />
        </Card>

        <Card
          title="Latest transactions"
          action={
            <Link href="/transactions" className="text-xs">
              View all →
            </Link>
          }
        >
          <LiveTransactions />
        </Card>
      </div>
    </div>
  );
}

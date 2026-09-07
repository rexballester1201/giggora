import Link from "next/link";
import { api, formatUnits, timeAgo, shorten } from "@/lib/api";
import { Card, Empty, Pager, StatusBadge, AddressCell } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  let page;
  try {
    page = await api.transactions(25, cursor ?? null);
  } catch (e: any) {
    return (
      <Card title="Transactions">
        <Empty>Could not load transactions: {e?.message}</Empty>
      </Card>
    );
  }

  return (
    <Card title="Transactions">
      {page.items.length === 0 ? (
        <Empty>No transactions indexed yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr>
                <th className="px-4 py-2 text-left">Txn hash</th>
                <th className="px-4 py-2 text-left">Block</th>
                <th className="px-4 py-2 text-left">Age</th>
                <th className="px-4 py-2 text-left">From</th>
                <th className="px-4 py-2 text-left">To</th>
                <th className="px-4 py-2 text-right">Value</th>
                <th className="px-4 py-2 text-right">Fee</th>
                <th className="px-4 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((t) => (
                <tr key={t.hash}>
                  <td className="px-4 py-2">
                    <Link href={`/tx/${t.hash}`} className="mono text-xs">
                      {shorten(t.hash, 12, 6)}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Link href={`/block/${t.blockNumber}`} className="mono text-xs">
                      {t.blockNumber.toLocaleString()}
                    </Link>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-xs" style={{ color: "var(--text-dim)" }}>
                    {timeAgo(t.timestamp)}
                  </td>
                  <td className="px-4 py-2">
                    <AddressCell address={t.from} />
                  </td>
                  <td className="px-4 py-2">
                    <AddressCell address={t.to} contractAddress={t.contractAddress} />
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                    {formatUnits(t.value, 18, 4)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-xs" style={{ color: "var(--text-dim)" }}>
                    {formatUnits(t.fee, 18, 8)}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={t.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager basePath="/transactions" nextCursor={page.nextCursor} hasPrev={Boolean(cursor)} />
    </Card>
  );
}

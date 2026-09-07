import Link from "next/link";
import { api, formatCount, timeAgo, shorten } from "@/lib/api";
import { Card, Empty, Pager } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function BlocksPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  let page;
  try {
    page = await api.blocks(25, cursor ?? null);
  } catch (e: any) {
    return (
      <Card title="Blocks">
        <Empty>Could not load blocks: {e?.message}</Empty>
      </Card>
    );
  }

  return (
    <Card title="Blocks">
      {page.items.length === 0 ? (
        <Empty>No blocks indexed yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr>
                <th className="px-4 py-2 text-left">Block</th>
                <th className="px-4 py-2 text-left">Age</th>
                <th className="px-4 py-2 text-right">Txns</th>
                <th className="px-4 py-2 text-left">Validator</th>
                <th className="px-4 py-2 text-right">Gas used</th>
                <th className="px-4 py-2 text-right">Gas limit</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((b) => (
                <tr key={b.hash}>
                  <td className="px-4 py-2">
                    <Link href={`/block/${b.number}`} className="mono font-semibold">
                      {b.number.toLocaleString()}
                    </Link>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap" style={{ color: "var(--text-dim)" }}>
                    {timeAgo(b.timestamp)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{b.transactionCount}</td>
                  <td className="px-4 py-2">
                    <Link href={`/address/${b.validator}`} className="mono text-xs">
                      {shorten(b.validator, 10, 6)}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCount(b.gasUsed)}</td>
                  <td className="px-4 py-2 text-right tabular-nums" style={{ color: "var(--text-dim)" }}>
                    {formatCount(b.gasLimit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager basePath="/blocks" nextCursor={page.nextCursor} hasPrev={Boolean(cursor)} />
    </Card>
  );
}

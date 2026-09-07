import Link from "next/link";
import { api, formatUnits, formatCount, shorten } from "@/lib/api";
import { Card, Empty, Pager, StandardBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function TokensPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  let page;
  try {
    page = await api.tokens(25, cursor ?? null);
  } catch (e: any) {
    return (
      <Card title="Tokens">
        <Empty>Could not load tokens: {e?.message}</Empty>
      </Card>
    );
  }

  return (
    <Card title="Tokens">
      {page.items.length === 0 ? (
        <Empty>No token contracts detected yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr>
                <th className="px-4 py-2 text-left">Token</th>
                <th className="px-4 py-2 text-left">Standard</th>
                <th className="px-4 py-2 text-left">Contract</th>
                <th className="px-4 py-2 text-right">Total supply</th>
                <th className="px-4 py-2 text-right">First seen</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((t) => (
                <tr key={t.address}>
                  <td className="px-4 py-2">
                    <Link href={`/token/${t.address}`} className="font-medium">
                      {t.name ?? "Unnamed token"}
                    </Link>
                    {t.symbol && (
                      <span className="ml-1 text-xs" style={{ color: "var(--text-dim)" }}>
                        ({t.symbol})
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <StandardBadge standard={t.standard} />
                  </td>
                  <td className="px-4 py-2">
                    <Link href={`/address/${t.address}`} className="mono text-xs">
                      {shorten(t.address, 10, 6)}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {t.totalSupply === null
                      ? "—"
                      : formatUnits(t.totalSupply, t.decimals ?? 0, 4)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-xs" style={{ color: "var(--text-dim)" }}>
                    <Link href={`/block/${t.firstSeenBlock}`}>{formatCount(t.firstSeenBlock)}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager basePath="/tokens" nextCursor={page.nextCursor} hasPrev={Boolean(cursor)} />
    </Card>
  );
}

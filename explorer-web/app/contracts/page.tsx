import Link from "next/link";
import { api, formatCount, shorten } from "@/lib/api";
import { Card, Empty, Pager, StandardBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  let page;
  try {
    page = await api.contracts(25, cursor ?? null);
  } catch (e: any) {
    return (
      <Card title="Contracts">
        <Empty>Could not load contracts: {e?.message}</Empty>
      </Card>
    );
  }

  return (
    <Card title="Contracts">
      {page.items.length === 0 ? (
        <Empty>No contracts deployed yet.</Empty>
      ) : (
        <>
          <div className="table-scroll">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr>
                  <th className="px-4 py-2 text-left">Address</th>
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-left">Type</th>
                  <th className="px-4 py-2 text-right">Deployed</th>
                  <th className="px-4 py-2 text-left">Verified</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((c: any) => (
                  <tr key={c.address}>
                    <td className="px-4 py-2">
                      <Link href={`/address/${c.address}`} className="mono text-xs">
                        {shorten(c.address, 12, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{c.name ?? "—"}</td>
                    <td className="px-4 py-2">
                      {c.tokenStandard ? <StandardBadge standard={c.tokenStandard} /> : "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-xs">
                      <Link href={`/block/${c.firstSeenBlock}`}>{formatCount(c.firstSeenBlock)}</Link>
                    </td>
                    <td className="px-4 py-2">
                      {c.verified ? (
                        <span className="badge badge-ok">✓ Verified</span>
                      ) : (
                        <span className="badge badge-neutral">Unverified</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 text-xs" style={{ color: "var(--text-dim)", borderTop: "1px solid var(--border)" }}>
            Source verification is delegated to Blockscout/Sourcify in this release
            (see docs/architecture.md §6), so every contract currently reports as unverified here.
          </div>
        </>
      )}
      <Pager basePath="/contracts" nextCursor={page.nextCursor} hasPrev={Boolean(cursor)} />
    </Card>
  );
}

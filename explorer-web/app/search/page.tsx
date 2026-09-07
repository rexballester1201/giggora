/** Search landing (brief §14, §26). Redirects to the resolved resource. */

import { redirect } from "next/navigation";
import { API_BASE } from "@/lib/api";
import { Card, Empty } from "@/components/ui";
import { SearchBar } from "@/components/SearchBar";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  if (q && q.trim()) {
    try {
      const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q.trim())}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const r = await res.json();
        if (r.kind === "block") redirect(`/block/${r.value}`);
        if (r.kind === "transaction") redirect(`/tx/${r.value}`);
        if (r.kind === "token") redirect(`/token/${r.value}`);
        if (r.kind === "contract" || r.kind === "address") redirect(`/address/${r.value}`);
      }
    } catch {
      /* fall through to the empty state */
    }
  }

  return (
    <Card title="Search">
      <div className="px-4 py-6">
        <SearchBar />
        <div className="mt-4">
          {q ? (
            <Empty>
              Nothing found for <span className="mono">{q}</span>.
            </Empty>
          ) : (
            <Empty>
              Search by address, transaction hash, block hash, block number or token.
            </Empty>
          )}
        </div>
      </div>
    </Card>
  );
}

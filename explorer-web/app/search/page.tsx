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
    // redirect() is NOT called inside the try. Next implements redirect() by
    // THROWING a NEXT_REDIRECT control-flow error, so a catch-all around it
    // swallowed every redirect and this page silently never left the search
    // landing — the search box "worked" and went nowhere. Resolve first, catch
    // only the fetch, redirect outside.
    let target: string | null = null;
    try {
      const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q.trim())}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const r = await res.json();
        if (r.kind === "block") target = `/block/${r.value}`;
        else if (r.kind === "transaction") target = `/tx/${r.value}`;
        else if (r.kind === "token") target = `/token/${r.value}`;
        else if (r.kind === "contract" || r.kind === "address") target = `/address/${r.value}`;
      }
    } catch {
      /* API unreachable: fall through to the empty state */
    }
    if (target) redirect(target);
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

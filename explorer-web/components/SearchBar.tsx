"use client";

/**
 * Universal search (brief §26).
 *
 * The API decides what a term is — a 32-byte hash is ambiguous between a
 * transaction and a block hash by shape alone, so only the database can tell
 * them apart. This component just routes to whatever the API resolved.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { API_BASE } from "@/lib/api";

export function SearchBar({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(term)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.message ?? "Not a valid address, hash or block number");
        return;
      }
      const r = await res.json();
      switch (r.kind) {
        case "block":
          router.push(`/block/${r.value}`);
          break;
        case "transaction":
          router.push(`/tx/${r.value}`);
          break;
        case "token":
          router.push(`/token/${r.value}`);
          break;
        case "contract":
        case "address":
          router.push(`/address/${r.value}`);
          break;
        default:
          setError("Nothing found for that term");
      }
    } catch {
      setError("Search is unavailable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full">
      <div className="flex w-full items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={compact ? "Search…" : "Search by address, transaction hash, block number or token"}
          aria-label="Search the Giggora chain"
          spellCheck={false}
          autoComplete="off"
          className="mono w-full rounded-lg px-3 py-2 text-sm outline-none focus:ring-2"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            color: "var(--text)",
          }}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          style={{ background: "var(--brand)", color: "#fff" }}
        >
          {busy ? "…" : "Search"}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-xs" style={{ color: "var(--fail)" }}>
          {error}
        </p>
      )}
    </form>
  );
}

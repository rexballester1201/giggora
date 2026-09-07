"use client";

/**
 * Live network status (brief §15, §25, §28).
 *
 * Polls the API for the chain head. Polling rather than websockets on purpose:
 * one small request every few seconds is far simpler to operate than a socket
 * fleet, and the block period is 2s so the resolution is adequate.
 *
 * "Indexer behind" is surfaced explicitly. An explorer that silently serves
 * stale data is worse than one that admits it is catching up.
 */

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/api";

interface Status {
  latestBlock: number | null;
  lastIndexedBlock: number | null;
}

export function NetworkStatus() {
  const [s, setS] = useState<Status | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch(`${API_BASE}/api/stats`, { cache: "no-store" });
        if (!res.ok) throw new Error();
        const j = await res.json();
        if (!alive) return;
        setS({ latestBlock: j.latestBlock, lastIndexedBlock: j.lastIndexedBlock });
        setDown(false);
      } catch {
        if (alive) setDown(true);
      }
    }
    poll();
    const id = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (down) {
    return (
      <span className="badge badge-fail" title="The explorer API is not reachable">
        Offline
      </span>
    );
  }
  if (!s || s.latestBlock === null) {
    return <span className="badge badge-neutral">…</span>;
  }

  const lag = (s.latestBlock ?? 0) - (s.lastIndexedBlock ?? 0);
  const behind = lag > 3;

  return (
    <span
      className={`badge ${behind ? "badge-neutral" : "badge-ok"} tabular-nums`}
      title={behind ? `Indexer is ${lag} blocks behind the chain head` : "Indexer is up to date"}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: behind ? "var(--warn)" : "var(--ok)" }}
        aria-hidden
      />
      #{s.latestBlock.toLocaleString()}
      {behind ? ` (−${lag})` : ""}
    </span>
  );
}

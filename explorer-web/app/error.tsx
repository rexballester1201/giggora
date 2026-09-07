"use client";

import { Card } from "@/components/ui";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <Card title="Something went wrong">
      <div className="px-4 py-12 text-center">
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          The explorer could not render this page. The API may be unreachable.
        </p>
        <button onClick={reset} className="mt-4 rounded-lg px-4 py-2 text-sm font-semibold"
          style={{ background: "var(--brand)", color: "#fff" }}>
          Try again
        </button>
      </div>
    </Card>
  );
}

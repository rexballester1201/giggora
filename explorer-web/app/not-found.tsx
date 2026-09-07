import Link from "next/link";
import { Card } from "@/components/ui";

export default function NotFound() {
  return (
    <Card title="Not found">
      <div className="px-4 py-12 text-center">
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          That block, transaction, address or token is not in the index.
        </p>
        <p className="mt-2 text-xs" style={{ color: "var(--text-dim)" }}>
          If it was just submitted, the indexer may not have reached it yet.
        </p>
        <Link href="/" className="mt-4 inline-block text-sm">
          ← Back to the explorer
        </Link>
      </div>
    </Card>
  );
}

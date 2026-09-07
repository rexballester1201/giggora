/**
 * Giggora explorer — shared presentational components.
 *
 * Server components except where interaction demands otherwise, so hash and
 * address pages render on the server and are indexable and fast on first paint.
 */

import Link from "next/link";
import { shorten } from "@/lib/api";

export function Card({
  title,
  children,
  className = "",
  action,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs uppercase tracking-wide" style={{ color: "var(--text-dim)" }}>
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {sub && (
        <div className="mt-0.5 text-xs" style={{ color: "var(--text-dim)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/** Status badge. status===1 is success; anything else is a revert. */
export function StatusBadge({ status }: { status: number }) {
  return status === 1 ? (
    <span className="badge badge-ok">✓ Success</span>
  ) : (
    <span className="badge badge-fail">✕ Failed</span>
  );
}

export function StandardBadge({ standard }: { standard: string }) {
  const label =
    standard === "erc20" ? "ERC-20" : standard === "erc721" ? "ERC-721" : standard === "erc1155" ? "ERC-1155" : standard;
  return <span className="badge badge-neutral">{label}</span>;
}

export function HashLink({
  href,
  value,
  head = 10,
  tail = 8,
  title,
}: {
  href: string;
  value: string | null;
  head?: number;
  tail?: number;
  title?: string;
}) {
  if (!value) return <span style={{ color: "var(--text-dim)" }}>—</span>;
  return (
    <Link href={href} className="mono text-sm" title={title ?? value}>
      {shorten(value, head, tail)}
    </Link>
  );
}

/**
 * An address that may be a contract creation.
 *
 * `null` means the transaction CREATED a contract — it does not mean the zero
 * address, and rendering it as 0x000…000 would be a lie about what happened.
 */
export function AddressCell({
  address,
  contractAddress,
}: {
  address: string | null;
  contractAddress?: string | null;
}) {
  if (address === null) {
    return contractAddress ? (
      <span className="inline-flex items-center gap-1.5">
        <span className="badge badge-neutral">Contract Creation</span>
        <HashLink href={`/address/${contractAddress}`} value={contractAddress} head={8} tail={6} />
      </span>
    ) : (
      <span className="badge badge-neutral">Contract Creation</span>
    );
  }
  return <HashLink href={`/address/${address}`} value={address} head={8} tail={6} />;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-10 text-center text-sm" style={{ color: "var(--text-dim)" }}>
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[minmax(150px,220px)_1fr] sm:gap-4"
      style={{ borderTop: "1px solid var(--border)" }}
    >
      <dt className="text-sm" style={{ color: "var(--text-dim)" }}>
        {label}
      </dt>
      <dd className="text-sm break-all">{children}</dd>
    </div>
  );
}

export function Pager({
  basePath,
  nextCursor,
  hasPrev,
}: {
  basePath: string;
  nextCursor: string | null;
  hasPrev: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-2 px-4 py-3"
      style={{ borderTop: "1px solid var(--border)" }}
    >
      {hasPrev ? (
        <Link href={basePath} className="text-sm">
          ← First page
        </Link>
      ) : (
        <span className="text-sm" style={{ color: "var(--text-dim)" }}>
          First page
        </span>
      )}
      {nextCursor ? (
        <Link href={`${basePath}?cursor=${encodeURIComponent(nextCursor)}`} className="text-sm">
          Next page →
        </Link>
      ) : (
        <span className="text-sm" style={{ color: "var(--text-dim)" }}>
          End of results
        </span>
      )}
    </div>
  );
}

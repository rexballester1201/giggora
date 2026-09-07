/** Block detail (brief §16). */

import Link from "next/link";
import { notFound } from "next/navigation";
import { api, formatCount, formatUnits, toGwei, shorten, ApiError } from "@/lib/api";
import { Card, Field, Empty, StatusBadge, AddressCell } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function BlockPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;

  let block;
  try {
    block = await api.block(number);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }

  const gasPct =
    block.gasLimit && BigInt(block.gasLimit) > 0n
      ? Number((BigInt(block.gasUsed) * 10000n) / BigInt(block.gasLimit)) / 100
      : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">
          Block <span className="mono">#{block.number.toLocaleString()}</span>
        </h1>
        <div className="flex gap-2 text-sm">
          {block.number > 0 && (
            <Link href={`/block/${block.number - 1}`}>← Previous</Link>
          )}
          <Link href={`/block/${block.number + 1}`}>Next →</Link>
        </div>
      </div>

      <Card title="Overview">
        <dl>
          <Field label="Block height">
            <span className="mono">{block.number.toLocaleString()}</span>
          </Field>
          <Field label="Timestamp">
            {new Date(block.timestamp).toUTCString()}
          </Field>
          <Field label="Transactions">
            {block.transactionCount === 0 ? (
              <span style={{ color: "var(--text-dim)" }}>
                0 — empty block
              </span>
            ) : (
              `${block.transactionCount} transaction${block.transactionCount === 1 ? "" : "s"}`
            )}
          </Field>
          <Field label="Validator">
            <Link href={`/address/${block.validator}`} className="mono">
              {block.validator}
            </Link>
          </Field>
          <Field label="Gas used">
            <span className="tabular-nums">{formatCount(block.gasUsed)}</span>{" "}
            <span style={{ color: "var(--text-dim)" }}>({gasPct.toFixed(2)}%)</span>
          </Field>
          <Field label="Gas limit">
            <span className="tabular-nums">{formatCount(block.gasLimit)}</span>
          </Field>
          <Field label="Base fee per gas">{toGwei(block.baseFeePerGas)} gwei</Field>
          <Field label="Size">{block.size ? `${formatCount(block.size)} bytes` : "—"}</Field>
          <Field label="Hash">
            <span className="mono break-all">{block.hash}</span>
          </Field>
          <Field label="Parent hash">
            <Link href={`/block/${block.number - 1}`} className="mono break-all">
              {block.parentHash}
            </Link>
          </Field>
          {block.stateRoot && (
            <Field label="State root">
              <span className="mono break-all">{block.stateRoot}</span>
            </Field>
          )}
          {block.transactionsRoot && (
            <Field label="Transactions root">
              <span className="mono break-all">{block.transactionsRoot}</span>
            </Field>
          )}
          {block.receiptsRoot && (
            <Field label="Receipts root">
              <span className="mono break-all">{block.receiptsRoot}</span>
            </Field>
          )}
        </dl>
      </Card>

      <Card title={`Transactions in this block`}>
        {!block.transactions?.length ? (
          <Empty>This block contains no transactions.</Empty>
        ) : (
          <>
            <div className="table-scroll">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr>
                    <th className="px-4 py-2 text-left">Txn hash</th>
                    <th className="px-4 py-2 text-left">From</th>
                    <th className="px-4 py-2 text-left">To</th>
                    <th className="px-4 py-2 text-right">Value</th>
                    <th className="px-4 py-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {block.transactions.map((t) => (
                    <tr key={t.hash}>
                      <td className="px-4 py-2">
                        <Link href={`/tx/${t.hash}`} className="mono text-xs">
                          {shorten(t.hash, 12, 6)}
                        </Link>
                      </td>
                      <td className="px-4 py-2">
                        <AddressCell address={t.from} />
                      </td>
                      <td className="px-4 py-2">
                        <AddressCell address={t.to} contractAddress={t.contractAddress} />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                        {formatUnits(t.value, 18, 4)} GIG
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge status={t.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {block.transactionsTruncated && (
              <div className="px-4 py-3 text-xs" style={{ color: "var(--text-dim)", borderTop: "1px solid var(--border)" }}>
                Showing the first 50 transactions.{" "}
                <Link href={`/transactions?block=${block.number}`}>View all →</Link>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

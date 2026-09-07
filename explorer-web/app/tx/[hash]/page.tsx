/** Transaction detail (brief §17). */

import Link from "next/link";
import { notFound } from "next/navigation";
import { api, formatCount, formatUnits, toGwei, shorten, ApiError } from "@/lib/api";
import { Card, Field, Empty, StatusBadge, StandardBadge, AddressCell } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function TxPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;

  let tx;
  try {
    tx = await api.transaction(hash);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Transaction</h1>

      <Card title="Overview">
        <dl>
          <Field label="Transaction hash">
            <span className="mono break-all">{tx.hash}</span>
          </Field>
          <Field label="Status">
            <StatusBadge status={tx.status} />
          </Field>
          <Field label="Block">
            <Link href={`/block/${tx.blockNumber}`} className="mono">
              {tx.blockNumber.toLocaleString()}
            </Link>
            {typeof tx.confirmations === "number" && (
              <span className="ml-2 badge badge-neutral">
                {tx.confirmations.toLocaleString()} confirmation
                {tx.confirmations === 1 ? "" : "s"}
              </span>
            )}
          </Field>
          <Field label="Timestamp">{new Date(tx.timestamp).toUTCString()}</Field>
          <Field label="From">
            <Link href={`/address/${tx.from}`} className="mono break-all">
              {tx.from}
            </Link>
          </Field>
          <Field label="To">
            {tx.to ? (
              <Link href={`/address/${tx.to}`} className="mono break-all">
                {tx.to}
              </Link>
            ) : (
              <span>
                <span className="badge badge-neutral">Contract Creation</span>
                {tx.contractAddress && (
                  <>
                    {" "}
                    <Link href={`/address/${tx.contractAddress}`} className="mono break-all">
                      {tx.contractAddress}
                    </Link>
                  </>
                )}
              </span>
            )}
          </Field>
          <Field label="Value">
            <span className="tabular-nums">{formatUnits(tx.value, 18)} GIG</span>
          </Field>
          <Field label="Transaction fee">
            <span className="tabular-nums">{formatUnits(tx.fee, 18, 12)} GIG</span>
          </Field>
          <Field label="Gas price">{toGwei(tx.effectiveGasPrice)} gwei</Field>
          <Field label="Gas limit / used">
            <span className="tabular-nums">
              {formatCount(tx.gas)} / {formatCount(tx.gasUsed)}
            </span>
          </Field>
          <Field label="Nonce">{tx.nonce}</Field>
          <Field label="Type">
            {tx.type === 2 ? "EIP-1559 (2)" : tx.type === 1 ? "EIP-2930 (1)" : `Legacy (${tx.type})`}
          </Field>
        </dl>
      </Card>

      {tx.tokenTransfers && tx.tokenTransfers.length > 0 && (
        <Card title="Token transfers">
          <div className="table-scroll">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr>
                  <th className="px-4 py-2 text-left">Standard</th>
                  <th className="px-4 py-2 text-left">Token</th>
                  <th className="px-4 py-2 text-left">From</th>
                  <th className="px-4 py-2 text-left">To</th>
                  <th className="px-4 py-2 text-right">Amount / ID</th>
                </tr>
              </thead>
              <tbody>
                {tx.tokenTransfers.map((tt) => (
                  <tr key={`${tt.logIndex}.${tt.batchIndex}`}>
                    <td className="px-4 py-2">
                      <StandardBadge standard={tt.standard} />
                    </td>
                    <td className="px-4 py-2">
                      <Link href={`/token/${tt.tokenAddress}`} className="text-xs">
                        {tt.tokenSymbol ?? shorten(tt.tokenAddress, 8, 6)}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <AddressCell address={tt.from} />
                    </td>
                    <td className="px-4 py-2">
                      <AddressCell address={tt.to} />
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-xs">
                      {/* NULL value means ERC-721; NULL tokenId means ERC-20. */}
                      {tt.value !== null
                        ? formatUnits(tt.value, tt.tokenDecimals ?? 0, 6)
                        : null}
                      {tt.tokenId !== null && (
                        <span className="mono"> #{tt.tokenId}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Input data">
        <div className="px-4 py-3">
          {tx.methodId && tx.methodId !== "0x" && (
            <p className="mb-2 text-xs" style={{ color: "var(--text-dim)" }}>
              Method ID <span className="mono">{tx.methodId}</span>
              {tx.inputSize !== undefined && ` · ${formatCount(tx.inputSize)} bytes`}
            </p>
          )}
          <pre
            className="mono max-h-64 overflow-auto rounded-lg p-3 text-xs break-all whitespace-pre-wrap"
            style={{ background: "var(--surface-2)" }}
          >
            {tx.input && tx.input !== "0x" ? tx.input : "0x (no input data)"}
          </pre>
          {tx.inputTruncated && (
            <p className="mt-2 text-xs" style={{ color: "var(--text-dim)" }}>
              Input truncated to 4096 bytes for display.
            </p>
          )}
        </div>
      </Card>

      <Card title={`Event logs${tx.logs?.length ? ` (${tx.logs.length})` : ""}`}>
        {!tx.logs?.length ? (
          <Empty>This transaction emitted no logs.</Empty>
        ) : (
          <ul>
            {tx.logs.map((l) => (
              <li key={l.logIndex} className="px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="badge badge-neutral">#{l.logIndex}</span>
                  <Link href={`/address/${l.address}`} className="mono text-xs">
                    {l.address}
                  </Link>
                </div>
                <div className="space-y-0.5">
                  {l.topics.map((t, i) => (
                    <div key={i} className="text-xs">
                      <span style={{ color: "var(--text-dim)" }}>topic{i} </span>
                      <span className="mono break-all">{t}</span>
                    </div>
                  ))}
                  {l.data && l.data !== "0x" && (
                    <div className="text-xs">
                      <span style={{ color: "var(--text-dim)" }}>data </span>
                      <span className="mono break-all">{l.data}</span>
                      {l.dataTruncated && (
                        <span style={{ color: "var(--text-dim)" }}> (truncated)</span>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

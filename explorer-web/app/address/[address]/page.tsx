/** Address detail (brief §18). */

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  api,
  formatUnits,
  timeAgo,
  shorten,
  ApiError,
  type Transaction,
  type TokenTransfer,
} from "@/lib/api";
import { Card, Field, Empty, StatusBadge, StandardBadge, AddressCell } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AddressPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;

  let info;
  try {
    info = await api.address(address);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }

  // Both feeds are independently paginated; the first page of each is shown.
  let txs: Transaction[] = [];
  let transfers: TokenTransfer[] = [];
  try {
    [txs, transfers] = await Promise.all([
      api.addressTransactions(address, 25).then((p) => p.items),
      api.addressTokenTransfers(address, 25).then((p) => p.items),
    ]);
  } catch {
    /* feeds are best-effort; the overview still renders */
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">{info.isContract ? "Contract" : "Address"}</h1>
        {info.isContract && <span className="badge badge-neutral">Contract</span>}
        {info.token && <StandardBadge standard={info.token.standard} />}
      </div>
      <p className="mono text-sm break-all" style={{ color: "var(--text-dim)" }}>
        {info.address}
      </p>

      <Card title="Overview">
        <dl>
          <Field label={`Balance`}>
            {info.balance !== null ? (
              <span className="tabular-nums">{formatUnits(info.balance, 18)} GIG</span>
            ) : (
              <span style={{ color: "var(--text-dim)" }}>
                Unavailable ({info.balanceError ?? "node unreachable"})
              </span>
            )}
          </Field>
          {info.firstSeenBlock !== null && (
            <Field label="First seen">
              <Link href={`/block/${info.firstSeenBlock}`} className="mono">
                block {info.firstSeenBlock.toLocaleString()}
              </Link>
            </Field>
          )}
          {info.lastSeenBlock !== null && (
            <Field label="Last seen">
              <Link href={`/block/${info.lastSeenBlock}`} className="mono">
                block {info.lastSeenBlock.toLocaleString()}
              </Link>
            </Field>
          )}
          {info.token && (
            <Field label="Token">
              <Link href={`/token/${info.token.address}`}>
                {info.token.name ?? "Unnamed"}{" "}
                {info.token.symbol && <span style={{ color: "var(--text-dim)" }}>({info.token.symbol})</span>}
              </Link>
            </Field>
          )}
          <Field label="Token holdings">
            {/*
              Stated honestly rather than faked. There is no balance state in the
              schema, and summing transfer history per request would be both
              unbounded and wrong.
            */}
            <span style={{ color: "var(--text-dim)" }}>{info.tokenHoldingsUnavailable}</span>
          </Field>
        </dl>
      </Card>

      <Card title="Transactions">
        {txs.length === 0 ? (
          <Empty>No transactions for this address.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[780px] text-sm">
              <thead>
                <tr>
                  <th className="px-4 py-2 text-left">Txn hash</th>
                  <th className="px-4 py-2 text-left">Block</th>
                  <th className="px-4 py-2 text-left">Age</th>
                  <th className="px-4 py-2 text-left">From</th>
                  <th className="px-4 py-2 text-left">To</th>
                  <th className="px-4 py-2 text-right">Value</th>
                  <th className="px-4 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((t) => {
                  const outgoing = t.from.toLowerCase() === info.address.toLowerCase();
                  return (
                    <tr key={t.hash}>
                      <td className="px-4 py-2">
                        <Link href={`/tx/${t.hash}`} className="mono text-xs">
                          {shorten(t.hash, 12, 6)}
                        </Link>
                      </td>
                      <td className="px-4 py-2">
                        <Link href={`/block/${t.blockNumber}`} className="mono text-xs">
                          {t.blockNumber.toLocaleString()}
                        </Link>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs" style={{ color: "var(--text-dim)" }}>
                        {timeAgo(t.timestamp)}
                      </td>
                      <td className="px-4 py-2">
                        {outgoing ? (
                          <span className="mono text-xs" style={{ color: "var(--text-dim)" }}>
                            {shorten(t.from, 8, 6)}
                          </span>
                        ) : (
                          <AddressCell address={t.from} />
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <AddressCell address={t.to} contractAddress={t.contractAddress} />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                        <span style={{ color: outgoing ? "var(--fail)" : "var(--ok)" }}>
                          {outgoing ? "−" : "+"}
                          {formatUnits(t.value, 18, 4)}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge status={t.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Token transfers">
        {transfers.length === 0 ? (
          <Empty>No token transfers for this address.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr>
                  <th className="px-4 py-2 text-left">Txn</th>
                  <th className="px-4 py-2 text-left">Standard</th>
                  <th className="px-4 py-2 text-left">Token</th>
                  <th className="px-4 py-2 text-left">From</th>
                  <th className="px-4 py-2 text-left">To</th>
                  <th className="px-4 py-2 text-right">Amount / ID</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((tt) => (
                  <tr key={`${tt.transactionHash}.${tt.logIndex}.${tt.batchIndex}`}>
                    <td className="px-4 py-2">
                      <Link href={`/tx/${tt.transactionHash}`} className="mono text-xs">
                        {shorten(tt.transactionHash, 10, 4)}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <StandardBadge standard={tt.standard} />
                    </td>
                    <td className="px-4 py-2">
                      <Link href={`/token/${tt.tokenAddress}`} className="text-xs">
                        {tt.tokenSymbol ?? shorten(tt.tokenAddress, 8, 4)}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <AddressCell address={tt.from} />
                    </td>
                    <td className="px-4 py-2">
                      <AddressCell address={tt.to} />
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-xs">
                      {tt.value !== null && formatUnits(tt.value, tt.tokenDecimals ?? 0, 6)}
                      {tt.tokenId !== null && <span className="mono"> #{tt.tokenId}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

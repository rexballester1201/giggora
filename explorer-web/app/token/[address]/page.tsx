/** Token detail (brief §20). */

import Link from "next/link";
import { notFound } from "next/navigation";
import { api, formatUnits, timeAgo, shorten, ApiError } from "@/lib/api";
import { Card, Field, Empty, StandardBadge, AddressCell } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function TokenPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;

  let token;
  try {
    token = await api.token(address);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }

  let transfers: Awaited<ReturnType<typeof api.tokenTransfers>>["items"] = [];
  try {
    transfers = (await api.tokenTransfers(address, 25)).items;
  } catch {
    /* best effort */
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">{token.name ?? "Unnamed token"}</h1>
        {token.symbol && <span style={{ color: "var(--text-dim)" }}>({token.symbol})</span>}
        <StandardBadge standard={token.standard} />
      </div>

      <Card title="Token details">
        <dl>
          <Field label="Contract">
            <Link href={`/address/${token.address}`} className="mono break-all">
              {token.address}
            </Link>
          </Field>
          <Field label="Name">{token.name ?? "—"}</Field>
          <Field label="Symbol">{token.symbol ?? "—"}</Field>
          {token.standard === "erc20" && (
            <Field label="Decimals">{token.decimals ?? "—"}</Field>
          )}
          <Field label="Total supply">
            {token.totalSupply === null ? (
              "—"
            ) : (
              <span className="tabular-nums">
                {formatUnits(token.totalSupply, token.decimals ?? 0, 6)}{" "}
                {token.symbol ?? ""}
              </span>
            )}
          </Field>
          <Field label="Holders">
            <span style={{ color: "var(--text-dim)" }}>
              {token.holdersUnavailable ?? "—"}
            </span>
          </Field>
          <Field label="First seen">
            <Link href={`/block/${token.firstSeenBlock}`} className="mono">
              block {token.firstSeenBlock.toLocaleString()}
            </Link>
          </Field>
        </dl>
      </Card>

      <Card title="Transfers">
        {transfers.length === 0 ? (
          <Empty>No transfers recorded for this token.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[700px] text-sm">
              <thead>
                <tr>
                  <th className="px-4 py-2 text-left">Txn</th>
                  <th className="px-4 py-2 text-left">Age</th>
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
                        {shorten(tt.transactionHash, 12, 4)}
                      </Link>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-xs" style={{ color: "var(--text-dim)" }}>
                      {timeAgo(tt.timestamp)}
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

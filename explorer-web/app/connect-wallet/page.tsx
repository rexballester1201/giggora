/**
 * Wallet connection guide (brief §9).
 *
 * Every value on this page is read from the live chain, not hard-coded — if the
 * chain id or currency ever changes, this page changes with it rather than
 * quietly telling users to connect to the wrong network.
 */

import Link from "next/link";
import { api } from "@/lib/api";
import { Card, Field, Empty } from "@/components/ui";
import { AddNetworkButton } from "@/components/AddNetworkButton";

export const dynamic = "force-dynamic";

const DEVNET_ACCOUNTS = [
  {
    label: "Anvil #0",
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  },
  {
    label: "Anvil #1",
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    key: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  },
];

export default async function ConnectWalletPage() {
  let stats;
  try {
    stats = await api.stats();
  } catch {
    return (
      <Card title="Connect a wallet">
        <Empty>The explorer API is unreachable, so the network details cannot be shown.</Empty>
      </Card>
    );
  }

  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "http://localhost:8545";
  const explorerUrl = process.env.NEXT_PUBLIC_EXPLORER_URL ?? "http://localhost:3000";
  const chainIdHex = `0x${stats.chainId.toString(16)}`;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Connect a wallet</h1>
      <p className="text-sm" style={{ color: "var(--text-dim)" }}>
        Giggora is a standard EVM chain, so it works with MetaMask and any other
        EIP-1193 wallet without a plugin or a fork.
      </p>

      <Card title="One-click">
        <div className="px-4 py-4">
          <AddNetworkButton
            chainIdHex={chainIdHex}
            chainName={`${stats.chainName} ${process.env.NEXT_PUBLIC_NETWORK_LABEL ?? "Devnet"}`}
            rpcUrl={rpcUrl}
            explorerUrl={explorerUrl}
            symbol={stats.currency.symbol}
            decimals={stats.currency.decimals}
          />
          <p className="mt-3 text-xs" style={{ color: "var(--text-dim)" }}>
            This uses <span className="mono">wallet_addEthereumChain</span> (EIP-3085). Your wallet
            will show a confirmation prompt; nothing is added without your approval.
          </p>
        </div>
      </Card>

      <Card title="Manual configuration">
        <dl>
          <Field label="Network name">{stats.chainName} Devnet</Field>
          <Field label="RPC URL">
            <span className="mono">{rpcUrl}</span>
          </Field>
          <Field label="Chain ID">
            <span className="mono">{stats.chainId}</span>{" "}
            <span style={{ color: "var(--text-dim)" }}>({chainIdHex})</span>
          </Field>
          <Field label="Currency symbol">
            <span className="mono">{stats.currency.symbol}</span>
          </Field>
          <Field label="Decimals">{stats.currency.decimals}</Field>
          <Field label="Block explorer URL">
            <span className="mono">{explorerUrl}</span>
          </Field>
        </dl>
        <div
          className="px-4 py-3 text-xs"
          style={{ color: "var(--text-dim)", borderTop: "1px solid var(--border)" }}
        >
          Wallets expect the chain ID as a hex quantity. If you enter it manually, most
          wallets accept the decimal form and convert it for you.
        </div>
      </Card>

      <Card title="Reaching the RPC endpoint">
        <div className="px-4 py-4 text-sm" style={{ color: "var(--text-dim)" }}>
          <p>
            The RPC URL above must be reachable <strong>from your browser</strong>. A{" "}
            <span className="mono">localhost</span> address only works on the machine running the
            node, which is correct for local development and will not work for anyone else.
          </p>
          <p className="mt-2">
            For a shared devnet or a public testnet, put the node behind a reverse proxy with
            HTTPS and publish that hostname instead — see{" "}
            <span className="mono">docs/architecture.md</span> §5 for the topology, which keeps
            validators unreachable and exposes only the RPC node.
          </p>
        </div>
      </Card>

      <Card title="Devnet test accounts">
        <div className="px-4 py-3 text-xs" style={{ color: "var(--text-dim)" }}>
          These private keys are published by Foundry and Besu. They are public knowledge and hold
          no real value. They exist so you can try the chain immediately.{" "}
          <strong style={{ color: "var(--fail)" }}>
            Never use them on a testnet or mainnet, and never send anything you care about to them.
          </strong>
        </div>
        <div className="table-scroll">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr>
                <th className="px-4 py-2 text-left">Account</th>
                <th className="px-4 py-2 text-left">Address</th>
                <th className="px-4 py-2 text-left">Private key (public knowledge)</th>
              </tr>
            </thead>
            <tbody>
              {DEVNET_ACCOUNTS.map((a) => (
                <tr key={a.address}>
                  <td className="px-4 py-2">{a.label}</td>
                  <td className="px-4 py-2">
                    <Link href={`/address/${a.address}`} className="mono text-xs">
                      {a.address}
                    </Link>
                  </td>
                  <td className="px-4 py-2 mono text-xs" style={{ color: "var(--text-dim)" }}>
                    {a.key}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Try it">
        <div className="px-4 py-4 text-sm">
          <p style={{ color: "var(--text-dim)" }}>
            The sample DApp sends {stats.currency.symbol} and an ERC-20 token from a connected
            wallet and waits for confirmation — the shortest proof that Giggora works with ordinary
            EVM tooling.
          </p>
          <p className="mt-2 text-xs" style={{ color: "var(--text-dim)" }}>
            Serve it with <span className="mono">node dapp/serve.mjs</span> and open{" "}
            <span className="mono">http://localhost:3001</span>.
          </p>
        </div>
      </Card>
    </div>
  );
}

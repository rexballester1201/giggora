"use client";

/**
 * "Add Giggora to MetaMask" (brief §9).
 *
 * Uses EIP-3085 `wallet_addEthereumChain` through the EIP-1193 provider. Notes
 * that matter for this to actually work in a real wallet:
 *
 *   - chainId MUST be a 0x-prefixed hex QUANTITY, not the decimal number. A
 *     decimal chain id is the single most common reason this call fails.
 *   - nativeCurrency.decimals must be 18; MetaMask rejects anything else.
 *   - rpcUrls entries must be reachable FROM THE USER'S BROWSER. A localhost URL
 *     works for local development and will not work for anyone else, which is
 *     why the page says so rather than pretending otherwise.
 *   - Error 4902 means "chain not added yet", which is what we are fixing; 4001
 *     means the user rejected the prompt, which is not an error worth shouting
 *     about.
 */

import { useState } from "react";

interface Props {
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  symbol: string;
  decimals: number;
}

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  isMetaMask?: boolean;
};

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export function AddNetworkButton(props: Props) {
  const [state, setState] = useState<"idle" | "busy" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function add() {
    const eth = typeof window !== "undefined" ? window.ethereum : undefined;
    if (!eth) {
      setState("error");
      setMessage(
        "No EIP-1193 wallet detected. Install MetaMask (or another EVM wallet) and reload, or add the network manually with the values below."
      );
      return;
    }

    setState("busy");
    setMessage(null);
    try {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: props.chainIdHex,
            chainName: props.chainName,
            nativeCurrency: {
              name: props.symbol,
              symbol: props.symbol,
              decimals: props.decimals,
            },
            rpcUrls: [props.rpcUrl],
            blockExplorerUrls: [props.explorerUrl],
          },
        ],
      });
      setState("ok");
      setMessage(`${props.chainName} added. Select it in your wallet's network list.`);
    } catch (err: any) {
      // 4001 is "user rejected" — a normal outcome, not a failure to report loudly.
      if (err?.code === 4001) {
        setState("idle");
        setMessage(null);
        return;
      }
      setState("error");
      setMessage(err?.message ?? "The wallet rejected the request.");
    }
  }

  return (
    <div>
      <button
        onClick={add}
        disabled={state === "busy"}
        className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        style={{ background: "var(--brand)", color: "#fff" }}
      >
        {state === "busy" ? "Waiting for wallet…" : `Add ${props.chainName} to your wallet`}
      </button>
      {message && (
        <p
          className="mt-2 text-xs"
          style={{ color: state === "error" ? "var(--fail)" : "var(--ok)" }}
        >
          {message}
        </p>
      )}
    </div>
  );
}

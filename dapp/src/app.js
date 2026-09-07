/**
 * Giggora sample DApp (brief §41).
 *
 * Raw EIP-1193 against window.ethereum. No web3 library, no bundler, no build
 * step — deliberately, because the point is to demonstrate that GIGGORA works
 * with standard EVM tooling, and a framework in the middle would obscure that.
 *
 * Every amount is handled as BigInt. Wei values exceed Number.MAX_SAFE_INTEGER
 * routinely (1 GIG is 1e18), so parsing one into a double would silently corrupt
 * the transfer — the same discipline the indexer, API and explorer all keep.
 */

const $ = (id) => document.getElementById(id);

const CONFIG = {
  // Overridable so the same page serves a devnet, a testnet or a local fork.
  chainId: Number(new URLSearchParams(location.search).get("chainId") ?? 4043),
  explorer: new URLSearchParams(location.search).get("explorer") ?? "http://localhost:3000",
  rpcUrl: new URLSearchParams(location.search).get("rpc") ?? "http://localhost:8545",
  symbol: "GIG",
};

let account = null;

// --- logging -----------------------------------------------------------------
function log(msg, cls) {
  const el = $("log");
  const time = new Date().toISOString().slice(11, 19);
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${time}] ${msg}`;
  if (el.textContent === "Ready.") el.textContent = "";
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function txLink(hash) {
  return `${CONFIG.explorer}/tx/${hash}`;
}

// --- units (BigInt only) -----------------------------------------------------
/** Decimal string -> base units, without ever touching a float. */
function parseUnits(value, decimals) {
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a valid amount: ${value}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`too many decimal places (max ${decimals})`);
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** Base units -> readable decimal string. BigInt division, never Number(). */
function formatUnits(v, decimals, maxFrac = 6) {
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

const toHexQty = (v) => "0x" + v.toString(16);

// --- provider ----------------------------------------------------------------
function provider() {
  if (!window.ethereum) {
    throw new Error("No EIP-1193 wallet found. Install MetaMask and reload.");
  }
  return window.ethereum;
}

async function rpc(method, params = []) {
  return provider().request({ method, params });
}

// --- ABI encoding (hand-rolled; only two shapes are needed) -------------------
// Keccak is NOT computed here — the two selectors used are the fixed, well-known
// ERC-20 ones, so hard-coding them avoids pulling in a hashing library for two
// constants. Anything beyond these would need a real ABI encoder.
const SELECTOR = {
  transfer: "0xa9059cbb", // transfer(address,uint256)
  balanceOf: "0x70a08231", // balanceOf(address)
  decimals: "0x313ce567", // decimals()
  symbol: "0x95d89b41", // symbol()
};

const padAddress = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padUint = (v) => v.toString(16).padStart(64, "0");

// --- wallet flow -------------------------------------------------------------
async function refresh() {
  if (!account) return;
  const [chainIdHex, balHex] = await Promise.all([
    rpc("eth_chainId"),
    rpc("eth_getBalance", [account, "latest"]),
  ]);
  const chainId = parseInt(chainIdHex, 16);

  $("account").textContent = account;
  $("chainId").textContent = `${chainId} (${chainIdHex})`;
  $("balance").textContent = `${formatUnits(BigInt(balHex), 18)} ${CONFIG.symbol}`;

  const right = chainId === CONFIG.chainId;
  $("switch").classList.toggle("hidden", right);
  $("sendNative").classList.toggle("hidden", !right);
  $("sendToken").classList.toggle("hidden", !right);
  if (!right) {
    $("walletMsg").textContent = `Connected to chain ${chainId}, but Giggora is ${CONFIG.chainId}. Switch networks to continue.`;
    $("walletMsg").className = "sub fail";
  } else {
    $("walletMsg").textContent = "";
  }
}

async function connect() {
  try {
    const accounts = await rpc("eth_requestAccounts");
    account = accounts[0];
    $("walletInfo").classList.remove("hidden");
    log(`Connected ${account}`, "ok");
    await refresh();
  } catch (err) {
    // 4001 = user rejected. Not an error worth shouting about.
    if (err?.code === 4001) return log("Connection request rejected.", "dim");
    log(err.message ?? String(err), "fail");
    $("walletMsg").textContent = err.message ?? String(err);
    $("walletMsg").className = "sub fail";
  }
}

async function switchChain() {
  const hex = toHexQty(CONFIG.chainId);
  try {
    await rpc("wallet_switchEthereumChain", [{ chainId: hex }]);
  } catch (err) {
    // 4902 = chain unknown to the wallet; offer to add it.
    if (err?.code === 4902) {
      await rpc("wallet_addEthereumChain", [
        {
          chainId: hex,
          chainName: "Giggora Devnet",
          nativeCurrency: { name: CONFIG.symbol, symbol: CONFIG.symbol, decimals: 18 },
          rpcUrls: [CONFIG.rpcUrl],
          blockExplorerUrls: [CONFIG.explorer],
        },
      ]);
    } else if (err?.code !== 4001) {
      log(err.message ?? String(err), "fail");
    }
  }
  await refresh();
}

/**
 * Submit a transaction and wait for its receipt.
 *
 * eth_sendTransaction hands the unsigned request to the WALLET, which signs it
 * and broadcasts via eth_sendRawTransaction. That is the whole point: the DApp
 * never sees a private key.
 */
async function sendAndWait(tx, label) {
  log(`${label}: requesting signature…`);
  const hash = await rpc("eth_sendTransaction", [tx]);
  log(`${label}: submitted ${hash}`);
  log(`  ${txLink(hash)}`);

  // Poll for the receipt. QBFT has absolute finality, so one confirmation is
  // final — there is no reorg to wait out.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      const ok = receipt.status === "0x1";
      const block = parseInt(receipt.blockNumber, 16);
      const gasUsed = BigInt(receipt.gasUsed);
      log(
        `${label}: ${ok ? "confirmed" : "REVERTED"} in block ${block}, gas used ${gasUsed}`,
        ok ? "ok" : "fail"
      );
      return { hash, receipt, ok };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log(`${label}: no receipt after 90s — still pending?`, "fail");
  return { hash, receipt: null, ok: false };
}

async function sendNative() {
  const btn = $("btnNative");
  btn.disabled = true;
  try {
    const to = $("toNative").value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("recipient is not a valid address");
    const value = parseUnits($("amtNative").value, 18);

    const before = BigInt(await rpc("eth_getBalance", [to, "latest"]));
    await sendAndWait({ from: account, to, value: toHexQty(value) }, "Send GIG");
    const after = BigInt(await rpc("eth_getBalance", [to, "latest"]));

    log(`  recipient balance ${formatUnits(before, 18)} -> ${formatUnits(after, 18)} ${CONFIG.symbol}`);
    await refresh();
  } catch (err) {
    if (err?.code === 4001) log("Signature rejected.", "dim");
    else log(err.message ?? String(err), "fail");
  } finally {
    btn.disabled = false;
  }
}

async function sendToken() {
  const btn = $("btnToken");
  btn.disabled = true;
  try {
    const token = $("tokenAddr").value.trim();
    const to = $("toToken").value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("token address is invalid");
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("recipient is not a valid address");

    // Read decimals from the contract rather than assuming 18 — assuming is how
    // a 6-decimal token transfer becomes a 10^12x mistake.
    const decHex = await rpc("eth_call", [{ to: token, data: SELECTOR.decimals }, "latest"]);
    const decimals = decHex && decHex !== "0x" ? parseInt(decHex, 16) : 18;
    const amount = parseUnits($("amtToken").value, decimals);

    const balBefore = BigInt(
      await rpc("eth_call", [{ to: token, data: SELECTOR.balanceOf + padAddress(to) }, "latest"])
    );

    const data = SELECTOR.transfer + padAddress(to) + padUint(amount);
    const { ok } = await sendAndWait({ from: account, to: token, data }, "ERC-20 transfer");

    if (ok) {
      const balAfter = BigInt(
        await rpc("eth_call", [{ to: token, data: SELECTOR.balanceOf + padAddress(to) }, "latest"])
      );
      log(
        `  recipient token balance ${formatUnits(balBefore, decimals)} -> ${formatUnits(balAfter, decimals)}`
      );
    }
  } catch (err) {
    if (err?.code === 4001) log("Signature rejected.", "dim");
    else log(err.message ?? String(err), "fail");
  } finally {
    btn.disabled = false;
  }
}

// --- wiring ------------------------------------------------------------------
$("connect").addEventListener("click", connect);
$("switch").addEventListener("click", switchChain);
$("btnNative").addEventListener("click", sendNative);
$("btnToken").addEventListener("click", sendToken);

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", (a) => {
    account = a[0] ?? null;
    if (!account) {
      $("walletInfo").classList.add("hidden");
      log("Wallet disconnected.", "dim");
    } else {
      log(`Account changed to ${account}`);
      refresh();
    }
  });
  window.ethereum.on?.("chainChanged", () => {
    log("Network changed.");
    refresh();
  });
} else {
  $("walletMsg").textContent =
    "No EIP-1193 wallet detected. Install MetaMask (or another EVM wallet) and reload.";
  $("walletMsg").className = "sub fail";
}

// Prefill the token field from the recorded deployment, if it is being served.
fetch("./deployments.json")
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    if (d?.contracts?.GigToken?.address) {
      $("tokenAddr").value = d.contracts.GigToken.address;
      log(`Prefilled GigToken ${d.contracts.GigToken.address}`, "dim");
    }
  })
  .catch(() => {});

/**
 * Giggora explorer UI — API client.
 *
 * Every value the explorer displays comes from the explorer API, which reads
 * the indexer's database, which reads the chain (brief §47.3-§47.5). Nothing is
 * hard-coded and nothing is mocked: if the chain is empty, the UI shows empty.
 *
 * uint256 values stay as STRINGS the whole way through. They are formatted for
 * display with BigInt arithmetic, never parsed into a JS number — a balance
 * rounded through a double is the one bug the whole stack has been built to
 * avoid, and it would be a shame to introduce it in the last mile.
 */

/**
 * Where to reach the explorer API.
 *
 * The server and the browser need DIFFERENT addresses, and conflating them is
 * the bug this shape exists to prevent.
 *
 *   server  runs inside the web container. It must use a private address
 *           (http://giggora-api:4100) - "localhost" there is the web container
 *           itself, where nothing is listening.
 *   browser runs on the user's machine and can only use a PUBLIC address, so
 *           that value has to be inlined at build time via NEXT_PUBLIC_*.
 *
 * NEXT_PUBLIC_API_BASE is inlined into BOTH bundles, so a single
 *   NEXT_PUBLIC_API_BASE ?? API_BASE
 * silently made the server use the browser's address and never read API_BASE
 * at all: on the devnet it fetched localhost:4100 from inside the container and
 * rendered "Could not reach the explorer API" while the API was perfectly
 * healthy. In deploy/ it was subtler - the server would have gone out through
 * Caddy and back in, rate-limiting itself through its own public endpoint.
 *
 * On a developer machine neither variable is set and both sides fall back to
 * localhost, which is correct there.
 */
export const API_BASE =
  typeof window === "undefined"
    ? process.env.API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4100"
    : process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4100";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Block {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: string;
  validator: string;
  gasUsed: string;
  gasLimit: string;
  baseFeePerGas: string | null;
  transactionCount: number;
  size: number | null;
  stateRoot?: string;
  receiptsRoot?: string;
  transactionsRoot?: string;
  transactions?: Transaction[];
  transactionsTruncated?: boolean;
}

export interface Transaction {
  hash: string;
  blockNumber: number;
  transactionIndex: number;
  from: string;
  /** null means contract creation, NOT the zero address. */
  to: string | null;
  value: string;
  nonce: number;
  gas: string;
  gasUsed: string;
  effectiveGasPrice: string;
  fee: string;
  status: number;
  type: number;
  contractAddress: string | null;
  timestamp: string;
  methodId: string | null;
  inputSize?: number;
  confirmations?: number;
  input?: string;
  inputTruncated?: boolean;
  logs?: LogEntry[];
  tokenTransfers?: TokenTransfer[];
}

export interface LogEntry {
  logIndex: number;
  address: string;
  topics: string[];
  data: string;
  dataTruncated: boolean;
}

export interface TokenTransfer {
  transactionHash: string;
  logIndex: number;
  batchIndex: number;
  blockNumber: number;
  tokenAddress: string;
  standard: "erc20" | "erc721" | "erc1155";
  from: string;
  to: string;
  /** null for ERC-721. */
  value: string | null;
  /** null for ERC-20. */
  tokenId: string | null;
  timestamp: string;
  tokenName?: string | null;
  tokenSymbol?: string | null;
  tokenDecimals?: number | null;
}

export interface Token {
  address: string;
  standard: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  firstSeenBlock: number;
  holders?: null;
  holdersUnavailable?: string;
}

export interface Stats {
  chainId: number;
  chainName: string;
  currency: { name: string; symbol: string; decimals: number };
  latestBlock: number | null;
  lastIndexedBlock: number | null;
  totalTransactions: string;
  totalLogs: string;
  totalTokenTransfers: string;
  totalContracts: number;
  totalTokens: number;
  averageBlockTimeSeconds: number | null;
  gasLimit: string | null;
  baseFeePerGas: string | null;

  // Staleness. Every other field here comes from the indexer database, so they
  // agree with each other even when the indexer has been dead for hours. These
  // three are the only way to know whether any of it is current.
  //
  // null means "unknown", NOT "fine": chainHeadBlock is null until the indexer
  // has run once since migration 004.
  chainHeadBlock: number | null;
  indexerLagBlocks: number | null;
  indexerStaleSeconds: number | null;
}

export interface AddressInfo {
  address: string;
  isContract: boolean;
  balance: string | null;
  balanceError: string | null;
  firstSeenBlock: number | null;
  lastSeenBlock: number | null;
  token: Token | null;
  tokenHoldings: null;
  tokenHoldingsUnavailable: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function get<T>(path: string, revalidate = 2): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    // Short revalidate: the head of the chain moves every couple of seconds.
    next: { revalidate },
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body?.message ?? msg;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export const api = {
  stats: () => get<Stats>("/api/stats", 2),
  blocks: (limit = 25, cursor?: string | null) =>
    get<Page<Block>>(`/api/blocks?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  block: (n: number | string) => get<Block>(`/api/blocks/${n}`, 30),
  transactions: (limit = 25, cursor?: string | null) =>
    get<Page<Transaction>>(
      `/api/transactions?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    ),
  transaction: (hash: string) => get<Transaction>(`/api/transactions/${hash}`, 30),
  address: (a: string) => get<AddressInfo>(`/api/address/${a}`, 5),
  addressTransactions: (a: string, limit = 25, cursor?: string | null) =>
    get<Page<Transaction>>(
      `/api/address/${a}/transactions?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    ),
  addressTokenTransfers: (a: string, limit = 25, cursor?: string | null) =>
    get<Page<TokenTransfer>>(
      `/api/address/${a}/token-transfers?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    ),
  tokens: (limit = 25, cursor?: string | null) =>
    get<Page<Token>>(`/api/tokens?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  token: (a: string) => get<Token>(`/api/token/${a}`, 30),
  tokenTransfers: (a: string, limit = 25, cursor?: string | null) =>
    get<Page<TokenTransfer>>(
      `/api/token/${a}/transfers?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    ),
  contracts: (limit = 25, cursor?: string | null) =>
    get<Page<any>>(`/api/contracts?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  search: (q: string) => get<{ kind: string; value: string | number | null; path: string | null }>(
    `/api/search?q=${encodeURIComponent(q)}`,
    2
  ),
};

// ---------------------------------------------------------------------------
// formatting — all BigInt, never Number
// ---------------------------------------------------------------------------

/**
 * Format a wei-denominated string for display.
 *
 * Deliberately BigInt arithmetic. Doing this with Number() would silently round
 * any balance above ~9 quadrillion wei (0.009 GIG), which is most of them.
 */
export function formatUnits(value: string | null | undefined, decimals = 18, maxFrac = 6): string {
  if (value === null || value === undefined) return "—";
  let v: bigint;
  try {
    v = BigInt(value);
  } catch {
    return "—";
  }
  const neg = v < 0n;
  if (neg) v = -v;

  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;

  let fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${wholeStr}${fracStr ? `.${fracStr}` : ""}`;
}

/** Thousands separators for a counter that may exceed Number.MAX_SAFE_INTEGER. */
export function formatCount(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function shorten(hex: string | null | undefined, head = 10, tail = 8): string {
  if (!hex) return "—";
  if (hex.length <= head + tail + 2) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Gas price in gwei, from wei. BigInt throughout. */
export function toGwei(wei: string | null | undefined): string {
  return formatUnits(wei, 9, 4);
}

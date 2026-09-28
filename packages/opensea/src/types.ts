/** Raw shapes returned by the OpenSea v2 Drops endpoints. */

export interface DropStage {
  uuid?: string;
  stage_type?: string;
  label?: string;
  /** Mint price per token, wei decimal string. */
  price?: string;
  price_currency_address?: string;
  currency?: string;
  start_time?: string;
  end_time?: string;
  max_per_wallet?: number | string;
  maxPerWallet?: number | string;
  limit_per_wallet?: number | string;
  max_per_stage?: number | string;
  /** Number of wallets whitelisted/allocated to this stage. */
  allowlist_wallet_count?: number | string;
  allowlist?: unknown;
  [k: string]: unknown;
}

export interface Drop {
  collection_slug: string;
  collection_name?: string;
  chain: string;
  contract_address?: string;
  drop_type?: string;
  is_minting: boolean;
  active_stage?: DropStage | null;
  next_stage?: DropStage | null;
  stages?: DropStage[];
  total_supply?: number;
  max_supply?: number;
  opensea_url?: string;
  [k: string]: unknown;
}

/** Normalized collection metadata from GET /api/v2/collections*. */
export interface CollectionInfo {
  slug: string;
  name?: string;
  description?: string;
  image?: string;
  banner?: string;
  safelist?: string;
  /** Primary chain from contracts[0]. */
  chain?: string;
  category?: string;
  opensea_url?: string;
  raw: unknown;
}

/** Stats from GET /api/v2/collections/{slug}/stats. */
export interface CollectionStats {
  floor_price?: number;
  floor_price_symbol?: string;
  num_owners?: number;
  total_volume?: number;
  total_sales?: number;
  /** interval -> {volume, sales} (one_day / seven_day / thirty_day). */
  intervals: Record<string, { volume?: number; sales?: number }>;
  raw: unknown;
}

/** Normalize a /collections item (the slug field is `collection`). */
export function normalizeCollection(raw: unknown): CollectionInfo | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const slug = pick<string>(r, "collection", "collection_slug", "slug");
  if (!slug) return null;
  return {
    slug,
    ...(r.name !== undefined ? { name: r.name as string } : {}),
    ...(r.description !== undefined
      ? { description: r.description as string }
      : {}),
    ...(r.image_url !== undefined ? { image: r.image_url as string } : {}),
    ...(r.banner_image_url !== undefined
      ? { banner: r.banner_image_url as string }
      : {}),
    ...(r.safelist_status !== undefined
      ? { safelist: r.safelist_status as string }
      : {}),
    ...(r.category !== undefined ? { category: r.category as string } : {}),
    ...(Array.isArray(r.contracts) &&
    (r.contracts[0] as Record<string, unknown> | undefined)?.chain !==
      undefined
      ? {
          chain: (r.contracts[0] as Record<string, unknown>).chain as string,
        }
      : {}),
    opensea_url:
      (r.opensea_url as string) ??
      `https://opensea.io/collection/${slug}`,
    raw,
  };
}

/** Normalize the /stats payload into CollectionStats. */
export function normalizeCollectionStats(raw: unknown): CollectionStats {
  const r = (raw ?? {}) as Record<string, unknown>;
  const total = (r.total ?? {}) as Record<string, unknown>;
  const intervals: CollectionStats["intervals"] = {};
  for (const i of Array.isArray(r.intervals) ? r.intervals : []) {
    const iv = i as Record<string, unknown>;
    if (typeof iv.interval === "string") {
      intervals[iv.interval] = {
        ...(iv.volume !== undefined ? { volume: iv.volume as number } : {}),
        ...(iv.sales !== undefined ? { sales: iv.sales as number } : {}),
      };
    }
  }
  return {
    ...(total.floor_price !== undefined
      ? { floor_price: total.floor_price as number }
      : {}),
    ...(total.floor_price_symbol !== undefined
      ? { floor_price_symbol: total.floor_price_symbol as string }
      : {}),
    ...(total.num_owners !== undefined
      ? { num_owners: total.num_owners as number }
      : {}),
    ...(total.volume !== undefined
      ? { total_volume: total.volume as number }
      : {}),
    ...(total.sales !== undefined
      ? { total_sales: total.sales as number }
      : {}),
    intervals,
    raw,
  };
}

export interface MintTransactionRequest {
  /** Wallet that will receive the minted tokens. */
  minter: string;
  quantity: number;
}

/** Normalized ready-to-sign transaction built by POST /drops/{slug}/mint. */
export interface MintTransaction {
  to: string;
  data: string;
  /** Native-token value in wei (decimal string). */
  value: string;
  chainId?: number;
  gasLimit?: string;
  raw: unknown;
}

export interface CrossChainPayment {
  /** OpenSea chain name the payer funds from, e.g. "robinhood". */
  chain: string;
  /** Payment token contract; zero address = native token. */
  tokenAddress: string;
}

export interface CrossChainMintRequest {
  /** Wallet paying on the payment chain. */
  payer: string;
  /** Wallet receiving the minted tokens. */
  minter: string;
  quantity: number;
  payment: CrossChainPayment;
}

/** One ordered transaction leg of a cross-chain mint. */
export interface CrossChainTransaction extends MintTransaction {
  /** Chain this leg must be submitted on (defaults to payment chain). */
  chain?: string;
}

export interface CrossChainMint {
  /** Ordered legs — sign and submit each in sequence. */
  transactions: CrossChainTransaction[];
  /** Opaque handle passed to POST /transactions/receipt. */
  receiptRequest?: unknown;
  raw: unknown;
}

export interface TransactionReceiptStatus {
  status: string;
  terminal: boolean;
  raw: unknown;
}

export interface StageEligibility {
  stage_uuid?: string;
  is_eligible: boolean;
  price?: string;
  remaining?: number;
  max_per_wallet?: number;
  minted_in_stage?: number;
  [k: string]: unknown;
}

export interface EligibilityResponse {
  stages: StageEligibility[];
}

function pick<T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}

/**
 * Normalize the mint-transaction response. The API has shipped both
 * {target, calldata} and {to, data} shapes; accept either.
 */
export function normalizeMintTransaction(raw: unknown): MintTransaction {
  const r = (raw ?? {}) as Record<string, unknown>;
  const to = pick<string>(r, "to", "target", "contract_address");
  const data = pick<string>(r, "data", "calldata", "input");
  const value = pick<string | number>(r, "value", "mint_value") ?? "0";
  if (!to || !data) {
    throw new Error(
      `Malformed mint transaction response: missing to/data (keys: ${Object.keys(r).join(",")})`,
    );
  }
  const chainId = pick<number | string>(r, "chain_id", "chainId");
  const gasLimit = pick<string | number>(r, "gas_limit", "gasLimit", "estimated_gas");
  return {
    to,
    data,
    value: String(value),
    ...(chainId !== undefined ? { chainId: Number(chainId) } : {}),
    ...(gasLimit !== undefined ? { gasLimit: String(gasLimit) } : {}),
    raw,
  };
}

/**
 * Normalize POST /drops/{slug}/cross_chain_mint. Each leg reuses the
 * mint-transaction shape plus an optional per-leg chain override.
 */
export function normalizeCrossChainMint(raw: unknown): CrossChainMint {
  const r = (raw ?? {}) as Record<string, unknown>;
  const legs = pick<unknown[]>(r, "transactions", "txs", "steps") ?? [];
  if (!legs.length) {
    throw new Error(
      `Malformed cross-chain mint response: no transactions (keys: ${Object.keys(r).join(",")})`,
    );
  }
  const transactions = legs.map((leg) => {
    const tx = normalizeMintTransaction(leg);
    const chain = pick<string>(
      (leg ?? {}) as Record<string, unknown>,
      "chain",
      "chain_name",
      "chainName",
    );
    return chain ? { ...tx, chain } : tx;
  });
  const receiptRequest = pick<unknown>(r, "receipt_request", "receiptRequest");
  return {
    transactions,
    ...(receiptRequest !== undefined ? { receiptRequest } : {}),
    raw,
  };
}

const TERMINAL_RECEIPT_STATUSES = new Set([
  "confirmed",
  "complete",
  "completed",
  "success",
  "succeeded",
  "failed",
  "failure",
  "reverted",
  "cancelled",
  "canceled",
  "expired",
]);

const SUCCESS_RECEIPT_STATUSES = new Set([
  "confirmed",
  "complete",
  "completed",
  "success",
  "succeeded",
]);

export function receiptSucceeded(status: string): boolean {
  return SUCCESS_RECEIPT_STATUSES.has(status.toLowerCase());
}

/** Normalize POST /transactions/receipt poll responses. */
export function normalizeReceiptStatus(raw: unknown): TransactionReceiptStatus {
  const r = (raw ?? {}) as Record<string, unknown>;
  const status = String(
    pick<string>(r, "status", "state") ?? "unknown",
  ).toLowerCase();
  return { status, terminal: TERMINAL_RECEIPT_STATUSES.has(status), raw };
}

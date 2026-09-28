import { Agent, request } from "undici";
import { nullLogger, type Logger } from "@aco/config";
import { OpenSeaApiError, extractApiErrors } from "./errors";
import { TokenBucket, type Priority } from "./rate-limiter";
import {
  normalizeCollection,
  normalizeCollectionStats,
  normalizeCrossChainMint,
  normalizeMintTransaction,
  normalizeReceiptStatus,
  type CollectionInfo,
  type CollectionStats,
  type CrossChainMint,
  type CrossChainMintRequest,
  type Drop,
  type EligibilityResponse,
  type MintTransaction,
  type MintTransactionRequest,
  type TransactionReceiptStatus,
} from "./types";

export type HttpMethod = "GET" | "POST";

export interface RequestMetric {
  method: HttpMethod;
  path: string;
  status: number;
  latencyMs: number;
}

export interface OpenSeaClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Max requests per second (token bucket). Default 4. */
  rps?: number;
  timeoutMs?: number;
  /** Retries for retryable failures (429/5xx/network). Default 3. */
  maxRetries?: number;
  onResponse?: (m: RequestMetric) => void;
  logger?: Logger;
  /**
   * Resolve a wallet-auth JWT for a named wallet (SIWE). Required for
   * wallet-scoped endpoints like eligibility — without it they 401.
   */
  getWalletToken?: (wallet: string) => Promise<string | undefined>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => ms * (0.5 + Math.random());

/**
 * Thin, rate-limited client over the official OpenSea v2 Drops endpoints.
 * Uses a persistent undici Agent (HTTP keep-alive) to avoid TCP/TLS
 * handshakes on the critical path.
 */
export class OpenSeaClient {
  private readonly baseUrl: string;
  private readonly agent: Agent;
  private readonly bucket: TokenBucket;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly logger: Logger;
  private readonly onResponse?: (m: RequestMetric) => void;

  constructor(private readonly opts: OpenSeaClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.opensea.io").replace(/\/$/, "");
    this.agent = new Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: 16,
    });
    const rps = opts.rps ?? 4;
    this.bucket = new TokenBucket(rps, rps);
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.logger = opts.logger ?? nullLogger;
    this.onResponse = opts.onResponse;
  }

  /** GET /api/v2/drops/{slug} — stages, supply, is_minting. */
  async getDrop(slug: string): Promise<Drop> {
    return this.call<Drop>(
      "GET",
      `/api/v2/drops/${encodeURIComponent(slug)}`,
      undefined,
      undefined,
      "low",
    );
  }

  /** GET /api/v2/drops — discovery. */
  async listDrops(): Promise<Drop[]> {
    const res = await this.call<Drop[] | { drops: Drop[] }>(
      "GET",
      "/api/v2/drops",
      undefined,
      undefined,
      "low",
    );
    return Array.isArray(res) ? res : res.drops ?? [];
  }

  /**
   * GET /api/v2/collections/{slug} — collection metadata (image, name,
   * description). Used to enrich discovery results; returns null when the
   * collection can't be fetched so callers degrade gracefully.
   */
  async getCollection(slug: string): Promise<CollectionInfo | null> {
    try {
      const res = await this.call<unknown>(
        "GET",
        `/api/v2/collections/${encodeURIComponent(slug)}`,
        undefined,
        undefined,
        "low",
      );
      return normalizeCollection(res);
    } catch {
      return null;
    }
  }

  /**
   * GET /api/v2/collections — ranked collection listing (trending, newest,
   * market cap…). Paginated via the `next` cursor.
   */
  async listCollections(opts: {
    orderBy?: string;
    chain?: string;
    limit?: number;
    next?: string;
  } = {}): Promise<{ collections: CollectionInfo[]; next?: string }> {
    const qs = new URLSearchParams();
    if (opts.orderBy) qs.set("order_by", opts.orderBy);
    if (opts.chain) qs.set("chain", opts.chain);
    qs.set("limit", String(opts.limit ?? 24));
    if (opts.next) qs.set("next", opts.next);
    const res = await this.call<{ collections?: unknown[]; next?: unknown }>(
      "GET",
      `/api/v2/collections?${qs.toString()}`,
      undefined,
      undefined,
      "low",
    );
    const collections = (res.collections ?? [])
      .map(normalizeCollection)
      .filter((c): c is CollectionInfo => c !== null);
    return {
      collections,
      ...(typeof res.next === "string" && res.next ? { next: res.next } : {}),
    };
  }

  /**
   * GET /api/v2/search?query=… — OpenSea's name search. Returns typed
   * results ({type:"collection"|"token", …}); we keep only collections
   * and normalize them. Resolves names that slug-guessing never would
   * ("urchin friends" -> urchin-frens).
   */
  async search(query: string): Promise<CollectionInfo[]> {
    const qs = new URLSearchParams({ query });
    const res = await this.call<{ results?: unknown[] }>(
      "GET",
      `/api/v2/search?${qs.toString()}`,
      undefined,
      undefined,
      "low",
    );
    const out: CollectionInfo[] = [];
    const seen = new Set<string>();
    for (const r of res.results ?? []) {
      const item = r as { type?: string; collection?: unknown };
      if (item.type !== "collection") continue;
      const col = normalizeCollection(item.collection);
      if (col && !seen.has(col.slug)) {
        seen.add(col.slug);
        out.push(col);
      }
    }
    return out;
  }

  /**
   * GET /api/v2/collections/{slug}/stats — floor, owners, per-interval
   * volume & sales (one_day / seven_day / thirty_day). Returns null on
   * failure so board-style callers degrade gracefully.
   */
  async getCollectionStats(slug: string): Promise<CollectionStats | null> {
    try {
      const res = await this.call<unknown>(
        "GET",
        `/api/v2/collections/${encodeURIComponent(slug)}/stats`,
        undefined,
        undefined,
        "low",
      );
      return normalizeCollectionStats(res);
    } catch {
      return null;
    }
  }

  /**
   * Collection floor price in wei (native), for the floor guard. Returns
   * undefined when the stats endpoint has no floor for the collection.
   */
  async getFloorPriceWei(slug: string): Promise<bigint | undefined> {
    try {
      const res = await this.call<{
        total?: { floor_price?: number; floor_price_symbol?: string };
      }>("GET", `/api/v2/collections/${encodeURIComponent(slug)}/stats`);
      const fp = res?.total?.floor_price;
      if (fp === undefined || fp === null) return undefined;
      // floor_price is in native units (ETH) — convert to wei.
      return BigInt(Math.round(fp * 1e18));
    } catch {
      return undefined;
    }
  }

  /**
   * GET /api/v2/drops/{slug}/eligibility — per-stage eligibility for the
   * authenticated wallet. `wallet` names the signer whose SIWE JWT is sent
   * as Authorization: Bearer. Returns null when the wallet can't
   * authenticate or the endpoint 401/403/404s, so callers degrade gracefully.
   */
  async getEligibility(
    slug: string,
    wallet?: string,
  ): Promise<EligibilityResponse | null> {
    try {
      const token =
        wallet && this.opts.getWalletToken
          ? await this.opts.getWalletToken(wallet)
          : undefined;
      if (!token) return null;
      return await this.call<EligibilityResponse>(
        "GET",
        `/api/v2/drops/${encodeURIComponent(slug)}/eligibility`,
        undefined,
        { authorization: `Bearer ${token}` },
        "high",
      );
    } catch (err) {
      if (
        err instanceof OpenSeaApiError &&
        (err.status === 401 || err.status === 403 || err.status === 404)
      ) {
        this.logger.debug(
          { slug, status: err.status },
          "eligibility endpoint unavailable with current auth",
        );
        return null;
      }
      throw err;
    }
  }

  /**
   * POST /api/v2/drops/{slug}/mint — build ready-to-sign mint calldata.
   * Throws OpenSeaApiError 409 when the drop is not active and 422 when a
   * precondition fails (allowlist, per-wallet limit, supply).
   */
  async buildMintTransaction(
    slug: string,
    req: MintTransactionRequest,
  ): Promise<MintTransaction> {
    const raw = await this.call<unknown>(
      "POST",
      `/api/v2/drops/${encodeURIComponent(slug)}/mint`,
      req,
      undefined,
      "high",
    );
    return normalizeMintTransaction(raw);
  }

  /**
   * POST /api/v2/drops/{slug}/cross_chain_mint — build the ordered
   * transaction list for paying on one chain and minting on another.
   * Same error semantics as /mint (409 inactive, 422 precondition).
   */
  async buildCrossChainMintTransaction(
    slug: string,
    req: CrossChainMintRequest,
  ): Promise<CrossChainMint> {
    const raw = await this.call<unknown>(
      "POST",
      `/api/v2/drops/${encodeURIComponent(slug)}/cross_chain_mint`,
      req,
      undefined,
      "high",
    );
    return normalizeCrossChainMint(raw);
  }

  /**
   * POST /api/v2/transactions/receipt — poll a cross-chain mint to a
   * terminal status using the receipt_request returned at build time.
   */
  async getTransactionReceipt(
    receiptRequest: unknown,
  ): Promise<TransactionReceiptStatus> {
    const raw = await this.call<unknown>(
      "POST",
      "/api/v2/transactions/receipt",
      receiptRequest,
      undefined,
      "high",
    );
    return normalizeReceiptStatus(raw);
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  private async call<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    priority: Priority = "normal",
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await this.bucket.take(priority);
      const started = performance.now();
      try {
        const res = await request(`${this.baseUrl}${path}`, {
          method,
          dispatcher: this.agent,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": this.opts.apiKey,
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          headersTimeout: this.timeoutMs,
          bodyTimeout: this.timeoutMs,
        });
        const latencyMs = performance.now() - started;
        const text = await res.body.text();
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = text;
        }
        this.onResponse?.({ method, path, status: res.statusCode, latencyMs });

        if (res.statusCode >= 200 && res.statusCode < 300) {
          return parsed as T;
        }
        const detail = extractApiErrors(parsed);
        const err = new OpenSeaApiError(res.statusCode, path, parsed, detail);
        if (!err.retryable || attempt === this.maxRetries) throw err;

        const retryAfter = Number(res.headers["retry-after"]);
        const backoff = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : Math.min(250 * 2 ** (attempt - 1), 5_000);
        this.logger.warn(
          { path, status: res.statusCode, attempt, backoff },
          "retryable OpenSea API error",
        );
        await sleep(jitter(backoff));
        lastErr = err;
      } catch (err) {
        if (err instanceof OpenSeaApiError) throw err;
        // Network/timeout error — retryable.
        this.onResponse?.({
          method,
          path,
          status: 0,
          latencyMs: performance.now() - started,
        });
        lastErr = err;
        if (attempt === this.maxRetries) break;
        const backoff = Math.min(250 * 2 ** (attempt - 1), 5_000);
        this.logger.warn({ path, attempt, err }, "OpenSea request failed, retrying");
        await sleep(jitter(backoff));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

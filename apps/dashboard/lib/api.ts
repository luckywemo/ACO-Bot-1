// Same-origin by default — next.config.mjs rewrites /api/* to the bot's
// API server, so the browser never talks to :4000 directly. Set
// NEXT_PUBLIC_ACO_API_URL to point at a remote API instead.
const API = process.env.NEXT_PUBLIC_ACO_API_URL ?? "";

export interface BotStatus {
  uptime_ms: number;
  dry_run: boolean;
  kill_switch: boolean;
  signer_configured: boolean;
  wallet?: string;
  wallets?: string[];
  strategies: number;
  monitored: {
    collection: string;
    chain: string;
    wallet?: string;
    auto_mint: boolean;
    paused: boolean;
  }[];
}

export interface DropSnapshotDto {
  slug: string;
  chain: string;
  name?: string;
  status: "live" | "scheduled" | "ended" | "unknown";
  isMinting: boolean;
  activeStage?: { type: string; label?: string; priceWei: string };
  nextStage?: { type: string; label?: string; startTime?: number };
  msUntilNextStage?: number;
  fetchedAt: number;
}

export interface AttemptDto {
  id: string;
  collection: string;
  chain: string;
  status: string;
  reason?: string;
  txHash?: string;
  quantity: number;
  priceWei: string;
  latencies?: Record<string, number>;
  createdAt: number;
}

export interface LatencyMetrics {
  attempts: {
    count: number;
    avg: Record<string, number>;
    p95: Record<string, number>;
  };
  opensea_api: { count: number; avg_ms?: number; p95_ms?: number };
}

export interface StrategyDto {
  collection: string;
  chain: string;
  quantity: number;
  max_price: string;
  auto_mint: boolean;
  payment_chain?: string;
  conditions: Record<string, unknown>;
}

export interface StageEligibilityDto {
  stage_uuid?: string;
  is_eligible: boolean;
  price?: string;
  remaining?: number;
  max_per_wallet?: number;
  minted_in_stage?: number;
}

export interface EligibilityDto {
  collection: string;
  /** Wallet the eligibility was evaluated for. */
  address?: string;
  /** null when the API key lacks wallet auth for the eligibility endpoint. */
  stages: StageEligibilityDto[] | null;
  reason?: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} -> ${res.status} ${text}`.trim());
  }
  return res.json() as Promise<T>;
}

export const api = {
  status: () => get<BotStatus>("/api/status"),
  strategies: () => get<StrategyDto[]>("/api/strategies"),
  drops: () => get<DropSnapshotDto[]>("/api/drops"),
  attempts: () => get<AttemptDto[]>("/api/attempts?limit=50"),
  latency: () => get<LatencyMetrics>("/api/metrics/latency"),
  eligibility: (collection: string) =>
    get<EligibilityDto>(`/api/eligibility/${encodeURIComponent(collection)}`),
  trigger: (collection: string) =>
    post<AttemptDto>("/api/mint/trigger", { collection }),
  kill: () => post<{ kill_switch: boolean }>("/api/kill"),
  releaseKill: () => post<{ kill_switch: boolean }>("/api/kill/release"),
  pause: (collection: string) =>
    post(`/api/monitor/${encodeURIComponent(collection)}/pause`),
  resume: (collection: string) =>
    post(`/api/monitor/${encodeURIComponent(collection)}/resume`),
};

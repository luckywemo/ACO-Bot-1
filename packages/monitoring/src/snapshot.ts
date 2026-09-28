import type { Drop, DropStage } from "@aco/opensea";

export interface NormalizedStage {
  uuid?: string;
  /** Lowercased stage_type, e.g. "public_sale", "allowlist". */
  type: string;
  label?: string;
  /** Per-token price in wei. */
  priceWei: bigint;
  currencyAddress?: string;
  startTime?: number;
  endTime?: number;
  maxPerWallet?: number;
  /** Wallets whitelisted/allocated to this stage (absent = open to all). */
  allowlistWalletCount?: number;
  /** Stage-wide mint cap, if the drop sets one. */
  maxPerStage?: number;
  raw: DropStage;
}

export type DropStatus = "live" | "scheduled" | "ended" | "unknown";

export interface DropSnapshot {
  slug: string;
  chain: string;
  name?: string;
  contractAddress?: string;
  isMinting: boolean;
  status: DropStatus;
  activeStage?: NormalizedStage;
  nextStage?: NormalizedStage;
  stages: NormalizedStage[];
  /** ms until nextStage.startTime when status === "scheduled". */
  msUntilNextStage?: number;
  totalSupply?: number;
  maxSupply?: number;
  fetchedAt: number;
  raw: Drop;
}

const PUBLIC_TYPES = new Set([
  "public",
  "public_sale",
  "publicsale",
  "open",
  "open_edition",
]);

export function isPublicStage(stage: NormalizedStage): boolean {
  if (PUBLIC_TYPES.has(stage.type)) return true;
  return (stage.label ?? "").toLowerCase().includes("public");
}

function toMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

function toInt(v: number | string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function normalizeStage(s: DropStage): NormalizedStage {
  const priceWei = (() => {
    try {
      return BigInt(s.price ?? "0");
    } catch {
      return 0n;
    }
  })();
  return {
    ...(s.uuid !== undefined ? { uuid: s.uuid } : {}),
    type: (s.stage_type ?? "unknown").toLowerCase(),
    ...(s.label !== undefined ? { label: s.label } : {}),
    priceWei,
    ...(s.price_currency_address !== undefined
      ? { currencyAddress: s.price_currency_address }
      : {}),
    ...(toMs(s.start_time) !== undefined ? { startTime: toMs(s.start_time) } : {}),
    ...(toMs(s.end_time) !== undefined ? { endTime: toMs(s.end_time) } : {}),
    ...(toInt(s.max_per_wallet ?? s.maxPerWallet ?? s.limit_per_wallet) !==
    undefined
      ? {
          maxPerWallet: toInt(
            s.max_per_wallet ?? s.maxPerWallet ?? s.limit_per_wallet,
          ),
        }
      : {}),
    ...(toInt(s.allowlist_wallet_count) !== undefined
      ? { allowlistWalletCount: toInt(s.allowlist_wallet_count) }
      : {}),
    ...(toInt(s.max_per_stage) !== undefined
      ? { maxPerStage: toInt(s.max_per_stage) }
      : {}),
    raw: s,
  };
}

/**
 * Pure drop-state evaluation — the core of mint-stage detection.
 * Deterministic given (drop, now); unit-tested directly.
 */
export function snapshotFromDrop(drop: Drop, now = Date.now()): DropSnapshot {
  const stages = (drop.stages ?? []).map(normalizeStage);
  const activeStage = drop.active_stage
    ? normalizeStage(drop.active_stage)
    : undefined;
  // The API often omits next_stage while a stage is live — fall back to
  // the soonest upcoming entry in stages[] so transitions still ramp.
  const nextStage = drop.next_stage
    ? normalizeStage(drop.next_stage)
    : stages
        .filter(
          (s) =>
            s.startTime !== undefined &&
            s.startTime > now &&
            s.uuid !== activeStage?.uuid,
        )
        .sort((a, b) => a.startTime! - b.startTime!)[0];

  let status: DropStatus;
  let msUntilNextStage: number | undefined;

  if (drop.is_minting && activeStage) {
    status = "live";
    // A later stage (e.g. public after allowlist) can still be pending —
    // expose its countdown so the monitor ramps toward the transition.
    if (nextStage?.startTime !== undefined) {
      msUntilNextStage = nextStage.startTime - now;
    }
  } else if (nextStage?.startTime !== undefined && nextStage.startTime > now) {
    status = "scheduled";
    msUntilNextStage = nextStage.startTime - now;
  } else if (nextStage) {
    // Start time passed but API hasn't flipped is_minting yet — imminent.
    status = "scheduled";
    msUntilNextStage = 0;
  } else if (
    stages.length > 0 &&
    stages.every((s) => s.endTime !== undefined && s.endTime < now)
  ) {
    status = "ended";
  } else {
    status = "unknown";
  }

  return {
    slug: drop.collection_slug,
    chain: drop.chain,
    ...(drop.collection_name !== undefined
      ? { name: drop.collection_name }
      : {}),
    ...(drop.contract_address !== undefined
      ? { contractAddress: drop.contract_address }
      : {}),
    isMinting: drop.is_minting,
    status,
    ...(activeStage !== undefined ? { activeStage } : {}),
    ...(nextStage !== undefined ? { nextStage } : {}),
    stages,
    ...(msUntilNextStage !== undefined ? { msUntilNextStage } : {}),
    ...(toInt(drop.total_supply) !== undefined
      ? { totalSupply: toInt(drop.total_supply) }
      : {}),
    ...(toInt(drop.max_supply) !== undefined
      ? { maxSupply: toInt(drop.max_supply) }
      : {}),
    fetchedAt: now,
    raw: drop,
  };
}

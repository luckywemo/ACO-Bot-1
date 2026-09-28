import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AttemptStatus =
  | "detected"
  | "skipped"
  | "dry_run"
  | "pending"
  | "confirmed"
  | "failed"
  | "unknown";

/** Terminal states — no further transitions expected. */
export const TERMINAL_STATUSES: ReadonlySet<AttemptStatus> = new Set([
  "skipped",
  "dry_run",
  "confirmed",
  "failed",
]);

export interface ExecutionTrace {
  event_detected_at?: number;
  validation_started_at?: number;
  validation_completed_at?: number;
  transaction_requested_at?: number;
  transaction_received_at?: number;
  simulation_completed_at?: number;
  sign_started_at?: number;
  signed_at?: number;
  broadcast_started_at?: number;
  broadcast_completed_at?: number;
  confirmation_received_at?: number;
}

export interface LatencyBreakdown {
  detection_ms?: number;
  validation_ms?: number;
  tx_build_ms?: number;
  simulation_ms?: number;
  signing_ms?: number;
  broadcast_ms?: number;
  confirmation_ms?: number;
  total_ms?: number;
}

export interface MintAttempt {
  id: string;
  collection: string;
  chain: string;
  wallet?: string;
  quantity: number;
  priceWei: string;
  status: AttemptStatus;
  reason?: string;
  txHash?: string;
  blockNumber?: number;
  error?: string;
  trace: ExecutionTrace;
  latencies?: LatencyBreakdown;
  createdAt: number;
  updatedAt: number;
}

export interface LatencyStats {
  count: number;
  avg: LatencyBreakdown;
  p95: LatencyBreakdown;
}

/**
 * Persistence abstraction. Phase 1 ships an in-memory implementation;
 * PostgresAttemptStore (schema.sql) plugs in behind the same interface
 * without touching the executor.
 */
export interface AttemptStore {
  create(
    a: Omit<MintAttempt, "id" | "createdAt" | "updatedAt">,
  ): MintAttempt;
  update(id: string, patch: Partial<MintAttempt>): void;
  get(id: string): MintAttempt | undefined;
  list(limit?: number): MintAttempt[];
  /**
   * Broadcast-but-unconfirmed attempts for a collection+wallet (duplicate
   * guard). Only "pending"/"unknown" count — a tx was sent and the outcome
   * is uncertain, so resubmitting could double-mint. A "detected" attempt
   * never broadcast, so it must NOT block (counting it makes every
   * execution self-block on its own freshly-created row).
   */
  hasActiveAttempt(collection: string, wallet?: string): boolean;
  /** A confirmed/dry-run success exists for this collection+wallet. */
  hasSuccessful(collection: string, wallet?: string): boolean;
  /** Sum of confirmed/pending spend in the last `windowMs`. */
  spendSince(sinceMs: number): bigint;
  latencyStats(): LatencyStats;
}

export class InMemoryAttemptStore implements AttemptStore {
  protected readonly attempts = new Map<string, MintAttempt>();
  protected order: string[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 5_000) {
    this.maxEntries = maxEntries;
  }

  /** Hook for persistent subclasses — called after every mutation. */
  protected onChange(): void {}

  /** Attempts in insertion order (oldest first) — for persistence. */
  protected snapshot(): MintAttempt[] {
    const out: MintAttempt[] = [];
    for (const id of this.order) {
      const a = this.attempts.get(id);
      if (a) out.push(a);
    }
    return out;
  }

  /** Repopulate from a persisted list (persistent subclasses). */
  protected restoreAll(list: MintAttempt[]): void {
    this.attempts.clear();
    this.order = [];
    for (const a of list) {
      if (!a || !a.id) continue;
      this.attempts.set(a.id, a);
      this.order.push(a.id);
    }
    while (this.order.length > this.maxEntries) {
      const evict = this.order.shift();
      if (evict) this.attempts.delete(evict);
    }
  }

  create(a: Omit<MintAttempt, "id" | "createdAt" | "updatedAt">): MintAttempt {
    const now = Date.now();
    const attempt: MintAttempt = { ...a, id: randomUUID(), createdAt: now, updatedAt: now };
    this.attempts.set(attempt.id, attempt);
    this.order.push(attempt.id);
    while (this.order.length > this.maxEntries) {
      const evict = this.order.shift();
      if (evict) this.attempts.delete(evict);
    }
    this.onChange();
    return attempt;
  }

  update(id: string, patch: Partial<MintAttempt>): void {
    const a = this.attempts.get(id);
    if (!a) return;
    Object.assign(a, patch, { updatedAt: Date.now() });
    this.onChange();
  }

  get(id: string): MintAttempt | undefined {
    return this.attempts.get(id);
  }

  list(limit = 100): MintAttempt[] {
    const out: MintAttempt[] = [];
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const a = this.attempts.get(this.order[i]!);
      if (a) out.push(a);
    }
    return out;
  }

  hasActiveAttempt(collection: string, wallet?: string): boolean {
    const w = wallet?.toLowerCase();
    for (const a of this.attempts.values()) {
      if (a.collection !== collection) continue;
      if (w !== undefined && a.wallet?.toLowerCase() !== w) continue;
      // Only a broadcast-but-unconfirmed attempt blocks resubmission.
      if (a.status === "pending" || a.status === "unknown") return true;
    }
    return false;
  }

  hasSuccessful(collection: string, wallet?: string): boolean {
    const w = wallet?.toLowerCase();
    for (const a of this.attempts.values()) {
      if (a.collection !== collection) continue;
      if (w !== undefined && a.wallet?.toLowerCase() !== w) continue;
      if (a.status === "confirmed" || a.status === "dry_run") return true;
    }
    return false;
  }

  spendSince(sinceMs: number): bigint {
    let total = 0n;
    for (const a of this.attempts.values()) {
      if (a.createdAt < sinceMs) continue;
      if (a.status !== "confirmed" && a.status !== "pending") continue;
      try {
        total += BigInt(a.priceWei) * BigInt(a.quantity);
      } catch {
        // ignore malformed rows
      }
    }
    return total;
  }

  latencyStats(): LatencyStats {
    const keys: (keyof LatencyBreakdown)[] = [
      "detection_ms",
      "validation_ms",
      "tx_build_ms",
      "simulation_ms",
      "signing_ms",
      "broadcast_ms",
      "confirmation_ms",
      "total_ms",
    ];
    const samples = this.list(this.maxEntries).filter((a) => a.latencies);
    const avg: LatencyBreakdown = {};
    const p95: LatencyBreakdown = {};
    for (const k of keys) {
      const vals = samples
        .map((a) => a.latencies?.[k])
        .filter((v): v is number => typeof v === "number")
        .sort((x, y) => x - y);
      if (!vals.length) continue;
      avg[k] = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
      p95[k] = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))];
    }
    return { count: samples.length, avg, p95 };
  }
}

/**
 * File-backed AttemptStore — persists attempts to a JSON file so history
 * and stop_after_success state survive restarts. Writes are synchronous
 * and atomic-ish (write whole file); volume is low (one row per attempt).
 */
export class JsonAttemptStore extends InMemoryAttemptStore {
  constructor(
    private readonly path: string,
    maxEntries = 5_000,
  ) {
    super(maxEntries);
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        const list = Array.isArray(raw) ? raw : (raw?.attempts ?? []);
        this.restoreAll(list as MintAttempt[]);
      } catch {
        // Corrupt file — start empty rather than crash the bot.
      }
    }
  }

  protected override onChange(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.snapshot(), null, 2));
    } catch {
      // Persistence is best-effort — never let a write failure break a mint.
    }
  }
}

import { EventEmitter } from "node:events";
import { nullLogger, type Logger, type Strategy } from "@aco/config";
import type { OpenSeaClient } from "@aco/opensea";
import {
  snapshotFromDrop,
  type DropSnapshot,
  type DropStatus,
} from "./snapshot";

export interface MintLiveEvent {
  strategy: Strategy;
  snapshot: DropSnapshot;
  /** Timestamp taken the moment the live stage was observed. */
  detectedAt: number;
}

export interface PollSchedule {
  /** Poll interval while a mint is live. */
  liveMs: number;
  /** Poll interval when nothing is scheduled. */
  idleMs: number;
  /** Countdown ramp: tighter polling as a stage start approaches. */
  ramp: { belowMs: number; intervalMs: number }[];
  /** If the expected start passed this long ago and still not live, back off. */
  staleAfterMs: number;
}

export const DEFAULT_SCHEDULE: PollSchedule = {
  liveMs: 2_000,
  idleMs: 30_000,
  ramp: [
    { belowMs: 3_000, intervalMs: 250 },
    { belowMs: 15_000, intervalMs: 1_000 },
    { belowMs: 60_000, intervalMs: 5_000 },
  ],
  staleAfterMs: 120_000,
};

/** Key identifying one client strategy on a collection. */
const strategyKey = (collection: string, wallet: string) =>
  `${collection}::${wallet}`;

interface MonitorEvents {
  /** Every successful poll, for dashboards/caches. */
  snapshot: (snap: DropSnapshot) => void;
  /** Transition into a live mint stage (or stage change while live). */
  "mint:live": (e: MintLiveEvent) => void;
  "stage:changed": (snap: DropSnapshot) => void;
  error: (err: unknown, slug: string) => void;
}

/**
 * Per-strategy adaptive poller. Polls slowly while idle, ramps up as a
 * stage start approaches, and polls quickly while live. All requests go
 * through the shared OpenSeaClient token bucket, so global rps limits
 * are always respected.
 */
export class DropMonitor extends EventEmitter {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastStatus = new Map<string, DropStatus>();
  private readonly lastStageKey = new Map<string, string | undefined>();
  private readonly paused = new Set<string>();
  /** (collection::wallet) clients finished via stop_after_success. */
  private readonly done = new Set<string>();
  /**
   * slug -> open throttle refs. While >0 the poll interval is floored at
   * throttleMinMs — an armed/in-flight snipe is the probe for the stage
   * open, so fast background polling just burns the shared rate budget
   * (and starves the hot path) at the worst possible moment.
   */
  private readonly throttled = new Map<string, number>();
  private static readonly THROTTLE_MIN_MS = 2_000;
  private running = false;

  constructor(
    private readonly deps: {
      client: Pick<OpenSeaClient, "getDrop">;
      strategies: Strategy[];
      schedule?: Partial<PollSchedule>;
      logger?: Logger;
    },
  ) {
    super();
    this.schedule = { ...DEFAULT_SCHEDULE, ...(deps.schedule ?? {}) };
    this.logger = deps.logger ?? nullLogger;
  }

  private readonly schedule: PollSchedule;
  private readonly logger: Logger;

  override on<K extends keyof MonitorEvents>(
    event: K,
    listener: MonitorEvents[K],
  ): this {
    return super.on(event, listener);
  }
  override emit<K extends keyof MonitorEvents>(
    event: K,
    ...args: Parameters<MonitorEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  private collections(): string[] {
    return [...new Set(this.deps.strategies.map((s) => s.collection))];
  }

  private strategiesFor(collection: string): Strategy[] {
    return this.deps.strategies.filter((s) => s.collection === collection);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const collection of this.collections()) {
      if (this.paused.has(collection)) continue;
      void this.poll(collection);
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Stop polling a collection (e.g. after stop_after_success). */
  pause(slug: string): void {
    this.paused.add(slug);
    const t = this.timers.get(slug);
    if (t) clearTimeout(t);
    this.timers.delete(slug);
  }

  resume(slug: string): void {
    this.paused.delete(slug);
    if (!this.running) return;
    if (this.strategiesFor(slug).length) void this.poll(slug);
  }

  isPaused(slug: string): boolean {
    return this.paused.has(slug);
  }

  /**
   * Clamp this collection's poll interval to THROTTLE_MIN_MS while a
   * snipe covers it. Reference-counted — one call per armed snipe, one
   * unthrottle when it finishes.
   */
  throttle(slug: string): void {
    this.throttled.set(slug, (this.throttled.get(slug) ?? 0) + 1);
  }

  unthrottle(slug: string): void {
    const n = (this.throttled.get(slug) ?? 0) - 1;
    if (n <= 0) this.throttled.delete(slug);
    else this.throttled.set(slug, n);
  }

  /**
   * Mark a (collection, wallet) client done — stop_after_success. The
   * collection keeps polling while other clients on it are still active;
   * it pauses only once every client is done.
   */
  markDone(collection: string, wallet: string): void {
    this.done.add(strategyKey(collection, wallet));
    const rest = this.strategiesFor(collection);
    if (
      rest.length &&
      rest.every((s) => this.done.has(strategyKey(s.collection, s.wallet)))
    ) {
      this.pause(collection);
    }
  }

  isDone(collection: string, wallet: string): boolean {
    return this.done.has(strategyKey(collection, wallet));
  }

  /** Clear the done flag — e.g. when a client is re-armed or removed. */
  clearDone(collection: string, wallet: string): void {
    this.done.delete(strategyKey(collection, wallet));
  }

  private async poll(collection: string): Promise<void> {
    if (!this.running || this.paused.has(collection)) return;
    const strategies = this.strategiesFor(collection);
    if (!strategies.length) return;
    let delay = this.schedule.idleMs;
    try {
      const drop = await this.deps.client.getDrop(collection);
      const snap = snapshotFromDrop(drop);
      this.handleSnapshot(strategies, snap);
      delay = this.nextDelay(strategies, snap);
    } catch (err) {
      this.emit("error", err, collection);
      delay = Math.min(this.schedule.idleMs, 10_000);
    }
    if (this.throttled.has(collection)) {
      delay = Math.max(delay, DropMonitor.THROTTLE_MIN_MS);
    }
    if (!this.running || this.paused.has(collection)) return;
    this.timers.set(
      collection,
      setTimeout(() => void this.poll(collection), delay),
    );
  }

  private handleSnapshot(strategies: Strategy[], snap: DropSnapshot): void {
    this.emit("snapshot", snap);

    const prevStatus = this.lastStatus.get(snap.slug);
    const stageKey = snap.activeStage?.uuid ?? snap.activeStage?.type;
    const prevStageKey = this.lastStageKey.get(snap.slug);

    if (snap.status === "live") {
      const becameLive = prevStatus !== "live";
      const stageChanged = stageKey !== undefined && stageKey !== prevStageKey;
      if (becameLive || stageChanged) {
        // One live transition fires mint:live for every client on the
        // drop that hasn't finished — each mints with its own wallet.
        for (const strategy of strategies) {
          if (this.done.has(strategyKey(strategy.collection, strategy.wallet))) {
            continue;
          }
          this.emit("mint:live", {
            strategy,
            snapshot: snap,
            detectedAt: Date.now(),
          });
        }
      }
      if (stageChanged && !becameLive) this.emit("stage:changed", snap);
    }

    this.lastStatus.set(snap.slug, snap.status);
    this.lastStageKey.set(snap.slug, stageKey);
  }

  /** Adaptive interval based on the latest snapshot. */
  nextDelay(strategies: Strategy[], snap: DropSnapshot): number {
    const s = this.schedule;
    // Poll at the fastest interval any client on this collection wants.
    const base = Math.min(
      ...strategies.map((st) => st.poll_interval_ms ?? s.idleMs),
    );
    if (snap.status === "live") {
      const until = snap.msUntilNextStage;
      if (until === undefined) return s.liveMs;
      // Stage transition pending (e.g. allowlist → public): ramp toward
      // it, never slower than liveMs.
      if (until <= 0) {
        return until < -s.staleAfterMs
          ? s.liveMs
          : Math.min(s.ramp[0]!.intervalMs, s.liveMs);
      }
      for (const tier of s.ramp) {
        if (until < tier.belowMs) return Math.min(tier.intervalMs, s.liveMs);
      }
      return s.liveMs;
    }

    if (snap.status === "scheduled") {
      const until = snap.msUntilNextStage ?? s.idleMs;
      if (until <= 0) {
        // Start time passed but is_minting hasn't flipped — poll fast,
        // but back off if the API stays stale.
        return until < -s.staleAfterMs ? s.idleMs : s.ramp[0]!.intervalMs;
      }
      for (const tier of s.ramp) {
        if (until < tier.belowMs) return tier.intervalMs;
      }
      return Math.min(base, Math.max(1_000, until / 4));
    }
    return base;
  }
}

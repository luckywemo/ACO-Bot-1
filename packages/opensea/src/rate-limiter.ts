const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Request priority — higher drains first when the bucket is contended. */
export type Priority = "high" | "normal" | "low";
const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

interface Waiter {
  priority: Priority;
  /** FIFO tiebreak within the same priority. */
  seq: number;
  wake: () => void;
}

/**
 * Token-bucket rate limiter with priority lanes. Guarantees the process
 * never exceeds the configured requests-per-second against the OpenSea
 * API — we comply with rate limits rather than work around them — but
 * when demand exceeds supply, mint-critical calls (build, eligibility)
 * drain ahead of background traffic (monitor polls, discovery) instead
 * of queueing behind it.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly waiters: Waiter[] = [];
  private seq = 0;
  private draining = false;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Wait until a token is available, then consume it. Uncontended calls
   * take a token immediately; queued calls wake in (priority, FIFO) order.
   */
  async take(priority: Priority = "normal"): Promise<void> {
    this.refill();
    if (this.tokens >= 1 && this.waiters.length === 0) {
      this.tokens -= 1;
      return;
    }
    // Even with a token spare, a queued caller must not jump waiters of
    // higher priority — enqueue, then the drain loop admits in order.
    await new Promise<void>((resolve) => {
      this.waiters.push({ priority, seq: this.seq++, wake: resolve });
      void this.drain();
    });
  }

  /**
   * Admit waiters in priority order as tokens refill. Runs as a self-
   * rescheduling loop until the queue empties — each waiter wakes to a
   * guaranteed token (decremented before waking), so no re-check is needed.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.waiters.length) {
        this.refill();
        if (this.tokens < 1) {
          const waitMs = ((1 - this.tokens) / this.refillPerSec) * 1000;
          await sleep(Math.max(5, waitMs));
          continue;
        }
        let best = 0;
        for (let i = 1; i < this.waiters.length; i++) {
          const w = this.waiters[i]!;
          const b = this.waiters[best]!;
          if (
            PRIORITY_RANK[w.priority] < PRIORITY_RANK[b.priority] ||
            (PRIORITY_RANK[w.priority] === PRIORITY_RANK[b.priority] &&
              w.seq < b.seq)
          ) {
            best = i;
          }
        }
        const [next] = this.waiters.splice(best, 1);
        this.tokens -= 1;
        next!.wake();
      }
    } finally {
      this.draining = false;
    }
  }

  private refill(): void {
    const now = Date.now();
    const dt = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
  }
}

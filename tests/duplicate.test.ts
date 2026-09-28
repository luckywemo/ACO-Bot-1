import { describe, expect, it } from "vitest";
import { InMemoryAttemptStore, type MintAttempt } from "@aco/database";
import { DuplicateGuard } from "@aco/executor";

const KEY = "base:cool-drop:0xaaa";
const WALLET = "0xAAA";

const make = (
  status: MintAttempt["status"],
  wallet: string = WALLET,
): Omit<MintAttempt, "id" | "createdAt" | "updatedAt"> => ({
  collection: "cool-drop",
  chain: "base",
  wallet,
  quantity: 1,
  priceWei: "0",
  status,
  trace: {},
});

describe("DuplicateGuard", () => {
  // Regression: the executor creates its attempt with status "detected"
  // BEFORE calling acquire(). If hasActiveAttempt counted that row, every
  // execution would self-block with duplicate_execution — which is exactly
  // the bug that silently skipped every mint.
  it("does not self-block on the attempt being executed (detected)", async () => {
    const store = new InMemoryAttemptStore();
    store.create(make("detected"));
    const guard = new DuplicateGuard(store);
    expect(await guard.acquire(KEY)).toBe(true);
  });

  it("blocks when a prior attempt already broadcast (pending)", async () => {
    const store = new InMemoryAttemptStore();
    store.create(make("pending"));
    const guard = new DuplicateGuard(store);
    expect(await guard.acquire(KEY)).toBe(false);
  });

  it("blocks when a prior attempt timed out unconfirmed (unknown)", async () => {
    const store = new InMemoryAttemptStore();
    store.create(make("unknown"));
    const guard = new DuplicateGuard(store);
    expect(await guard.acquire(KEY)).toBe(false);
  });

  it("does not block on terminal attempts (confirmed/failed/skipped)", async () => {
    for (const status of ["confirmed", "failed", "skipped", "dry_run"] as const) {
      const store = new InMemoryAttemptStore();
      store.create(make(status));
      const guard = new DuplicateGuard(store);
      expect(await guard.acquire(KEY)).toBe(true);
    }
  });

  it("a detected attempt for a different wallet does not block", async () => {
    const store = new InMemoryAttemptStore();
    store.create(make("detected", "0xBBB"));
    const guard = new DuplicateGuard(store);
    expect(await guard.acquire(KEY)).toBe(true);
  });

  it("holds the key while in-flight and releases it", async () => {
    const store = new InMemoryAttemptStore();
    const guard = new DuplicateGuard(store);
    expect(await guard.acquire(KEY)).toBe(true);
    // Second acquire while held -> duplicate.
    expect(await guard.acquire(KEY)).toBe(false);
    guard.release(KEY);
    expect(await guard.acquire(KEY)).toBe(true);
  });

  it("two concurrent acquires resolve to exactly one winner", async () => {
    const store = new InMemoryAttemptStore();
    const guard = new DuplicateGuard(store);
    const [a, b] = await Promise.all([guard.acquire(KEY), guard.acquire(KEY)]);
    expect([a, b].sort()).toEqual([false, true]);
  });
});

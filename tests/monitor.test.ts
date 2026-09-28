import { describe, expect, it, vi } from "vitest";
import type { Strategy } from "@aco/config";
import {
  DropMonitor,
  snapshotFromDrop,
  type MintLiveEvent,
} from "@aco/monitoring";
import type { Drop } from "@aco/opensea";

const strategy: Strategy = {
  collection: "cool-drop",
  chain: "base",
  quantity: 1,
  max_price: "0.05",
  auto_mint: true,
  wallet: "default",
  max_attempts: 3,
  conditions: {
    require_public_mint: true,
    stop_after_success: true,
    mint_max: false,
  },
};

const scheduledDrop: Drop = {
  collection_slug: "cool-drop",
  chain: "base",
  is_minting: false,
  next_stage: {
    stage_type: "public_sale",
    start_time: new Date(Date.now() + 600_000).toISOString(),
  },
};

const liveDrop: Drop = {
  ...scheduledDrop,
  is_minting: true,
  next_stage: undefined,
  active_stage: { uuid: "s1", stage_type: "public_sale", price: "0" },
};

function monitorWith(drops: Drop[]) {
  let i = 0;
  const client = { getDrop: vi.fn(async () => drops[Math.min(i++, drops.length - 1)]!) };
  const monitor = new DropMonitor({
    client,
    strategies: [strategy],
    schedule: { liveMs: 20, idleMs: 20, ramp: [{ belowMs: 3_000, intervalMs: 10 }], staleAfterMs: 60_000 },
  });
  return { monitor, client };
}

describe("DropMonitor", () => {
  it("emits mint:live exactly once on the transition to live", async () => {
    const { monitor } = monitorWith([scheduledDrop, liveDrop, liveDrop, liveDrop]);
    const events: MintLiveEvent[] = [];
    monitor.on("mint:live", (e) => events.push(e));
    monitor.start();
    await new Promise((r) => setTimeout(r, 150));
    monitor.stop();
    expect(events).toHaveLength(1);
    expect(events[0]!.snapshot.status).toBe("live");
    expect(events[0]!.detectedAt).toBeGreaterThan(0);
  });

  it("re-emits when the stage changes while live", async () => {
    const stage2: Drop = {
      ...liveDrop,
      active_stage: { uuid: "s2", stage_type: "public_sale", price: "0" },
    };
    const { monitor } = monitorWith([liveDrop, stage2]);
    const events: MintLiveEvent[] = [];
    monitor.on("mint:live", (e) => events.push(e));
    monitor.start();
    await new Promise((r) => setTimeout(r, 120));
    monitor.stop();
    expect(events).toHaveLength(2);
  });

  it("ramps toward a pending stage transition while live", () => {
    const { monitor } = monitorWith([]);
    const wlThenPublic: Drop = {
      collection_slug: "cool-drop",
      chain: "base",
      is_minting: true,
      active_stage: { uuid: "wl", stage_type: "allowlist", price: "0" },
      next_stage: {
        stage_type: "public_sale",
        start_time: new Date(Date.now() + 2_000).toISOString(),
      },
    };
    const snap = snapshotFromDrop(wlThenPublic);
    expect(snap.status).toBe("live");
    expect(snap.msUntilNextStage).toBeGreaterThan(0);
    // 2s out → inside the 3s ramp tier (10ms), not flat liveMs (20ms).
    expect(monitor.nextDelay([strategy], snap)).toBe(10);
  });

  it("derives the pending stage from stages[] when next_stage is omitted", () => {
    const { monitor } = monitorWith([]);
    const wlThenPublic: Drop = {
      collection_slug: "cool-drop",
      chain: "base",
      is_minting: true,
      active_stage: { uuid: "wl", stage_type: "allowlist", price: "0" },
      stages: [
        {
          uuid: "wl",
          stage_type: "allowlist",
          price: "0",
          start_time: new Date(Date.now() - 3_600_000).toISOString(),
          end_time: new Date(Date.now() + 2_000).toISOString(),
        },
        {
          uuid: "pub",
          stage_type: "public_sale",
          price: "0",
          start_time: new Date(Date.now() + 2_000).toISOString(),
        },
      ],
    };
    const snap = snapshotFromDrop(wlThenPublic);
    expect(snap.status).toBe("live");
    expect(snap.nextStage?.uuid).toBe("pub");
    expect(monitor.nextDelay([strategy], snap)).toBe(10);
  });

  it("keeps liveMs when live with no pending stage", () => {
    const { monitor } = monitorWith([]);
    const snap = snapshotFromDrop(liveDrop);
    expect(snap.status).toBe("live");
    expect(snap.msUntilNextStage).toBeUndefined();
    expect(monitor.nextDelay([strategy], snap)).toBe(20);
  });

  it("pause() stops polling that collection", async () => {
    const { monitor, client } = monitorWith([scheduledDrop]);
    monitor.start();
    await new Promise((r) => setTimeout(r, 60));
    monitor.pause("cool-drop");
    const callsAtPause = client.getDrop.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    monitor.stop();
    expect(client.getDrop.mock.calls.length).toBe(callsAtPause);
  });
});

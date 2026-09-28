import { describe, expect, it } from "vitest";
import type { Drop } from "@aco/opensea";
import {
  isPublicStage,
  normalizeStage,
  snapshotFromDrop,
} from "@aco/monitoring";

const NOW = Date.parse("2026-09-14T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const baseDrop: Drop = {
  collection_slug: "cool-drop",
  collection_name: "Cool Drop",
  chain: "base",
  contract_address: "0x000000000000000000000000000000000000bEEF",
  is_minting: false,
};

describe("snapshotFromDrop", () => {
  it("detects a live mint", () => {
    const snap = snapshotFromDrop(
      {
        ...baseDrop,
        is_minting: true,
        active_stage: {
          uuid: "s1",
          stage_type: "public_sale",
          price: "25000000000000000",
          start_time: iso(NOW - 60_000),
          end_time: iso(NOW + 3_600_000),
          max_per_wallet: 5,
        },
      },
      NOW,
    );
    expect(snap.status).toBe("live");
    expect(snap.activeStage?.type).toBe("public_sale");
    expect(snap.activeStage?.priceWei).toBe(25_000_000_000_000_000n);
    expect(snap.activeStage?.maxPerWallet).toBe(5);
  });

  it("detects a scheduled mint with countdown", () => {
    const snap = snapshotFromDrop(
      {
        ...baseDrop,
        next_stage: {
          uuid: "s2",
          stage_type: "allowlist",
          price: "0",
          start_time: iso(NOW + 600_000),
        },
      },
      NOW,
    );
    expect(snap.status).toBe("scheduled");
    expect(snap.msUntilNextStage).toBe(600_000);
  });

  it("treats a passed start_time as imminent (msUntil 0)", () => {
    const snap = snapshotFromDrop(
      {
        ...baseDrop,
        next_stage: { stage_type: "public_sale", start_time: iso(NOW - 5_000) },
      },
      NOW,
    );
    expect(snap.status).toBe("scheduled");
    expect(snap.msUntilNextStage).toBe(0);
  });

  it("detects an ended drop", () => {
    const snap = snapshotFromDrop(
      {
        ...baseDrop,
        stages: [
          {
            stage_type: "public_sale",
            start_time: iso(NOW - 7200_000),
            end_time: iso(NOW - 3600_000),
          },
        ],
      },
      NOW,
    );
    expect(snap.status).toBe("ended");
  });

  it("returns unknown when nothing is scheduled", () => {
    const snap = snapshotFromDrop({ ...baseDrop }, NOW);
    expect(snap.status).toBe("unknown");
  });
});

describe("isPublicStage", () => {
  it("recognizes public stage types", () => {
    expect(
      isPublicStage(normalizeStage({ stage_type: "public_sale" })),
    ).toBe(true);
    expect(isPublicStage(normalizeStage({ stage_type: "allowlist" }))).toBe(
      false,
    );
    expect(
      isPublicStage(normalizeStage({ stage_type: "x", label: "Public Mint" })),
    ).toBe(true);
  });
});

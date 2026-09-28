import { parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { InMemoryAttemptStore } from "@aco/database";
import { SafetyController, SafetyViolation } from "@aco/executor";

const limits = {
  killSwitch: false,
  maxSpendPerTxWei: parseEther("0.5"),
  maxSpendPerDayWei: parseEther("2"),
  maxGasFeeWei: parseEther("0.02"),
  maxQuantityPerTx: 10,
};

function make(overrides: Partial<typeof limits> = {}) {
  const store = new InMemoryAttemptStore();
  return { store, safety: new SafetyController({ ...limits, ...overrides }, store) };
}

describe("SafetyController", () => {
  it("blocks execution when the kill switch is engaged", () => {
    const { safety } = make({ killSwitch: true });
    expect(() => safety.assertLive()).toThrow(SafetyViolation);
    safety.releaseKillSwitch();
    expect(() => safety.assertLive()).not.toThrow();
  });

  it("enforces the per-tx spend cap", () => {
    const { safety } = make();
    expect(() => safety.assertCanSpend(parseEther("0.4"))).not.toThrow();
    expect(() => safety.assertCanSpend(parseEther("0.6"))).toThrow(/per-tx cap/);
  });

  it("enforces the rolling daily spend cap", () => {
    const { safety, store } = make();
    store.create({
      collection: "c",
      chain: "base",
      quantity: 1,
      priceWei: parseEther("1.6").toString(),
      status: "confirmed",
      trace: {},
    });
    // 1.6 + 0.39 = 1.99 < 2.0 daily cap (and under the 0.5 per-tx cap)
    expect(() => safety.assertCanSpend(parseEther("0.39"))).not.toThrow();
    // 1.6 + 0.45 = 2.05 > 2.0 daily cap
    expect(() => safety.assertCanSpend(parseEther("0.45"))).toThrow(/daily spend/);
  });

  it("enforces quantity and gas caps", () => {
    const { safety } = make();
    expect(() => safety.assertQuantity(11)).toThrow(/MAX_QUANTITY_PER_TX/);
    expect(() => safety.assertGas(parseEther("0.03"))).toThrow(/gas fee/);
    // per-strategy cap tighter than global wins
    expect(() =>
      safety.assertGas(parseEther("0.008"), parseEther("0.005")),
    ).toThrow(/gas fee/);
    expect(() =>
      safety.assertGas(parseEther("0.008"), parseEther("0.01")),
    ).not.toThrow();
  });
});

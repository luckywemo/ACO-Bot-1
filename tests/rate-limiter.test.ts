import { describe, expect, it } from "vitest";
import { TokenBucket } from "@aco/opensea";

describe("TokenBucket", () => {
  it("allows bursts up to capacity then throttles", async () => {
    const bucket = new TokenBucket(2, 10); // 2 burst, 10 rps refill
    const t0 = Date.now();
    await bucket.take();
    await bucket.take();
    // Third take must wait ~100ms for a token to refill.
    await bucket.take();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  });

  it("refills over time", async () => {
    const bucket = new TokenBucket(1, 50);
    await bucket.take();
    await new Promise((r) => setTimeout(r, 60)); // ~3 tokens refilled
    const t0 = Date.now();
    await bucket.take();
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

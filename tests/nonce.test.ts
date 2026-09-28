import type { Address, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { NonceManager } from "@aco/wallet";

const ADDR = "0x0000000000000000000000000000000000000AaA" as Address;

function clientWith(pending: number) {
  return {
    chain: { id: 8453 },
    getTransactionCount: vi.fn(async () => pending),
  } as unknown as PublicClient;
}

describe("NonceManager", () => {
  it("seeds from pending count and increments atomically", async () => {
    const nm = new NonceManager();
    const client = clientWith(7);
    expect(await nm.reserve(client, ADDR)).toBe(7);
    expect(await nm.reserve(client, ADDR)).toBe(8);
    expect(await nm.reserve(client, ADDR)).toBe(9);
  });

  it("never goes below the chain pending count", async () => {
    const nm = new NonceManager();
    const client = clientWith(7);
    await nm.reserve(client, ADDR); // 7
    // Chain advanced further than our cache (e.g. external tx landed).
    const advanced = clientWith(20);
    expect(await nm.reserve(advanced, ADDR)).toBe(20);
  });

  it("resyncs after a nonce conflict", async () => {
    const nm = new NonceManager();
    await nm.reserve(clientWith(7), ADDR);
    const next = await nm.resync(clientWith(15), ADDR);
    expect(next).toBe(15);
    expect(await nm.reserve(clientWith(15), ADDR)).toBe(15);
  });
});

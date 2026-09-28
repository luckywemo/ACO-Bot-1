import type { Address, PublicClient } from "viem";

/** Minimal client surface needed for nonce reads (test-friendly). */
export type NonceClient = Pick<PublicClient, "getTransactionCount"> & {
  chain?: { id: number } | undefined;
};

/**
 * Nonce manager. Tracks the next usable nonce per (chain, address) in
 * memory and resyncs from the chain's pending count on first use or
 * after a conflict — never reuses a nonce, never skips blindly.
 */
export class NonceManager {
  private readonly next = new Map<string, number>();

  private key(chainId: number, address: Address): string {
    return `${chainId}:${address.toLowerCase()}`;
  }

  /**
   * Atomically reserve and return the next nonce. The first call for a
   * (chain, address) seeds from `eth_getTransactionCount(pending)`.
   */
  async reserve(client: NonceClient, address: Address): Promise<number> {
    const chainId = client.chain?.id ?? 0;
    const key = this.key(chainId, address);
    const pending = await client.getTransactionCount({
      address,
      blockTag: "pending",
    });
    const cached = this.next.get(key);
    const nonce = cached === undefined ? pending : Math.max(cached, pending);
    this.next.set(key, nonce + 1);
    return nonce;
  }

  /**
   * Give back a nonce that was reserved but never broadcast (e.g. a snipe
   * that signed then bailed before send). Rolls `next` back only when this
   * nonce is still the tip — a later reserve may already have advanced it.
   */
  release(client: NonceClient, address: Address, nonce: number): void {
    const chainId = client.chain?.id ?? 0;
    const key = this.key(chainId, address);
    if (this.next.get(key) === nonce + 1) this.next.set(key, nonce);
  }

  /**
   * Force resync after a nonce conflict ("nonce too low" / replacement
   * errors). Returns the corrected next nonce without reserving it.
   */
  async resync(client: NonceClient, address: Address): Promise<number> {
    const chainId = client.chain?.id ?? 0;
    const key = this.key(chainId, address);
    const pending = await client.getTransactionCount({
      address,
      blockTag: "pending",
    });
    this.next.set(key, pending);
    return pending;
  }
}

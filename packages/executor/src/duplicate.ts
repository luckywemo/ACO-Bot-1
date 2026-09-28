import type { AttemptStore } from "@aco/database";

/**
 * Duplicate-execution protection. A (chain, collection, wallet) key can
 * only have one in-flight execution; the store is also checked so a
 * pending/confirmed attempt blocks resubmission after restarts or
 * repeated monitor events.
 */
export class DuplicateGuard {
  private readonly held = new Set<string>();

  constructor(private readonly store: AttemptStore) {}

  static key(chain: string, collection: string, wallet: string): string {
    return `${chain}:${collection}:${wallet.toLowerCase()}`;
  }

  /** Returns true when the key was acquired; false = duplicate. */
  async acquire(key: string): Promise<boolean> {
    if (this.held.has(key)) return false;
    // Claim synchronously before the async store check — otherwise two
    // concurrent executions could both pass the `held` check before either
    // adds, and both proceed to broadcast.
    this.held.add(key);
    const [chain, collection, wallet] = key.split(":");
    if (this.store.hasActiveAttempt(collection!, wallet)) {
      this.held.delete(key); // a prior broadcast blocks us — release the claim
      return false;
    }
    return true;
  }

  release(key: string): void {
    this.held.delete(key);
  }
}

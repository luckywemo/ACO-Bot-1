import {
  createPublicClient,
  webSocket,
  type Block,
  type PublicClient,
} from "viem";
import { nullLogger, type Logger } from "@aco/config";
import { getChain } from "./chains";

export interface BlockHead {
  number: number;
  /** Block timestamp in ms. */
  timestamp: number;
}

type BlockCb = (head: BlockHead) => void;

interface ChainSub {
  listeners: Set<BlockCb>;
  unwatch?: () => void;
  latest?: BlockHead;
}

/**
 * Low-latency new-head watcher. Subscribes to `newHeads` over the first
 * ws(s):// endpoint for the chain when one is configured, else fast-polls
 * the shared HTTP client. Listeners are reference-counted — the underlying
 * subscription is created on the first listener and torn down when the
 * last one leaves, so idle chains cost nothing.
 *
 * Used by the snipe engine to (a) fire precisely when the chain crosses a
 * stage startTime and (b) react per-block to a stuck or reverted mint.
 */
export class BlockWatcher {
  private readonly subs = new Map<string, ChainSub>();

  constructor(
    private readonly getClient: (chain: string) => PublicClient,
    private readonly wsEndpoints: Record<string, string[]> = {},
    private readonly logger: Logger = nullLogger,
    /** HTTP polling interval when no wss endpoint is configured. */
    private readonly pollMs = 400,
  ) {}

  /** Latest observed head for a chain (undefined until the first block). */
  latest(chain: string): BlockHead | undefined {
    return this.subs.get(chain)?.latest;
  }

  /**
   * Register a per-block callback. Returns an unsubscribe function. The
   * chain subscription is shared across listeners and removed when the
   * last one unsubscribes.
   */
  onBlock(chain: string, cb: BlockCb): () => void {
    let sub = this.subs.get(chain);
    if (!sub) {
      sub = { listeners: new Set() };
      this.subs.set(chain, sub);
      this.subscribe(chain, sub);
    }
    sub.listeners.add(cb);
    return () => {
      sub.listeners.delete(cb);
      if (sub.listeners.size === 0) this.teardown(chain, sub!);
    };
  }

  /**
   * Resolve on the first observed head whose timestamp >= tsMs, or when the
   * wall clock reaches tsMs (whichever comes first), or on timeoutMs. The
   * wall-clock fallback guarantees the snipe still fires at T-0 even if no
   * head has been observed yet.
   */
  awaitTimestamp(
    chain: string,
    tsMs: number,
    timeoutMs = 60_000,
  ): Promise<BlockHead> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (h: BlockHead) => {
        if (done) return;
        done = true;
        clearTimeout(wall);
        clearTimeout(cap);
        off();
        resolve(h);
      };
      const off = this.onBlock(chain, (h) => {
        if (h.timestamp >= tsMs) finish(h);
      });
      const wall = setTimeout(
        () =>
          finish(this.latest(chain) ?? { number: 0, timestamp: tsMs }),
        Math.max(0, tsMs - Date.now()),
      );
      const cap = setTimeout(
        () =>
          finish(
            this.latest(chain) ?? { number: 0, timestamp: Date.now() },
          ),
        timeoutMs,
      );
    });
  }

  private subscribe(chain: string, sub: ChainSub): void {
    const onBlock = (block: Block) => {
      const head: BlockHead = {
        number: Number(block.number),
        timestamp: Number(block.timestamp) * 1000,
      };
      sub.latest = head;
      for (const cb of sub.listeners) {
        try {
          cb(head);
        } catch {
          // A throwing listener must not break the others.
        }
      }
    };
    const onError = (err: unknown) =>
      this.logger.warn({ chain, err }, "block watcher error");

    const wsUrl = (this.wsEndpoints[chain] ?? []).find((u) =>
      /^wss?:\/\//i.test(u),
    );
    if (wsUrl) {
      try {
        const wsClient = createPublicClient({
          chain: getChain(chain),
          transport: webSocket(wsUrl),
        });
        sub.unwatch = wsClient.watchBlocks({ onBlock, onError });
        this.logger.info({ chain, wsUrl }, "block watcher: websocket newHeads");
        return;
      } catch (err) {
        this.logger.warn(
          { chain, err },
          "ws subscribe failed — falling back to polling",
        );
      }
    }
    sub.unwatch = this.getClient(chain).watchBlocks({
      onBlock,
      onError,
      poll: true,
      pollingInterval: this.pollMs,
    });
    this.logger.info({ chain, pollMs: this.pollMs }, "block watcher: polling");
  }

  private teardown(chain: string, sub: ChainSub): void {
    try {
      sub.unwatch?.();
    } catch {
      // ignore
    }
    this.subs.delete(chain);
  }
}

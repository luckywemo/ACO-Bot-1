import {
  createPublicClient,
  fallback,
  http,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { nullLogger, type Logger } from "@aco/config";
import { getChain } from "./chains";

/**
 * Lazily-created, cached viem PublicClients per chain. Multiple RPC
 * endpoints per chain are combined with viem's ranked `fallback`
 * transport, which periodically re-ranks endpoints by latency and
 * automatically fails over — warm, redundant connections.
 */
export class ChainClients {
  private readonly clients = new Map<string, PublicClient>();

  constructor(
    private readonly rpcEndpoints: Record<string, string[]>,
    private readonly logger: Logger = nullLogger,
    /** chain -> private-relay endpoints broadcast alongside public RPCs. */
    private readonly relayEndpoints: Record<string, string[]> = {},
  ) {}

  get(chainName: string): PublicClient {
    let client = this.clients.get(chainName);
    if (client) return client;

    const chain = getChain(chainName);
    const urls = this.rpcEndpoints[chainName] ?? [];
    const transports: Transport[] = urls.map((u) =>
      http(u, { timeout: 10_000, retryCount: 1 }),
    );
    // No configured endpoint -> viem's default public RPC for the chain.
    if (transports.length === 0) transports.push(http());

    client = createPublicClient({
      chain,
      transport:
        transports.length > 1
          ? fallback(transports, { rank: true, retryCount: 1 })
          : transports[0]!,
      batch: { multicall: true },
    });
    this.clients.set(chainName, client);
    return client;
  }

  /**
   * Broadcast a signed tx to every configured RPC + private-relay endpoint
   * for the chain in parallel, plus the shared fallback client. Returns the
   * first successful tx hash; throws only if every path fails. Parallel
   * fan-out maximizes propagation speed and lets a relay land the tx even
   * when public mempools are congested or sniped.
   */
  async broadcast(chainName: string, signedTx: Hex): Promise<Hex> {
    const urls = [
      ...(this.rpcEndpoints[chainName] ?? []),
      ...(this.relayEndpoints[chainName] ?? []),
    ];
    const attempts: Promise<Hex>[] = urls.map((u) =>
      this.sendRawVia(u, signedTx),
    );
    // Shared fallback client as an additional path (covers the no-RPC case).
    attempts.push(
      this.get(chainName).sendRawTransaction({
        serializedTransaction: signedTx,
      }),
    );
    try {
      return await Promise.any(attempts);
    } catch (err) {
      // Surface the most useful underlying error rather than AggregateError.
      const reasons =
        err instanceof AggregateError
          ? err.errors.map((e) => (e instanceof Error ? e.message : String(e)))
          : [String(err)];
      throw new Error(`broadcast failed on all endpoints: ${reasons.join(" | ")}`);
    }
  }

  /** Raw eth_sendRawTransaction against a single endpoint. */
  private async sendRawVia(url: string, signedTx: Hex): Promise<Hex> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [signedTx],
      }),
    });
    const j = (await res.json()) as {
      result?: Hex;
      error?: { message?: string };
    };
    if (j.error) throw new Error(j.error.message ?? "rpc error");
    if (!j.result) throw new Error("empty rpc result");
    return j.result;
  }

  /**
   * Establish connections and verify each chain responds before the bot
   * goes live, so the first real request doesn't pay connection setup.
   */
  async warm(chainNames: string[]): Promise<void> {
    await Promise.all(
      chainNames.map(async (name) => {
        try {
          const block = await this.get(name).getBlockNumber();
          this.logger.info({ chain: name, block: Number(block) }, "RPC warm");
        } catch (err) {
          this.logger.warn({ chain: name, err }, "RPC warm-up failed");
        }
      }),
    );
  }
}

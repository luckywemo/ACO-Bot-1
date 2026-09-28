import {
  createWalletClient,
  fallback,
  http,
  type Address,
  type Chain,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getChain } from "@aco/blockchain";

/** Transaction fields required to produce a signed raw transaction. */
export interface PreparedTx {
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  nonce: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

/**
 * Signing abstraction. The executor only ever sees this interface —
 * private keys never leave the wallet package.
 */
export interface WalletSigner {
  readonly address: Address;
  readonly chainId: number;
  signTransaction(tx: PreparedTx): Promise<Hex>;
  /** EIP-191 personal_sign — used for OpenSea SIWE wallet auth. */
  signMessage(message: string): Promise<Hex>;
}

/**
 * Local hot-wallet signer backed by a raw private key. Signing happens
 * in-process — no wallet popup on the critical path.
 *
 * SECURITY: the key is held only in memory, never logged, never sent
 * over the network, and never exposed through the API. Use a dedicated
 * hot wallet funded only with what you intend to spend.
 */
export class LocalWalletSigner implements WalletSigner {
  private readonly account: PrivateKeyAccount;
  private readonly client: WalletClient;
  readonly chainId: number;

  constructor(privateKey: Hex, chain: Chain, rpcUrls: string[] = []) {
    this.account = privateKeyToAccount(privateKey);
    this.chainId = chain.id;
    const transports = rpcUrls.map((u) => http(u, { timeout: 10_000 }));
    this.client = createWalletClient({
      account: this.account,
      chain,
      transport:
        transports.length > 1
          ? fallback(transports, { rank: true })
          : (transports[0] ?? http()),
    });
  }

  get address(): Address {
    return this.account.address;
  }

  /** Locally sign a fully-specified transaction; returns raw tx hex. */
  async signTransaction(tx: PreparedTx): Promise<Hex> {
    const request = {
      account: this.account,
      chain: this.client.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: tx.gas,
      nonce: tx.nonce,
      ...(tx.maxFeePerGas !== undefined
        ? {
            maxFeePerGas: tx.maxFeePerGas,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n,
          }
        : { gasPrice: tx.gasPrice }),
    };
    // viem types the union loosely; both branches are valid requests.
    return this.client.signTransaction(request as never);
  }

  /** EIP-191 personal_sign — signs an arbitrary message (SIWE auth). */
  async signMessage(message: string): Promise<Hex> {
    return this.account.signMessage({ message });
  }
}

/**
 * Per-(wallet, chain) signer registry. Builds a WalletClient on first
 * use, sharing the same failover RPC endpoints as the public clients.
 * Supports multiple named wallets — strategies pick one via `wallet`.
 */
export class SignerRegistry {
  private readonly signers = new Map<string, LocalWalletSigner>();
  private readonly keys: Record<string, Hex>;

  constructor(
    privateKey: Hex | undefined,
    private readonly rpcEndpoints: Record<string, string[]>,
    namedKeys: Record<string, Hex> = {},
  ) {
    this.keys = { ...namedKeys };
    if (privateKey) this.keys.default = privateKey;
  }

  get available(): boolean {
    return Object.keys(this.keys).length > 0;
  }

  /** Wallet names with a configured key. */
  get walletNames(): string[] {
    return Object.keys(this.keys);
  }

  has(wallet: string): boolean {
    return this.keys[wallet] !== undefined;
  }

  /** Register (or replace) a named wallet key at runtime. */
  register(wallet: string, key: Hex): void {
    this.keys[wallet] = key;
    // Drop cached signers for this wallet so the new key takes effect.
    for (const id of [...this.signers.keys()]) {
      if (id.startsWith(`${wallet}:`)) this.signers.delete(id);
    }
  }

  get(chainName: string, wallet = "default"): LocalWalletSigner | undefined {
    const key = this.keys[wallet];
    if (!key) return undefined;
    const id = `${wallet}:${chainName}`;
    let s = this.signers.get(id);
    if (!s) {
      s = new LocalWalletSigner(
        key,
        getChain(chainName),
        this.rpcEndpoints[chainName] ?? [],
      );
      this.signers.set(id, s);
    }
    return s;
  }

  /** Address is identical across EVM chains for a given key. */
  address(chainName: string, wallet = "default"): Address | undefined {
    // get() throws when the chain has no usable RPC — for display/lookup
    // purposes that must degrade to "no address", never crash the caller.
    try {
      return this.get(chainName, wallet)?.address;
    } catch {
      return undefined;
    }
  }
}

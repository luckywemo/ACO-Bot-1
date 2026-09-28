import {
  encodeFunctionData,
  getFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { nullLogger, type Logger } from "@aco/config";

/**
 * Candidate public-mint signatures, tried in order. Only signatures whose
 * args we can supply locally (quantity, recipient) are listed — anything
 * needing a merkle proof or signed voucher falls back to the OpenSea build
 * path, which returns the proof-bearing calldata for us.
 *
 * Detection is a bytecode scan for the 4-byte selector. A false positive is
 * possible (the selector appearing as push-data) but rare; a wrong guess
 * simply reverts on-chain and the executor falls back to OpenSea.
 */
const CANDIDATES: { sig: string; args: (q: bigint, to: Address) => unknown[] }[] = [
  // SeaDrop public mint (most OpenSea drops).
  { sig: "mintPublic(address,address,address,uint256)", args: (q, to) => [to, to, to, q] },
  { sig: "publicMint(uint256)", args: (q) => [q] },
  { sig: "mint(uint256)", args: (q) => [q] },
  { sig: "mintPublic(uint256)", args: (q) => [q] },
  { sig: "publicSaleMint(uint256)", args: (q) => [q] },
  { sig: "mintPublic(address,uint256)", args: (q, to) => [to, q] },
  { sig: "mint(address,uint256)", args: (q, to) => [to, q] },
  { sig: "claim(uint256)", args: (q) => [q] },
  { sig: "purchase(uint256)", args: (q) => [q] },
];

const paramTypes = (sig: string): string[] =>
  sig.slice(sig.indexOf("(") + 1, sig.lastIndexOf(")")).split(",");

const buildCalldata = (
  sig: string,
  args: unknown[],
): Hex =>
  encodeFunctionData({
    abi: [
      {
        type: "function",
        name: sig.slice(0, sig.indexOf("(")),
        stateMutability: "payable",
        inputs: paramTypes(sig).map((t, i) => ({ name: `a${i}`, type: t })),
        outputs: [],
      },
    ],
    functionName: sig.slice(0, sig.indexOf("(")),
    args,
  }) as Hex;

export interface DirectMint {
  to: Address;
  data: Hex;
  /** Detected function signature (for logging). */
  sig: string;
}

/**
 * Detect a callable public-mint function on `contract` and return the
 * calldata for `quantity` to `minter`. Returns undefined when no known
 * selector is present in the bytecode (caller falls back to OpenSea build).
 * Result is cached per contract so the scan runs once per drop.
 */
export class DirectMinter {
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly logger: Logger = nullLogger) {}

  async detect(
    client: Pick<PublicClient, "getCode">,
    contract: Address,
  ): Promise<string | undefined> {
    const key = contract.toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key) ?? undefined;
    let found: string | null = null;
    try {
      const code = await client.getCode({ address: contract });
      if (code && code !== "0x") {
        const bytecode = code.toLowerCase();
        for (const c of CANDIDATES) {
          const sel = getFunctionSelector(c.sig).slice(2).toLowerCase();
          if (bytecode.includes(sel)) {
            found = c.sig;
            break;
          }
        }
      }
    } catch (err) {
      this.logger.warn({ contract, err }, "direct-mint detection failed");
    }
    this.cache.set(key, found);
    if (found) this.logger.info({ contract, sig: found }, "direct-mint selector");
    return found ?? undefined;
  }

  /** Build the mint calldata for a detected signature. */
  calldata(sig: string, quantity: bigint, minter: Address): Hex {
    const c = CANDIDATES.find((x) => x.sig === sig);
    if (!c) throw new Error(`no calldata builder for ${sig}`);
    return buildCalldata(sig, c.args(quantity, minter));
  }
}

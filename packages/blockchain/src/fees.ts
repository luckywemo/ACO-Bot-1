import type { PublicClient } from "viem";

/** Minimal client surface needed for fee estimation (test-friendly). */
export type FeeClient = Pick<
  PublicClient,
  "estimateFeesPerGas" | "getGasPrice"
>;

export interface FeeEstimate {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** true when the chain returned EIP-1559 fees. */
  eip1559: boolean;
}

/**
 * Estimate current network fees. Uses EIP-1559 fields when the chain
 * supports them and falls back to legacy gasPrice otherwise.
 */
export async function estimateFees(client: FeeClient): Promise<FeeEstimate> {
  try {
    const fees = await client.estimateFeesPerGas();
    if ("maxFeePerGas" in fees && fees.maxFeePerGas !== undefined) {
      return {
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
        eip1559: true,
      };
    }
    if ("gasPrice" in fees && fees.gasPrice !== undefined) {
      return {
        maxFeePerGas: fees.gasPrice,
        maxPriorityFeePerGas: 0n,
        eip1559: false,
      };
    }
  } catch {
    // fall through to getGasPrice
  }
  const gasPrice = await client.getGasPrice();
  return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: 0n, eip1559: false };
}

/** Worst-case gas cost for a transaction. */
export function maxGasCost(gasLimit: bigint, fees: FeeEstimate): bigint {
  return gasLimit * fees.maxFeePerGas;
}

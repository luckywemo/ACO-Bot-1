import { formatEther } from "viem";
import type { MintAttempt } from "@aco/database";
import type { NotifyEvent } from "./notifier";

const CHAIN_EXPLORERS: Record<string, string> = {
  ethereum: "https://etherscan.io",
  base: "https://basescan.org",
  polygon: "https://polygonscan.com",
  arbitrum: "https://arbiscan.io",
  optimism: "https://optimistic.etherscan.io",
  zora: "https://explorer.zora.energy",
  blast: "https://blastscan.io",
  avalanche: "https://snowtrace.io",
  bsc: "https://bscscan.com",
  sei: "https://seitrace.com",
};

export function txUrl(chain: string, hash: string): string {
  const base = CHAIN_EXPLORERS[chain];
  return base ? `${base}/tx/${hash}` : hash;
}

function fmtMs(v: number | undefined): string {
  return v === undefined ? "—" : `${Math.round(v)} ms`;
}

/** "🚀 MINT EXECUTED" style message for a submitted/dry-run mint. */
export function mintExecutedEvent(a: MintAttempt, dryRun: boolean): NotifyEvent {
  const price = (() => {
    try {
      return `${formatEther(BigInt(a.priceWei) * BigInt(a.quantity))} ETH`;
    } catch {
      return `${a.priceWei} wei`;
    }
  })();
  return {
    title: dryRun ? "🧪 DRY-RUN MINT" : "🚀 MINT EXECUTED",
    color: dryRun ? 0xf0b90b : 0x2081e2,
    lines: [
      `Collection: ${a.collection}`,
      `Quantity: ${a.quantity}`,
      `Price: ${price}`,
      `Chain: ${a.chain}`,
      "",
      `Detection: ${fmtMs(a.latencies?.detection_ms)}`,
      `TX build: ${fmtMs(a.latencies?.tx_build_ms)}`,
      `TX submission: ${fmtMs(a.latencies?.broadcast_ms)}`,
      "",
      `TX: ${a.txHash ? txUrl(a.chain, a.txHash) : "(not broadcast)"}`,
      `Status: ${dryRun ? "Dry run — not broadcast" : "Pending"}`,
    ],
  };
}

/** "✅ MINT CONFIRMED" message. */
export function mintConfirmedEvent(a: MintAttempt): NotifyEvent {
  return {
    title: "✅ MINT CONFIRMED",
    color: 0x35d07f,
    lines: [
      `Collection: ${a.collection}`,
      `Quantity: ${a.quantity}`,
      `TX: ${a.txHash ? txUrl(a.chain, a.txHash) : "—"}`,
      `Block: ${a.blockNumber ?? "—"}`,
      `Total latency: ${fmtMs(a.latencies?.total_ms)}`,
    ],
  };
}

/** "❌ MINT FAILED" message. */
export function mintFailedEvent(a: MintAttempt): NotifyEvent {
  return {
    title: "❌ MINT FAILED",
    color: 0xe5484d,
    lines: [
      `Collection: ${a.collection}`,
      `Chain: ${a.chain}`,
      `Reason: ${a.reason ?? a.error ?? "unknown"}`,
      ...(a.txHash ? [`TX: ${txUrl(a.chain, a.txHash)}`] : []),
    ],
  };
}

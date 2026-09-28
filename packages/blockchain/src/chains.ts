import type { Chain } from "viem";
import * as viemChains from "viem/chains";

/**
 * OpenSea chain name -> viem Chain export name, for every chain where the
 * two naming conventions differ. Anything not listed here is resolved
 * dynamically by normalized name against all viem exports.
 */
const OPENSEA_TO_VIEM: Record<string, string> = {
  ethereum: "mainnet",
  matic: "polygon",
  bnb_chain: "bsc",
  ape_chain: "apeChain",
  arbitrum_nova: "arbitrumNova",
  flow_evm: "flowMainnet",
  flow: "flowMainnet",
  hyper_evm: "hyperEvm",
  world_chain: "worldchain",
  arena_z: "arenaz",
  polygon_zkevm: "polygonZkEvm",
  zksync: "zkSync",
  opbnb: "opBNB",
  x_layer: "xLayer",
  xrp_evm: "xrplevm",
  plume: "plumeMainnet",
  lumia: "lumiaMainnet",
  forma: "forma",
  kaia: "kaia",
  harmony: "harmonyOne",
};

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Lazily-built index of normalized export name -> Chain. */
let viemIndex: Map<string, Chain> | undefined;
function index(): Map<string, Chain> {
  if (viemIndex) return viemIndex;
  viemIndex = new Map();
  for (const [exportName, value] of Object.entries(viemChains)) {
    const c = value as Chain;
    if (c && typeof c === "object" && typeof c.id === "number" && c.name) {
      viemIndex.set(normalize(exportName), c);
    }
  }
  return viemIndex;
}

/**
 * Resolve an OpenSea chain name (or any viem chain name) to a viem Chain.
 * Accepts e.g. "ethereum", "base", "ape_chain", "flow_evm", "hyper_evm",
 * "base_sepolia" (testnet), or a raw viem export name like "arbitrumNova".
 */
export function getChain(name: string): Chain {
  const key = name.trim();
  const mapped = OPENSEA_TO_VIEM[key.toLowerCase()];
  const chain =
    (mapped ? index().get(normalize(mapped)) : undefined) ??
    index().get(normalize(key));
  if (!chain) {
    throw new Error(
      `Unsupported chain "${name}". Use an OpenSea chain name ` +
        `(ethereum, base, polygon, arbitrum, ape_chain, flow_evm, …) or any ` +
        `viem chain export name.`,
    );
  }
  return chain;
}

/** All chain names that resolve successfully (explicit map + viem exports). */
export function supportedChains(): string[] {
  return [...Object.keys(OPENSEA_TO_VIEM), ...index().keys()].sort();
}


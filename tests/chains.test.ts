import { describe, expect, it } from "vitest";
import { getChain, supportedChains } from "@aco/blockchain";

describe("getChain — all-networks resolution", () => {
  it("resolves OpenSea names that differ from viem exports", () => {
    expect(getChain("ethereum").id).toBe(1);
    expect(getChain("ape_chain").id).toBe(33139);
    expect(getChain("flow_evm").id).toBe(747);
    expect(getChain("hyper_evm").id).toBe(999);
    expect(getChain("world_chain").id).toBe(480);
    expect(getChain("arbitrum_nova").id).toBe(42170);
    expect(getChain("bnb_chain").id).toBe(56);
    expect(getChain("matic").id).toBe(137);
  });

  it("resolves plain OpenSea/viem names dynamically", () => {
    for (const [name, id] of [
      ["base", 8453],
      ["polygon", 137],
      ["arbitrum", 42161],
      ["optimism", 10],
      ["avalanche", 43114],
      ["blast", 81457],
      ["zora", 7777777],
      ["sei", 1329],
      ["abstract", 2741],
      ["berachain", 80094],
      ["monad", 143],
      ["unichain", 130],
      ["ronin", 2020],
      ["somnia", 5031],
      ["soneium", 1868],
      ["ink", 57073],
      ["swellchain", 1923],
      ["story", 1514],
      ["scroll", 534352],
      ["linea", 59144],
      ["mantle", 5000],
      ["taiko", 167000],
      ["zksync", 324],
      ["sonic", 146],
      ["robinhood", 4663],
    ] as const) {
      expect(getChain(name).id, name).toBe(id);
    }
  });

  it("is case- and separator-insensitive", () => {
    expect(getChain("BASE").id).toBe(8453);
    expect(getChain("Ape_Chain").id).toBe(33139);
    expect(getChain("arbitrum-nova").id).toBe(42170);
    expect(getChain("arbitrumNova").id).toBe(42170);
  });

  it("resolves testnets too", () => {
    expect(getChain("base_sepolia").id).toBe(84532);
    expect(getChain("sepolia").id).toBe(11155111);
  });

  it("throws for unknown or non-EVM chains", () => {
    expect(() => getChain("solana")).toThrow(/Unsupported chain/);
    expect(() => getChain("notachain")).toThrow(/Unsupported chain/);
    expect(() => getChain("")).toThrow(/Unsupported chain/);
  });

  it("supportedChains lists the explicit map plus viem exports", () => {
    const names = supportedChains();
    expect(names).toContain("ethereum");
    expect(names).toContain("ape_chain");
    expect(names).toContain("flow_evm");
    expect(names.length).toBeGreaterThan(100);
  });
});

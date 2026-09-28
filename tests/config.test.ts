import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv, loadStrategiesFile } from "@aco/config";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function writeYaml(content: string): string {
  dir = mkdtempSync(join(tmpdir(), "aco-"));
  const p = join(dir, "strategies.yaml");
  writeFileSync(p, content);
  return p;
}

const VALID = `
version: 1
strategies:
  - collection: "cool-drop"
    chain: "base"
    quantity: 2
    max_price: 0.05
    auto_mint: true
    conditions:
      require_public_mint: true
      max_gas_fee: 0.01
      stop_after_success: true
`;

describe("loadStrategiesFile", () => {
  it("parses a valid file and applies defaults", () => {
    const strategies = loadStrategiesFile(writeYaml(VALID));
    expect(strategies).toHaveLength(1);
    const s = strategies[0]!;
    expect(s.collection).toBe("cool-drop");
    expect(s.chain).toBe("base");
    expect(s.quantity).toBe(2);
    expect(s.max_price).toBe("0.05");
    expect(s.wallet).toBe("default");
    expect(s.max_attempts).toBe(3);
    expect(s.conditions.require_public_mint).toBe(true);
    expect(s.conditions.stop_after_success).toBe(true);
  });

  it("merges top-level defaults under each strategy", () => {
    const p = writeYaml(`
version: 1
defaults:
  quantity: 3
  conditions:
    require_public_mint: true
strategies:
  - collection: "a"
    chain: "base"
    max_price: 0.01
  - collection: "b"
    chain: "ethereum"
    max_price: 0.02
    quantity: 1
`);
    const [a, b] = loadStrategiesFile(p);
    expect(a!.quantity).toBe(3);
    expect(a!.conditions.require_public_mint).toBe(true);
    expect(b!.quantity).toBe(1); // per-strategy override wins
  });

  it("accepts any chain name (validated later by getChain)", () => {
    // Chain names are free-form in config — resolution happens in
    // @aco/blockchain so new networks need no schema change.
    const p = writeYaml(`
strategies:
  - collection: "x"
    chain: "ape_chain"
    max_price: 0.01
`);
    const [s] = loadStrategiesFile(p);
    expect(s!.chain).toBe("ape_chain");
  });

  it("normalizes chain names to lowercase", () => {
    const p = writeYaml(`
strategies:
  - collection: "x"
    chain: "  BASE  "
    max_price: 0.01
`);
    const [s] = loadStrategiesFile(p);
    expect(s!.chain).toBe("base");
  });

  it("rejects missing max_price", () => {
    const p = writeYaml(`
strategies:
  - collection: "x"
    chain: "base"
`);
    expect(() => loadStrategiesFile(p)).toThrow(/Invalid strategies file/);
  });

  it("rejects zero quantity", () => {
    const p = writeYaml(`
strategies:
  - collection: "x"
    chain: "base"
    max_price: 0.01
    quantity: 0
`);
    expect(() => loadStrategiesFile(p)).toThrow(/Invalid strategies file/);
  });
});

describe("loadEnv", () => {
  const base = { OPENSEA_API_KEY: "k" };

  it("defaults DRY_RUN to true", () => {
    const env = loadEnv({ ...base });
    expect(env.DRY_RUN).toBe(true);
    expect(env.KILL_SWITCH).toBe(false);
  });

  it("parses per-chain RPC lists", () => {
    const env = loadEnv({
      ...base,
      RPC_BASE: "https://a.example, https://b.example",
      RPC_ETHEREUM: "https://c.example",
    });
    expect(env.rpcEndpoints.base).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(env.rpcEndpoints.ethereum).toEqual(["https://c.example"]);
  });

  it("rejects a malformed PRIVATE_KEY", () => {
    expect(() => loadEnv({ ...base, PRIVATE_KEY: "notakey" })).toThrow();
  });

  it("accepts a valid PRIVATE_KEY and empty string becomes undefined", () => {
    const key = `0x${"ab".repeat(32)}`;
    expect(loadEnv({ ...base, PRIVATE_KEY: key }).PRIVATE_KEY).toBe(key);
    expect(loadEnv({ ...base, PRIVATE_KEY: "" }).PRIVATE_KEY).toBeUndefined();
  });
});

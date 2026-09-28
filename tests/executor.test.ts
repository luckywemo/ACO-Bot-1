import { parseEther, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { Strategy } from "@aco/config";
import { InMemoryAttemptStore } from "@aco/database";
import {
  DuplicateGuard,
  MintExecutor,
  SafetyController,
  type ExecutorDeps,
} from "@aco/executor";
import { snapshotFromDrop } from "@aco/monitoring";
import {
  OpenSeaApiError,
  type CrossChainMint,
  type Drop,
  type MintTransaction,
} from "@aco/opensea";
import { NonceManager } from "@aco/wallet";

const MINTER = "0x0000000000000000000000000000000000000AaA" as Address;
const CONTRACT = "0x000000000000000000000000000000000000bEEF" as Address;

const strategy: Strategy = {
  collection: "cool-drop",
  chain: "base",
  quantity: 1,
  max_price: "0.05",
  auto_mint: true,
  wallet: "default",
  max_attempts: 2,
  conditions: {
    require_public_mint: true,
    stop_after_success: true,
  },
};

const liveDrop: Drop = {
  collection_slug: "cool-drop",
  chain: "base",
  contract_address: CONTRACT,
  is_minting: true,
  active_stage: {
    uuid: "s1",
    stage_type: "public_sale",
    price: parseEther("0.025").toString(),
    max_per_wallet: 5,
  },
};

const mintTx: MintTransaction = {
  to: CONTRACT,
  data: "0x1249c58b",
  value: parseEther("0.025").toString(),
  raw: {},
};

function makeDeps(overrides: Partial<ExecutorDeps> = {}) {
  const store = new InMemoryAttemptStore();
  const safety = new SafetyController(
    {
      killSwitch: false,
      maxSpendPerTxWei: parseEther("0.5"),
      maxSpendPerDayWei: parseEther("2"),
      maxGasFeeWei: parseEther("0.02"),
      maxQuantityPerTx: 10,
    },
    store,
  );
  const sendRawTransaction = vi.fn(async () => ("0x" + "11".repeat(32)) as Hex);
  const client = {
    getBalance: vi.fn(async () => parseEther("1")),
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
    })),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    estimateGas: vi.fn(async () => 120_000n),
    call: vi.fn(async () => ({ data: "0x" })),
    sendRawTransaction,
    waitForTransactionReceipt: vi.fn(async () => ({
      status: "success" as const,
      blockNumber: 1234n,
    })),
    getTransactionCount: vi.fn(async () => 7),
  };
  const deps: ExecutorDeps = {
    opensea: { buildMintTransaction: vi.fn(async () => mintTx) },
    publicClient: () => client as never,
    signer: () => undefined,
    fallbackMinter: MINTER,
    nonce: new NonceManager(),
    store,
    safety,
    guard: new DuplicateGuard(store),
    dryRun: true,
    simulate: true,
    confirmationTimeoutMs: 5_000,
    ...overrides,
  };
  return { deps, store, client, sendRawTransaction };
}

const job = (s: Strategy = strategy, drop: Drop = liveDrop) => ({
  strategy: s,
  snapshot: snapshotFromDrop(drop),
  detectedAt: Date.now(),
});

describe("MintExecutor dry-run pipeline", () => {
  it("runs the full pipeline and never broadcasts", async () => {
    const { deps, sendRawTransaction } = makeDeps();
    const attempt = await new MintExecutor(deps).execute(job());
    expect(attempt.status).toBe("dry_run");
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(attempt.trace.event_detected_at).toBeDefined();
    expect(attempt.trace.transaction_requested_at).toBeDefined();
    expect(attempt.trace.transaction_received_at).toBeDefined();
    expect(attempt.trace.simulation_completed_at).toBeDefined();
    expect(attempt.latencies?.total_ms).toBeGreaterThanOrEqual(0);
  });

  it("skips when auto_mint is off and not forced", async () => {
    const { deps } = makeDeps();
    const attempt = await new MintExecutor(deps).execute(
      job({ ...strategy, auto_mint: false }),
    );
    expect(attempt.status).toBe("skipped");
    expect(attempt.reason).toBe("auto_mint_disabled");
  });

  it("skips when price exceeds max_price", async () => {
    const { deps } = makeDeps();
    const expensive: Drop = {
      ...liveDrop,
      active_stage: { ...liveDrop.active_stage!, price: parseEther("0.09").toString() },
    };
    const attempt = await new MintExecutor(deps).execute(job(strategy, expensive));
    expect(attempt.status).toBe("skipped");
    expect(attempt.reason).toMatch(/price_above_max/);
  });

  it("skips non-public stages when require_public_mint is set", async () => {
    const { deps } = makeDeps();
    const allowlist: Drop = {
      ...liveDrop,
      active_stage: { ...liveDrop.active_stage!, stage_type: "allowlist" },
    };
    const attempt = await new MintExecutor(deps).execute(job(strategy, allowlist));
    expect(attempt.status).toBe("skipped");
    expect(attempt.reason).toBe("stage_not_public");
  });

  it("fails on insufficient balance", async () => {
    const { deps, client } = makeDeps();
    client.getBalance.mockResolvedValue(parseEther("0.001"));
    const attempt = await new MintExecutor(deps).execute(job());
    expect(attempt.status).toBe("failed");
    expect(attempt.reason).toMatch(/insufficient_balance/);
  });

  it("fails when simulation reverts", async () => {
    const { deps, client } = makeDeps();
    client.call.mockRejectedValue(new Error("execution reverted"));
    const attempt = await new MintExecutor(deps).execute(job());
    expect(attempt.status).toBe("failed");
    expect(attempt.reason).toBe("simulation_reverted");
  });

  it("fails on contract mismatch (verified target)", async () => {
    const { deps } = makeDeps();
    deps.opensea.buildMintTransaction = vi.fn(async () => ({
      ...mintTx,
      to: "0x000000000000000000000000000000000000dEaD",
    }));
    const attempt = await new MintExecutor(deps).execute(job());
    expect(attempt.status).toBe("failed");
    expect(attempt.reason).toMatch(/contract_mismatch/);
  });

  it("maps 422 from the mint endpoint to not_eligible", async () => {
    const { deps } = makeDeps();
    deps.opensea.buildMintTransaction = vi.fn(async () => {
      throw new OpenSeaApiError(422, "/mint", { errors: ["allowlist"] });
    });
    const attempt = await new MintExecutor(deps).execute(job());
    expect(attempt.status).toBe("skipped");
    expect(attempt.reason).toMatch(/not_eligible/);
  });

  it("retries retryable build failures then succeeds", async () => {
    const { deps } = makeDeps();
    let calls = 0;
    deps.opensea.buildMintTransaction = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new OpenSeaApiError(500, "/mint", {});
      return mintTx;
    });
    const attempt = await new MintExecutor(deps).execute(job());
    expect(attempt.status).toBe("dry_run");
    expect(calls).toBe(2);
  });

  it("blocks a second concurrent execution (duplicate protection)", async () => {
    const { deps } = makeDeps();
    const executor = new MintExecutor(deps);
    const first = executor.execute(job());
    const second = executor.execute(job());
    const [a, b] = await Promise.all([first, second]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["dry_run", "skipped"]);
    const skipped = [a, b].find((x) => x.status === "skipped")!;
    expect(skipped.reason).toBe("duplicate_execution");
  });

  it("respects the kill switch", async () => {
    const { deps } = makeDeps();
    deps.safety.engageKillSwitch();
    const attempt = await new MintExecutor(deps).execute(job());
    expect(attempt.status).toBe("skipped");
    expect(attempt.reason).toBe("safety:kill_switch");
  });
});

describe("cross-chain mint (payment_chain)", () => {
  // Drop lives on base; payer funds from robinhood.
  const xStrategy: Strategy = { ...strategy, payment_chain: "robinhood" };
  const xMint: CrossChainMint = {
    transactions: [
      {
        to: "0x000000000000000000000000000000000000b1d6",
        data: "0x01",
        value: parseEther("0.026").toString(),
        raw: {},
      },
      {
        to: "0x000000000000000000000000000000000000be11",
        data: "0x02",
        value: "0",
        raw: {},
      },
    ],
    receiptRequest: { id: "req-1" },
    raw: {},
  };

  it("dry-run builds legs and simulates each without broadcasting", async () => {
    const { deps, client, sendRawTransaction } = makeDeps();
    deps.opensea.buildCrossChainMintTransaction = vi.fn(async () => xMint);
    deps.opensea.getTransactionReceipt = vi.fn(async () => ({
      status: "confirmed",
      terminal: true,
      raw: {},
    }));
    const attempt = await new MintExecutor(deps).execute(job(xStrategy));
    expect(attempt.status).toBe("dry_run");
    expect(deps.opensea.buildCrossChainMintTransaction).toHaveBeenCalledWith(
      "cool-drop",
      expect.objectContaining({
        payer: MINTER,
        minter: MINTER,
        quantity: 1,
        payment: expect.objectContaining({ chain: "robinhood" }),
      }),
    );
    expect(client.call).toHaveBeenCalledTimes(2); // both legs simulated
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("broadcasts legs in order then polls receipt to confirmed", async () => {
    const { deps, sendRawTransaction } = makeDeps({ dryRun: false });
    deps.opensea.buildCrossChainMintTransaction = vi.fn(async () => xMint);
    const getReceipt = vi.fn(async () => ({
      status: "confirmed",
      terminal: true,
      raw: {},
    }));
    deps.opensea.getTransactionReceipt = getReceipt;
    deps.signer = () =>
      ({
        address: MINTER,
        signTransaction: vi.fn(async () => "0xdeadbeef" as Hex),
      }) as never;
    const attempt = await new MintExecutor(deps).execute(job(xStrategy));
    expect(attempt.status).toBe("confirmed");
    expect(sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(getReceipt).toHaveBeenCalledWith({ id: "req-1" });
  });

  it("maps 422 from cross_chain_mint to not_eligible", async () => {
    const { deps } = makeDeps();
    deps.opensea.buildCrossChainMintTransaction = vi.fn(async () => {
      throw new OpenSeaApiError(422, "/cross_chain_mint", {});
    });
    const attempt = await new MintExecutor(deps).execute(job(xStrategy));
    expect(attempt.status).toBe("skipped");
    expect(attempt.reason).toMatch(/not_eligible/);
  });

  it("fails when the payer has no balance on the payment chain", async () => {
    const { deps, client } = makeDeps();
    deps.opensea.buildCrossChainMintTransaction = vi.fn(async () => xMint);
    client.getBalance.mockResolvedValue(0n);
    const attempt = await new MintExecutor(deps).execute(job(xStrategy));
    expect(attempt.status).toBe("failed");
    expect(attempt.reason).toMatch(/insufficient_balance on robinhood/);
  });
});

describe("named wallets", () => {
  it("resolves the signer for the strategy's wallet name", async () => {
    const signer = vi.fn(() => undefined);
    const { deps } = makeDeps({ signer });
    const s: Strategy = { ...strategy, wallet: "alice" };
    const attempt = await new MintExecutor(deps).execute(job(s));
    expect(signer).toHaveBeenCalledWith("base", "alice");
    expect(attempt.status).toBe("dry_run");
  });

  it("uses the named wallet for the payment-chain signer", async () => {
    const signer = vi.fn(() => undefined);
    const { deps } = makeDeps({ signer });
    deps.opensea.buildCrossChainMintTransaction = vi.fn(async () => ({
      transactions: [
        {
          to: CONTRACT,
          data: "0x1249c58b",
          value: parseEther("0.01").toString(),
          raw: {},
        },
      ],
      raw: {},
    }));
    const s: Strategy = {
      ...strategy,
      wallet: "alice",
      payment_chain: "robinhood",
    };
    const attempt = await new MintExecutor(deps).execute(job(s));
    expect(signer).toHaveBeenCalledWith("robinhood", "alice");
    expect(attempt.status).toBe("dry_run");
  });
});

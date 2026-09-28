import { parseEther, type Address, type Hex, type PublicClient } from "viem";
import { nullLogger, type Logger, type Strategy } from "@aco/config";
import {
  estimateFees,
  maxGasCost,
  type BlockWatcher,
  type DirectMinter,
  type FeeEstimate,
} from "@aco/blockchain";
import {
  TERMINAL_STATUSES,
  type AttemptStatus,
  type AttemptStore,
  type ExecutionTrace,
  type MintAttempt,
} from "@aco/database";
import {
  isPublicStage,
  type DropSnapshot,
  type NormalizedStage,
} from "@aco/monitoring";
import {
  mintConfirmedEvent,
  mintExecutedEvent,
  mintFailedEvent,
  nullNotifier,
  type Notifier,
} from "@aco/notifications";
import {
  OpenSeaApiError,
  receiptSucceeded,
  type CrossChainMint,
  type MintTransaction,
  type OpenSeaClient,
} from "@aco/opensea";
import type { NonceClient, NonceManager, PreparedTx, WalletSigner } from "@aco/wallet";
import { DuplicateGuard } from "./duplicate";
import { SafetyController, SafetyViolation } from "./safety";
import { computeLatencies, now } from "./trace";

export interface MintJob {
  strategy: Strategy;
  snapshot: DropSnapshot;
  detectedAt: number;
  /** Manual triggers bypass the auto_mint flag. */
  force?: boolean;
}

/** Narrow structural types so tests can inject fakes without casts. */
export interface ExecutorDeps {
  opensea: Pick<OpenSeaClient, "buildMintTransaction"> &
    Partial<
      Pick<
        OpenSeaClient,
        | "buildCrossChainMintTransaction"
        | "getTransactionReceipt"
        | "getEligibility"
      >
    >;
  publicClient: (chain: string) => Pick<
    PublicClient,
    | "getBalance"
    | "estimateFeesPerGas"
    | "getGasPrice"
    | "estimateGas"
    | "call"
    | "sendRawTransaction"
    | "waitForTransactionReceipt"
    | "getTransactionCount"
    | "getTransactionReceipt"
    | "getCode"
  >;
  signer: (chain: string, wallet?: string) => WalletSigner | undefined;
  /** Address used for balance/simulation when no signer exists. */
  fallbackMinter?: Address;
  nonce: NonceManager;
  store: AttemptStore;
  safety: SafetyController;
  guard: DuplicateGuard;
  notifier?: Notifier;
  dryRun: boolean;
  simulate: boolean;
  confirmationTimeoutMs: number;
  /** % bump applied to estimated gas fees for faster inclusion. */
  priorityFeeBumpPct?: number;
  /**
   * Parallel broadcast — fans the signed tx out to every RPC + relay
   * endpoint. Defaults to the chain client's sendRawTransaction when unset.
   */
  broadcast?: (chain: string, signedTx: Hex) => Promise<Hex>;
  /** Snipe-engine timing for scheduled stages (contest mints). */
  sniper?: SniperConfig;
  /** Stuck-transaction speed-up (replacement tx with higher fee). */
  speedup?: SpeedupConfig;
  /**
   * Floor-price guard — returns the collection floor in wei, or undefined
   * when unavailable. When set with `floorMinRatio`, a mint is skipped if
   * floor < mintPrice * ratio (don't mint straight into a loss).
   */
  floorPrice?: (collection: string) => Promise<bigint | undefined>;
  floorMinRatio?: number;
  /**
   * New-head watcher — drives block-boundary broadcast timing and the
   * per-block speed-up / revert-fallback loop. When unset the executor
   * falls back to a fixed-interval poll.
   */
  watcher?: BlockWatcher;
  /**
   * Direct contract mint — detects a public-mint selector on the NFT
   * contract and builds calldata locally, bypassing the OpenSea build
   * round-trip in the hot path. Only used for public stages; anything
   * needing a merkle proof falls back to the OpenSea build.
   */
  directMint?: DirectMinter;
  directMintEnabled?: boolean;
  /** % padding added to msg.value on a direct mint to cover contract fees. */
  directMintValuePadPct?: number;
  /**
   * eth_call the snipe tx against `latest` before broadcasting — skips the
   * broadcast on a guaranteed revert so no gas is wasted. Runs after the
   * chain crosses startTime, so the sim context already has the stage open.
   */
  simulateSnipe?: boolean;
  logger?: Logger;
}

/** Snipe-engine timing knobs (see env SNIPER_*). */
export interface SniperConfig {
  enabled: boolean;
  armMs: number;
  buildLeadMs: number;
  buildIntervalMs: number;
  buildTimeoutMs: number;
  broadcastLeadMs: number;
  gasLimit: bigint;
  feeBumpPct: number;
}

/** Stuck-tx speed-up knobs (see env SPEEDUP_*). */
export interface SpeedupConfig {
  afterMs: number;
  bumpPct: number;
  max: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_GAS_LIMIT = 300_000n;
/**
 * How long a mint keeps retrying transient pre-broadcast failures (build
 * errors, timing sim reverts, gas spikes, RPC hiccups) before giving up.
 * Bounded so a genuinely stuck attempt can't loop for a whole 24h stage —
 * terminal conditions (sold out, not eligible, price moved, limits) still
 * stop it immediately.
 */
const MINT_RETRY_WINDOW_MS = 15 * 60_000;
/**
 * Shared OpenSea mint contracts a drop may route through instead of the
 * NFT contract itself. SeaDrop 1.0 is the deterministic CREATE2 address
 * OpenSea uses for most drops — the build endpoint returns it as tx.to.
 */
const KNOWN_MINTERS = new Set([
  "0x00005ea00ac477b1030ce78506496e8c2de24bf5", // SeaDrop 1.0
]);

type Finish = (
  status: AttemptStatus,
  extra?: Partial<MintAttempt>,
) => MintAttempt;

/**
 * Mint execution pipeline:
 *   validate -> build (OpenSea) -> simulate -> sign -> broadcast -> confirm
 * Every stage is timestamped; retries only happen before broadcast so a
 * transaction is never blindly resubmitted.
 */
export class MintExecutor {
  private readonly logger: Logger;
  private readonly notifier: Notifier;

  constructor(private readonly deps: ExecutorDeps) {
    this.logger = deps.logger ?? nullLogger;
    this.notifier = deps.notifier ?? nullNotifier;
  }

  async execute(job: MintJob): Promise<MintAttempt> {
    const { strategy, snapshot } = job;
    const trace: ExecutionTrace = { event_detected_at: job.detectedAt };
    const stage = snapshot.activeStage;
    // Resolving the signer builds a chain client — a chain with no usable
    // RPC (or an unsupported chain) throws here. Capture it so the attempt
    // skips cleanly instead of crashing the whole bot.
    let signer: WalletSigner | undefined;
    let signerErr: string | undefined;
    try {
      signer = this.deps.signer(strategy.chain, strategy.wallet);
    } catch (err) {
      signerErr = errMsg(err);
    }
    const minter = signer?.address ?? this.deps.fallbackMinter;

    const attempt = this.deps.store.create({
      collection: strategy.collection,
      chain: strategy.chain,
      ...(minter !== undefined ? { wallet: minter } : {}),
      quantity: strategy.quantity,
      priceWei: (stage?.priceWei ?? 0n).toString(),
      status: "detected",
      trace,
    });

    const finish: Finish = (status, extra = {}) => {
      attempt.status = status;
      Object.assign(attempt, extra);
      attempt.latencies = computeLatencies(trace);
      this.deps.store.update(attempt.id, {
        status,
        ...extra,
        trace,
        latencies: attempt.latencies,
      });
      this.logger.info(
        {
          id: attempt.id,
          collection: attempt.collection,
          status,
          reason: attempt.reason,
          latencies: attempt.latencies,
        },
        "mint attempt finished",
      );
      void this.notify(attempt);
      return attempt;
    };

    try {
      // ── Validation ────────────────────────────────────────────────
      trace.validation_started_at = now();
      this.deps.safety.assertLive();

      if (signerErr !== undefined) {
        return finish("skipped", {
          reason: `no_rpc_for_chain (${strategy.chain})`,
          error: signerErr,
        });
      }
      if (!strategy.auto_mint && !job.force) {
        return finish("skipped", { reason: "auto_mint_disabled" });
      }
      if (!stage) {
        return finish("skipped", { reason: "no_active_stage" });
      }
      if (
        strategy.conditions.require_public_mint &&
        !isPublicStage(stage)
      ) {
        return finish("skipped", { reason: "stage_not_public" });
      }
      const allowed = strategy.conditions.allowed_stage_types;
      if (allowed?.length && !allowed.includes(stage.type)) {
        return finish("skipped", { reason: `stage_type_${stage.type}_not_allowed` });
      }
      if (!this.withinWindow(strategy)) {
        return finish("skipped", { reason: "outside_time_window" });
      }

      const unitPrice = stage.priceWei;
      const maxPriceWei = parseEther(String(strategy.max_price));
      if (unitPrice > maxPriceWei) {
        return finish("skipped", {
          reason: `price_above_max (${unitPrice} > ${maxPriceWei} wei)`,
        });
      }
      // ── Eligibility + auto-quantity ─────────────────────────────
      // getEligibility resolves a SIWE JWT by wallet NAME — pass
      // strategy.wallet, not the minter address (an address finds no
      // signer, so the call always returned null and the gate was dead).
      // The endpoint is advisory only: it both over-reports (weird-cats
      // said eligible while /mint 422'd) and can under-report (a false
      // negative would silently skip a mintable wallet). POST /mint is
      // the only authoritative gate — its 422 gets recorded upstream so
      // a genuinely ineligible wallet is skipped once, not re-tried.
      // mint_max mints the wallet's full eligible cap.
      const elig = await this.deps.opensea.getEligibility?.(
        strategy.collection,
        strategy.wallet,
      ).catch(() => null);
      let quantity = strategy.quantity;
      if (elig?.stages?.length && stage.uuid) {
        const want = normUuid(stage.uuid);
        const st = elig.stages.find((s) => normUuid(s.stage_uuid) === want);
        const cap = Number(
          st?.max_total_mintable_by_wallet ?? st?.max_per_wallet,
        );
        if (Number.isFinite(cap) && cap > 0) {
          quantity = strategy.conditions.mint_max
            ? cap
            : Math.min(quantity, cap);
        }
      }
      if (stage.maxPerWallet !== undefined && quantity > stage.maxPerWallet) {
        // mint_max clamps to the wallet limit; a fixed over-limit
        // quantity skips outright.
        if (!strategy.conditions.mint_max) {
          return finish("skipped", {
            reason: `quantity_exceeds_wallet_limit_${stage.maxPerWallet}`,
          });
        }
        quantity = stage.maxPerWallet;
      }
      this.deps.safety.assertQuantity(quantity);
      const totalWei = unitPrice * BigInt(quantity);
      this.deps.safety.assertCanSpend(totalWei);
      attempt.quantity = quantity;

      if (!minter) {
        return finish("skipped", {
          reason: "no_minter_address (set PRIVATE_KEY or MINTER_ADDRESS)",
        });
      }

      // ── Duplicate protection ──────────────────────────────────────
      const key = DuplicateGuard.key(strategy.chain, strategy.collection, minter);
      if (!(await this.deps.guard.acquire(key))) {
        return finish("skipped", { reason: "duplicate_execution" });
      }

      try {
        // ── Cross-chain mint: pay on payment_chain, mint on chain ───
        const paymentChain = strategy.payment_chain;
        if (paymentChain && paymentChain !== strategy.chain) {
          return await this.executeCrossChain(
            job,
            minter,
            maxPriceWei,
            trace,
            finish,
            quantity,
          );
        }

        // ── Retry-until-mint ─────────────────────────────────────────
        // Re-run the pre-broadcast pipeline on transient failures (build
        // errors, timing sim reverts, gas spikes, RPC hiccups) until a tx
        // is signed & ready, the stage closes, or the retry window lapses.
        // Terminal conditions (sold out, not eligible, price moved, limits)
        // return immediately. Broadcast + confirm run exactly once — a
        // broadcast tx is never blindly resubmitted.
        // Retry until the stage closes or the window lapses — but never
        // less than a minute: a stale/passed endTime must not make the
        // first transient failure (RPC hiccup, 429) instantly terminal.
        const retryDeadline = Math.min(
          Math.max(stage.endTime ?? 0, Date.now() + 60_000),
          Date.now() + MINT_RETRY_WINDOW_MS,
        );
        const client = this.deps.publicClient(strategy.chain);
        let signed: Hex | undefined;
        let retries = 0;

        for (;;) {
          try {
            // Keep the kill switch live across retries.
            this.deps.safety.assertLive();

            // ── Preflight: balance + gas ceiling ────────────────────
            const [balance, rawFees] = await Promise.all([
              client.getBalance({ address: minter }),
              estimateFees(client),
            ]);
            const fees = this.bumpFees(rawFees);
            const strategyGasCap = strategy.conditions.max_gas_fee
              ? parseEther(String(strategy.conditions.max_gas_fee))
              : undefined;
            const worstCaseGas = maxGasCost(DEFAULT_GAS_LIMIT, fees);
            this.deps.safety.assertGas(worstCaseGas, strategyGasCap);
            if (balance < totalWei + worstCaseGas) {
              return finish("failed", {
                reason: `insufficient_balance (have ${balance}, need ~${totalWei + worstCaseGas} wei)`,
              });
            }
            trace.validation_completed_at = now();

            // ── Build mint transaction ──────────────────────────────
            trace.transaction_requested_at = now();
            const tx = await this.buildWithRetry(strategy, minter, quantity);
            trace.transaction_received_at = now();

            // Contract verification: the mint must target the drop's NFT
            // contract or a known OpenSea minter (e.g. SeaDrop) — drops
            // often route through a shared mint contract that differs.
            if (
              snapshot.contractAddress &&
              tx.to.toLowerCase() !== snapshot.contractAddress.toLowerCase() &&
              !KNOWN_MINTERS.has(tx.to.toLowerCase())
            ) {
              return finish("failed", {
                reason: `contract_mismatch (${tx.to} != ${snapshot.contractAddress})`,
              });
            }
            const value = BigInt(tx.value || "0");
            // Price moved above the detected stage price → abort rather
            // than chase a repriced mint. A drop is fine (paying less).
            if (value > totalWei) {
              return finish("skipped", {
                reason: `price_changed (${value} > detected ${totalWei} wei)`,
              });
            }
            if (value > maxPriceWei * BigInt(quantity)) {
              return finish("skipped", {
                reason: `tx_value_above_max (${value} wei)`,
              });
            }
            this.deps.safety.assertCanSpend(value);

            // ── Simulation (eth_call preflight) ─────────────────────
            if (this.deps.simulate) {
              try {
                await client.call({
                  account: minter,
                  to: tx.to as Address,
                  data: tx.data as Hex,
                  value,
                });
                trace.simulation_completed_at = now();
              } catch (err) {
                // A "not active yet" revert means the sim head hasn't
                // caught the stage open — retry; anything else is real.
                if (isTimingRevert(errMsg(err)) && Date.now() < retryDeadline) {
                  retries++;
                  await sleep(retryBackoffMs(retries));
                  continue;
                }
                return finish("failed", {
                  reason: "simulation_reverted",
                  error: errMsg(err),
                });
              }
            }

            // ── Gas estimate (best effort) ──────────────────────────
            let gas = DEFAULT_GAS_LIMIT;
            try {
              gas = await client.estimateGas({
                account: minter,
                to: tx.to as Address,
                data: tx.data as Hex,
                value,
              });
              gas = (gas * 120n) / 100n; // +20% buffer
            } catch {
              this.logger.warn(
                { collection: strategy.collection },
                "estimateGas failed; using default limit",
              );
            }
            this.deps.safety.assertGas(maxGasCost(gas, fees), strategyGasCap);

            // ── Signing (local, no popup) ───────────────────────────
            if (signer) {
              const nonce = await this.deps.nonce.reserve(client, minter);
              trace.sign_started_at = now();
              try {
                signed = await signer.signTransaction({
                  to: tx.to as Address,
                  data: tx.data as Hex,
                  value,
                  gas,
                  nonce,
                  ...(fees.eip1559
                    ? {
                        maxFeePerGas: fees.maxFeePerGas,
                        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                      }
                    : { gasPrice: fees.maxFeePerGas }),
                });
              } catch (err) {
                // Signing failed after reserving — hand the nonce back so a
                // retry doesn't leave a gap that stalls the next mint.
                this.deps.nonce.release(client, minter, nonce);
                throw err;
              }
              trace.signed_at = now();
            }
            break; // pre-broadcast pipeline succeeded — tx ready
          } catch (err) {
            // Terminal conditions rethrow to the outer catch (which maps
            // them to the right skip/fail reason). Transient ones retry
            // until the stage closes or the window lapses.
            if (!isRetryableMintError(err) || Date.now() >= retryDeadline) {
              throw err;
            }
            retries++;
            this.logger.warn(
              { collection: strategy.collection, retries, err: errMsg(err) },
              "mint attempt transient failure — retrying",
            );
            await sleep(retryBackoffMs(retries));
          }
        }

        // ── Dry run terminates before broadcast ─────────────────────
        if (this.deps.dryRun || !signed) {
          return finish("dry_run", {
            reason: this.deps.dryRun
              ? "dry_run_mode"
              : "no_signer_configured",
          });
        }

        // ── Broadcast ───────────────────────────────────────────────
        trace.broadcast_started_at = now();
        let hash: Hex;
        try {
          hash = await client.sendRawTransaction({
            serializedTransaction: signed,
          });
        } catch (err) {
          // Unknown broadcast state — the tx may have landed. Never
          // resubmit blindly; mark unknown for manual reconciliation.
          return finish("unknown", {
            reason: "broadcast_result_unknown",
            error: errMsg(err),
          });
        }
        trace.broadcast_completed_at = now();
        this.deps.store.update(attempt.id, { txHash: hash, status: "pending", trace });
        attempt.txHash = hash;
        attempt.status = "pending";
        void this.notifier.send(mintExecutedEvent(attempt, false));

        // ── Confirmation ────────────────────────────────────────────
        try {
          const receipt = await client.waitForTransactionReceipt({
            hash,
            timeout: this.deps.confirmationTimeoutMs,
          });
          trace.confirmation_received_at = now();
          if (receipt.status === "success") {
            return finish("confirmed", {
              txHash: hash,
              blockNumber: Number(receipt.blockNumber),
            });
          }
          return finish("failed", {
            txHash: hash,
            reason: "reverted_onchain",
            blockNumber: Number(receipt.blockNumber),
          });
        } catch (err) {
          return finish("unknown", {
            txHash: hash,
            reason: "confirmation_timeout",
            error: errMsg(err),
          });
        }
      } finally {
        this.deps.guard.release(key);
      }
    } catch (err) {
      if (err instanceof SafetyViolation) {
        return finish("skipped", { reason: `safety:${err.code}`, error: err.message });
      }
      if (err instanceof OpenSeaApiError && err.notEligible) {
        // Supply exhausted is terminal for the whole drop — surface it as
        // its own reason so the caller can stop retrying instead of
        // burning an attempt on every stage change / manual trigger.
        const soldOut = /minted out|sold out|exhausted|no remaining|out of (stock|supply)/i.test(
          err.message,
        );
        return finish("skipped", {
          reason: soldOut ? "sold_out" : `not_eligible (HTTP ${err.status})`,
          error: err.message,
        });
      }
      return finish("failed", { reason: "unhandled_error", error: errMsg(err) });
    }
  }

  /**
   * Contest-mint path for a scheduled stage. Instead of waiting for the
   * monitor to observe is_minting, we pre-warm, then tight-loop the OpenSea
   * build endpoint so we capture a valid tx the instant the stage opens,
   * pre-sign it, and broadcast to every RPC/relay at the exact start time.
   * Holds the duplicate guard for the whole window so the normal mint:live
   * path can't double-fire.
   */
  async snipe(job: MintJob, target: NormalizedStage): Promise<MintAttempt> {
    const { strategy, snapshot } = job;
    const cfg = this.deps.sniper;
    const trace: ExecutionTrace = { event_detected_at: job.detectedAt };
    // Same guard as execute() — a chain with no usable RPC throws when the
    // signer builds its chain client; skip cleanly rather than crash.
    let signer: WalletSigner | undefined;
    let signerErr: string | undefined;
    try {
      signer = this.deps.signer(strategy.chain, strategy.wallet);
    } catch (err) {
      signerErr = errMsg(err);
    }
    const minter = signer?.address ?? this.deps.fallbackMinter;

    const attempt = this.deps.store.create({
      collection: strategy.collection,
      chain: strategy.chain,
      ...(minter !== undefined ? { wallet: minter } : {}),
      quantity: strategy.quantity,
      priceWei: (target.priceWei ?? 0n).toString(),
      status: "detected",
      trace,
    });
    const finish: Finish = (status, extra = {}) => {
      attempt.status = status;
      Object.assign(attempt, extra);
      attempt.latencies = computeLatencies(trace);
      this.deps.store.update(attempt.id, {
        status,
        ...extra,
        trace,
        latencies: attempt.latencies,
      });
      this.logger.info(
        { id: attempt.id, collection: attempt.collection, status, reason: attempt.reason, latencies: attempt.latencies },
        "snipe attempt finished",
      );
      void this.notify(attempt);
      return attempt;
    };

    const key = minter
      ? DuplicateGuard.key(strategy.chain, strategy.collection, minter)
      : undefined;
    try {
      trace.validation_started_at = now();
      this.deps.safety.assertLive();
      if (signerErr !== undefined) {
        return finish("skipped", {
          reason: `no_rpc_for_chain (${strategy.chain})`,
          error: signerErr,
        });
      }
      if (!strategy.auto_mint && !job.force) {
        return finish("skipped", { reason: "auto_mint_disabled" });
      }
      if (!minter) {
        return finish("skipped", { reason: "no_minter_address" });
      }
      if (
        strategy.conditions.require_public_mint &&
        !isPublicStage(target)
      ) {
        return finish("skipped", { reason: "stage_not_public" });
      }
      const allowed = strategy.conditions.allowed_stage_types;
      if (allowed?.length && !allowed.includes(target.type)) {
        return finish("skipped", { reason: `stage_type_${target.type}_not_allowed` });
      }
      if (!this.withinWindow(strategy)) {
        return finish("skipped", { reason: "outside_time_window" });
      }
      const unitPrice = target.priceWei;
      const maxPriceWei = parseEther(String(strategy.max_price));
      if (unitPrice > maxPriceWei) {
        return finish("skipped", { reason: `price_above_max` });
      }

      // ── Eligibility + auto-quantity (pre-warm, off critical path) ──
      let quantity = strategy.quantity;
      const elig = await this.deps.opensea.getEligibility?.(
        strategy.collection,
        strategy.wallet,
      ).catch(() => null);
      if (elig?.stages?.length && target.uuid) {
        const want = normUuid(target.uuid);
        const st = elig.stages.find((s) => normUuid(s.stage_uuid) === want);
        const cap = Number(st?.max_total_mintable_by_wallet ?? st?.max_per_wallet);
        if (Number.isFinite(cap) && cap > 0) {
          quantity = strategy.conditions.mint_max
            ? cap
            : Math.min(quantity, cap);
        }
      }
      if (target.maxPerWallet !== undefined) {
        quantity = Math.min(quantity, target.maxPerWallet);
      }
      this.deps.safety.assertQuantity(quantity);
      const totalWei = unitPrice * BigInt(quantity);
      this.deps.safety.assertCanSpend(totalWei);

      // ── Floor-price guard ─────────────────────────────────────────
      if (this.deps.floorPrice && unitPrice > 0n) {
        const floor = await this.deps.floorPrice(strategy.collection).catch(() => undefined);
        if (floor !== undefined) {
          const ratio = this.deps.floorMinRatio ?? 1;
          const need = (unitPrice * BigInt(Math.round(ratio * 100))) / 100n;
          if (floor < need) {
            return finish("skipped", {
              reason: `floor_below_mint (floor ${floor} < ${need} wei)`,
            });
          }
        }
      }

      // ── Acquire duplicate guard — blocks the normal path ──────────
      if (key && !(await this.deps.guard.acquire(key))) {
        return finish("skipped", { reason: "duplicate_execution" });
      }
      // Tracks a reserved-but-unbroadcast nonce so the finally can hand it
      // back — otherwise the manager stays ahead of the chain's pending
      // count and a later mint stalls behind a gap that never fills.
      let reserved: { client: NonceClient; nonce: number } | undefined;
      try {
        // ── Pre-warm: client, fees, balance, gas ceiling ────────────
        const client = this.deps.publicClient(strategy.chain);
        const [balance, rawFees] = await Promise.all([
          client.getBalance({ address: minter }),
          estimateFees(client),
        ]);
        const fees = this.bumpFees(rawFees, cfg?.feeBumpPct ?? 0);
        const gasCap = strategy.conditions.max_gas_fee
          ? parseEther(String(strategy.conditions.max_gas_fee))
          : undefined;
        const gas = cfg?.gasLimit ?? DEFAULT_GAS_LIMIT;
        this.deps.safety.assertGas(maxGasCost(gas, fees), gasCap);
        if (balance < totalWei + maxGasCost(gas, fees)) {
          return finish("failed", { reason: "insufficient_balance" });
        }
        trace.validation_completed_at = now();

        // ── Direct contract mint — bypass the OpenSea build round-trip ──
        // Only for public stages on a detected contract; allowlist/proof
        // mints fall through to the OpenSea build path (it supplies proofs).
        let direct: { to: Address; data: Hex; sig: string } | undefined;
        if (
          this.deps.directMintEnabled &&
          this.deps.directMint &&
          snapshot.contractAddress &&
          isPublicStage(target)
        ) {
          const sig = await this.deps.directMint
            .detect(client, snapshot.contractAddress as Address)
            .catch(() => undefined);
          if (sig) {
            direct = {
              to: snapshot.contractAddress as Address,
              data: this.deps.directMint.calldata(sig, BigInt(quantity), minter),
              sig,
            };
            this.logger.info(
              { collection: strategy.collection, sig },
              "snipe: direct contract mint",
            );
          }
        }

        const startTime = target.startTime ?? Date.now();
        // Re-signable tx template — the confirm loop re-signs it with a
        // bumped fee for each speed-up replacement.
        let tpl: { to: Address; data: Hex; value: bigint } | undefined;
        let nonce = 0;
        let signed: Hex | undefined;

        if (direct && signer) {
          // Pre-sign the direct mint — no OpenSea call on the hot path.
          tpl = { to: direct.to, data: direct.data, value: this.padValue(totalWei) };
          this.deps.safety.assertCanSpend(tpl.value);
          nonce = await this.deps.nonce.reserve(client, minter);
          reserved = { client, nonce };
          trace.sign_started_at = now();
          signed = await signer.signTransaction({ ...tpl, gas, nonce, ...feeFields(fees) });
          trace.signed_at = now();
        } else {
          // ── Tight build loop — capture the tx the instant it opens ──
          const buildStart = startTime - (cfg?.buildLeadMs ?? 4_000);
          const deadline = startTime + (cfg?.buildTimeoutMs ?? 45_000);
          const wait = buildStart - Date.now();
          if (wait > 0) await sleep(wait);

          let tx: MintTransaction | undefined;
          trace.transaction_requested_at = now();
          while (Date.now() < deadline) {
            try {
              tx = await this.deps.opensea.buildMintTransaction(
                strategy.collection,
                { minter, quantity },
              );
              break;
            } catch (err) {
              // Before the stage opens the build endpoint returns "not
              // active" (409) or a transitional 422 while the backend flips
              // the stage live — keep polling so we capture the tx the
              // instant it opens. Only a 422 AFTER startTime is a genuine
              // terminal precondition failure (allowlist / limit / supply).
              const genuineRejection =
                err instanceof OpenSeaApiError &&
                err.status === 422 &&
                Date.now() >= startTime;
              if (genuineRejection) {
                return finish("skipped", { reason: `not_eligible (HTTP ${err.status})` });
              }
              await sleep(cfg?.buildIntervalMs ?? 120);
            }
          }
          if (!tx) {
            return finish("failed", { reason: "build_timeout" });
          }
          trace.transaction_received_at = now();

          // Contract + value sanity (same checks as the normal path).
          if (
            snapshot.contractAddress &&
            tx.to.toLowerCase() !== snapshot.contractAddress.toLowerCase() &&
            !KNOWN_MINTERS.has(tx.to.toLowerCase())
          ) {
            return finish("failed", { reason: `contract_mismatch (${tx.to})` });
          }
          const value = BigInt(tx.value || "0");
          // Price moved above the detected stage price → abort rather than
          // chase a repriced mint. A drop is fine (paying less).
          if (value > totalWei) {
            return finish("skipped", {
              reason: `price_changed (${value} > detected ${totalWei} wei)`,
            });
          }
          if (value > maxPriceWei * BigInt(quantity)) {
            return finish("skipped", { reason: `tx_value_above_max (${value} wei)` });
          }
          this.deps.safety.assertCanSpend(value);
          tpl = { to: tx.to as Address, data: tx.data as Hex, value };

          if (signer) {
            nonce = await this.deps.nonce.reserve(client, minter);
            reserved = { client, nonce };
            trace.sign_started_at = now();
            signed = await signer.signTransaction({ ...tpl, gas, nonce, ...feeFields(fees) });
            trace.signed_at = now();
          }
        }

        if (this.deps.dryRun || !signed || !tpl) {
          return finish("dry_run", {
            reason: this.deps.dryRun ? "dry_run_mode" : "no_signer_configured",
          });
        }

        // ── Block-boundary broadcast — fire when the chain crosses startTime ──
        const fireAt = startTime + (cfg?.broadcastLeadMs ?? 0);
        if (this.deps.watcher) {
          await this.deps.watcher.awaitTimestamp(strategy.chain, fireAt, 60_000);
        } else {
          const hold = fireAt - Date.now();
          if (hold > 0) await sleep(hold);
        }
        // ── Pre-broadcast simulation — catch a guaranteed revert before
        //    spending gas. Runs against `latest`, which is the head that just
        //    crossed startTime, so a success means the mint lands. A timing
        //    revert means the node hasn't processed the crossing head yet —
        //    retry once, then broadcast anyway. ──
        if (this.deps.simulateSnipe) {
          let sim = await this.simulateTx(client, { account: minter, ...tpl, gas });
          if (!sim.ok && isTimingRevert(sim.err)) {
            await sleep(350);
            sim = await this.simulateTx(client, { account: minter, ...tpl, gas });
          }
          if (!sim.ok && !isTimingRevert(sim.err)) {
            this.logger.warn(
              { collection: strategy.collection, err: sim.err },
              "snipe simulation reverted — skipping broadcast",
            );
            if (direct && signer) {
              return await this.openSeaFallback({
                strategy, client, signer, minter, quantity, gas, fees, trace, finish,
              });
            }
            return finish("failed", {
              reason: `sim_${classifyRevert(sim.err)}`,
              error: sim.err,
            });
          }
        }
        trace.broadcast_started_at = now();
        const hash = await this.broadcast(strategy.chain, signed);
        trace.broadcast_completed_at = now();
        this.deps.store.update(attempt.id, { txHash: hash, status: "pending", trace });
        attempt.txHash = hash;
        attempt.status = "pending";
        void this.notifier.send(mintExecutedEvent(attempt, false));

        // ── Per-block confirm: escalate the fee each block until included;
        //    a direct-mint revert falls back to the OpenSea build path. ──
        const template = tpl;
        return await this.confirmLoop({
          client,
          chain: strategy.chain,
          signer,
          nonce,
          fees,
          hash,
          trace,
          finish,
          reSign: (f) =>
            signer!.signTransaction({ ...template, gas, nonce, ...feeFields(f) }),
          onRevert: direct
            ? () =>
                this.openSeaFallback({
                  strategy,
                  client,
                  signer: signer!,
                  minter,
                  quantity,
                  gas,
                  fees,
                  trace,
                  finish,
                })
            : undefined,
        });
      } finally {
        // Reserved a nonce but never broadcast → hand it back so the next
        // mint isn't stuck behind a gap that will never fill.
        if (reserved !== undefined && !attempt.txHash) {
          this.deps.nonce.release(reserved.client, minter, reserved.nonce);
        }
        if (key) this.deps.guard.release(key);
      }
    } catch (err) {
      if (err instanceof SafetyViolation) {
        return finish("skipped", { reason: `safety:${err.code}`, error: err.message });
      }
      if (err instanceof OpenSeaApiError && err.notEligible) {
        return finish("skipped", { reason: `not_eligible (HTTP ${err.status})`, error: err.message });
      }
      return finish("failed", { reason: "unhandled_error", error: errMsg(err) });
    }
  }

  /** Broadcast via the parallel fan-out when configured, else the client. */
  private async broadcast(chain: string, signed: Hex): Promise<Hex> {
    if (this.deps.broadcast) return this.deps.broadcast(chain, signed);
    return this.deps.publicClient(chain).sendRawTransaction({
      serializedTransaction: signed,
    });
  }

  /**
   * Block-driven confirmation. On each new head (or each poll tick when no
   * watcher is configured) it checks the current tx's receipt:
   *   - success            -> confirmed
   *   - reverted           -> onRevert() (direct-mint -> OpenSea fallback)
   *                           or failed
   *   - still pending      -> re-sign a same-nonce replacement with a bumped
   *                           fee and re-broadcast (up to speedup.max)
   * Reacting per-block is what lands a competitive mint in block 1 — a
   * fixed timeout would sit idle through the opening block.
   */
  private async confirmLoop(args: {
    client: Pick<PublicClient, "getTransactionReceipt">;
    chain: string;
    signer: WalletSigner | undefined;
    nonce: number;
    fees: FeeEstimate;
    hash: Hex;
    trace: ExecutionTrace;
    finish: Finish;
    reSign: (fees: FeeEstimate) => Promise<Hex>;
    onRevert?: () => Promise<MintAttempt>;
  }): Promise<MintAttempt> {
    const { client, chain, signer, nonce, fees, trace, finish, reSign, onRevert } = args;
    let { hash } = args;
    const sp = this.deps.speedup;
    const max = sp?.max ?? 0;
    const bumpPct = sp?.bumpPct ?? 15;
    const timeout = this.deps.confirmationTimeoutMs;
    let bumps = 0;

    return new Promise<MintAttempt>((resolve) => {
      let done = false;
      let off: () => void = () => {};
      const finishOnce = (a: MintAttempt) => {
        if (done) return;
        done = true;
        off();
        clearTimeout(cap);
        resolve(a);
      };
      const check = async (fromBlock: boolean) => {
        if (done) return;
        let receipt;
        try {
          receipt = await client.getTransactionReceipt({ hash });
        } catch {
          receipt = undefined; // not yet mined
        }
        if (done) return;
        if (receipt) {
          trace.confirmation_received_at = now();
          if (receipt.status === "success") {
            finishOnce(
              finish("confirmed", { txHash: hash, blockNumber: Number(receipt.blockNumber) }),
            );
          } else if (onRevert) {
            try {
              finishOnce(await onRevert());
            } catch (e) {
              finishOnce(
                finish("failed", { txHash: hash, reason: "fallback_failed", error: errMsg(e) }),
              );
            }
          } else {
            finishOnce(
              finish("failed", {
                txHash: hash,
                reason: classifyRevert(undefined),
                blockNumber: Number(receipt.blockNumber),
              }),
            );
          }
          return;
        }
        // Still pending — escalate the fee once per new block.
        if (fromBlock && signer && bumps < max) {
          bumps++;
          try {
            const bumped = this.bumpFees(fees, bumpPct * bumps);
            const replacement = await reSign(bumped);
            hash = await this.broadcast(chain, replacement);
            this.logger.warn({ chain, nonce, hash, bump: bumps }, "speed-up replacement broadcast");
          } catch (e) {
            this.logger.warn({ chain, err: e }, "speed-up re-sign/broadcast failed");
          }
        }
      };
      if (this.deps.watcher) {
        off = this.deps.watcher.onBlock(chain, () => void check(true));
      } else {
        const iv = setInterval(() => void check(true), Math.max(250, sp?.afterMs ?? 1000));
        off = () => clearInterval(iv);
      }
      const cap = setTimeout(
        () => finishOnce(finish("unknown", { txHash: hash, reason: "confirmation_timeout" })),
        timeout,
      );
      void check(false); // immediate first look — don't wait a block if already mined
    });
  }

  /**
   * Direct mint reverted on-chain — build the tx via OpenSea (which returns
   * proof-bearing calldata for gated stages) and mint through the normal
   * path with a freshly-resynced nonce.
   */
  private async openSeaFallback(args: {
    strategy: Strategy;
    client: Pick<PublicClient, "getTransactionReceipt" | "getTransactionCount">;
    signer: WalletSigner;
    minter: Address;
    quantity: number;
    gas: bigint;
    fees: FeeEstimate;
    trace: ExecutionTrace;
    finish: Finish;
  }): Promise<MintAttempt> {
    const { strategy, client, signer, minter, quantity, gas, fees, trace, finish } = args;
    this.logger.warn({ collection: strategy.collection }, "direct mint reverted — OpenSea fallback");
    const tx = await this.deps.opensea.buildMintTransaction(strategy.collection, {
      minter,
      quantity,
    });
    const nonce = await this.deps.nonce.resync(client, minter);
    const tpl = { to: tx.to as Address, data: tx.data as Hex, value: BigInt(tx.value || "0") };
    const signed = await signer.signTransaction({ ...tpl, gas, nonce, ...feeFields(fees) });
    const hash = await this.broadcast(strategy.chain, signed);
    return this.confirmLoop({
      client,
      chain: strategy.chain,
      signer,
      nonce,
      fees,
      hash,
      trace,
      finish,
      reSign: (f) => signer.signTransaction({ ...tpl, gas, nonce, ...feeFields(f) }),
    });
  }

  /**
   * eth_call the tx against `latest`. Returns ok on success, else the raw
   * revert message. Used to skip a broadcast that is guaranteed to revert.
   */
  private async simulateTx(
    client: Pick<PublicClient, "call">,
    tx: { account: Address; to: Address; data: Hex; value: bigint; gas: bigint },
  ): Promise<{ ok: boolean; err?: string }> {
    try {
      await client.call({
        account: tx.account,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gas: tx.gas,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, err: errMsg(err) };
    }
  }

  /** Pad msg.value for a direct mint to cover contract-level mint fees. */
  private padValue(value: bigint): bigint {
    const pct = this.deps.directMintValuePadPct ?? 0;
    return pct > 0 ? (value * BigInt(100 + Math.round(pct))) / 100n : value;
  }

  /** Scale estimated fees by priorityFeeBumpPct (competitive mints). */
  private bumpFees(fees: FeeEstimate, extraPct = 0): FeeEstimate {
    const pct = (this.deps.priorityFeeBumpPct ?? 0) + extraPct;
    if (pct <= 0) return fees;
    const mul = BigInt(Math.round(100 + pct));
    return {
      ...fees,
      maxFeePerGas: (fees.maxFeePerGas * mul) / 100n,
      maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * mul) / 100n,
    };
  }

  /** Retry only pre-broadcast API failures; never resubmit a sent tx. */
  private async buildWithRetry(
    strategy: Strategy,
    minter: Address,
    quantity: number,
  ): Promise<MintTransaction> {
    let lastErr: unknown;
    for (let i = 1; i <= strategy.max_attempts; i++) {
      try {
        return await this.deps.opensea.buildMintTransaction(
          strategy.collection,
          { minter, quantity },
        );
      } catch (err) {
        lastErr = err;
        const retryable =
          err instanceof OpenSeaApiError ? err.retryable : true;
        if (!retryable || i === strategy.max_attempts) throw err;
        await sleep(Math.min(200 * 2 ** (i - 1), 2_000));
      }
    }
    throw lastErr;
  }

  /**
   * Cross-chain mint: OpenSea returns ordered legs (bridge/swap/mint)
   * which the payer signs and submits in sequence, then we poll
   * POST /transactions/receipt until the mint reaches a terminal state.
   * Caller holds the duplicate guard.
   */
  private async executeCrossChain(
    job: MintJob,
    minter: Address,
    maxPriceWei: bigint,
    trace: ExecutionTrace,
    finish: Finish,
    quantity: number,
  ): Promise<MintAttempt> {
    const { strategy } = job;
    const paymentChain = strategy.payment_chain!;
    const payerSigner = this.deps.signer(paymentChain);
    const payer = payerSigner?.address ?? this.deps.fallbackMinter;
    if (!payer) {
      return finish("skipped", {
        reason: `no_payer_address on ${paymentChain} (set PRIVATE_KEY or MINTER_ADDRESS)`,
      });
    }
    if (!this.deps.opensea.buildCrossChainMintTransaction) {
      return finish("failed", {
        reason: "cross_chain_not_supported_by_opensea_client",
      });
    }

    // ── Build ordered legs (retryable pre-broadcast) ──────────────
    trace.transaction_requested_at = now();
    const mint = await this.buildCrossChainWithRetry(
      strategy,
      payer,
      minter,
      quantity,
    );
    trace.transaction_received_at = now();

    // Bridge/swap legs can carry a premium over the mint price — enforce
    // the absolute spend cap but only warn above the per-token ceiling.
    const totalValue = mint.transactions.reduce(
      (sum, leg) => sum + BigInt(leg.value || "0"),
      0n,
    );
    const ceiling = maxPriceWei * BigInt(quantity);
    if (totalValue > ceiling) {
      this.logger.warn(
        { collection: strategy.collection, totalValue, ceiling },
        "cross-chain total exceeds mint ceiling (bridge premium?)",
      );
    }
    this.deps.safety.assertCanSpend(totalValue);

    // ── Payment-chain balance preflight ───────────────────────────
    const paymentClient = this.deps.publicClient(paymentChain);
    const paymentFees = this.bumpFees(await estimateFees(paymentClient));
    const strategyGasCap = strategy.conditions.max_gas_fee
      ? parseEther(String(strategy.conditions.max_gas_fee))
      : undefined;
    const worstCaseGas =
      maxGasCost(DEFAULT_GAS_LIMIT, paymentFees) *
      BigInt(mint.transactions.length);
    const balance = await paymentClient.getBalance({ address: payer });
    if (balance < totalValue + worstCaseGas) {
      return finish("failed", {
        reason: `insufficient_balance on ${paymentChain} (have ${balance}, need ~${totalValue + worstCaseGas} wei)`,
      });
    }
    trace.validation_completed_at = now();

    // ── Execute legs in order ─────────────────────────────────────
    let lastHash: Hex | undefined;
    for (const [i, leg] of mint.transactions.entries()) {
      const legChain = leg.chain ?? paymentChain;
      const client = this.deps.publicClient(legChain);
      const value = BigInt(leg.value || "0");

      if (this.deps.simulate) {
        try {
          await client.call({
            account: payer,
            to: leg.to as Address,
            data: leg.data as Hex,
            value,
          });
        } catch (err) {
          if (i === 0) {
            return finish("failed", {
              reason: "simulation_reverted",
              error: errMsg(err),
            });
          }
          // Later legs may depend on earlier legs' state changes —
          // a lone eth_call can revert spuriously; warn and continue.
          this.logger.warn(
            { collection: strategy.collection, leg: i, err },
            "cross-chain leg simulation reverted (may depend on prior legs)",
          );
        }
        trace.simulation_completed_at = now();
      }

      let gas = leg.gasLimit ? BigInt(leg.gasLimit) : DEFAULT_GAS_LIMIT;
      try {
        gas = await client.estimateGas({
          account: payer,
          to: leg.to as Address,
          data: leg.data as Hex,
          value,
        });
        gas = (gas * 120n) / 100n;
      } catch {
        this.logger.warn(
          { collection: strategy.collection, leg: i },
          "estimateGas failed; using provided/default limit",
        );
      }
      const legFees =
        legChain === paymentChain
          ? paymentFees
          : this.bumpFees(await estimateFees(client));
      this.deps.safety.assertGas(maxGasCost(gas, legFees), strategyGasCap);

      const legSigner = this.deps.signer(legChain, strategy.wallet);
      let signed: Hex | undefined;
      if (legSigner) {
        const nonce = await this.deps.nonce.reserve(client, payer);
        trace.sign_started_at = now();
        signed = await legSigner.signTransaction({
          to: leg.to as Address,
          data: leg.data as Hex,
          value,
          gas,
          nonce,
          ...(legFees.eip1559
            ? {
                maxFeePerGas: legFees.maxFeePerGas,
                maxPriorityFeePerGas: legFees.maxPriorityFeePerGas,
              }
            : { gasPrice: legFees.maxFeePerGas }),
        });
        trace.signed_at = now();
      }

      if (this.deps.dryRun || !signed) continue;

      trace.broadcast_started_at = now();
      try {
        lastHash = await client.sendRawTransaction({
          serializedTransaction: signed,
        });
      } catch (err) {
        return finish("unknown", {
          reason: `broadcast_result_unknown (leg ${i})`,
          error: errMsg(err),
        });
      }
      trace.broadcast_completed_at = now();

      try {
        const receipt = await client.waitForTransactionReceipt({
          hash: lastHash,
          timeout: this.deps.confirmationTimeoutMs,
        });
        if (receipt.status !== "success") {
          return finish("failed", {
            txHash: lastHash,
            reason: `leg_${i}_reverted_onchain`,
            blockNumber: Number(receipt.blockNumber),
          });
        }
      } catch (err) {
        return finish("unknown", {
          txHash: lastHash,
          reason: `leg_${i}_confirmation_timeout`,
          error: errMsg(err),
        });
      }
    }

    if (this.deps.dryRun || !lastHash) {
      return finish("dry_run", {
        reason: this.deps.dryRun ? "dry_run_mode" : "no_signer_configured",
      });
    }

    // ── Poll OpenSea receipt to terminal status ───────────────────
    const getReceipt = this.deps.opensea.getTransactionReceipt;
    if (mint.receiptRequest !== undefined && getReceipt) {
      const deadline = Date.now() + this.deps.confirmationTimeoutMs;
      while (Date.now() < deadline) {
        try {
          const res = await getReceipt.call(
            this.deps.opensea,
            mint.receiptRequest,
          );
          if (res.terminal) {
            trace.confirmation_received_at = now();
            if (receiptSucceeded(res.status)) {
              return finish("confirmed", { txHash: lastHash });
            }
            return finish("failed", {
              txHash: lastHash,
              reason: `cross_chain_${res.status}`,
            });
          }
        } catch (err) {
          this.logger.warn({ err }, "receipt poll failed, retrying");
        }
        await sleep(2_000);
      }
      return finish("unknown", {
        txHash: lastHash,
        reason: "receipt_poll_timeout",
      });
    }
    return finish("confirmed", { txHash: lastHash });
  }

  private async buildCrossChainWithRetry(
    strategy: Strategy,
    payer: Address,
    minter: Address,
    quantity: number,
  ): Promise<CrossChainMint> {
    let lastErr: unknown;
    for (let i = 1; i <= strategy.max_attempts; i++) {
      try {
        return await this.deps.opensea.buildCrossChainMintTransaction!(
          strategy.collection,
          {
            payer,
            minter,
            quantity,
            payment: {
              chain: strategy.payment_chain!,
              tokenAddress:
                strategy.payment_token ??
                "0x0000000000000000000000000000000000000000",
            },
          },
        );
      } catch (err) {
        lastErr = err;
        const retryable =
          err instanceof OpenSeaApiError ? err.retryable : true;
        if (!retryable || i === strategy.max_attempts) throw err;
        await sleep(Math.min(200 * 2 ** (i - 1), 2_000));
      }
    }
    throw lastErr;
  }

  private withinWindow(strategy: Strategy): boolean {
    const { start_at, end_at } = strategy.conditions;
    const t = Date.now();
    if (start_at && t < Date.parse(start_at)) return false;
    if (end_at && t > Date.parse(end_at)) return false;
    return true;
  }

  private async notify(attempt: MintAttempt): Promise<void> {
    if (!TERMINAL_STATUSES.has(attempt.status)) return;
    try {
      if (attempt.status === "confirmed") {
        await this.notifier.send(mintConfirmedEvent(attempt));
      } else if (attempt.status === "failed" || attempt.status === "unknown") {
        await this.notifier.send(mintFailedEvent(attempt));
      } else if (attempt.status === "dry_run") {
        await this.notifier.send(mintExecutedEvent(attempt, true));
      }
    } catch (err) {
      this.logger.warn({ err }, "notification failed");
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
}

/** Map a FeeEstimate to PreparedTx fee fields (EIP-1559 or legacy gasPrice). */
function feeFields(
  fees: FeeEstimate,
): Pick<PreparedTx, "maxFeePerGas" | "maxPriorityFeePerGas" | "gasPrice"> {
  return fees.eip1559
    ? {
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      }
    : { gasPrice: fees.maxFeePerGas };
}

/**
 * True when a revert looks like "stage not open yet" rather than a real
 * failure — used to tell node lag on the crossing head from a guaranteed
 * revert during pre-broadcast simulation.
 */
function isTimingRevert(err: string | undefined): boolean {
  const m = String(err ?? "").toLowerCase();
  return /not.*(active|open|started|live|begun)|stage.*(not|inactive)|too.*early|before.*start|not.*yet|sale.*not.*(start|open|active)/.test(
    m,
  );
}

/**
 * Is this failure worth retrying? Transient conditions — a gas spike that
 * may dip back under the cap, an OpenSea 429/5xx, a network hiccup — can
 * clear on their own. Terminal ones (not eligible, sold out, spend /
 * quantity / kill-switch limits) won't, so they stop the loop immediately.
 */
function isRetryableMintError(err: unknown): boolean {
  if (err instanceof SafetyViolation) return err.code === "gas_fee";
  // 429/5xx are retryable; 409 "not active" is backend lag on a stage the
  // snapshot already shows live — retry it too. 422 (allowlist / limit /
  // supply) is a genuine precondition failure — terminal.
  if (err instanceof OpenSeaApiError) return err.retryable || err.status === 409;
  return true; // network / unknown — treat as transient
}

/** Backoff between mint retries — gentle so we don't hammer the RPC/API. */
function retryBackoffMs(retries: number): number {
  return Math.min(500 * 2 ** (retries - 1), 3_000);
}

/** Normalize a stage uuid for comparison — snapshots store them dashless. */
function normUuid(u: string | undefined): string {
  return String(u ?? "").replace(/-/g, "").toLowerCase();
}

/**
 * Map a revert / simulation error to a friendly reason. Distinguishes the
 * common mint failure modes so the dashboard + logs are actionable.
 */
function classifyRevert(err: unknown): string {
  const m = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (/sold ?out|exceeds.*supply|no.*remaining|mint.*closed|stage.*ended/.test(m))
    return "sold_out";
  if (/not.*eligible|allowlist|whitelist|not.*on.*list|merkle|invalid.*proof/.test(m))
    return "not_eligible";
  if (/insufficient.*fund|exceeds.*balance|not.*enough/.test(m))
    return "insufficient_funds";
  if (/gas|fee|underpriced|replacement/.test(m)) return "gas_or_fee";
  if (/limit|max.*per.*wallet|exceeds.*wallet/.test(m)) return "wallet_limit";
  return "reverted_onchain";
}

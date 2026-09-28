import type { AttemptStore } from "@aco/database";

export class SafetyViolation extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SafetyViolation";
  }
}

export interface SafetyLimits {
  killSwitch: boolean;
  maxSpendPerTxWei: bigint;
  maxSpendPerDayWei: bigint;
  maxGasFeeWei: bigint;
  maxQuantityPerTx: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hard execution limits. Every check throws SafetyViolation — the bot
 * refuses to execute rather than degrade a limit.
 */
export class SafetyController {
  private killSwitchEngaged: boolean;

  constructor(
    private readonly limits: SafetyLimits,
    private readonly store: AttemptStore,
  ) {
    this.killSwitchEngaged = limits.killSwitch;
  }

  engageKillSwitch(): void {
    this.killSwitchEngaged = true;
  }
  releaseKillSwitch(): void {
    this.killSwitchEngaged = false;
  }
  get killSwitch(): boolean {
    return this.killSwitchEngaged;
  }

  assertLive(): void {
    if (this.killSwitchEngaged) {
      throw new SafetyViolation("kill_switch", "kill switch is engaged");
    }
  }

  assertQuantity(qty: number): void {
    if (!Number.isInteger(qty) || qty < 1) {
      throw new SafetyViolation("quantity", `invalid quantity ${qty}`);
    }
    if (qty > this.limits.maxQuantityPerTx) {
      throw new SafetyViolation(
        "quantity",
        `quantity ${qty} exceeds MAX_QUANTITY_PER_TX ${this.limits.maxQuantityPerTx}`,
      );
    }
  }

  /** Per-tx spend cap + rolling 24h aggregate cap. */
  assertCanSpend(amountWei: bigint): void {
    if (amountWei > this.limits.maxSpendPerTxWei) {
      throw new SafetyViolation(
        "spend_per_tx",
        `tx value ${amountWei} wei exceeds per-tx cap ${this.limits.maxSpendPerTxWei} wei`,
      );
    }
    const spentToday = this.store.spendSince(Date.now() - DAY_MS);
    if (spentToday + amountWei > this.limits.maxSpendPerDayWei) {
      throw new SafetyViolation(
        "spend_per_day",
        `daily spend cap would be exceeded (spent ${spentToday} + ${amountWei} > ${this.limits.maxSpendPerDayWei} wei)`,
      );
    }
  }

  /** Gas ceiling: min(global cap, per-strategy cap when provided). */
  assertGas(estimatedFeeWei: bigint, strategyCapWei?: bigint): void {
    const cap =
      strategyCapWei !== undefined && strategyCapWei < this.limits.maxGasFeeWei
        ? strategyCapWei
        : this.limits.maxGasFeeWei;
    if (estimatedFeeWei > cap) {
      throw new SafetyViolation(
        "gas_fee",
        `estimated gas fee ${estimatedFeeWei} wei exceeds cap ${cap} wei`,
      );
    }
  }
}

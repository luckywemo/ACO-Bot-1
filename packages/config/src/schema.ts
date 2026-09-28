import { z } from "zod";

/**
 * Chain identifier — any OpenSea chain name ("ethereum", "ape_chain",
 * "flow_evm", …) or viem export name. Validated at resolution time by
 * @aco/blockchain's getChain(); kept as a free-form string here because
 * config cannot import blockchain (circular dependency).
 */
export const ChainNameSchema = z
  .string()
  .min(1)
  .transform((s) => s.trim().toLowerCase());
export type ChainName = z.infer<typeof ChainNameSchema>;

/** Native-token amount expressed as number or string; normalized to string. */
const NativeAmount = z
  .union([z.string(), z.number()])
  .transform((v) => String(v));

export const StrategyConditionsSchema = z
  .object({
    /** Only mint when the active stage is a public stage. */
    require_public_mint: z.boolean().default(false),
    /** Whitelist of stage_type values allowed to trigger execution. */
    allowed_stage_types: z.array(z.string()).optional(),
    /** Per-transaction gas ceiling in native units. */
    max_gas_fee: NativeAmount.optional(),
    /** Stop monitoring this collection after a successful mint. */
    stop_after_success: z.boolean().default(true),
    /**
     * Mint the wallet's full eligibility cap (from getEligibility
     * max_total_mintable_by_wallet) instead of the fixed `quantity`.
     */
    mint_max: z.boolean().default(false),
    /** Optional ISO-8601 window during which execution is allowed. */
    start_at: z.string().optional(),
    end_at: z.string().optional(),
  })
  .default({});

export const StrategySchema = z.object({
  /** OpenSea collection slug. */
  collection: z.string().min(1),
  chain: ChainNameSchema,
  quantity: z.number().int().min(1).max(100).default(1),
  /** Per-token price ceiling in native units. */
  max_price: NativeAmount,
  auto_mint: z.boolean().default(false),
  /** Wallet identifier (multi-wallet ready; "default" for MVP). */
  wallet: z.string().default("default"),
  /** Max pre-broadcast attempts per detected mint window. */
  max_attempts: z.number().int().min(1).max(50).default(3),
  /** Optional per-strategy base poll interval override (ms). */
  poll_interval_ms: z.number().int().min(100).optional(),
  /**
   * Cross-chain mint: pay from this chain instead of the drop's chain
   * (e.g. "robinhood"). Omit for same-chain mints.
   */
  payment_chain: ChainNameSchema.optional(),
  /** Payment token contract on payment_chain; zero address = native. */
  payment_token: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "payment_token must be an EVM address")
    .optional(),
  conditions: StrategyConditionsSchema,
});
export type Strategy = z.infer<typeof StrategySchema>;

export const StrategiesFileSchema = z.object({
  version: z.number().default(1),
  defaults: z.record(z.unknown()).optional(),
  strategies: z.array(StrategySchema).min(1, "at least one strategy is required"),
});
export type StrategiesFile = z.infer<typeof StrategiesFileSchema>;

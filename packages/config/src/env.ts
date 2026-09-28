import { z } from "zod";

const envBool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined ? def : v === "true" || v === "1" || v === "yes",
    );

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  OPENSEA_API_KEY: z.string().min(1, "OPENSEA_API_KEY is required"),
  OPENSEA_API_BASE: z.string().url().default("https://api.opensea.io"),
  OPENSEA_RPS: z.coerce.number().positive().default(4),
  OPENSEA_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  PRIVATE_KEY: z
    .string()
    .regex(
      /^0x[0-9a-fA-F]{64}$/,
      "PRIVATE_KEY must be a 0x-prefixed 32-byte hex string",
    )
    .optional()
    .or(z.literal("").transform(() => undefined)),
  MINTER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "MINTER_ADDRESS must be an EVM address")
    .optional()
    .or(z.literal("").transform(() => undefined)),

  DRY_RUN: envBool(true),
  KILL_SWITCH: envBool(false),
  SIMULATE_BEFORE_SEND: envBool(true),
  /** Interactive setup wizard on startup (only when stdin is a TTY). */
  ACO_WIZARD: envBool(true),

  MAX_SPEND_PER_TX_ETH: z.coerce.number().positive().default(0.5),
  MAX_SPEND_PER_DAY_ETH: z.coerce.number().positive().default(2),
  MAX_GAS_FEE_ETH: z.coerce.number().positive().default(0.02),
  MAX_QUANTITY_PER_TX: z.coerce.number().int().min(1).default(10),
  CONFIRMATION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** % bump on estimated gas fees — outbids competing mint txs. */
  PRIORITY_FEE_BUMP_PCT: z.coerce.number().min(0).default(0),

  // ── Snipe engine (contest-mint speed path) ─────────────────────────
  /** Master switch for the pre-arm/snipe path on scheduled stages. */
  SNIPER_ENABLED: envBool(true),
  /** Arm the snipe this many ms before the stage startTime. */
  SNIPER_ARM_MS: z.coerce.number().int().positive().default(10_000),
  /** Start the tight build loop this many ms before startTime. */
  SNIPER_BUILD_LEAD_MS: z.coerce.number().int().positive().default(4_000),
  /** Retry interval (ms) between build attempts inside the loop. */
  SNIPER_BUILD_INTERVAL_MS: z.coerce.number().int().min(20).default(120),
  /** Give up building this many ms after startTime if it never succeeds. */
  SNIPER_BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  /**
   * Broadcast lead relative to startTime. 0 = broadcast the moment the
   * signed tx is ready and startTime has passed. Negative values broadcast
   * early (tx may land in a pre-start block and revert — use with care).
   */
  SNIPER_BROADCAST_LEAD_MS: z.coerce.number().int().default(0),
  /** Fixed gas limit for snipes — skips the estimateGas RPC on the critical path. */
  SNIPER_GAS_LIMIT: z.coerce.number().int().positive().default(350_000),
  /** Extra % fee bump applied to snipe transactions on top of PRIORITY_FEE_BUMP_PCT. */
  SNIPER_FEE_BUMP_PCT: z.coerce.number().min(0).default(0),
  /**
   * eth_call the snipe tx against `latest` before broadcasting — skips the
   * broadcast on a guaranteed revert so no gas is wasted. Adds one RPC
   * round-trip to the critical path; set false for maximum speed.
   */
  SNIPER_SIMULATE: envBool(true),

  // ── Direct contract mint (bypass OpenSea build) ────────────────────
  /**
   * Detect a public-mint selector on the NFT contract and pre-sign the
   * calldata locally — removes the OpenSea build round-trip from the snipe
   * hot path. Public stages only; gated/proof mints still use OpenSea.
   */
  DIRECT_MINT_ENABLED: envBool(true),
  /** % padding on msg.value for a direct mint to cover contract mint fees. */
  DIRECT_MINT_VALUE_PAD_PCT: z.coerce.number().min(0).default(0),

  // ── Stuck-transaction speed-up ─────────────────────────────────────
  /** Re-broadcast a replacement tx (same nonce, higher fee) if pending this long. */
  SPEEDUP_AFTER_MS: z.coerce.number().int().positive().default(12_000),
  /** % fee bump applied to each speed-up replacement. */
  SPEEDUP_FEE_BUMP_PCT: z.coerce.number().min(1).default(15),
  /** Max number of speed-up replacements before giving up. */
  SPEEDUP_MAX: z.coerce.number().int().min(0).default(3),

  // ── Floor-price guard ──────────────────────────────────────────────
  /** Skip a mint when the collection floor is below the mint price. */
  FLOOR_GUARD: envBool(false),
  /** Required floor/mint ratio — e.g. 1.1 only mints if floor ≥ 110% of price. */
  FLOOR_MIN_RATIO: z.coerce.number().positive().default(1.0),

  // ── Drop auto-discovery ────────────────────────────────────────────
  DISCOVER_ENABLED: envBool(false),
  /** Poll listDrops this often (ms). */
  DISCOVER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** Only auto-add drops on these chains (comma-separated); empty = all. */
  DISCOVER_CHAINS: z.string().optional().transform((v) => v || undefined),
  /** Only auto-add drops at or below this mint price (native units). */
  DISCOVER_MAX_PRICE_ETH: z.coerce.number().min(0).default(0),
  /** Auto-added strategies mint this many and auto-mint by default. */
  DISCOVER_QUANTITY: z.coerce.number().int().min(1).default(1),
  DISCOVER_AUTO_MINT: envBool(false),

  STRATEGIES_FILE: z.string().default("strategies.yaml"),
  /** JSON file for persisted mint attempts (survives restarts). */
  ATTEMPTS_FILE: z.string().default("attempts.json"),
  /** JSON file for persisted OpenSea wallet-auth PATs (SIWE). */
  WALLET_AUTH_FILE: z.string().default("wallet-auth.json"),

  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().default(4000),
  CORS_ORIGIN: z.string().default("*"),

  DISCORD_WEBHOOK_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  TELEGRAM_BOT_TOKEN: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  TELEGRAM_CHAT_ID: z
    .string()
    .optional()
    .transform((v) => v || undefined),

  DATABASE_URL: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  REDIS_URL: z
    .string()
    .optional()
    .transform((v) => v || undefined),
});

export type Env = z.infer<typeof EnvSchema> & {
  /** chain name -> ordered list of RPC endpoints (failover order). */
  rpcEndpoints: Record<string, string[]>;
  /**
   * chain name -> private-relay endpoints (Flashbots Protect, MEV-Blocker,
   * bloXroute, …). Broadcast in parallel with public RPCs so the tx reaches
   * builders/validators directly and avoids mempool sniping.
   */
  relayEndpoints: Record<string, string[]>;
  /**
   * chain name -> ws(s):// endpoints for the newHeads block watcher
   * (WSS_<CHAIN>). Drives block-boundary broadcast timing and per-block
   * speed-up. Falls back to HTTP polling when unset.
   */
  wssEndpoints: Record<string, string[]>;
  /**
   * Named wallets from PRIVATE_KEY_<NAME> (name lowercased). Strategies
   * reference these via their `wallet` field; "default" maps to
   * PRIVATE_KEY when set.
   */
  wallets: Record<string, string>;
};

const RPC_KEY = /^RPC_([A-Z0-9_]+)$/;
const RELAY_KEY = /^RELAY_([A-Z0-9_]+)$/;
const WSS_KEY = /^WSS_([A-Z0-9_]+)$/;
const WALLET_KEY = /^PRIVATE_KEY_([A-Z0-9_]+)$/;
const KEY_HEX = /^0x[0-9a-fA-F]{64}$/;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.parse(source);
  const rpcEndpoints: Record<string, string[]> = {};
  const relayEndpoints: Record<string, string[]> = {};
  const wssEndpoints: Record<string, string[]> = {};
  const wallets: Record<string, string> = {};
  const badKeys: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (!value) continue;
    const wss = WSS_KEY.exec(key);
    if (wss) {
      const chain = wss[1]!.toLowerCase();
      const urls = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (urls.length) wssEndpoints[chain] = urls;
      continue;
    }
    const relay = RELAY_KEY.exec(key);
    if (relay) {
      const chain = relay[1]!.toLowerCase();
      const urls = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (urls.length) relayEndpoints[chain] = urls;
      continue;
    }
    const rpc = RPC_KEY.exec(key);
    if (rpc) {
      const chain = rpc[1]!.toLowerCase();
      const urls = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (urls.length) rpcEndpoints[chain] = urls;
      continue;
    }
    const wallet = WALLET_KEY.exec(key);
    if (wallet) {
      const name = wallet[1]!.toLowerCase();
      if (KEY_HEX.test(value.trim())) wallets[name] = value.trim();
      else badKeys.push(key);
    }
  }
  if (badKeys.length) {
    throw new Error(
      `Invalid private key format in ${badKeys.join(", ")} — expected 0x-prefixed 32-byte hex`,
    );
  }
  if (parsed.PRIVATE_KEY) wallets.default = parsed.PRIVATE_KEY;
  return { ...parsed, rpcEndpoints, relayEndpoints, wssEndpoints, wallets };
}

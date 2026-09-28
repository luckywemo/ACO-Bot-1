import { readFileSync } from "node:fs";
import YAML from "yaml";
import { ZodError } from "zod";
import { StrategiesFileSchema, type Strategy } from "./schema";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

export function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

/** Env-safe wallet name — matches PRIVATE_KEY_<NAME> normalization. */
function cleanWalletName(n: unknown): string {
  return String(n ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Resolve a strategy `wallet` spec into concrete wallet names so a drop can
 * be armed for many wallets in one entry instead of one strategy each:
 *   "all" | "*"        → every configured wallet name
 *   ["a","b"] | "a,b"  → those names
 *   "name" | undefined → that one name (undefined → "default")
 */
export function resolveWalletSpec(
  spec: unknown,
  configured: string[],
): string[] {
  const raw = String(spec ?? "").trim().toLowerCase();
  if (!Array.isArray(spec) && (raw === "all" || raw === "*")) {
    return configured.length ? configured : ["default"];
  }
  const parts = Array.isArray(spec) ? spec : raw.split(",");
  const names = parts.map(cleanWalletName).filter(Boolean);
  return names.length ? names : ["default"];
}

/**
 * Load and validate a strategies YAML file. Top-level `defaults` are
 * deep-merged under each entry of `strategies` before validation. A `wallet`
 * of "all"/"*"/a list/comma-string expands into one strategy per wallet —
 * `walletNames` should be the configured wallet names (PRIVATE_KEY_<NAME>).
 */
export function loadStrategiesFile(
  path: string,
  walletNames: string[] = [],
): Strategy[] {
  const raw = readFileSync(path, "utf8");
  const doc = YAML.parse(raw) as Record<string, unknown> | null;
  if (!isPlainObject(doc)) {
    throw new Error(`Strategies file ${path} is empty or invalid YAML`);
  }
  const defaults = isPlainObject(doc.defaults) ? doc.defaults : {};
  const rawStrategies = Array.isArray(doc.strategies) ? doc.strategies : [];
  const merged = rawStrategies.map((s) =>
    isPlainObject(s) ? deepMerge(defaults, s) : s,
  );
  // Expand multi-wallet specs into one concrete entry per wallet.
  const expanded = merged.flatMap((s) =>
    isPlainObject(s)
      ? resolveWalletSpec(s.wallet, walletNames).map((w) => ({ ...s, wallet: w }))
      : [s],
  );
  try {
    return StrategiesFileSchema.parse({ ...doc, strategies: expanded }).strategies;
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`Invalid strategies file ${path}:\n${formatZodError(err)}`);
    }
    throw err;
  }
}

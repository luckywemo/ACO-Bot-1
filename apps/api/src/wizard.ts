import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { formatEther, type Hex } from "viem";
import { estimateFees, maxGasCost } from "@aco/blockchain";
import { snapshotFromDrop } from "@aco/monitoring";
import type { Strategy } from "@aco/config";
import type { Drop, DropStage } from "@aco/opensea";
import type { AcoBot } from "./bot";

/** Rough per-tx gas used for the funding estimate (mint + margin). */
const GAS_ESTIMATE = 200_000n;
const KEY_HEX = /^0x[0-9a-fA-F]{64}$/;

/** Extract a collection slug from an OpenSea link or bare slug. */
export function parseOpenSeaLink(input: string): string | null {
  const s = input.trim();
  const m = /opensea\.io\/collection\/([a-z0-9-]+)/i.exec(s);
  if (m) return m[1]!.toLowerCase();
  if (/^[a-z0-9-]+$/i.test(s) && !s.includes("/")) return s.toLowerCase();
  return null;
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtStage(stage: DropStage | null | undefined): string {
  if (!stage) return "none";
  const price = stage.price ? `${formatEther(BigInt(stage.price))} ETH` : "?";
  const start = stage.start_time ?? "?";
  const cap = stage.max_per_wallet ?? stage.maxPerWallet ?? "?";
  return `${stage.stage_type ?? "?"} @ ${price} · starts ${start} · max/wallet ${cap}`;
}

/**
 * Interactive setup wizard. Runs before the monitor starts: pick self or
 * client mode, paste an OpenSea link, get time/eligibility/funding, then
 * arm the mint. Strategies added here live for this process only — add
 * them to strategies.yaml to persist.
 */
export async function runWizard(bot: AcoBot): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = (q: string) => rl.question(q);
  const askYN = async (q: string, def: boolean) => {
    const a = (await ask(`${q} [${def ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
    return a === "" ? def : a === "y" || a === "yes";
  };

  try {
    console.log("\n── ACO mint setup ──────────────────────────────");
    let first = true;
    for (;;) {
      // Under `tsx watch` stdin is swallowed — if the first question gets
      // no answer in 45s, skip the wizard rather than hang the boot.
      const raw = first
        ? await Promise.race([
            ask("Mint for yourself or for clients? [self/clients/done] "),
            new Promise<null>((res) => setTimeout(() => res(null), 45_000)),
          ])
        : await ask("Mint for yourself or for clients? [self/clients/done] ");
      first = false;
      if (raw === null) {
        console.log("  no input — starting monitor (use `npm start` for the wizard)");
        break;
      }
      const mode = raw.trim().toLowerCase();
      if (mode === "done" || mode === "" || mode === "skip") break;
      if (mode !== "self" && mode !== "clients" && mode !== "client") {
        console.log('  answer "self", "clients", or "done"');
        continue;
      }

      // ── Wallet ────────────────────────────────────────────────
      let wallet = "default";
      if (mode === "self") {
        if (!bot.signers.has("default")) {
          console.log("  no PRIVATE_KEY configured — mints will be dry-run only");
          const key = (await ask("  paste a private key now? (0x… or Enter to skip) ")).trim();
          if (key && KEY_HEX.test(key)) bot.signers.register("default", key as Hex);
        }
      } else {
        const name = (
          await ask("  client name (e.g. alice): ")
        )
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "");
        if (!name) {
          console.log("  invalid name");
          continue;
        }
        wallet = name;
        if (!bot.signers.has(name)) {
          const key = (
            await ask(`  private key for "${name}" (0x…): `)
          ).trim();
          if (!KEY_HEX.test(key)) {
            console.log("  invalid key — expected 0x + 64 hex chars");
            continue;
          }
          bot.signers.register(name, key as Hex);
        }
        console.log(`  wallet "${wallet}" → ${bot.signers.address("ethereum", wallet)}`);
      }

      // ── Drop link ─────────────────────────────────────────────
      const link = await ask("  OpenSea drop link (or slug): ");
      const slug = parseOpenSeaLink(link);
      if (!slug) {
        console.log("  couldn't parse — use https://opensea.io/collection/<slug>");
        continue;
      }

      let drop: Drop;
      try {
        drop = await bot.opensea.getDrop(slug);
      } catch (err) {
        console.log(`  drop lookup failed: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      const snap = snapshotFromDrop(drop);
      bot.snapshots.set(slug, snap);

      // ── Report: what / when ───────────────────────────────────
      console.log(`\n  ${drop.collection_name ?? slug} (${slug})`);
      console.log(`  chain:   ${drop.chain}`);
      console.log(`  status:  ${snap.status}${drop.is_minting ? " (minting)" : ""}`);
      console.log(`  active:  ${fmtStage(drop.active_stage)}`);
      if (snap.status === "scheduled") {
        console.log(`  next:    ${fmtStage(drop.next_stage)}`);
        if (snap.msUntilNextStage !== undefined) {
          console.log(`  starts in: ${fmtCountdown(snap.msUntilNextStage)}`);
        }
      }

      // ── Eligibility ───────────────────────────────────────────
      const address =
        bot.signers.address(drop.chain, wallet) ?? bot.env.MINTER_ADDRESS;
      if (address) {
        const elig = await bot.opensea.getEligibility(slug, address);
        if (elig) {
          for (const st of elig.stages) {
            console.log(
              `  eligibility: stage ${st.stage_uuid ?? "?"} → ` +
                `${st.is_eligible ? "ELIGIBLE" : "not eligible"}` +
                (st.remaining !== undefined ? ` · remaining ${st.remaining}` : "") +
                (st.max_per_wallet !== undefined ? ` · max/wallet ${st.max_per_wallet}` : ""),
            );
          }
        } else {
          console.log("  eligibility: unavailable with API-key auth (verified at mint time)");
        }
      } else {
        console.log("  eligibility: no wallet address to check");
      }

      // ── Quantity + payment chain ──────────────────────────────
      const qty = Number((await ask("  quantity [1]: ")).trim() || "1");
      if (!Number.isInteger(qty) || qty < 1) {
        console.log("  invalid quantity");
        continue;
      }
      const payChain = (
        await ask(`  pay on chain [${drop.chain}]: `)
      ).trim().toLowerCase() || drop.chain;

      // ── Funding estimate ──────────────────────────────────────
      const stage = drop.active_stage ?? drop.next_stage;
      const priceWei = stage?.price ? BigInt(stage.price) : 0n;
      const costWei = priceWei * BigInt(qty);
      let gasWei = 0n;
      let balance: bigint | undefined;
      if (address) {
        try {
          const client = bot.chains.get(payChain);
          const fees = await estimateFees(client);
          gasWei = maxGasCost(GAS_ESTIMATE, fees);
          balance = await client.getBalance({ address: address as Hex });
        } catch {
          console.log(`  (couldn't reach ${payChain} RPC — skipping balance check)`);
        }
      }
      console.log(
        `  funding: ~${formatEther(costWei + gasWei)} native ` +
          `(mint ${formatEther(costWei)} + est gas ${formatEther(gasWei)})` +
          (balance !== undefined
            ? ` · balance ${formatEther(balance)} ${balance >= costWei + gasWei ? "✓" : "— INSUFFICIENT"}`
            : ""),
      );

      // ── Arm ───────────────────────────────────────────────────
      const defMax = priceWei ? formatEther((priceWei * 120n) / 100n) : "0.05";
      const maxPrice = (await ask(`  max price per NFT [${defMax}]: `)).trim() || defMax;
      const autoMint = await askYN("  auto-mint when it goes live?", true);

      const strategy: Strategy = {
        collection: slug,
        chain: drop.chain,
        quantity: qty,
        max_price: maxPrice,
        auto_mint: autoMint,
        wallet,
        max_attempts: 3,
        ...(payChain !== drop.chain ? { payment_chain: payChain } : {}),
        conditions: {
          require_public_mint: false,
          stop_after_success: true,
          mint_max: false,
        },
      };
      if (bot.addStrategy(strategy)) {
        console.log(
          `  ✓ armed: ${slug} · ${qty}x · wallet "${wallet}" · ` +
            `${autoMint ? "auto-mint on live" : "manual trigger only"}\n`,
        );
      } else {
        console.log(
          `  ✓ already armed via strategies.yaml — existing config kept\n`,
        );
      }
    }
    console.log("────────────────────────────────────────────────\n");
  } finally {
    rl.close();
  }
}

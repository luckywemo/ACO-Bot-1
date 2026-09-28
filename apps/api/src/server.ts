import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther, type Hex } from "viem";
import YAML from "yaml";
import { ZodError } from "zod";
import {
  formatZodError,
  resolveWalletSpec,
  StrategySchema,
  type Env,
  type Strategy,
} from "@aco/config";
import type { CollectionInfo, Drop, DropStage } from "@aco/opensea";
import type { AcoBot } from "./bot";
import { parseOpenSeaLink } from "./wizard";

const DASHBOARD_HTML = fileURLToPath(new URL("./dashboard.html", import.meta.url));
const DROPS_HTML = fileURLToPath(new URL("./drops.html", import.meta.url));
/** Repo root — apps/api/src is three levels deep (same as index.ts). */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export function buildServer(bot: AcoBot, env: Env): FastifyInstance {
  const app = Fastify({ logger: false });
  const strategiesPath = isAbsolute(env.STRATEGIES_FILE)
    ? env.STRATEGIES_FILE
    : resolve(ROOT, env.STRATEGIES_FILE);
  const envPath = join(ROOT, ".env");

  void app.register(cors, { origin: env.CORS_ORIGIN });

  app.get("/health", async () => ({ ok: true, ts: Date.now() }));

  // Dashboard — same origin as the API, so the page's fetches can never
  // hit a wrong port/host. Read per-request so edits don't need a restart.
  app.get("/", async (_req, reply) => {
    const html = await readFile(DASHBOARD_HTML, "utf8");
    return reply
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(html);
  });

  // Drops discovery page — same origin as the API.
  app.get("/drops", async (_req, reply) => {
    const html = await readFile(DROPS_HTML, "utf8");
    return reply
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(html);
  });

  app.get("/api/status", async () => bot.status());

  app.get("/api/strategies", async () => bot.strategies);

  /**
   * Add a strategy at runtime and persist it to STRATEGIES_FILE so it
   * survives restarts. Accepts an OpenSea link or bare slug; the chain is
   * auto-detected from the drop (which also validates the collection).
   */
  app.post("/api/strategies", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const slug = parseOpenSeaLink(String(body.collection ?? ""));
    if (!slug) {
      return reply
        .code(400)
        .send({ error: "invalid collection — paste an OpenSea link or slug" });
    }
    let drop;
    try {
      drop = await bot.opensea.getDrop(slug);
      const { snapshotFromDrop } = await import("@aco/monitoring");
      bot.snapshots.set(slug, snapshotFromDrop(drop));
    } catch (err) {
      return reply.code(502).send({
        error: `drop lookup failed: ${err instanceof Error ? err.message : err}`,
      });
    }
    const chain =
      typeof body.chain === "string" && body.chain.trim()
        ? body.chain.trim().toLowerCase()
        : drop.chain;
    // Smart ceiling: 120% of the upcoming stage price, else a flat default.
    const stage = drop.active_stage ?? drop.next_stage;
    const stagePrice = stage?.price ? BigInt(stage.price) : 0n;
    const defMax = stagePrice ? formatEther((stagePrice * 120n) / 100n) : "0.05";
    // Resolve the wallet spec — "all"/"*"/a list/comma-string arms the drop
    // for many wallets in one call instead of one strategy each.
    const walletNames = resolveWalletSpec(body.wallet, bot.signers.walletNames);
    const privKey =
      typeof body.private_key === "string" ? body.private_key.trim() : "";
    if (privKey && walletNames.length > 1) {
      return reply.code(400).send({
        error:
          "private_key only applies to a single wallet — add wallets one at a time when supplying a key",
      });
    }
    if (privKey && !/^0x[0-9a-fA-F]{64}$/.test(privKey)) {
      return reply
        .code(400)
        .send({ error: "invalid private_key — expected 0x + 64 hex chars" });
    }

    const base = {
      collection: slug,
      chain,
      quantity: body.quantity !== undefined ? Number(body.quantity) : 1,
      max_price:
        typeof body.max_price === "string" && body.max_price.trim()
          ? body.max_price.trim()
          : defMax,
      auto_mint: body.auto_mint !== undefined ? Boolean(body.auto_mint) : true,
      max_attempts: 3,
      ...(typeof body.payment_chain === "string" && body.payment_chain.trim()
        ? { payment_chain: body.payment_chain.trim().toLowerCase() }
        : {}),
      conditions: {
        require_public_mint:
          body.require_public_mint !== undefined
            ? Boolean(body.require_public_mint)
            : true,
        stop_after_success:
          body.stop_after_success !== undefined
            ? Boolean(body.stop_after_success)
            : true,
        mint_max:
          body.mint_max !== undefined ? Boolean(body.mint_max) : false,
      },
    };

    const created: Strategy[] = [];
    const skipped: string[] = [];
    let persisted = true;
    let keyPersisted = false;
    let persistWarning: string | undefined;

    for (const walletName of walletNames) {
      let strategy: Strategy;
      try {
        strategy = StrategySchema.parse({ ...base, wallet: walletName });
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof ZodError ? formatZodError(err) : String(err),
        });
      }
      // A client wallet's key registers under the strategy's wallet name and
      // persists to .env so it survives restarts. Register before addStrategy
      // so the "no key for wallet" warning doesn't fire.
      if (privKey) {
        bot.signers.register(walletName, privKey as Hex);
        try {
          persistWalletKey(envPath, walletName, privKey);
          keyPersisted = true;
        } catch { /* runtime-only wallet — reported in the response */ }
      }
      if (!bot.addStrategy(strategy)) {
        skipped.push(walletName);
        continue;
      }
      try {
        persistStrategy(strategiesPath, strategy);
      } catch (err) {
        // Armed in-memory but not saved — still works until restart.
        persisted = false;
        persistWarning = err instanceof Error ? err.message : String(err);
      }
      created.push(strategy);
    }

    if (!created.length) {
      return reply.code(409).send({
        error:
          `"${slug}" already armed for ${skipped.map((w) => `"${w}"`).join(", ")} — ` +
          `give this client a different wallet name`,
      });
    }
    return {
      ok: true,
      strategy: created[0], // first — keeps single-wallet responses unchanged
      strategies: created,
      count: created.length,
      ...(skipped.length ? { skipped } : {}),
      persisted,
      keyPersisted,
      ...(persistWarning ? { warning: persistWarning } : {}),
    };
  });

  // Remove one client — disarm in-memory and drop it from strategies.yaml.
  app.delete("/api/strategies/:collection/:wallet", async (req, reply) => {
    const { collection, wallet } = req.params as {
      collection: string;
      wallet: string;
    };
    const removed = bot.removeStrategy(collection, wallet);
    let persisted = false;
    try {
      persisted = removeStrategyFromYaml(strategiesPath, collection, wallet);
    } catch { /* disarmed in-memory; yaml removal failed */ }
    if (!removed && !persisted) {
      return reply
        .code(404)
        .send({ error: `no strategy for "${collection}" wallet "${wallet}"` });
    }
    return { ok: true, collection, wallet, removed, persisted };
  });

  // Snapshots carry bigint priceWei — JSON.stringify throws on bigint,
  // so serialize explicitly or this 500s and the dashboard goes "offline".
  app.get("/api/drops", async (_req, reply) => {
    const json = JSON.stringify([...bot.snapshots.values()], (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    return reply.type("application/json").send(json);
  });

  /**
   * Drops explorer — normalized listDrops feed for the /drops page.
   * Cached 30s + singleflight so the page (and auto-refresh) never burns
   * extra OpenSea quota; the client call itself is low-priority.
   */
  let exploreCache: { ts: number; json: string } | undefined;
  let exploreInflight: Promise<string> | undefined;
  app.get("/api/drops/explore", async (_req, reply) => {
    const TTL = 30_000;
    if (exploreCache && Date.now() - exploreCache.ts < TTL) {
      return reply.type("application/json").send(exploreCache.json);
    }
    exploreInflight ??= (async () => {
      const drops = await bot.opensea.listDrops();
      const armed = new Set(bot.strategies.map((s) => s.collection));
      const items = drops.map((d) => normalizeDropCard(d, armed.has(d.collection_slug)));
      return JSON.stringify({ fetched_at: Date.now(), drops: items });
    })().finally(() => {
      exploreInflight = undefined;
    });
    try {
      const json = await exploreInflight;
      exploreCache = { ts: Date.now(), json };
      return reply.type("application/json").send(json);
    } catch (err) {
      if (exploreCache) {
        // Serve stale rather than error — the feed is best-effort.
        return reply.type("application/json").send(exploreCache.json);
      }
      return reply.code(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Trending collections — the ranked /collections feed (7d volume etc.).
   * These aren't necessarily drops; the page labels them and the modal
   * lookup reveals whether a live/scheduled drop exists. Cached 60s per
   * ordering; low-priority calls.
   */
  const TRENDING_ORDERS = new Set([
    "seven_day_volume",
    "one_day_volume",
    "thirty_day_volume",
    "market_cap",
    "created_date",
  ]);
  const trendingCache = new Map<string, { ts: number; json: string }>();
  app.get("/api/drops/trending", async (req, reply) => {
    const q = req.query as { order?: string; limit?: string };
    const order = TRENDING_ORDERS.has(q.order ?? "")
      ? q.order!
      : "seven_day_volume";
    const limit = Math.min(Math.max(Number(q.limit ?? 24) || 24, 1), 50);
    const cacheKey = `${order}:${limit}`;
    const hit = trendingCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < 60_000) {
      return reply.type("application/json").send(hit.json);
    }
    try {
      const { collections } = await bot.opensea.listCollections({
        orderBy: order,
        limit,
      });
      const armed = new Set(bot.strategies.map((s) => s.collection));
      const json = JSON.stringify({
        order,
        fetched_at: Date.now(),
        collections: collections.map((c) =>
          collectionCard(c, armed.has(c.slug)),
        ),
      });
      trendingCache.set(cacheKey, { ts: Date.now(), json });
      return reply.type("application/json").send(json);
    } catch (err) {
      if (hit) return reply.type("application/json").send(hit.json);
      return reply.code(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Market board — one aggregated payload for the terminal-style /drops
   * page: the ranked collection list enriched with stats (floor, 1d/7d
   * volume & sales), the newest collections, and the live drops feed.
   * Floor deltas are computed against the previous snapshot (real
   * movement rather than a fabricated 24h change). Cached 60s per
   * order+chain with per-key singleflight; upstream calls are all
   * low-priority so board refreshes never block a mint.
   */
  const BOARD_ORDERS = new Set([
    "one_day_volume",
    "seven_day_volume",
    "thirty_day_volume",
    "market_cap",
  ]);
  const boardCache = new Map<string, { ts: number; json: string }>();
  const boardInflight = new Map<string, Promise<string>>();
  /** slug -> last seen floor, for computing real floor deltas. */
  const floorBaseline = new Map<string, { ts: number; floor: number }>();
  /** slug -> supply samples of live drops → real mints/min velocity. */
  const supplyHistory = new Map<
    string,
    Array<{ ts: number; supply: number }>
  >();
  /** slug -> first time it appeared on the board (for "listed Xm ago"). */
  const firstSeen = new Map<string, number>();
  app.get("/api/drops/board", async (req, reply) => {
    const q = req.query as { order?: string; chain?: string };
    const order = BOARD_ORDERS.has(q.order ?? "")
      ? q.order!
      : "seven_day_volume";
    const chain = q.chain && q.chain !== "all" ? q.chain : undefined;
    const cacheKey = `${order}:${chain ?? "all"}`;
    const hit = boardCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < 20_000) {
      return reply.type("application/json").send(hit.json);
    }
    let inflight = boardInflight.get(cacheKey);
    inflight ??= (async () => {
      const armed = new Set(bot.strategies.map((s) => s.collection));
      const [trendRes, newRes, drops] = await Promise.all([
        bot.opensea.listCollections({ orderBy: order, chain, limit: 20 }),
        bot.opensea.listCollections({
          orderBy: "created_date",
          chain,
          limit: 20,
        }),
        bot.opensea.listDrops().catch(() => [] as Drop[]),
      ]);
      const visible = trendRes.collections.slice(0, 15);
      const statsArr = await Promise.all(
        visible.map((c) => bot.opensea.getCollectionStats(c.slug)),
      );
      const dropSlugs = new Set(drops.map((d) => d.collection_slug));
      const now = Date.now();
      const seen = (slug: string): number => {
        const t = firstSeen.get(slug);
        if (t) return t;
        firstSeen.set(slug, now);
        return now;
      };
      // Sample live-drop supply every build → real mint velocity
      // (mints/min over the trailing ~15min window). Supply moves with
      // every mint; OpenSea's volume stats lag far behind.
      const dropCards = drops.map((d) =>
        normalizeDropCard(d, armed.has(d.collection_slug)),
      );
      for (const c of dropCards) {
        const supply = Number(c.total_supply);
        if (!c.is_minting || !Number.isFinite(supply)) continue;
        const arr = supplyHistory.get(c.slug) ?? [];
        const last = arr[arr.length - 1];
        if (!last || last.supply !== supply) arr.push({ ts: now, supply });
        while (arr.length > 2 && now - arr[0].ts > 15 * 60_000) arr.shift();
        if (arr.length > 60) arr.splice(0, arr.length - 60);
        supplyHistory.set(c.slug, arr);
        const spanMs = arr[arr.length - 1].ts - arr[0].ts;
        if (arr.length >= 2 && spanMs >= 10_000) {
          const rate = ((supply - arr[0].supply) / spanMs) * 60_000;
          (c as Record<string, unknown>).mints_per_min =
            Math.max(0, Math.round(rate * 10) / 10);
        }
        (c as Record<string, unknown>).first_seen = seen(c.slug);
      }
      const market = visible.map((c, i) => {
        const s = statsArr[i];
        const floor = s?.floor_price;
        let floor_delta_pct: number | null = null;
        if (floor != null && floor > 0) {
          const prev = floorBaseline.get(c.slug);
          if (!prev) {
            floorBaseline.set(c.slug, { ts: now, floor });
          } else if (now - prev.ts >= 3 * 60_000 && prev.floor > 0) {
            // Rolling ~3min window — delta vs the snapshot, then rebase.
            floor_delta_pct =
              Math.round(((floor - prev.floor) / prev.floor) * 1000) / 10;
            floorBaseline.set(c.slug, { ts: now, floor });
          }
        }
        return {
          ...collectionCard(c, armed.has(c.slug)),
          has_drop: dropSlugs.has(c.slug),
          floor: floor ?? null,
          floor_symbol: s?.floor_price_symbol ?? null,
          vol_1d: s?.intervals.one_day?.volume ?? null,
          vol_7d: s?.intervals.seven_day?.volume ?? null,
          vol_30d: s?.intervals.thirty_day?.volume ?? null,
          sales_1d: s?.intervals.one_day?.sales ?? null,
          owners: s?.num_owners ?? null,
          floor_delta_pct,
        };
      });
      const trendSlugs = new Set(visible.map((c) => c.slug));
      const new_mints = newRes.collections
        .filter((c) => !trendSlugs.has(c.slug))
        .slice(0, 15)
        .map((c) => ({
          ...collectionCard(c, armed.has(c.slug)),
          has_drop: dropSlugs.has(c.slug),
          first_seen: seen(c.slug),
        }));
      return JSON.stringify({
        order,
        chain: chain ?? "all",
        fetched_at: now,
        market,
        new_mints,
        drops: dropCards,
      });
    })().finally(() => {
      boardInflight.delete(cacheKey);
    });
    boardInflight.set(cacheKey, inflight);
    try {
      const json = await inflight;
      boardCache.set(cacheKey, { ts: Date.now(), json });
      return reply.type("application/json").send(json);
    } catch (err) {
      if (hit) return reply.type("application/json").send(hit.json);
      return reply.code(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Name search — GET /api/v2/search resolves arbitrary names into
   * collection hits. It isn't fuzzy ("urchin friends" misses
   * urchin-frens), so on a miss we search each word separately, merge,
   * and rank by token overlap — then fall back to slug candidates for
   * unindexed collections. Hits are then checked for a live drop so the
   * results can badge them. Cached 60s per query.
   */
  const searchCache = new Map<string, { ts: number; cols: CollectionInfo[] }>();
  const trySearch = async (q: string): Promise<CollectionInfo[]> => {
    try {
      return await bot.opensea.search(q);
    } catch {
      return [];
    }
  };
  const searchCollections = async (raw: string): Promise<CollectionInfo[]> => {
    const direct = await trySearch(raw);
    if (direct.length) return rankByQuery(raw, direct);
    const words = [
      ...new Set(raw.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)),
    ].slice(0, 4);
    if (words.length > 1) {
      const merged = new Map<string, CollectionInfo>();
      await Promise.all(
        words.map(async (w) => {
          for (const c of await trySearch(w)) merged.set(c.slug, c);
        }),
      );
      const ranked = rankByQuery(raw, [...merged.values()]).filter(
        (c) => queryScore(raw, c) > 0,
      );
      if (ranked.length) return ranked;
    }
    const bySlug = new Map<string, CollectionInfo>();
    await Promise.all(
      slugCandidates(raw).map(async (cand) => {
        const col = await bot.opensea.getCollection(cand);
        if (col) bySlug.set(col.slug, col);
      }),
    );
    return [...bySlug.values()];
  };
  app.get("/api/drops/search/:query", async (req, reply) => {
    const { query } = req.params as { query: string };
    const raw = decodeURIComponent(query).trim();
    if (!raw) {
      return reply.code(400).send({ error: "empty search" });
    }
    const linked = parseOpenSeaLink(raw);
    let hits: CollectionInfo[];
    if (linked) {
      const col = await bot.opensea.getCollection(linked);
      hits = col ? [col] : [];
    } else {
      const key = raw.toLowerCase();
      const hit = searchCache.get(key);
      if (hit && Date.now() - hit.ts < 60_000) {
        hits = hit.cols;
      } else {
        hits = await searchCollections(raw);
        if (searchCache.size > 200) searchCache.clear();
        searchCache.set(key, { ts: Date.now(), cols: hits });
      }
    }
    const armed = new Set(bot.strategies.map((s) => s.collection));
    // Flag live/scheduled drops on the hits (one call each, parallel).
    const results = await Promise.all(
      hits.slice(0, 6).map(async (col) => {
        let drop: Drop | undefined;
        try {
          drop = await bot.opensea.getDrop(col.slug);
        } catch {
          /* no drop on this collection */
        }
        return {
          ...collectionCard(col, armed.has(col.slug)),
          has_drop: Boolean(drop),
          is_minting: Boolean(drop?.is_minting),
          active_stage: cardStage(drop?.active_stage),
          next_stage: cardStage(drop?.next_stage),
        };
      }),
    );
    return { query: raw, results };
  });

  /**
   * Single-drop lookup for the /drops search — accepts a slug or OpenSea
   * link, returns the full normalized snapshot (stages, supply) plus
   * collection metadata (image) for the detail view. When the collection
   * has no drop it still returns collection info (kind:"collection") so
   * the modal can show it instead of erroring.
   */
  app.get("/api/drops/lookup/:query", async (req, reply) => {
    const { query } = req.params as { query: string };
    const slug = parseOpenSeaLink(decodeURIComponent(query));
    if (!slug) {
      return reply
        .code(400)
        .send({ error: "invalid collection — paste an OpenSea link or slug" });
    }
    const armed = bot.strategies.some((s) => s.collection === slug);
    try {
      const [drop, collection, stats] = await Promise.all([
        bot.opensea.getDrop(slug),
        bot.opensea.getCollection(slug),
        bot.opensea.getCollectionStats(slug),
      ]);
      const { snapshotFromDrop } = await import("@aco/monitoring");
      const snap = snapshotFromDrop(drop);
      const json = JSON.stringify(
        {
          kind: "drop",
          card: normalizeDropCard(drop, armed),
          snapshot: snap,
          collection,
          stats,
        },
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      );
      return reply.type("application/json").send(json);
    } catch (err) {
      // No drop on this collection — surface collection info when it
      // exists rather than a bare error.
      const [collection, stats] = await Promise.all([
        bot.opensea.getCollection(slug),
        bot.opensea.getCollectionStats(slug),
      ]);
      if (collection) {
        const json = JSON.stringify({
          kind: "collection",
          card: collectionCard(collection, armed),
          snapshot: null,
          collection,
          stats,
        });
        return reply.type("application/json").send(json);
      }
      return reply.code(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Per-stage eligibility for every client wallet on the collection. Each
   * wallet authenticates via its own SIWE JWT, so stages reflect that
   * specific wallet's allowlist/limits. stages:null means the wallet
   * couldn't authenticate (no key or SIWE failed).
   */
  app.get("/api/eligibility/:collection", async (req, reply) => {
    const { collection } = req.params as { collection: string };
    const clients = bot.strategies.filter((s) => s.collection === collection);
    const wallets = [] as Array<{
      wallet: string;
      address?: string;
      stages: unknown[] | null;
      error?: string;
    }>;
    for (const s of clients) {
      const address =
        bot.signers.address(s.chain, s.wallet) ?? bot.env.MINTER_ADDRESS;
      try {
        const res = await bot.opensea.getEligibility(collection, s.wallet);
        // Overlay build-verified truth — the eligibility endpoint
        // over-reports for signed_presale stages; once POST /mint has
        // 422'd this wallet+stage, it's genuinely unable to mint it.
        const stages = res
          ? res.stages.map((st) => {
              const rejected = bot.isStageRejected(
                collection,
                s.wallet,
                st.stage_uuid,
              );
              return rejected
                ? { ...st, is_eligible: false, rejected: true }
                : st;
            })
          : null;
        wallets.push({
          wallet: s.wallet,
          address,
          stages,
        });
      } catch (err) {
        wallets.push({
          wallet: s.wallet,
          address,
          stages: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { collection, wallets };
  });

  app.get("/api/attempts", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 100);
    return bot.store.list(Math.min(limit, 500));
  });

  app.get("/api/metrics/latency", async () => ({
    attempts: bot.store.latencyStats(),
    opensea_api: summarizeApiMetrics(bot.apiMetrics),
  }));

  app.post("/api/kill", async () => {
    bot.safety.engageKillSwitch();
    return { kill_switch: true };
  });

  app.post("/api/kill/release", async () => {
    bot.safety.releaseKillSwitch();
    return { kill_switch: false };
  });

  app.post("/api/monitor/:collection/pause", async (req) => {
    const { collection } = req.params as { collection: string };
    bot.monitor.pause(collection);
    return { collection, paused: true };
  });

  app.post("/api/monitor/:collection/resume", async (req) => {
    const { collection } = req.params as { collection: string };
    bot.monitor.resume(collection);
    return { collection, paused: false };
  });

  /**
   * Manually run the full pipeline for a collection. Respects DRY_RUN —
   * when DRY_RUN=true this is a safe end-to-end test; when false it
   * executes a real mint (all safety checks still apply).
   */
  app.post("/api/mint/trigger", async (req, reply) => {
    const { collection, wallet } = (req.body ?? {}) as {
      collection?: string;
      wallet?: string;
    };
    if (!collection) {
      return reply.code(400).send({ error: "collection is required" });
    }
    try {
      const attempt = await bot.trigger(collection, wallet);
      return attempt;
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}

/**
 * Append a strategy to the YAML file, preserving existing comments —
 * the Document API edits the tree instead of re-serializing.
 */
function persistStrategy(path: string, strategy: Strategy): void {
  const doc = existsSync(path)
    ? YAML.parseDocument(readFileSync(path, "utf8"))
    : new YAML.Document({ version: 1, strategies: [] });
  if (!YAML.isSeq(doc.get("strategies"))) {
    doc.set("strategies", []);
  }
  doc.addIn(["strategies"], strategy);
  writeFileSync(path, doc.toString());
}

/**
 * Write PRIVATE_KEY_<NAME> to .env — append or replace the line so a
 * client wallet registered at runtime survives restarts.
 */
function persistWalletKey(envPath: string, name: string, key: string): void {
  const line = `PRIVATE_KEY_${name.toUpperCase()}=${key}`;
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const re = new RegExp(`^PRIVATE_KEY_${name.toUpperCase()}=.*$`, "m");
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    if (content && !content.endsWith("\n")) content += "\n";
    content += `\n# Client wallets (added via dashboard)\n${line}\n`;
  }
  writeFileSync(envPath, content);
}


/**
 * Remove a strategy from strategies.yaml by collection slug, preserving
 * comments via the Document API. Returns false when not found.
 */
function removeStrategyFromYaml(
  path: string,
  collection: string,
  wallet: string,
): boolean {
  if (!existsSync(path)) return false;
  const doc = YAML.parseDocument(readFileSync(path, "utf8"));
  const seq = doc.get("strategies");
  if (!YAML.isSeq(seq)) return false;
  const idx = seq.items.findIndex(
    (item) =>
      YAML.isMap(item) &&
      item.get("collection") === collection &&
      (item.get("wallet") ?? "default") === wallet,
  );
  if (idx === -1) return false;
  doc.deleteIn(["strategies", idx]);
  writeFileSync(path, doc.toString());
  return true;
}

/** One stage as shown on a drops-explorer card. */
function cardStage(s: DropStage | null | undefined) {
  if (!s) return null;
  return {
    type: s.stage_type ?? "unknown",
    label: s.label ?? s.stage_type ?? "",
    price_wei: s.price ?? "0",
    start_time: s.start_time ?? null,
    end_time: s.end_time ?? null,
    max_per_wallet:
      s.max_per_wallet ?? s.maxPerWallet ?? s.limit_per_wallet ?? null,
    allowlist_wallet_count: s.allowlist_wallet_count ?? null,
    max_per_stage: s.max_per_stage ?? null,
  };
}

/** CollectionInfo -> the card shape used by trending + search results. */
function collectionCard(c: CollectionInfo, armed: boolean) {
  return {
    slug: c.slug,
    name: c.name ?? c.slug,
    image: c.image ?? null,
    banner: c.banner ?? null,
    safelist: c.safelist ?? null,
    chain: c.chain ?? null,
    category: c.category ?? null,
    description: c.description ?? null,
    opensea_url:
      c.opensea_url ?? `https://opensea.io/collection/${c.slug}`,
    armed,
  };
}

/**
 * Turn a free-text collection name into likely OpenSea slugs. Slugs are
 * derived from names ("Cool Cats NFT" -> cool-cats-nft), so kebab/squash
 * forms plus trailing stop-word trims cover most lookups.
 */
const SLUG_STOP_WORDS = new Set([
  "nft",
  "nfts",
  "official",
  "collection",
  "collections",
  "the",
  "by",
  "of",
  "token",
  "tokens",
]);
function slugCandidates(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  const push = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };
  push(words.join("-"));
  push(words.join(""));
  const w = [...words];
  while (w.length > 1 && SLUG_STOP_WORDS.has(w[w.length - 1]!)) {
    w.pop();
    push(w.join("-"));
    push(w.join(""));
  }
  return out.slice(0, 8);
}

/**
 * Relevance score for a collection vs. a free-text query. Exact token
 * hits score 2; near-hits (shared 4-char prefix, catches frens~friends
 * style respellings) score 1. Used to rank merged multi-word results.
 */
function queryScore(query: string, col: CollectionInfo): number {
  const hay = new Set(
    `${col.slug} ${col.name}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  let score = 0;
  for (const qt of query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    if (hay.has(qt)) {
      score += 2;
    } else if (qt.length >= 4) {
      const p = qt.slice(0, 4);
      for (const h of hay) {
        if (h.startsWith(p) || (h.length >= 4 && qt.startsWith(h.slice(0, 4)))) {
          score += 1;
          break;
        }
      }
    }
  }
  return score;
}

function rankByQuery(query: string, cols: CollectionInfo[]): CollectionInfo[] {
  return [...cols].sort((a, b) => queryScore(query, b) - queryScore(query, a));
}

/** Raw Drop -> the card shape the /drops page renders. */
function normalizeDropCard(d: Drop, armed: boolean) {
  const extra = d as Record<string, unknown>;
  return {
    slug: d.collection_slug,
    name: d.collection_name ?? d.collection_slug,
    chain: d.chain,
    contract_address: d.contract_address ?? null,
    drop_type: d.drop_type ?? null,
    image: (extra.image_url ?? extra.image) as string | undefined ?? null,
    opensea_url:
      d.opensea_url ?? `https://opensea.io/collection/${d.collection_slug}`,
    is_minting: Boolean(d.is_minting),
    active_stage: cardStage(d.active_stage),
    next_stage: cardStage(d.next_stage),
    stages: (d.stages ?? []).map((s) => cardStage(s)),
    total_supply: d.total_supply ?? null,
    max_supply: d.max_supply ?? null,
    armed,
  };
}

function summarizeApiMetrics(metrics: { status: number; latencyMs: number }[]) {
  if (!metrics.length) return { count: 0 };
  const lat = metrics.map((m) => m.latencyMs).sort((a, b) => a - b);
  const errors = metrics.filter((m) => m.status === 0 || m.status >= 400);
  return {
    count: metrics.length,
    errors: errors.length,
    avg_ms: Math.round(lat.reduce((s, v) => s + v, 0) / lat.length),
    p50_ms: Math.round(lat[Math.floor(lat.length * 0.5)]!),
    p95_ms: Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))]!),
  };
}

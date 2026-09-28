import { readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import {
  loadStrategiesFile,
  type Env,
  type Logger,
  type Strategy,
} from "@aco/config";
import {
  BlockWatcher,
  ChainClients,
  DirectMinter,
  getChain,
} from "@aco/blockchain";
import { JsonAttemptStore, type MintAttempt } from "@aco/database";
import {
  DuplicateGuard,
  MintExecutor,
  SafetyController,
} from "@aco/executor";
import {
  DropMonitor,
  type DropSnapshot,
  type MintLiveEvent,
  type NormalizedStage,
} from "@aco/monitoring";
import { buildNotifier, type Notifier } from "@aco/notifications";
import {
  OpenSeaClient,
  WalletAuthManager,
  type RequestMetric,
} from "@aco/opensea";
import { NonceManager, SignerRegistry } from "@aco/wallet";

/**
 * AcoBot wires every package together:
 *   strategies -> DropMonitor --(mint:live)--> MintExecutor -> store/notifier
 */
/** Repo root — apps/api/src is three levels deep (same as index.ts). */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** Max single arm-timer sleep — far-future stages re-arm in 12h hops. */
const MAX_ARM_SLEEP_MS = 12 * 3_600_000;

export class AcoBot {
  readonly store: JsonAttemptStore;
  readonly opensea: OpenSeaClient;
  readonly chains: ChainClients;
  readonly safety: SafetyController;
  readonly monitor: DropMonitor;
  readonly executor: MintExecutor;
  readonly notifier: Notifier;
  readonly signers: SignerRegistry;
  readonly walletAuth: WalletAuthManager;
  readonly watcher: BlockWatcher;
  readonly directMinter: DirectMinter;
  readonly startedAt = Date.now();

  /** Latest drop snapshot per collection slug (dashboard feed). */
  readonly snapshots = new Map<string, DropSnapshot>();
  /** Recent OpenSea API latencies (dashboard feed). */
  readonly apiMetrics: RequestMetric[] = [];
  /** (collection::wallet::stageKey) already armed — prevents re-arming a stage. */
  private readonly snipeArmed = new Set<string>();
  /** (collection::wallet) with a snipe currently in-flight. */
  private readonly snipeInflight = new Set<string>();
  /**
   * Scheduled arm timers (collection::stageKey) — the snipe is armed by
   * wall clock at startTime - SNIPER_ARM_MS, not by a poll happening to
   * land inside the arm window. Poll cadence no longer decides whether
   * a mint fires on time.
   */
  private readonly snipeTimers = new Map<
    string,
    { timer: NodeJS.Timeout; armAt: number }
  >();
  /**
   * (collection::wallet::stageUuid) -> ts — build-verified rejections.
   * The eligibility endpoint over-reports for signed_presale stages; a
   * 422 from POST /mint (or an eligibility is_eligible:false) is the
   * truth. Rejected wallets skip instantly instead of re-hammering /mint
   * on every stage event, and the dashboard shows them as truly unable.
   */
  private readonly stageRejections = new Map<string, number>();
  /** Rejections persist beside the attempts store so restarts don't re-verify. */
  private readonly rejectionsPath: string;
  /** Resolved strategies.yaml path (hot-reload + persistence). */
  private readonly strategiesPath: string;
  private discoverTimer?: NodeJS.Timeout;
  private watchTimer?: NodeJS.Timeout;

  constructor(
    readonly env: Env,
    readonly strategies: Strategy[],
    private readonly logger: Logger,
  ) {
    // Persisted attempt store — attempts + stop_after_success survive restarts.
    const attemptsPath = isAbsolute(env.ATTEMPTS_FILE)
      ? env.ATTEMPTS_FILE
      : resolve(ROOT, env.ATTEMPTS_FILE);
    this.store = new JsonAttemptStore(attemptsPath);
    this.rejectionsPath = resolve(
      dirname(attemptsPath),
      "stage-rejections.json",
    );
    try {
      const data = JSON.parse(
        readFileSync(this.rejectionsPath, "utf8"),
      ) as Record<string, number>;
      for (const [k, ts] of Object.entries(data)) {
        this.stageRejections.set(k, ts);
      }
    } catch {
      /* no rejections file yet */
    }
    this.strategiesPath = isAbsolute(env.STRATEGIES_FILE)
      ? env.STRATEGIES_FILE
      : resolve(ROOT, env.STRATEGIES_FILE);

    // Wallet-auth (SIWE) — persists scoped PATs so eligibility stays
    // authenticated across restarts; JWTs are exchanged on demand.
    const walletAuthPath = isAbsolute(env.WALLET_AUTH_FILE)
      ? env.WALLET_AUTH_FILE
      : resolve(ROOT, env.WALLET_AUTH_FILE);
    this.walletAuth = new WalletAuthManager({
      apiBaseUrl: env.OPENSEA_API_BASE,
      persistPath: walletAuthPath,
      logger,
    });

    // Fail fast: every strategy chain (and cross-chain payment chain)
    // must resolve to a known EVM chain.
    for (const s of strategies) {
      getChain(s.chain);
      if (s.payment_chain) getChain(s.payment_chain);
    }
    this.opensea = new OpenSeaClient({
      apiKey: env.OPENSEA_API_KEY,
      baseUrl: env.OPENSEA_API_BASE,
      rps: env.OPENSEA_RPS,
      timeoutMs: env.OPENSEA_TIMEOUT_MS,
      logger,
      getWalletToken: (wallet) => this.walletToken(wallet),
      onResponse: (m) => {
        this.apiMetrics.push(m);
        if (this.apiMetrics.length > 500) this.apiMetrics.shift();
      },
    });

    this.chains = new ChainClients(
      env.rpcEndpoints,
      logger,
      env.relayEndpoints,
    );
    // New-head watcher (ws newHeads, else fast poll) — drives block-boundary
    // broadcast timing and the per-block speed-up / revert-fallback loop.
    this.watcher = new BlockWatcher(
      (chain) => this.chains.get(chain),
      env.wssEndpoints,
      logger,
    );
    // Direct contract mint — detects a public-mint selector and builds
    // calldata locally, bypassing the OpenSea build round-trip.
    this.directMinter = new DirectMinter(logger);
    this.signers = new SignerRegistry(
      env.PRIVATE_KEY ? (env.PRIVATE_KEY as Hex) : undefined,
      env.rpcEndpoints,
      env.wallets as Record<string, Hex>,
    );
    this.notifier = buildNotifier(
      {
        discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
        telegramBotToken: env.TELEGRAM_BOT_TOKEN,
        telegramChatId: env.TELEGRAM_CHAT_ID,
      },
      logger,
    );

    this.safety = new SafetyController(
      {
        killSwitch: env.KILL_SWITCH,
        maxSpendPerTxWei: parseEther(String(env.MAX_SPEND_PER_TX_ETH)),
        maxSpendPerDayWei: parseEther(String(env.MAX_SPEND_PER_DAY_ETH)),
        maxGasFeeWei: parseEther(String(env.MAX_GAS_FEE_ETH)),
        maxQuantityPerTx: env.MAX_QUANTITY_PER_TX,
      },
      this.store,
    );

    const nonce = new NonceManager();
    this.executor = new MintExecutor({
      opensea: this.opensea,
      publicClient: (chain) => this.chains.get(chain),
      signer: (chain, wallet) => this.signers.get(chain, wallet),
      fallbackMinter: env.MINTER_ADDRESS as Address | undefined,
      nonce,
      store: this.store,
      safety: this.safety,
      guard: new DuplicateGuard(this.store),
      notifier: this.notifier,
      dryRun: env.DRY_RUN,
      simulate: env.SIMULATE_BEFORE_SEND,
      confirmationTimeoutMs: env.CONFIRMATION_TIMEOUT_MS,
      priorityFeeBumpPct: env.PRIORITY_FEE_BUMP_PCT,
      broadcast: (chain, signed) => this.chains.broadcast(chain, signed),
      sniper: {
        enabled: env.SNIPER_ENABLED,
        armMs: env.SNIPER_ARM_MS,
        buildLeadMs: env.SNIPER_BUILD_LEAD_MS,
        buildIntervalMs: env.SNIPER_BUILD_INTERVAL_MS,
        buildTimeoutMs: env.SNIPER_BUILD_TIMEOUT_MS,
        broadcastLeadMs: env.SNIPER_BROADCAST_LEAD_MS,
        gasLimit: BigInt(env.SNIPER_GAS_LIMIT),
        feeBumpPct: env.SNIPER_FEE_BUMP_PCT,
      },
      speedup: {
        afterMs: env.SPEEDUP_AFTER_MS,
        bumpPct: env.SPEEDUP_FEE_BUMP_PCT,
        max: env.SPEEDUP_MAX,
      },
      floorPrice: env.FLOOR_GUARD
        ? (slug) => this.opensea.getFloorPriceWei(slug)
        : undefined,
      floorMinRatio: env.FLOOR_MIN_RATIO,
      watcher: this.watcher,
      directMint: this.directMinter,
      directMintEnabled: env.DIRECT_MINT_ENABLED,
      directMintValuePadPct: env.DIRECT_MINT_VALUE_PAD_PCT,
      simulateSnipe: env.SNIPER_SIMULATE,
      logger,
    });

    this.monitor = new DropMonitor({
      client: this.opensea,
      strategies,
      logger,
    });
    // A strategy naming a wallet with no PRIVATE_KEY_<NAME> will skip at
    // mint time — surface it now instead.
    for (const s of strategies) {
      if (!this.signers.has(s.wallet)) {
        this.logger.warn(
          { collection: s.collection, wallet: s.wallet },
          `no key for wallet "${s.wallet}" — set PRIVATE_KEY_${s.wallet.toUpperCase()} in .env`,
        );
      }
    }

    this.monitor.on("snapshot", (snap) => {
      this.snapshots.set(snap.slug, snap);
      this.maybeSnipe(snap);
    });
    this.monitor.on("mint:live", (e) => void this.onMintLive(e));
    this.monitor.on("error", (err, slug) =>
      this.logger.warn({ slug, err }, "monitor poll error"),
    );
  }

  private strategiesFor(collection: string): Strategy[] {
    return this.strategies.filter((s) => s.collection === collection);
  }

  /** Normalized rejection key — eligibility uuids are dashed, drop uuids aren't. */
  private static rejKey(collection: string, wallet: string, uuid: string): string {
    return `${collection}::${wallet}::${uuid.replace(/-/g, "").toLowerCase()}`;
  }

  /** True once a wallet is provably unable to mint this stage (eligibility no / build 422). */
  isStageRejected(collection: string, wallet: string, stageUuid?: string): boolean {
    if (!stageUuid) return false;
    return this.stageRejections.has(
      AcoBot.rejKey(collection, wallet, stageUuid),
    );
  }

  private noteStageRejection(
    collection: string,
    wallet: string,
    stageUuid: string | undefined,
    reason: string | undefined,
  ): void {
    if (!stageUuid || !/not_eligible|stage_not_eligible/i.test(reason ?? "")) return;
    const k = AcoBot.rejKey(collection, wallet, stageUuid);
    if (this.stageRejections.has(k)) return;
    this.stageRejections.set(k, Date.now());
    this.persistRejections();
    this.logger.info(
      { collection, wallet, stage: stageUuid, reason },
      "stage mint-rejected — wallet will skip this stage",
    );
  }

  private persistRejections(): void {
    try {
      writeFileSync(
        this.rejectionsPath,
        JSON.stringify(Object.fromEntries(this.stageRejections), null, 1),
      );
    } catch (err) {
      this.logger.warn({ err }, "could not persist stage rejections");
    }
  }

  /**
   * Arm a snipe for a stage's startTime. When the start is inside the arm
   * window every eligible client is armed immediately; when it's further
   * out a wall-clock timer is scheduled for startTime - SNIPER_ARM_MS so
   * the arm can't be missed by a slow/failed poll. The snipe pre-warms,
   * tight-loops the build endpoint, pre-signs, and broadcasts at the
   * exact start — far faster than waiting for is_minting to flip.
   */
  private maybeSnipe(snap: DropSnapshot): void {
    if (!this.env.SNIPER_ENABLED) return;
    const target = snap.nextStage;
    if (!target?.startTime) {
      this.cancelArmTimers(snap.slug);
      return;
    }
    const until = target.startTime - Date.now();
    if (until <= this.env.SNIPER_ARM_MS) {
      // Inside the window (or the API is lagging the open) — arm now. The
      // snipe's build loop is itself the fastest probe for the stage open.
      this.cancelArmTimers(snap.slug);
      for (const s of this.strategiesFor(snap.slug)) {
        this.armSnipe(s, snap, target);
      }
      return;
    }
    this.scheduleArm(snap.slug, target);
  }

  /** Per-strategy arm — deduped per (collection, wallet, stage). */
  private armSnipe(
    s: Strategy,
    snap: DropSnapshot,
    target: NormalizedStage,
  ): void {
    if (!s.auto_mint) return;
    if (this.monitor.isDone(s.collection, s.wallet)) return;
    if (this.isStageRejected(s.collection, s.wallet, target.uuid)) return;
    const stageKey = target.uuid ?? String(target.startTime);
    const armKey = `${s.collection}::${s.wallet}::${stageKey}`;
    if (this.snipeArmed.has(armKey)) return;
    this.snipeArmed.add(armKey);
    const inflightKey = `${s.collection}::${s.wallet}`;
    this.snipeInflight.add(inflightKey);
    // The snipe's own build loop is the probe now — background polls back
    // off so the shared rate budget stays free for the hot path.
    this.monitor.throttle(s.collection);
    this.logger.info(
      {
        collection: s.collection,
        wallet: s.wallet,
        stage: target.type,
        inMs: target.startTime !== undefined ? target.startTime - Date.now() : 0,
      },
      "snipe armed",
    );
    void this.executor
      .snipe(
        { strategy: s, snapshot: snap, detectedAt: Date.now() },
        target,
      )
      .then((attempt) => {
        this.noteStageRejection(
          s.collection,
          s.wallet,
          target.uuid,
          attempt.reason,
        );
        this.afterSnipe(s, attempt, target.uuid);
      })
      .catch((err) =>
        this.logger.warn({ collection: s.collection, err }, "snipe error"),
      )
      .finally(() => {
        this.snipeInflight.delete(inflightKey);
        this.monitor.unthrottle(s.collection);
      });
  }

  /**
   * Wall-clock arm for a future stage. One timer per (collection, stage);
   * re-derived from the freshest snapshot at fire time so a moved start
   * reschedules rather than firing at a stale moment.
   */
  private scheduleArm(slug: string, target: NormalizedStage): void {
    const stageKey = target.uuid ?? String(target.startTime);
    const key = `${slug}::${stageKey}`;
    const armAt = target.startTime! - this.env.SNIPER_ARM_MS;
    // A newer snapshot superseded older stage keys — cancel their timers.
    for (const [k, v] of this.snipeTimers) {
      if (k.startsWith(`${slug}::`) && k !== key) {
        clearTimeout(v.timer);
        this.snipeTimers.delete(k);
      }
    }
    const existing = this.snipeTimers.get(key);
    // Keep the current timer when it's already aimed at ~this arm time —
    // resetting on every poll would churn timers for no gain.
    if (existing && Math.abs(existing.armAt - armAt) < 1_000) return;
    if (existing) clearTimeout(existing.timer);
    // setTimeout overflows beyond ~24.8 days — cap the sleep and let
    // fireArm re-resolve + reschedule until the stage is genuinely close.
    const delay = Math.min(
      Math.max(0, armAt - Date.now()),
      MAX_ARM_SLEEP_MS,
    );
    const timer = setTimeout(() => this.fireArm(slug, stageKey), delay);
    this.snipeTimers.set(key, { timer, armAt });
    this.logger.debug(
      { collection: slug, stage: target.type, armInMs: armAt - Date.now() },
      "snipe arm scheduled",
    );
  }

  /** Timer fired — re-resolve the stage from the freshest snapshot, then arm. */
  private fireArm(slug: string, stageKey: string): void {
    this.snipeTimers.delete(`${slug}::${stageKey}`);
    const snap = this.snapshots.get(slug);
    const target = snap?.nextStage;
    const key =
      target?.uuid ??
      (target?.startTime !== undefined ? String(target.startTime) : undefined);
    if (!snap || !target?.startTime || key !== stageKey) {
      // Stage data moved on — re-derive from whatever the monitor last saw.
      if (snap) this.maybeSnipe(snap);
      return;
    }
    const until = target.startTime - Date.now();
    if (until > this.env.SNIPER_ARM_MS) {
      this.scheduleArm(slug, target); // start moved later — reschedule
      return;
    }
    for (const s of this.strategiesFor(slug)) {
      this.armSnipe(s, snap, target);
    }
  }

  private cancelArmTimers(slug: string): void {
    const prefix = `${slug}::`;
    for (const [k, v] of this.snipeTimers) {
      if (k.startsWith(prefix)) {
        clearTimeout(v.timer);
        this.snipeTimers.delete(k);
      }
    }
  }

  /**
   * A "sold_out" attempt only pauses the collection when the whole drop
   * is genuinely exhausted — a stage-level sellout (or a stale supply
   * read) must not kill monitoring for stages that haven't run yet
   * (e.g. an allowlist cap hit while a public round is still coming).
   */
  private handleSoldOut(
    collection: string,
    wallet?: string,
    stageUuid?: string,
  ): void {
    const snap = this.snapshots.get(collection);
    const moreStages = snap?.nextStage !== undefined;
    const supplyLeft =
      snap?.maxSupply === undefined ||
      (snap.totalSupply ?? 0) < snap.maxSupply;
    if (moreStages || supplyLeft) {
      if (wallet && stageUuid) {
        this.stageRejections.set(
          AcoBot.rejKey(collection, wallet, stageUuid),
          Date.now(),
        );
        this.persistRejections();
      }
      this.logger.info(
        { collection, stage: stageUuid },
        "stage sold out — drop continues (more stages or supply left)",
      );
      return;
    }
    this.monitor.pause(collection);
    this.cancelArmTimers(collection);
    this.logger.info({ collection }, "drop sold out — pausing collection");
  }

  private afterSnipe(
    s: Strategy,
    attempt: MintAttempt,
    stageUuid?: string,
  ): void {
    if (attempt.reason === "sold_out") {
      this.handleSoldOut(s.collection, s.wallet, stageUuid);
      return;
    }
    if (
      (attempt.status === "confirmed" || attempt.status === "dry_run") &&
      s.conditions.stop_after_success
    ) {
      this.monitor.markDone(s.collection, s.wallet);
      this.logger.info(
        { collection: s.collection, wallet: s.wallet },
        "stop_after_success — client done (snipe)",
      );
    }
  }

  private async onMintLive(e: MintLiveEvent): Promise<void> {
    // A snipe already holds this client's guard — don't double-fire.
    if (this.snipeInflight.has(`${e.strategy.collection}::${e.strategy.wallet}`)) {
      return;
    }
    const stageUuid = e.snapshot.activeStage?.uuid;
    // Already proven unable to mint this stage — skip without spending a
    // single API call. Eligible wallets get the rate budget.
    if (
      this.isStageRejected(
        e.strategy.collection,
        e.strategy.wallet,
        stageUuid,
      )
    ) {
      this.logger.debug(
        { collection: e.strategy.collection, wallet: e.strategy.wallet },
        "skipping — wallet rejected for this stage",
      );
      return;
    }
    this.logger.info(
      { collection: e.strategy.collection, stage: e.snapshot.activeStage?.type },
      "mint stage live",
    );
    const attempt = await this.executor.execute(e);
    this.noteStageRejection(
      e.strategy.collection,
      e.strategy.wallet,
      stageUuid,
      attempt.reason,
    );
    if (attempt.reason === "sold_out") {
      this.handleSoldOut(
        e.strategy.collection,
        e.strategy.wallet,
        stageUuid,
      );
      return;
    }
    if (
      (attempt.status === "confirmed" || attempt.status === "dry_run") &&
      e.strategy.conditions.stop_after_success
    ) {
      // Mark just this client done — other clients on the same drop keep
      // minting; the collection pauses only once all of them are done.
      this.monitor.markDone(e.strategy.collection, e.strategy.wallet);
      this.logger.info(
        { collection: e.strategy.collection, wallet: e.strategy.wallet },
        "stop_after_success — client done",
      );
    }
  }

  /** Manual trigger used by POST /api/mint/trigger. */
  /**
   * Register a strategy at runtime (interactive wizard). If the monitor
   * is already running it starts polling immediately; otherwise it's
   * picked up by start().
   */
  addStrategy(strategy: Strategy): boolean {
    // A drop can host many clients — the same collection with a different
    // wallet is a distinct strategy. Only an exact (collection, wallet)
    // duplicate is rejected.
    if (
      this.strategies.some(
        (s) =>
          s.collection === strategy.collection &&
          s.wallet === strategy.wallet,
      )
    ) {
      this.logger.warn(
        { collection: strategy.collection, wallet: strategy.wallet },
        "strategy already exists — skipping",
      );
      return false;
    }
    this.strategies.push(strategy);
    this.monitor.clearDone(strategy.collection, strategy.wallet);
    if (!this.signers.has(strategy.wallet)) {
      this.logger.warn(
        { collection: strategy.collection, wallet: strategy.wallet },
        `no key for wallet "${strategy.wallet}" — set PRIVATE_KEY_${strategy.wallet.toUpperCase()} in .env`,
      );
    }
    this.monitor.resume(strategy.collection);
    this.logger.info(
      { collection: strategy.collection, chain: strategy.chain, wallet: strategy.wallet },
      "strategy added",
    );
    // Edge-trigger gap: the monitor only fires mint:live on a stage
    // transition. A wallet armed while the drop is already live would
    // wait for a transition that never comes — fire now from the
    // freshest snapshot instead. auto_mint/rejected/done checks happen
    // downstream, so this is safe for manual-only clients too.
    const snap = this.snapshots.get(strategy.collection);
    if (snap?.status === "live" && snap.activeStage) {
      this.logger.info(
        { collection: strategy.collection, wallet: strategy.wallet },
        "armed on a live stage — firing immediately",
      );
      void this.onMintLive({
        strategy,
        snapshot: snap,
        detectedAt: Date.now(),
      });
    } else if (snap?.nextStage) {
      // Upcoming stage — arm the snipe timer now rather than waiting a
      // poll cycle.
      this.maybeSnipe(snap);
    }
    return true;
  }

  /**
   * Disarm a strategy at runtime — stops the monitor polling it and drops
   * the cached snapshot. The DELETE route also removes it from
   * strategies.yaml so it stays gone after restart.
   */
  removeStrategy(collection: string, wallet: string): boolean {
    const i = this.strategies.findIndex(
      (s) => s.collection === collection && s.wallet === wallet,
    );
    if (i === -1) return false;
    this.strategies.splice(i, 1);
    this.monitor.clearDone(collection, wallet);
    // Stop polling the collection only when its last client is removed.
    if (!this.strategies.some((s) => s.collection === collection)) {
      this.monitor.pause(collection);
      this.cancelArmTimers(collection);
      this.snapshots.delete(collection);
    }
    this.logger.info({ collection, wallet }, "strategy removed");
    return true;
  }

  async trigger(collection: string, wallet?: string): Promise<MintAttempt> {
    const strategy = this.strategies.find(
      (s) =>
        s.collection === collection &&
        (wallet === undefined || s.wallet === wallet),
    );
    if (!strategy) {
      throw new Error(
        `unknown strategy "${collection}"${wallet ? ` wallet "${wallet}"` : ""}`,
      );
    }
    const drop = await this.opensea.getDrop(collection);
    const { snapshotFromDrop } = await import("@aco/monitoring");
    const snapshot = snapshotFromDrop(drop);
    this.snapshots.set(collection, snapshot);
    return this.executor.execute({
      strategy,
      snapshot,
      detectedAt: Date.now(),
      force: true,
    });
  }

  async start(): Promise<void> {
    const chains = [
      ...new Set(
        this.strategies.flatMap((s) =>
          s.payment_chain ? [s.chain, s.payment_chain] : [s.chain],
        ),
      ),
    ];
    const missingRpc = chains.filter((c) => !this.env.rpcEndpoints[c]?.length);
    if (missingRpc.length) {
      this.logger.warn(
        { chains: missingRpc },
        "no RPC_* endpoints configured — falling back to public defaults " +
          "(slower, rate-limited; set RPC_<CHAIN> in .env for production)",
      );
    }
    await this.chains.warm(chains);
    // Restore stop_after_success state — a client that already minted
    // (confirmed/dry_run, persisted) stays done across restarts.
    for (const s of this.strategies) {
      if (!s.conditions.stop_after_success) continue;
      // Attempts store the minter address, not the wallet name — resolve it.
      const addr =
        this.signers.address(s.chain, s.wallet) ?? this.env.MINTER_ADDRESS;
      if (addr && this.store.hasSuccessful(s.collection, addr)) {
        this.monitor.markDone(s.collection, s.wallet);
      }
    }
    this.monitor.start();
    this.startHotReload();
    this.startDiscovery();
    this.logger.info(
      {
        strategies: this.strategies.map((s) => s.collection),
        dryRun: this.env.DRY_RUN,
        killSwitch: this.safety.killSwitch,
        signer: this.signers.available,
        sniper: this.env.SNIPER_ENABLED,
        discover: this.env.DISCOVER_ENABLED,
      },
      "bot started",
    );
  }

  async stop(): Promise<void> {
    this.monitor.stop();
    for (const v of this.snipeTimers.values()) clearTimeout(v.timer);
    this.snipeTimers.clear();
    if (this.discoverTimer) clearInterval(this.discoverTimer);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    await this.opensea.close();
  }

  /**
   * Hot-reload strategies.yaml — watch the file and reconcile changes into
   * the live strategy list (the monitor reads this.strategies by reference,
   * so in-place updates take effect without a restart).
   */
  private startHotReload(): void {
    try {
      watch(this.strategiesPath, () => {
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.reconcileStrategies(), 300);
      });
    } catch (err) {
      this.logger.warn({ err }, "strategy hot-reload watch failed");
    }
  }

  /** Diff the file against the live list; add/remove/update in place. */
  private reconcileStrategies(): void {
    let next: Strategy[];
    try {
      next = loadStrategiesFile(this.strategiesPath, this.signers.walletNames);
    } catch (err) {
      this.logger.warn({ err }, "strategies.yaml reload failed — keeping current");
      return;
    }
    const keyOf = (s: Strategy) => `${s.collection}::${s.wallet}`;
    const nextByKey = new Map(next.map((s) => [keyOf(s), s]));
    const curByKey = new Map(this.strategies.map((s) => [keyOf(s), s]));

    // Remove strategies no longer in the file.
    for (const s of [...this.strategies]) {
      if (!nextByKey.has(keyOf(s))) this.removeStrategy(s.collection, s.wallet);
    }
    // Add new + update changed strategies in place.
    for (const s of next) {
      const cur = curByKey.get(keyOf(s));
      if (!cur) {
        this.addStrategy(s);
        continue;
      }
      if (JSON.stringify(cur) !== JSON.stringify(s)) {
        const i = this.strategies.indexOf(cur);
        if (i !== -1) this.strategies.splice(i, 1, s);
        this.monitor.clearDone(s.collection, s.wallet);
        this.monitor.resume(s.collection);
        this.logger.info(
          { collection: s.collection, wallet: s.wallet },
          "strategy updated (hot-reload)",
        );
      }
    }
  }

  /**
   * Drop auto-discovery — poll listDrops and auto-add strategies for drops
   * matching the configured filters (chain, max price). Off by default.
   */
  private startDiscovery(): void {
    if (!this.env.DISCOVER_ENABLED) return;
    const chains = (this.env.DISCOVER_CHAINS ?? "")
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    const maxPriceWei = parseEther(String(this.env.DISCOVER_MAX_PRICE_ETH));
    const tick = async () => {
      try {
        const drops = await this.opensea.listDrops();
        for (const d of drops) {
          const slug = d.collection_slug;
          if (!slug) continue;
          if (chains.length && !chains.includes(d.chain.toLowerCase())) continue;
          if (this.strategies.some((s) => s.collection === slug)) continue;
          const priceWei = (() => {
            try {
              return BigInt(d.active_stage?.price ?? d.next_stage?.price ?? "0");
            } catch {
              return 0n;
            }
          })();
          if (priceWei > maxPriceWei) continue;
          const strategy: Strategy = {
            collection: slug,
            chain: d.chain.toLowerCase(),
            quantity: this.env.DISCOVER_QUANTITY,
            max_price: formatEther(priceWei > 0n ? priceWei : maxPriceWei),
            auto_mint: this.env.DISCOVER_AUTO_MINT,
            wallet: "default",
            max_attempts: 3,
            conditions: {
              require_public_mint: false,
              stop_after_success: true,
              mint_max: false,
            },
          };
          if (this.addStrategy(strategy)) {
            this.logger.info(
              { collection: slug, chain: d.chain, priceWei: priceWei.toString() },
              "discovered drop — strategy added",
            );
          }
        }
      } catch (err) {
        this.logger.warn({ err }, "discovery poll failed");
      }
    };
    void tick();
    this.discoverTimer = setInterval(() => void tick(), this.env.DISCOVER_INTERVAL_MS);
  }

  /**
   * Resolve a wallet-auth JWT for a named wallet. personal_sign is
   * chain-agnostic, so the signer is fetched on a fixed chain — the JWT
   * proves wallet identity regardless of which chain the drop mints on.
   */
  async walletToken(wallet: string): Promise<string | undefined> {
    const signer = this.signers.get("ethereum", wallet);
    if (!signer) return undefined;
    return this.walletAuth.getJwt(wallet, signer);
  }

  status() {
    return {
      uptime_ms: Date.now() - this.startedAt,
      dry_run: this.env.DRY_RUN,
      kill_switch: this.safety.killSwitch,
      signer_configured: this.signers.available,
      wallet: this.signers.address(this.strategies[0]?.chain ?? "ethereum"),
      wallets: this.signers.walletNames,
      strategies: this.strategies.length,
      sniper: this.env.SNIPER_ENABLED,
      sniper_arm_ms: this.env.SNIPER_ARM_MS,
      monitored: this.strategies.map((s) => ({
        collection: s.collection,
        chain: s.chain,
        wallet: s.wallet,
        address: this.signers.address(s.chain, s.wallet),
        auto_mint: s.auto_mint,
        paused: this.monitor.isPaused(s.collection),
        done: this.monitor.isDone(s.collection, s.wallet),
        sniping: this.snipeInflight.has(`${s.collection}::${s.wallet}`),
      })),
    };
  }
}

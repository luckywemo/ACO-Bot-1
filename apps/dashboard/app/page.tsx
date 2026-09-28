"use client";

import { useEffect, useRef, useState } from "react";
import {
  api,
  type AttemptDto,
  type BotStatus,
  type DropSnapshotDto,
  type EligibilityDto,
  type LatencyMetrics,
  type StrategyDto,
} from "../lib/api";

const fmtMs = (v?: number) => (v === undefined ? "—" : `${Math.round(v)} ms`);
const fmtEth = (wei: string) => {
  try {
    return `${(Number(wei) / 1e18).toFixed(4)} ETH`;
  } catch {
    return `${wei} wei`;
  }
};

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${
        ok ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
      }`}
    >
      {label}
    </span>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-edge bg-panel p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function Overview() {
  const [status, setStatus] = useState<BotStatus>();
  const [strategies, setStrategies] = useState<StrategyDto[]>([]);
  const [drops, setDrops] = useState<DropSnapshotDto[]>([]);
  const [attempts, setAttempts] = useState<AttemptDto[]>([]);
  const [latency, setLatency] = useState<LatencyMetrics>();
  const [offline, setOffline] = useState(false);
  const [elig, setElig] = useState<Record<string, EligibilityDto | "loading">>({});
  const [mint, setMint] = useState<Record<string, "running" | AttemptDto>>({});
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [killBusy, setKillBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [s, st, d, a, l] = await Promise.all([
          api.status(),
          api.strategies(),
          api.drops(),
          api.attempts(),
          api.latency(),
        ]);
        if (!alive) return;
        setStatus(s);
        setStrategies(st);
        setDrops(d);
        setAttempts(a);
        setLatency(l);
        setOffline(false);
      } catch {
        if (alive) setOffline(true);
      }
    };
    void tick();
    const t = setInterval(tick, 2_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Auto-check eligibility once strategies are known (one pass, not polled).
  const eligRequested = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const s of strategies) {
      if (eligRequested.current.has(s.collection)) continue;
      eligRequested.current.add(s.collection);
      void checkEligibility(s.collection);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategies]);

  const snap = (slug: string) => drops.find((d) => d.slug === slug);
  const monitored = (slug: string) =>
    status?.monitored.find((m) => m.collection === slug);

  const checkEligibility = async (slug: string) => {
    setElig((m) => ({ ...m, [slug]: "loading" }));
    try {
      const res = await api.eligibility(slug);
      setElig((m) => ({ ...m, [slug]: res }));
    } catch (e) {
      setElig((m) => ({
        ...m,
        [slug]: {
          collection: slug,
          stages: null,
          reason: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  };

  const mintNow = async (slug: string) => {
    if (
      status &&
      !status.dry_run &&
      !window.confirm(
        `DRY_RUN is off — this broadcasts a REAL mint for "${slug}". Continue?`,
      )
    ) {
      return;
    }
    setMint((m) => ({ ...m, [slug]: "running" }));
    try {
      const attempt = await api.trigger(slug);
      setMint((m) => ({ ...m, [slug]: attempt }));
    } catch (e) {
      setMint((m) => ({
        ...m,
        [slug]: {
          id: "",
          collection: slug,
          chain: "",
          status: "error",
          reason: e instanceof Error ? e.message : String(e),
          quantity: 0,
          priceWei: "0",
          createdAt: Date.now(),
        },
      }));
    }
  };

  const togglePause = async (slug: string, paused: boolean) => {
    setRowBusy((m) => ({ ...m, [slug]: true }));
    try {
      if (paused) await api.resume(slug);
      else await api.pause(slug);
    } finally {
      setRowBusy((m) => ({ ...m, [slug]: false }));
    }
  };

  const toggleKill = async () => {
    setKillBusy(true);
    try {
      if (status?.kill_switch) await api.releaseKill();
      else await api.kill();
    } finally {
      setKillBusy(false);
    }
  };

  const btn =
    "rounded border border-edge px-2 py-1 text-xs font-medium transition hover:bg-edge disabled:opacity-40";

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">ACO Bot</h1>
        <div className="flex items-center gap-2">
          {offline && <Badge ok={false} label="API offline" />}
          {status && (
            <Badge
              ok={!status.kill_switch}
              label={status.kill_switch ? "KILL SWITCH" : "live"}
            />
          )}
          {status && (
            <Badge
              ok={status.dry_run}
              label={status.dry_run ? "dry-run" : "REAL TX"}
            />
          )}
          {status && (
            <button
              className={`${btn} ${status.kill_switch ? "border-emerald-600 text-emerald-400" : "border-red-600 text-red-400"}`}
              disabled={killBusy}
              onClick={() => void toggleKill()}
            >
              {status.kill_switch ? "Release kill switch" : "Kill switch"}
            </button>
          )}
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Status">
          {status ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-slate-400">Uptime</dt><dd>{Math.round(status.uptime_ms / 1000)}s</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Wallet</dt><dd className="font-mono text-xs">{status.wallet ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Signer</dt><dd>{status.signer_configured ? "configured" : "not configured"}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Strategies</dt><dd>{status.strategies}</dd></div>
            </dl>
          ) : (
            <p className="text-sm text-slate-500">connecting…</p>
          )}
        </Card>

        <Card title="Latency (avg / p95)">
          <dl className="space-y-1 text-sm">
            {(["detection_ms", "tx_build_ms", "signing_ms", "broadcast_ms", "confirmation_ms", "total_ms"] as const).map((k) => (
              <div key={k} className="flex justify-between">
                <dt className="text-slate-400">{k.replace("_ms", "").replace("_", " ")}</dt>
                <dd className="font-mono">
                  {fmtMs(latency?.attempts.avg[k])} / {fmtMs(latency?.attempts.p95[k])}
                </dd>
              </div>
            ))}
            <div className="flex justify-between border-t border-edge pt-1">
              <dt className="text-slate-400">OpenSea API</dt>
              <dd className="font-mono">{fmtMs(latency?.opensea_api.avg_ms)} / {fmtMs(latency?.opensea_api.p95_ms)}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card title="Collections">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-slate-500">
              <th className="pb-2">Collection</th>
              <th className="pb-2">Chain</th>
              <th className="pb-2">Status</th>
              <th className="pb-2">Stage</th>
              <th className="pb-2">Price</th>
              <th className="pb-2">Starts in</th>
              <th className="pb-2">Eligibility</th>
              <th className="pb-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => {
              const d = snap(s.collection);
              const mon = monitored(s.collection);
              const e = elig[s.collection];
              const m = mint[s.collection];
              return (
                <FragmentRow
                  key={s.collection}
                  strategy={s}
                  drop={d}
                  paused={mon?.paused ?? false}
                  elig={e}
                  mint={m}
                  busy={rowBusy[s.collection] ?? false}
                  btn={btn}
                  onCheckEligibility={() => void checkEligibility(s.collection)}
                  onMint={() => void mintNow(s.collection)}
                  onTogglePause={() => void togglePause(s.collection, mon?.paused ?? false)}
                />
              );
            })}
            {!strategies.length && (
              <tr><td colSpan={8} className="py-4 text-center text-slate-500">no strategies loaded</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card title="Recent attempts">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-slate-500">
              <th className="pb-2">Collection</th><th className="pb-2">Status</th><th className="pb-2">Reason</th><th className="pb-2">Total</th><th className="pb-2">TX</th><th className="pb-2">Time</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((a) => (
              <tr key={a.id} className="border-t border-edge">
                <td className="py-2">{a.collection}</td>
                <td className="py-2"><Badge ok={a.status === "confirmed" || a.status === "dry_run"} label={a.status} /></td>
                <td className="py-2 text-slate-400">{a.reason ?? "—"}</td>
                <td className="py-2 font-mono">{fmtMs(a.latencies?.total_ms)}</td>
                <td className="py-2 font-mono text-xs">{a.txHash ? `${a.txHash.slice(0, 10)}…` : "—"}</td>
                <td className="py-2 text-slate-400">{new Date(a.createdAt).toLocaleTimeString()}</td>
              </tr>
            ))}
            {!attempts.length && (
              <tr><td colSpan={6} className="py-4 text-center text-slate-500">no attempts yet</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </main>
  );
}

function FragmentRow({
  strategy: s,
  drop: d,
  paused,
  elig: e,
  mint: m,
  busy,
  btn,
  onCheckEligibility,
  onMint,
  onTogglePause,
}: {
  strategy: StrategyDto;
  drop?: DropSnapshotDto;
  paused: boolean;
  elig?: EligibilityDto | "loading";
  mint?: "running" | AttemptDto;
  busy: boolean;
  btn: string;
  onCheckEligibility: () => void;
  onMint: () => void;
  onTogglePause: () => void;
}) {
  return (
    <>
      <tr className="border-t border-edge">
        <td className="py-2 font-medium">
          {d?.name ?? s.collection}
          {s.auto_mint && (
            <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
              auto
            </span>
          )}
        </td>
        <td className="py-2">
          {s.chain}
          {s.payment_chain && (
            <span className="text-slate-500"> ← {s.payment_chain}</span>
          )}
        </td>
        <td className="py-2">
          {d ? <Badge ok={d.status === "live"} label={d.status} /> : "—"}
          {paused && (
            <span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">
              paused
            </span>
          )}
        </td>
        <td className="py-2">{d?.activeStage?.label ?? d?.activeStage?.type ?? d?.nextStage?.label ?? "—"}</td>
        <td className="py-2 font-mono">{d?.activeStage ? fmtEth(d.activeStage.priceWei) : "—"}</td>
        <td className="py-2 font-mono">{d?.msUntilNextStage !== undefined ? `${Math.max(0, Math.round(d.msUntilNextStage / 1000))}s` : "—"}</td>
        <td className="py-2">
          {e === "loading" ? (
            <span className="text-xs text-slate-500">checking…</span>
          ) : e?.stages ? (
            <span className="flex flex-wrap gap-1">
              {e.stages.map((st, i) => (
                <Badge
                  key={st.stage_uuid ?? i}
                  ok={st.is_eligible}
                  label={st.is_eligible ? "eligible" : "not eligible"}
                />
              ))}
              {!e.stages.length && <span className="text-xs text-slate-500">no stages</span>}
            </span>
          ) : e ? (
            <span className="text-xs text-slate-500" title={e.reason}>
              unavailable (wallet auth)
            </span>
          ) : (
            <button className={btn} onClick={onCheckEligibility}>
              Check
            </button>
          )}
        </td>
        <td className="py-2">
          <div className="flex gap-1">
            <button
              className={`${btn} border-accent text-accent`}
              disabled={m === "running"}
              onClick={onMint}
            >
              {m === "running" ? "minting…" : "Mint now"}
            </button>
            <button className={btn} disabled={busy} onClick={onTogglePause}>
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        </td>
      </tr>
      {m && m !== "running" && (
        <tr className="border-t border-edge/50 bg-panel/60">
          <td colSpan={8} className="py-1.5 text-xs">
            <Badge ok={m.status === "confirmed" || m.status === "dry_run"} label={m.status} />
            {m.reason && <span className="ml-2 text-slate-400">{m.reason}</span>}
            {m.txHash && <span className="ml-2 font-mono text-slate-500">{m.txHash.slice(0, 14)}…</span>}
          </td>
        </tr>
      )}
    </>
  );
}

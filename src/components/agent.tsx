"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ASSETS, type AssetCode, pairSlug, type BaseAsset } from "@/lib/assets";
import { accountUrl, api, num, price, short, signed, timeAgo, txUrl, usd, useApi, useSimulatedAutofill } from "@/lib/client";
import type { AgentStatusDTO, PortfolioDTO, ProposalDTO } from "@/lib/types";
import { useProposal } from "./forms";
import { ProposalCard } from "./proposal-card";
import { Badge, Button, Card, CardHeader, cx, ErrorState, Field, Meter, Skeleton } from "./ui";

type Decision = AgentStatusDTO["decisions"][number];
type OpenPosition = AgentStatusDTO["positions"][number];
type Read = AgentStatusDTO["reads"][number];

const tone = (n: number) => (Math.abs(n) < 0.005 ? "text-ink" : n > 0 ? "text-up" : "text-down");

/** Re-renders every second, for countdowns. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function AgentPage() {
  const status = useApi<AgentStatusDTO>("/api/agent", 8_000);
  const portfolio = useApi<PortfolioDTO>("/api/portfolio", 30_000);
  const pending = useApi<ProposalDTO[]>("/api/proposals?source=agent", 15_000);
  const [checking, setChecking] = useState(false);
  const a = status.data;
  const refreshStatus = status.refresh;
  const refreshPending = pending.refresh;

  const check = async () => {
    setChecking(true);
    await api("/api/agent/check", { method: "POST" }).catch(() => null);
    refreshStatus();
    refreshPending();
    setChecking(false);
  };

  // No background worker (for example on a serverless host): this page keeps the agent checking.
  const stale = Boolean(a && !a.online);
  useEffect(() => {
    if (!stale) return;
    const run = () => {
      if (document.visibilityState !== "visible") return;
      void api("/api/agent/check", { method: "POST" })
        .catch(() => null)
        .then(() => {
          refreshStatus();
          refreshPending();
        });
    };
    run();
    const id = setInterval(run, 60_000);
    return () => clearInterval(id);
  }, [stale, refreshStatus, refreshPending]);

  const suggestions = (pending.data ?? []).filter((p) => p.status === "pending");

  return (
    <div className="mx-auto max-w-[1040px] space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[32px] leading-tight font-extrabold tracking-tight">Agent</h1>
          <p className="mt-1 max-w-[62ch] text-ink-2">
            Trades the money in your vault by fixed rules, inside your guardrails. Everything it sees, decides and does is on this page.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {a && <Heartbeat a={a} />}
          <Button size="sm" variant="secondary" icon="ri-refresh-line" loading={checking} onClick={check}>
            Check now
          </Button>
        </div>
      </header>

      {status.error && <ErrorState message={status.error} onRetry={status.refresh} />}
      {!a && !status.error && <Skeleton className="h-40 rounded-card" />}

      {a && (
        <>
          <StatusBanner a={a} />
          <Stats a={a} />
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="space-y-6">
              <EquityCard a={a} />
              <PositionsCard a={a} />
              {suggestions.length > 0 && (
                <Card>
                  <CardHeader title="Waiting for you" hint="In copilot mode the agent stages its trades here. Nothing moves until you confirm." />
                  <div className="space-y-3 px-5 pt-3 pb-5">
                    {suggestions.map((p) => (
                      <ProposalCard nested key={p.id} proposal={p} onChange={() => { refreshPending(); refreshStatus(); portfolio.refresh(); }} />
                    ))}
                  </div>
                </Card>
              )}
              <DrillCard onDone={refreshStatus} />
              <WalletCard a={a} onDone={() => { refreshStatus(); portfolio.refresh(); }} />
              <MarketsCard a={a} />
              <FindTrade onSettled={() => { refreshStatus(); refreshPending(); }} />
            </div>
            <div className="space-y-6">
              <JournalCard a={a} />
              <ClosedCard a={a} />
              <RulesCard a={a} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Heartbeat({ a }: { a: AgentStatusDTO }) {
  const now = useNow();
  const last = a.lastTickAt ? Math.max(0, Math.round((now - new Date(a.lastTickAt).getTime()) / 1000)) : null;
  const next = a.nextTickAt ? Math.round((new Date(a.nextTickAt).getTime() - now) / 1000) : null;
  return (
    <span
      className="inline-flex h-8 items-center gap-2 rounded-full border border-line-strong px-3 text-sm text-ink-2"
      role="status"
      aria-label={a.online ? "Agent is running" : "Agent is not running"}
    >
      <span className="relative grid size-2 place-items-center" aria-hidden>
        {a.online && <span className="absolute size-2 animate-ping rounded-full bg-up opacity-60 motion-reduce:hidden" />}
        <span className={cx("size-2 rounded-full", a.online ? "bg-up" : "border border-ink-2")} />
      </span>
      {a.online ? (
        <span className="tabular">
          Live · check #{a.tickCount} {last}s ago{next !== null && next > 0 ? ` · next in ${next}s` : " · checking…"}
        </span>
      ) : (
        <span>{last === null ? "Not started" : `Paused · last check ${timeAgo(a.lastTickAt!)}`}</span>
      )}
    </span>
  );
}

function StatusBanner({ a }: { a: AgentStatusDTO }) {
  const icon = a.halted ? "ri-stop-circle-line" : a.mode === "autonomous" ? "ri-robot-2-line" : "ri-user-voice-line";
  return (
    <Card as="div">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-well text-xl text-ink" aria-hidden>
          <i className={icon} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={a.halted ? "danger" : a.mode === "autonomous" ? "accent" : "neutral"}>
              {a.halted ? "Halted" : a.mode === "autonomous" ? "Autonomous" : "Copilot"}
            </Badge>
            <p className="text-[15px] text-ink">{a.headline || "Starting up: the first check runs within a minute."}</p>
          </div>
          {!a.halted && a.mode === "copilot" && (
            <p className="mt-1 text-sm text-muted">
              The agent suggests and you confirm each trade.{" "}
              <Link href="/guardrails" className="rounded text-ink underline underline-offset-4">
                Switch to autonomous in Guardrails
              </Link>{" "}
              to let it trade on its own.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function Stats({ a }: { a: AgentStatusDTO }) {
  const s = a.stats;
  const tiles: [string, string, string?, string?][] = [
    ["Vault value", usd(s.equityUsd)],
    ["Invested", usd(s.investedUsd), s.equityUsd > 0 ? `${num((s.investedUsd / s.equityUsd) * 100, 0)}% of the vault` : "of the vault"],
    ["Open profit / loss", `${signed(s.unrealizedUsd)} USD`, `${a.positions.length} open position${a.positions.length === 1 ? "" : "s"}`, tone(s.unrealizedUsd)],
    [
      "Closed profit / loss",
      `${signed(s.realizedUsd)} USD`,
      s.winRatePct === null ? "No closed trades yet" : `${s.closedTrades} closed · ${num(s.winRatePct, 0)}% won`,
      tone(s.realizedUsd),
    ],
  ];
  return (
    <Card as="div">
      <dl className="grid grid-cols-2 divide-line max-lg:[&>*:nth-child(-n+2)]:border-b max-lg:[&>*:nth-child(odd)]:border-r lg:grid-cols-4 lg:divide-x">
        {tiles.map(([label, value, detail, color]) => (
          <div key={label} className="border-line px-5 py-4">
            <dt className="text-sm text-muted">{label}</dt>
            <dd className={cx("tabular mt-0.5 text-[22px] leading-tight font-bold tracking-tight", color ?? "text-ink")}>{value}</dd>
            {detail && <dd className="mt-0.5 text-sm text-muted">{detail}</dd>}
          </div>
        ))}
      </dl>
    </Card>
  );
}

function EquityCard({ a }: { a: AgentStatusDTO }) {
  const points = a.equity;
  const first = points[0]?.v ?? 0;
  const last = points.at(-1)?.v ?? 0;
  return (
    <Card>
      <CardHeader
        title="Vault value, last 24 hours"
        hint="Valued at mainnet prices every minute while the agent runs. Deposits and withdrawals show as steps."
        action={points.length > 1 ? <span className={cx("tabular text-sm", tone(last - first))}>{signed(last - first)} USD</span> : undefined}
      />
      <div className="px-5 pt-3 pb-5">{points.length > 1 ? <Curve points={points} /> : <p className="py-8 text-center text-sm text-muted">The curve starts once the vault holds funds.</p>}</div>
    </Card>
  );
}

function Curve({ points }: { points: { t: string; v: number }[] }) {
  const W = 600;
  const H = 150;
  const values = points.map((p) => p.v);
  const times = points.map((p) => new Date(p.t).getTime());
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min || Math.max(max, 1) * 0.01) * 0.15;
  const [lo, hi] = [min - pad, max + pad];
  const [t0, t1] = [times[0], times.at(-1)!];
  const x = (t: number) => (t1 === t0 ? W : ((t - t0) / (t1 - t0)) * W);
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(times[i]).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const clock = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return (
    <figure>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label={`Vault value from ${usd(values[0])} to ${usd(values.at(-1)!)}`}>
          <defs>
            <linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--color-ink)" stopOpacity="0.16" />
              <stop offset="1" stopColor="var(--color-ink)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line}L${W},${H}L0,${H}Z`} fill="url(#equity-fill)" />
          <path d={line} fill="none" stroke="var(--color-ink)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
        <span className="tabular absolute top-0 right-0 text-xs text-muted">{usd(max)}</span>
        <span className="tabular absolute right-0 bottom-0 text-xs text-muted">{usd(min)}</span>
      </div>
      <figcaption className="tabular mt-1.5 flex justify-between text-xs text-muted">
        <span>{clock(t0)}</span>
        <span>{clock(t1)}</span>
      </figcaption>
    </figure>
  );
}

function PositionsCard({ a }: { a: AgentStatusDTO }) {
  return (
    <Card>
      <CardHeader title="Open positions" hint="What the vault holds beyond USDC, with the stop and target the agent is working to." />
      <div className="px-5 pt-3 pb-5">
        {a.positions.length === 0 ? (
          <p className="text-sm text-muted">Nothing open. The vault is in USDC until a market meets the entry rules.</p>
        ) : (
          <ul className="space-y-3">
            {a.positions.map((p) => (
              <PositionRow key={p.id} p={p} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

const STRATEGY_LABEL = { trend: "Trend", dip: "Dip buy", manual: "Bought by you" } as const;

function PositionRow({ p }: { p: OpenPosition }) {
  const span = p.targetPrice - p.stopPrice;
  const at = (value: number) => `${Math.min(100, Math.max(0, ((value - p.stopPrice) / span) * 100))}%`;
  return (
    <li className="rounded-control bg-well px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <Link href={`/trading/${pairSlug(p.asset as BaseAsset)}`} className="rounded text-[15px] font-medium text-ink underline-offset-4 hover:underline">
            {p.asset}
          </Link>
          <Badge>{STRATEGY_LABEL[p.strategy]}</Badge>
          <span className="text-sm text-muted">opened {timeAgo(p.openedAt)}</span>
        </div>
        <p className="tabular text-sm">
          <span className="text-ink">{usd(p.valueUsd)}</span>{" "}
          <span className={tone(p.pnlUsd)}>
            {signed(p.pnlUsd)} USD ({signed(p.pnlPct)}%)
          </span>
        </p>
      </div>
      <div className="relative mt-4 h-1.5 rounded-full bg-line-strong" role="img" aria-label={`Price ${price(p.price)} between stop ${price(p.stopPrice)} and target ${price(p.targetPrice)}`}>
        <span className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-muted" style={{ left: at(p.entryPrice) }} />
        <span className={cx("absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-paper", p.pnlUsd >= 0 ? "bg-up" : "bg-down")} style={{ left: at(p.price) }} />
      </div>
      <dl className="tabular mt-2 flex justify-between gap-3 text-xs text-muted">
        <div>
          <dt className="inline">Stop </dt>
          <dd className="inline text-ink-2">{price(p.stopPrice)}</dd>
        </div>
        <div>
          <dt className="inline">Entry </dt>
          <dd className="inline text-ink-2">{price(p.entryPrice)}</dd>
          <dt className="ml-3 inline">Now </dt>
          <dd className="inline text-ink-2">{price(p.price)}</dd>
        </div>
        <div>
          <dt className="inline">Target </dt>
          <dd className="inline text-ink-2">{price(p.targetPrice)}</dd>
        </div>
      </dl>
    </li>
  );
}

const REGIME: Record<Read["regime"], { label: string; tone: "neutral" | "accent" | "warn" }> = {
  trend: { label: "Uptrend", tone: "accent" },
  range: { label: "Range", tone: "neutral" },
  risk_off: { label: "Risk-off", tone: "warn" },
  no_data: { label: "No data", tone: "neutral" },
};

function MarketsCard({ a }: { a: AgentStatusDTO }) {
  return (
    <Card>
      <CardHeader title="What the agent sees" hint="Each market read from real mainnet hourly candles, and what the agent is waiting for." />
      <div className="px-5 pt-3 pb-5">
        {a.reads.length === 0 ? (
          <p className="text-sm text-muted">The first read appears after the next check.</p>
        ) : (
          <ul className="divide-y divide-line">
            {a.reads.map((r) => (
              <li key={r.asset} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[4.5rem_6.5rem_minmax(0,1fr)]">
                <div>
                  <p className="font-medium text-ink" title={ASSETS[r.asset as AssetCode]?.name}>
                    {r.asset}
                  </p>
                  <p className={cx("tabular text-xs", tone(r.change24hPct))}>{signed(r.change24hPct)}%</p>
                </div>
                <div className="max-sm:col-start-2 max-sm:row-start-1">
                  <Badge tone={REGIME[r.regime].tone}>{REGIME[r.regime].label}</Badge>
                  {r.rsi !== null && <p className="tabular mt-1 text-xs text-muted">RSI {num(r.rsi, 0)}</p>}
                </div>
                <p className="text-sm leading-relaxed text-ink-2 max-sm:col-span-2">{r.note}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

const ACTION: Record<Decision["action"], { icon: string; label: string }> = {
  buy: { icon: "ri-arrow-right-up-line", label: "Bought" },
  sell: { icon: "ri-arrow-right-down-line", label: "Sold" },
  suggest: { icon: "ri-lightbulb-line", label: "Suggested" },
  watch: { icon: "ri-eye-line", label: "Watching" },
  hold: { icon: "ri-hand-coin-line", label: "Holding" },
  blocked: { icon: "ri-shield-cross-line", label: "Blocked" },
  failed: { icon: "ri-error-warning-line", label: "Failed" },
  halt: { icon: "ri-stop-circle-line", label: "Halted" },
  info: { icon: "ri-information-line", label: "Status" },
};
const TRADE_ACTIONS: Decision["action"][] = ["buy", "sell", "suggest", "blocked", "failed", "halt"];

function JournalCard({ a }: { a: AgentStatusDTO }) {
  const [filter, setFilter] = useState<"all" | "trades">("all");
  const items = a.decisions.filter((d) => filter === "all" || TRADE_ACTIONS.includes(d.action));
  return (
    <Card>
      <CardHeader
        title="Decision journal"
        hint="A line each time the agent acts or changes its mind, newest first."
        action={
          <button
            type="button"
            onClick={() => setFilter(filter === "all" ? "trades" : "all")}
            aria-pressed={filter === "trades"}
            className={cx(
              "h-8 shrink-0 rounded-full border px-3 text-sm transition-colors duration-[var(--dur-micro)]",
              filter === "trades" ? "border-ink bg-ink text-paper" : "border-line-strong text-ink-2 hover:text-ink",
            )}
          >
            Trades only
          </button>
        }
      />
      <div className="px-5 pt-3 pb-5">
        {items.length === 0 ? (
          <p className="text-sm text-muted">{filter === "trades" ? "No trades yet." : "Nothing yet. The journal fills in from the first check."}</p>
        ) : (
          <ol className="max-h-[560px] space-y-3 overflow-y-auto pr-1">
            {items.map((d) => (
              <JournalRow key={d.id} d={d} />
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

const DETAIL_LABELS: [string, string, (n: number) => string][] = [
  ["price", "Price", (n) => price(n)],
  ["rsi", "RSI 14h", (n) => num(n, 0)],
  ["atr_pct", "Hourly range", (n) => `${num(n)}%`],
  ["sma_20h", "20h average", (n) => price(n)],
  ["sma_50h", "50h average", (n) => price(n)],
  ["change_24h_pct", "24h change", (n) => `${signed(n)}%`],
];

function JournalRow({ d }: { d: Decision }) {
  const meta = ACTION[d.action];
  const traded = d.action === "buy" || d.action === "sell";
  const detail = d.detail as Record<string, number | string | null> | null;
  const facts = detail ? DETAIL_LABELS.filter(([key]) => typeof detail[key] === "number") : [];
  return (
    <li className="flex gap-3">
      <span
        className={cx("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-[15px]", traded ? "bg-ink text-paper" : "bg-well text-ink-2")}
        aria-hidden
      >
        <i className={meta.icon} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed text-ink">
          <span className="sr-only">{meta.label}: </span>
          {d.summary}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
          <time dateTime={d.createdAt}>{timeAgo(d.createdAt)}</time>
          {d.txHash && (
            <a href={txUrl(d.txHash)} target="_blank" rel="noreferrer" className="rounded text-ink underline-offset-4 hover:underline">
              Transaction on StellarChain
            </a>
          )}
          {facts.length > 0 && (
            <details className="w-full">
              <summary className="cursor-pointer rounded text-ink-2 hover:text-ink">The numbers behind it</summary>
              <dl className="tabular mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5">
                {facts.map(([key, label, format]) => (
                  <div key={key} className="flex justify-between gap-2">
                    <dt>{label}</dt>
                    <dd className="text-ink-2">{format(detail![key] as number)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

function ClosedCard({ a }: { a: AgentStatusDTO }) {
  if (a.closed.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Closed trades" hint="Why each position was closed and what it made or lost." />
      <ul className="divide-y divide-line px-5 pt-2 pb-4">
        {a.closed.map((p) => (
          <li key={p.id} className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
            <span className="min-w-0">
              <span className="font-medium text-ink">{p.asset}</span> <span className="text-muted">{p.exitReason ?? "Closed"}</span>
              {p.closedAt && <span className="text-muted"> · {timeAgo(p.closedAt)}</span>}
            </span>
            <span className={cx("tabular shrink-0", tone(p.pnlUsd))}>{signed(p.pnlUsd)} USD</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RulesCard({ a }: { a: AgentStatusDTO }) {
  const r = a.rules;
  const rules: [string, string][] = [
    ["Stays out", `Downtrends, markets moving over ${r.maxAtrPct}% an hour, or down over ${r.maxDrop24hPct}% in a day.`],
    ["Buys", `Uptrends (price above the 20h average, above the 50h) with RSI under ${r.trendMaxRsi}; or dips in a range with RSI ${r.dipMaxRsi} or lower.`],
    ["Sizes", `So a stopped trade costs about ${r.riskPerTradePct}% of the vault. At most ${r.maxPositionPct}% per position, ${r.maxExposurePct}% invested, ${r.maxPositions} positions.`],
    ["Sells", `At the stop (${r.stopAtr}× the hourly range below entry), at the target (${r.rewardToRisk}× that distance above), on a trailing stop, when the market turns risk-off, or after ${r.timeStopHours}h going nowhere.`],
    ["Cools off", `${r.cooldownHours}h on an asset after a loss; ${r.lossPauseHours}h off new buys after ${r.lossStreak} losses in a row.`],
  ];
  return (
    <Card>
      <CardHeader title="The rules it follows" hint="Fixed and deterministic. The AI explains trades; it never invents them." />
      <dl className="space-y-2.5 px-5 pt-3 pb-5 text-sm">
        {rules.map(([label, body]) => (
          <div key={label} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
            <dt className="text-muted">{label}</dt>
            <dd className="leading-relaxed text-ink-2">{body}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function FindTrade({ onSettled }: { onSettled: () => void }) {
  const idea = useProposal(onSettled);
  return (
    <Card>
      <CardHeader
        title="Ask for a trade"
        hint="Runs the same rules right now and stages the best trade for you to confirm."
        action={
          <Button size="sm" variant="secondary" icon="ri-radar-line" loading={idea.busy} onClick={() => idea.stage("propose_strategy_trades")}>
            Find a trade
          </Button>
        }
      />
      <div className="space-y-3 px-5 pt-3 pb-5">
        {idea.error && <p className="rounded-control bg-well px-3 py-2 text-sm text-ink-2">{idea.error}</p>}
        {idea.card}
      </div>
    </Card>
  );
}

type Drill = { attack: string; attempt: string; held: boolean; stoppedBy: string; detail: string; proof: "live" | "design" };

function DrillCard({ onDone }: { onDone: () => void }) {
  const [results, setResults] = useState<Drill[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResults((await api<{ results: Drill[] }>("/api/agent/drill", { method: "POST" })).results);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The drill couldn't run");
    } finally {
      setBusy(false);
    }
  };
  const held = results?.filter((r) => r.held).length ?? 0;
  return (
    <Card>
      <CardHeader
        title="What if the agent is hijacked?"
        hint="Run the drill: MINT plays a compromised agent against your real guardrails. Nothing is signed or sent."
        action={
          <Button size="sm" variant="secondary" icon="ri-shield-keyhole-line" loading={busy} onClick={run}>
            {results ? "Run again" : "Run the drill"}
          </Button>
        }
      />
      <div className="px-5 pt-3 pb-5">
        {error && <ErrorState message={error} onRetry={run} />}
        {!results && !error && (
          <p className="text-sm text-muted">Six attacks: stealing the vault, an oversized trade, paying a fake API, orders hidden in data, reusing the agent&apos;s key, and loosening its own limits.</p>
        )}
        {results && (
          <>
            <p className="flex items-center gap-2 text-[15px] text-ink" role="status">
              <i className={held === results.length ? "ri-shield-check-fill" : "ri-error-warning-fill"} aria-hidden />
              {held} of {results.length} attacks stopped.
            </p>
            <ol className="mt-3 divide-y divide-line rounded-control border border-line">
              {results.map((r) => (
                <li key={r.attack} className="px-3.5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <i className={cx("text-[17px] text-ink", r.held ? "ri-checkbox-circle-fill" : "ri-close-circle-line")} aria-label={r.held ? "Stopped" : "Not stopped"} />
                    <h3 className="text-[15px] font-medium text-ink">{r.attack}</h3>
                    <Badge tone={r.held ? "neutral" : "danger"}>{r.held ? `Stopped by: ${r.stoppedBy}` : "Got through"}</Badge>
                    {r.proof === "design" && <Badge>By design</Badge>}
                  </div>
                  <p className="mt-1.5 text-sm text-muted">Tried: {r.attempt}.</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-ink-2">{r.detail}</p>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </Card>
  );
}

function WalletCard({ a, onDone }: { a: AgentStatusDTO; onDone: () => void }) {
  const d = a.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [simulated, setSimulated] = useState(false);
  const { autofill, typing, cancel } = useSimulatedAutofill();

  const act = async (action: "enable" | "topup" | "revoke") => {
    setBusy(action);
    setError(null);
    try {
      const result = await api<{ needsConfirmation?: boolean; devCode?: string }>("/api/agent/wallet", { body: { action, code: action === "enable" && needsCode ? code : undefined } });
      if (result.needsConfirmation) {
        setNeedsCode(true);
        setSimulated(Boolean(result.devCode));
        if (result.devCode) autofill(result.devCode, setCode);
        return;
      }
      setNeedsCode(false);
      setCode("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Agent wallet and data budget"
        hint="The agent pays for market data per request over x402, from its own small wallet. That key can't touch your vault or main wallet."
        action={d.enabled ? <Badge tone="accent">On</Badge> : <Badge>Off</Badge>}
      />
      <div className="space-y-4 px-5 pt-3 pb-5">
        {!d.enabled ? (
          <>
            <p className="text-sm leading-relaxed text-ink-2">
              Give the agent up to {usd(d.budgetUsd)} from your main wallet. It may spend {usd(d.dailyUsd)} a day, {usd(d.maxCallUsd)} a request, and only at sellers on its list. You can
              take it all back at any time.
            </p>
            {needsCode && (
              <Field
                label="Code from your email"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => {
                  cancel();
                  setCode(e.target.value.replace(/\D/g, ""));
                }}
                hint={typing ? "Filling in the code…" : simulated ? "Development mode: no email is sent, so the code was filled in for you." : "We sent a 6-digit code to confirm giving the agent a budget."}
              />
            )}
            <Button size="sm" icon="ri-wallet-3-line" loading={busy === "enable" || typing} disabled={needsCode && code.length !== 6} onClick={() => act("enable")}>
              {needsCode ? "Confirm and fund the agent" : "Give the agent a data budget"}
            </Button>
          </>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted">In the agent wallet</dt>
                <dd className="tabular mt-0.5 text-[20px] font-bold tracking-tight text-ink">{usd(d.balanceUsd)}</dd>
              </div>
              <div>
                <dt className="text-muted">Max per request</dt>
                <dd className="tabular mt-0.5 text-ink">{usd(d.maxCallUsd)}</dd>
              </div>
              <div className="max-sm:col-span-2">
                <dt className="text-muted">May buy from</dt>
                <dd className="mt-0.5 break-all text-ink">{d.sellers.join(", ")}</dd>
              </div>
            </dl>
            <Meter label="Spent on data in the last 24h" value={d.spent24hUsd} max={d.dailyUsd} detail={`${usd(d.spent24hUsd)} of ${usd(d.dailyUsd)}`} />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon="ri-add-line" loading={busy === "topup"} disabled={busy !== null} onClick={() => act("topup")}>
                Top up to {usd(d.budgetUsd)}
              </Button>
              <Button size="sm" variant="danger" icon="ri-forbid-line" loading={busy === "revoke"} disabled={busy !== null} onClick={() => act("revoke")}>
                Revoke and take the money back
              </Button>
              {d.wallet && (
                <a href={accountUrl(d.wallet)} target="_blank" rel="noreferrer" className="ml-auto rounded text-sm text-ink underline-offset-4 hover:underline">
                  {short(d.wallet)} on StellarChain
                </a>
              )}
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="flex gap-1.5 text-sm text-ink">
            <i className="ri-error-warning-line" aria-hidden />
            {error}
          </p>
        )}
        {d.payments.length > 0 && (
          <div>
            <h3 className="text-sm text-muted">Data payments</h3>
            <ul className="mt-1.5 divide-y divide-line text-sm">
              {d.payments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                  <i className={cx("translate-y-0.5 text-ink", p.status === "paid" ? "ri-checkbox-circle-fill" : p.status === "blocked" ? "ri-shield-cross-line" : "ri-error-warning-line")} aria-hidden />
                  <span className="text-ink">
                    {p.status === "paid" ? "Paid" : p.status === "blocked" ? "Blocked" : "Failed"} <span className="tabular">{usd(p.amountUsd)}</span>
                  </span>
                  <span className="min-w-0 truncate text-muted">{hostOf(p.url)}</span>
                  <span className="ml-auto text-xs text-muted">{timeAgo(p.createdAt)}</span>
                  {p.txHash && (
                    <a href={txUrl(p.txHash)} target="_blank" rel="noreferrer" className="rounded text-xs text-ink underline-offset-4 hover:underline">
                      Transaction
                    </a>
                  )}
                  {p.reason && p.status !== "paid" && <p className="w-full pl-7 text-xs leading-relaxed text-muted">{p.reason}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

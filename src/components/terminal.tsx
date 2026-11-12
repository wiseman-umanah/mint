"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { amountDigits, ASSETS, BASE_ASSETS, type BaseAsset, pairSlug, priceDigits } from "@/lib/assets";
import { num, price as fmtPrice, signed, useApi } from "@/lib/client";
import type { Candle } from "@/lib/stellar/market";
import type { MarketDTO, PortfolioDTO } from "@/lib/types";
import { PriceChart } from "./chart";
import { FormShell, Segmented, SwapForm, useProposal } from "./forms";
import { Badge, Button, Card, CardHeader, ErrorState, Field, Skeleton, cx } from "./ui";

type Network = "mainnet" | "testnet";
type Interval = "5m" | "15m" | "1h" | "1d";

export function TradingTerminal({ base }: { base: BaseAsset }) {
  const [network, setNetwork] = useState<Network>("mainnet");
  const [interval, setTimeframe] = useState<Interval>("1h");
  const market = useApi<MarketDTO>(`/api/market?asset=${base}`, 10_000);
  const portfolio = useApi<PortfolioDTO>("/api/portfolio", 15_000);
  const candles = useApi<Candle[]>(`/api/market/candles?asset=${base}&network=${network}&interval=${interval}`, 30_000);
  const m = market.data;
  const p = portfolio.data;

  return (
    <div className="space-y-4">
      <Ticker base={base} m={m} p={p} />
      {market.error && <ErrorState message={market.error} onRetry={market.refresh} />}

      {/* Two columns on desktop. Below lg the columns dissolve into one stack (display: contents)
          so the order ticket sits right under the chart and open orders drop to the end. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="contents min-w-0 lg:block lg:space-y-4">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
              <Segmented<Network>
                label="Chart market"
                value={network}
                onChange={setNetwork}
                options={[
                  { value: "mainnet", label: "Mainnet price" },
                  { value: "testnet", label: "Testnet fills" },
                ]}
              />
              <Segmented<Interval>
                label="Candle interval"
                value={interval}
                onChange={setTimeframe}
                options={[
                  { value: "5m", label: "5m" },
                  { value: "15m", label: "15m" },
                  { value: "1h", label: "1h" },
                  { value: "1d", label: "1d" },
                ]}
              />
            </div>
            <div className="relative h-[360px] px-1 pt-2 pb-1 sm:h-[520px]">
              <PriceChart candles={candles.data} digits={m ? priceDigits(m.reference.mid) : 5} label={`${base} to USDC price chart`} className="size-full" />
              {candles.loading && <Skeleton className="absolute inset-4" />}
              {candles.data?.length === 0 && (
                <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted">
                  No {network} trades in this window yet. Try a longer interval.
                </p>
              )}
              {candles.error && (
                <div className="absolute inset-x-4 top-4">
                  <ErrorState message={candles.error} onRetry={candles.refresh} />
                </div>
              )}
            </div>
          </Card>
          <div className="order-last lg:order-none">
            <OpenOrders p={p} onSettled={portfolio.refresh} />
          </div>
        </div>

        <div className="contents lg:block lg:space-y-4">
          <OrderEntry base={base} m={m} p={p} onSettled={portfolio.refresh} />
          <OrderBook base={base} m={m} />
        </div>
      </div>
    </div>
  );
}

export const directionTone = (pct: number) => (Math.abs(pct) < 0.005 ? "text-ink" : pct > 0 ? "text-up" : "text-down");

const compactUsd = (n: number) => (n >= 1e6 ? `$${num(n / 1e6, 1)}M` : n >= 1e3 ? `$${num(n / 1e3, 1)}K` : `$${num(n, 0)}`);

function Ticker({ base, m, p }: { base: BaseAsset; m: MarketDTO | null; p: PortfolioDTO | null }) {
  const change = m?.reference.change24hPct ?? 0;
  const direction = directionTone(change);
  const stats: [string, string | null, string?][] = [
    ["24h change", m ? `${signed(change)}%` : null, direction],
    ["24h high", m ? fmtPrice(m.reference.high24h) : null],
    ["24h low", m ? fmtPrice(m.reference.low24h) : null],
    ["24h volume", m ? compactUsd(m.reference.volume24hUsd) : null],
    ["Testnet mid", m ? (m.venue.mid ? fmtPrice(m.venue.mid) : "No quotes") : null],
    ["Gap to mainnet", m ? (m.deviationBps !== null ? `${signed(m.deviationBps, 0)} bps` : "n/a") : null],
  ];

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4">
        <div className="flex items-center gap-3">
          <PairSwitcher base={base} />
          {m ? (
            <span className={cx("tabular text-[22px] leading-none font-bold", direction)}>{fmtPrice(m.reference.mid)}</span>
          ) : (
            <Skeleton className="h-6 w-20" />
          )}
          {m && Math.abs(change) >= 0.005 && (
            <i
              className={cx("text-lg", direction, change > 0 ? "ri-arrow-right-up-line" : "ri-arrow-right-down-line")}
              aria-label={change > 0 ? "up over 24 hours" : "down over 24 hours"}
            />
          )}
        </div>
        <dl className="flex flex-wrap gap-x-7 gap-y-3 text-sm">
          {stats.map(([label, value, tone = "text-ink"]) => (
            <div key={label}>
              <dt className="text-muted">{label}</dt>
              <dd className={cx("tabular mt-0.5", tone)}>{value ?? <Skeleton className="h-5 w-16" />}</dd>
            </div>
          ))}
        </dl>
        {p && (
          <div className="ml-auto">
            <Badge tone={p.guardrails.halted ? "danger" : p.guardrails.mode === "autonomous" ? "accent" : "neutral"}>
              {p.guardrails.halted ? "Trading halted" : p.guardrails.mode === "autonomous" ? "Autonomous" : "Copilot"}
            </Badge>
          </div>
        )}
      </div>
    </Card>
  );
}

/** The pair name doubles as a menu of every market, each its own route. */
function PairSwitcher({ base }: { base: BaseAsset }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        className="inline-flex items-center gap-1.5 rounded-full py-1 pr-2 text-left transition-colors duration-[var(--dur-micro)] hover:text-ink-2"
      >
        <h1 className="font-display text-[22px] leading-none font-extrabold tracking-tight">{base} / USDC</h1>
        <i className={cx("text-xl text-muted", open ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line")} aria-hidden />
      </button>
      {open && (
        <nav aria-label="Markets" className="glass absolute top-full left-0 z-20 mt-2 w-64 rounded-[18px] p-1.5">
          {BASE_ASSETS.map((code) => (
            <Link
              key={code}
              href={`/trading/${pairSlug(code)}`}
              onClick={() => setOpen(false)}
              aria-current={code === base ? "page" : undefined}
              className={cx(
                "flex items-baseline justify-between gap-3 rounded-[12px] px-3 py-2 text-sm transition-colors duration-[var(--dur-micro)]",
                code === base ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-well hover:text-ink",
              )}
            >
              <span className="font-medium">{code} / USDC</span>
              <span className="truncate text-xs text-muted">{ASSETS[code].name}</span>
            </Link>
          ))}
          <Link href="/markets" onClick={() => setOpen(false)} className="mt-1 block rounded-[12px] border-t border-line px-3 py-2 text-sm text-ink-2 hover:text-ink">
            All markets
          </Link>
        </nav>
      )}
    </div>
  );
}

function OrderEntry({ base, m, p, onSettled }: { base: BaseAsset; m: MarketDTO | null; p: PortfolioDTO | null; onSettled: () => void }) {
  const [type, setType] = useState<"market" | "limit">("limit");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const order = useProposal(onSettled);
  const total = Number(price) * Number(amount);
  const reference = m?.venue.mid ?? m?.reference.mid;
  const digits = reference ? priceDigits(reference) : 5;

  return (
    <Card>
      <CardHeader
        title="Place an order"
        hint={
          p
            ? `Vault: ${num(p.vault.balances.USDC)} USDC and ${num(p.vault.balances[base], amountDigits(base))} ${base}`
            : "Trades settle in your vault."
        }
      />
      <div className="space-y-4 px-5 pt-4 pb-5">
        <Segmented
          label="Order type"
          value={type}
          onChange={setType}
          options={[
            { value: "limit", label: "Limit" },
            { value: "market", label: "Market swap" },
          ]}
        />
        {type === "market" ? (
          <SwapForm wallet="vault" assets={[base, "USDC"]} onSettled={onSettled} />
        ) : (
          <div className="space-y-4">
            <FormShell
              submit={`Review ${side} order`}
              busy={order.busy}
              error={order.error}
              onSubmit={() => order.stage("propose_limit_order", { asset: base, side, amount: Number(amount), price_usdc: Number(price) })}
            >
              <div className="grid grid-cols-2 gap-1 rounded-full border border-line bg-well p-1" role="radiogroup" aria-label="Side">
                {(["buy", "sell"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={side === s}
                    onClick={() => setSide(s)}
                    className={cx(
                      "h-9 rounded-full text-sm font-medium capitalize transition-colors duration-[var(--dur-micro)]",
                      side !== s ? "text-muted hover:text-ink" : s === "buy" ? "bg-up text-paper" : "bg-down text-ink",
                    )}
                  >
                    {s} {base}
                  </button>
                ))}
              </div>
              <Field
                label={`Price (USDC per ${base})`}
                inputMode="decimal"
                placeholder={reference ? reference.toFixed(digits) : "0.00"}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                required
                pattern="[0-9]*[.]?[0-9]+"
                suffix={
                  reference ? (
                    <button type="button" onClick={() => setPrice(reference.toFixed(digits))} className="-mr-1.5 inline-flex h-8 items-center rounded-full px-2.5 text-sm text-ink-2 hover:text-ink">
                      Mid
                    </button>
                  ) : null
                }
              />
              <Field label={`Amount (${base})`} inputMode="decimal" placeholder={reference ? (25 / reference).toFixed(amountDigits(base)) : "0"} value={amount} onChange={(e) => setAmount(e.target.value)} required pattern="[0-9]*[.]?[0-9]+" />
              <p className="flex justify-between text-sm">
                <span className="text-muted">Total</span>
                <span className="tabular text-ink">{Number.isFinite(total) && total > 0 ? `${num(total, 4)} USDC` : "n/a"}</span>
              </p>
            </FormShell>
            {order.card}
          </div>
        )}
      </div>
    </Card>
  );
}

function OrderBook({ base, m }: { base: BaseAsset; m: MarketDTO | null }) {
  if (!m) {
    return (
      <Card>
        <CardHeader title="Order book" />
        <div className="px-5 pt-4 pb-5">
          <Skeleton className="h-72" />
        </div>
      </Card>
    );
  }
  const asks = m.venue.asks.slice(0, 8);
  const bids = m.venue.bids.slice(0, 8);
  const depth = Math.max(...asks.map((a) => a.amount), ...bids.map((b) => b.amount), 1);

  return (
    <Card>
      <CardHeader title="Order book" hint="Stellar DEX, testnet." />
      <div className="px-3 pt-3 pb-4">
        <div className="flex justify-between px-2 pb-1.5 text-xs text-muted">
          <span>Price (USDC)</span>
          <span>Size ({base})</span>
        </div>
        <BookRows base={base} rows={[...asks].reverse()} depth={depth} side="ask" />
        <div className="my-1.5 flex items-baseline justify-between rounded-control bg-well px-2 py-2">
          <span className="tabular text-[17px] font-bold">{m.venue.mid ? fmtPrice(m.venue.mid) : "No quotes"}</span>
          <span className="text-xs text-muted">Spread {m.venue.spreadBps !== null ? `${num(m.venue.spreadBps, 0)} bps` : "n/a"}</span>
        </div>
        <BookRows base={base} rows={bids} depth={depth} side="bid" />
        {asks.length + bids.length === 0 && <p className="px-2 py-4 text-sm text-muted">No resting orders. The market maker starts with pnpm dev.</p>}
      </div>
    </Card>
  );
}

function BookRows({ base, rows, depth, side }: { base: BaseAsset; rows: { price: number; amount: number }[]; depth: number; side: "bid" | "ask" }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{side === "bid" ? `Bids, buyers of ${base}` : `Asks, sellers of ${base}`}</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.price}-${r.amount}`} className="relative">
            <td className={cx("tabular relative z-10 px-2 py-1", side === "bid" ? "text-up" : "text-down")}>{fmtPrice(r.price)}</td>
            <td className="tabular relative z-10 px-2 py-1 text-right text-ink-2">
              {num(r.amount, amountDigits(base))}
              {/* Depth bar, scaled to the largest level on either side. */}
              <span
                aria-hidden
                className={cx("absolute inset-y-0.5 right-0 -z-10 w-full origin-right rounded-sm", side === "bid" ? "bg-up-soft" : "bg-down-soft")}
                style={{ transform: `scaleX(${r.amount / depth})` }}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OpenOrders({ p, onSettled }: { p: PortfolioDTO | null; onSettled: () => void }) {
  const cancel = useProposal(onSettled);
  const offers = p?.offers ?? [];
  return (
    <Card>
      <CardHeader
        title="Open orders"
        hint="Resting in your vault on the Stellar DEX, across every market."
        action={
          offers.length > 0 ? (
            <Button size="sm" variant="secondary" loading={cancel.busy} onClick={() => cancel.stage("propose_cancel_orders")}>
              Cancel all
            </Button>
          ) : null
        }
      />
      <div className="space-y-3 px-5 pt-3 pb-5">
        {!p && <Skeleton className="h-16" />}
        {p && offers.length === 0 && <p className="text-sm text-muted">No open orders. Place a limit order and it rests here until it fills.</p>}
        {offers.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-muted">
                <th scope="col" className="py-1.5 text-left font-normal">Market</th>
                <th scope="col" className="py-1.5 text-left font-normal">Side</th>
                <th scope="col" className="py-1.5 text-right font-normal">Amount</th>
                <th scope="col" className="py-1.5 text-right font-normal">Price</th>
                <th scope="col" className="py-1.5 text-right font-normal">USDC</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => (
                <tr key={o.id} className="border-b border-line last:border-0">
                  <td className="py-2">
                    <Link href={`/trading/${pairSlug(o.base)}`} className="rounded underline-offset-4 hover:underline">
                      {o.base} / USDC
                    </Link>
                  </td>
                  <td className="py-2">
                    <span className={cx("font-medium capitalize", o.side === "buy" ? "text-up" : "text-down")}>{o.side}</span>
                  </td>
                  <td className="tabular py-2 text-right">{num(o.amount, amountDigits(o.base))}</td>
                  <td className="tabular py-2 text-right">{fmtPrice(o.price)}</td>
                  <td className="tabular py-2 text-right text-ink-2">{num(o.amount * o.price, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cancel.error && <ErrorState message={cancel.error} />}
        {cancel.card}
      </div>
    </Card>
  );
}

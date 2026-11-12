"use client";

import Link from "next/link";
import { useState } from "react";
import { pairSlug } from "@/lib/assets";
import { api, num, price, signed, usd, useApi } from "@/lib/client";
import type { MarketDTO, PortfolioDTO } from "@/lib/types";
import { Button, Card, ErrorState, Meter, Skeleton } from "./ui";

export function GuardrailMeters({ p }: { p: PortfolioDTO }) {
  const g = p.guardrails;
  return (
    <div className="space-y-4">
      <Meter label="Vault vs capital cap" value={p.vault.valueUsd} max={g.capitalCapUsd} detail={`${usd(p.vault.valueUsd)} of ${usd(g.capitalCapUsd, 0)}`} />
      <Meter
        label="Loss in the last 24h"
        value={p.loss.lossPct}
        max={g.dailyLossPct}
        detail={`${num(p.loss.lossPct)}% of ${g.dailyLossPct}%`}
      />
    </div>
  );
}

export function KillSwitch({ p, onDone }: { p: PortfolioDTO; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const halted = p.guardrails.halted;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/guardrails/halt", { body: { halted: !halted } });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {halted && <p className="mb-2 text-sm text-ink">Trading halted: {p.guardrails.haltedReason}</p>}
      <Button
        variant={halted ? "secondary" : "danger"}
        size="sm"
        icon={halted ? "ri-play-line" : "ri-stop-circle-line"}
        loading={busy}
        onClick={toggle}
        className="w-full"
      >
        {halted ? "Resume trading" : "Halt trading and cancel orders"}
      </Button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-ink">
          {error}
        </p>
      )}
    </div>
  );
}

export function Rail() {
  const portfolio = useApi<PortfolioDTO>("/api/portfolio", 15_000);
  const markets = useApi<MarketDTO[]>("/api/markets", 20_000);
  const p = portfolio.data;

  return (
    <div className="space-y-4">
      <Card>
        <div className="px-5 pt-4 pb-5">
          <p className="text-sm text-muted">Total balance</p>
          {p ? (
            <p className="tabular mt-1 text-[32px] leading-tight font-bold tracking-tight text-ink">{usd(p.totalUsd)}</p>
          ) : portfolio.error ? (
            <div className="mt-2">
              <ErrorState message={portfolio.error} onRetry={portfolio.refresh} />
            </div>
          ) : (
            <Skeleton className="mt-2 h-9 w-40" />
          )}
          <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
            <div>
              <dt className="text-muted">Main wallet</dt>
              <dd className="tabular mt-0.5 text-ink">{p ? usd(p.main.valueUsd) : <Skeleton className="h-5 w-20" />}</dd>
            </div>
            <div>
              <dt className="text-muted">Trading vault</dt>
              <dd className="tabular mt-0.5 text-ink">{p ? usd(p.vault.valueUsd) : <Skeleton className="h-5 w-20" />}</dd>
            </div>
          </dl>
        </div>
      </Card>

      <Card>
        <div className="space-y-4 px-5 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-medium">Guardrails</h2>
            <Link href="/guardrails" className="rounded text-sm text-ink underline-offset-4 hover:underline">
              Adjust
            </Link>
          </div>
          {p ? (
            <>
              <GuardrailMeters p={p} />
              <KillSwitch p={p} onDone={portfolio.refresh} />
            </>
          ) : (
            <div className="space-y-4">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          )}
        </div>
      </Card>

      <Card>
        <div className="px-5 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-medium">Markets</h2>
            <Link href="/markets" className="rounded text-sm text-ink underline-offset-4 hover:underline">
              See all
            </Link>
          </div>
          {markets.data ? (
            <ul className="mt-2 text-sm" aria-label="Market prices">
              {markets.data.map((m) => (
                <li key={m.base}>
                  <Link
                    href={`/trading/${pairSlug(m.base)}`}
                    className="-mx-2 flex items-baseline justify-between gap-3 rounded-[10px] px-2 py-1.5 transition-colors duration-[var(--dur-micro)] hover:bg-well"
                  >
                    <span className="font-medium text-ink">{m.base}</span>
                    <span className="tabular ml-auto text-ink-2">{price(m.reference.mid)}</span>
                    <span className={`tabular w-16 text-right ${directionTone(m.reference.change24hPct)}`}>{signed(m.reference.change24hPct)}%</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : markets.error ? (
            <div className="mt-3">
              <ErrorState message={markets.error} onRetry={markets.refresh} />
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

const directionTone = (pct: number) => (Math.abs(pct) < 0.005 ? "text-ink" : pct > 0 ? "text-up" : "text-down");

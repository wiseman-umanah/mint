"use client";

import Link from "next/link";
import { useState } from "react";
import { ASSETS, type AssetInfo, pairSlug } from "@/lib/assets";
import { num, price, signed, useApi } from "@/lib/client";
import type { MarketDTO } from "@/lib/types";
import { directionTone } from "./terminal";
import { Card, ErrorState, Skeleton, cx } from "./ui";

const GROUPS: ("All" | AssetInfo["group"])[] = ["All", "Major coins", "Stablecoins and FX", "Stellar ecosystem", "Real-world assets"];
type SortKey = "volume" | "change" | "volatility";

const compactUsd = (n: number) => (n >= 1e6 ? `$${num(n / 1e6, 1)}M` : n >= 1e3 ? `$${num(n / 1e3, 1)}K` : `$${num(n, 0)}`);

export function Markets() {
  const { data, error, loading, refresh } = useApi<MarketDTO[]>("/api/markets", 15_000);
  const [group, setGroup] = useState<(typeof GROUPS)[number]>("All");
  const [sort, setSort] = useState<SortKey>("volume");

  const rows = (data ?? [])
    .filter((m) => group === "All" || ASSETS[m.base].group === group)
    .sort((a, b) =>
      sort === "volume"
        ? b.reference.volume24hUsd - a.reference.volume24hUsd
        : sort === "change"
          ? Math.abs(b.reference.change24hPct) - Math.abs(a.reference.change24hPct)
          : b.signals.volatilityPct - a.signals.volatilityPct,
    );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-[32px] leading-tight font-extrabold tracking-tight">Markets</h1>
        <p className="mt-1 max-w-[62ch] text-ink-2">
          Prices and volume from the real Stellar mainnet markets. You trade testnet copies, quoted around these prices.
        </p>
      </header>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter markets">
        {GROUPS.map((g) => (
          <button
            key={g}
            type="button"
            aria-pressed={group === g}
            onClick={() => setGroup(g)}
            className={cx(
              "h-9 rounded-full border px-4 text-sm transition-colors duration-[var(--dur-micro)]",
              group === g ? "border-ink bg-ink text-paper" : "border-line-strong text-ink-2 hover:text-ink",
            )}
          >
            {g}
          </button>
        ))}
      </div>

      {error && <ErrorState message={error} onRetry={refresh} />}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm md:min-w-[760px]">
            <thead>
              <tr className="border-b border-line text-muted">
                <th scope="col" className="py-3 pr-3 pl-4 text-left font-normal sm:px-5">Market</th>
                <th scope="col" className="px-3 py-3 text-right font-normal">Price</th>
                <SortHeader id="change" sort={sort} onSort={setSort}>
                  24h change
                </SortHeader>
                <SortHeader id="volume" sort={sort} onSort={setSort} className="hidden sm:table-cell">
                  24h volume
                </SortHeader>
                <SortHeader id="volatility" sort={sort} onSort={setSort} className="hidden md:table-cell">
                  Volatility
                </SortHeader>
                <th scope="col" className="hidden px-3 py-3 text-right font-normal md:table-cell">Testnet spread</th>
                <th scope="col" className="hidden px-5 py-3 text-right font-normal md:table-cell">
                  <span className="sr-only">Trade</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 6 }, (_, i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    <td colSpan={7} className="px-5 py-3">
                      <Skeleton className="h-6" />
                    </td>
                  </tr>
                ))}
              {rows.map((m) => (
                <tr key={m.base} className="border-b border-line transition-colors duration-[var(--dur-micro)] last:border-0 hover:bg-well">
                  <th scope="row" className="py-3 pr-3 pl-4 text-left font-normal sm:px-5">
                    <Link href={`/trading/${pairSlug(m.base)}`} className="rounded">
                      <span className="block font-medium text-ink">{m.base} / USDC</span>
                      <span className="block text-xs text-muted">{ASSETS[m.base].name}</span>
                    </Link>
                  </th>
                  <td className={cx("tabular px-3 py-3 text-right font-medium", directionTone(m.reference.change24hPct))}>{price(m.reference.mid)}</td>
                  <td className={cx("tabular px-3 py-3 text-right", directionTone(m.reference.change24hPct))}>{signed(m.reference.change24hPct)}%</td>
                  <td className="tabular hidden px-3 py-3 text-right text-ink-2 sm:table-cell">{compactUsd(m.reference.volume24hUsd)}</td>
                  <td className="tabular hidden px-3 py-3 text-right text-ink-2 md:table-cell">{num(m.signals.volatilityPct, 2)}%</td>
                  <td className="tabular hidden px-3 py-3 text-right text-ink-2 md:table-cell">
                    {m.venue.spreadBps !== null ? `${num(m.venue.spreadBps, 0)} bps` : "No quotes"}
                  </td>
                  <td className="hidden px-5 py-3 text-right md:table-cell">
                    <Link
                      href={`/trading/${pairSlug(m.base)}`}
                      className="inline-flex h-8 items-center rounded-full border border-line-strong px-3.5 text-sm text-ink transition-colors duration-[var(--dur-micro)] hover:border-ink"
                    >
                      Trade
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && rows.length === 0 && <p className="px-5 py-4 text-sm text-muted">No markets in this group right now.</p>}
      </Card>
    </div>
  );
}

function SortHeader({ id, sort, onSort, className, children }: { id: SortKey; sort: SortKey; onSort: (key: SortKey) => void; className?: string; children: string }) {
  return (
    <th scope="col" aria-sort={sort === id ? "descending" : undefined} className={cx("px-3 py-3 text-right font-normal", className)}>
      <button type="button" onClick={() => onSort(id)} className={cx("-my-1.5 inline-flex h-8 items-center rounded", sort === id ? "text-ink" : "hover:text-ink")}>
        {children}
        {sort === id && <i className="ri-arrow-down-line ml-0.5" aria-hidden />}
      </button>
    </th>
  );
}

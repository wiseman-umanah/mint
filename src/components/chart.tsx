"use client";

import type { CandlestickData, HistogramData, IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { Candle } from "@/lib/stellar/market";

type Series = { candles: ISeriesApi<"Candlestick">; volume: ISeriesApi<"Histogram"> };

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** TradingView Lightweight Charts, coloured from the theme tokens (market green and red). */
export function PriceChart({ candles, digits, label, className }: { candles: Candle[] | null; digits: number; label: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const [series, setSeries] = useState<Series | null>(null);

  useEffect(() => {
    let disposed = false;
    // The library touches the DOM on load, so it is pulled in on the client only.
    void import("lightweight-charts").then(({ createChart, CandlestickSeries, HistogramSeries, ColorType, CrosshairMode }) => {
      if (disposed || !host.current) return;
      const muted = token("--color-muted");
      const grid = token("--chart-grid");
      const instance = createChart(host.current, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: muted,
          fontFamily: getComputedStyle(document.body).fontFamily,
          fontSize: 12,
          attributionLogo: true,
        },
        grid: { vertLines: { color: grid }, horzLines: { color: grid } },
        rightPriceScale: { borderColor: grid },
        timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: muted, labelBackgroundColor: token("--color-surface") },
          horzLine: { color: muted, labelBackgroundColor: token("--color-surface") },
        },
      });
      const candles = instance.addSeries(CandlestickSeries, {
        upColor: token("--chart-up"),
        downColor: token("--chart-down"),
        borderUpColor: token("--chart-up"),
        borderDownColor: token("--chart-down-edge"),
        wickUpColor: token("--chart-up"),
        wickDownColor: token("--chart-down-edge"),
      });
      const volume = instance.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
      chart.current = instance;
      setSeries({ candles, volume });
    });
    return () => {
      disposed = true;
      chart.current?.remove();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    series?.candles.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 1 / 10 ** digits } });
  }, [series, digits]);

  useEffect(() => {
    if (!series || !candles) return;
    const up = token("--chart-volume-up");
    const down = token("--chart-volume-down");
    series.candles.setData(
      candles.map((c): CandlestickData => ({ time: (c.t / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })),
    );
    series.volume.setData(
      candles.map((c): HistogramData => ({ time: (c.t / 1000) as UTCTimestamp, value: c.volume, color: c.close >= c.open ? up : down })),
    );
    chart.current?.timeScale().fitContent();
  }, [series, candles]);

  return <div ref={host} className={className} role="img" aria-label={label} />;
}

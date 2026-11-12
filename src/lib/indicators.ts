import type { Candle } from "./stellar/market";

// Classic technical indicators over hourly candles. Computed here so the AI quotes numbers,
// never estimates them.

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);

export const sma = (closes: number[], period: number) => (closes.length >= period ? mean(closes.slice(-period)) : null);

/** Wilder's RSI. Above 70 is conventionally overbought, below 30 oversold. */
export function rsi(closes: number[], period = 14) {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

/** Average true range as a % of price: how far it typically moves in one candle. */
export function atrPct(candles: Candle[], period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(1).map((c, i) => {
    const prev = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  const last = candles.at(-1)!.close;
  return last ? (mean(ranges.slice(-period)) / last) * 100 : null;
}

/** Daily volatility (%) from hourly log returns. */
export function dailyVolatilityPct(closes: number[]) {
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i])).filter(Number.isFinite);
  if (returns.length < 2) return null;
  const avg = mean(returns);
  return Math.sqrt(mean(returns.map((r) => (r - avg) ** 2))) * Math.sqrt(24) * 100;
}

const change = (from: number | undefined, to: number) => (from ? ((to - from) / from) * 100 : null);

/** Everything the assistant needs for a technical read of one market. Expects hourly candles. */
export function technicals(candles: Candle[]) {
  const closes = candles.map((c) => c.close).filter((c) => c > 0);
  const last = closes.at(-1) ?? 0;
  const recent = candles.slice(-48);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  return {
    last,
    change_24h_pct: change(closes.at(-25), last),
    change_7d_pct: change(closes.at(-169) ?? closes[0], last),
    sma_20h: sma20,
    sma_50h: sma50,
    trend: sma20 && sma50 ? (sma20 > sma50 * 1.002 ? "up" : sma20 < sma50 * 0.998 ? "down" : "flat") : "unknown",
    rsi_14h: rsi(closes),
    atr_14h_pct: atrPct(candles),
    daily_volatility_pct: dailyVolatilityPct(closes.slice(-168)),
    support_48h: recent.length ? Math.min(...recent.map((c) => c.low)) : null,
    resistance_48h: recent.length ? Math.max(...recent.map((c) => c.high)) : null,
    candles_used: candles.length,
  };
}

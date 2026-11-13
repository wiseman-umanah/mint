import type { BaseAsset } from "../assets";
import type { AssetRead } from "../db/schema";
import { atrPct, rsi, sma } from "../indicators";
import type { Candle, MarketSnapshot } from "../stellar/market";

/**
 * The agent's rulebook. Long-only against USDC, read from hourly mainnet candles. The shape
 * follows what established open-source bots do: a regime filter first, then entries, with every
 * position bounded by a stop, a target and a time limit (Hummingbot's "triple barrier") and
 * cooldowns after losses (Freqtrade's protections).
 */
export const RULES = {
  // Regime: no new buys, and agent positions are sold, when any of these hold.
  maxAtrPct: 4,
  maxDrop24hPct: 8,
  // Entries.
  trendMaxRsi: 72,
  dipMaxRsi: 35,
  // Sizing: lose at most this share of the vault if the stop is hit.
  riskPerTradePct: 1,
  maxPositionPct: 25,
  maxExposurePct: 60,
  maxPositions: 4,
  minTradeUsd: 2,
  // Exits. The stop sits 2 ATR under the entry, kept between these bounds.
  stopAtr: 2,
  minStopPct: 1.2,
  maxStopPct: 8,
  // Target is this multiple of the stop distance above the entry.
  rewardToRisk: 1.5,
  // Once the price has run this fraction of the stop distance, the stop trails the high.
  trailAfter: 0.75,
  timeStopHours: 48,
  // Protections.
  cooldownHours: 6,
  lossStreak: 3,
  lossPauseHours: 12,
  // Data quality.
  minCandles: 50,
  maxCandleAgeHours: 12,
} as const;

export type Read = AssetRead & {
  asset: BaseAsset;
  sma20: number | null;
  sma50: number | null;
  // Which entry rule is satisfied right now, if any.
  entry: "trend" | "dip" | null;
  // Short name of the rule that produced this read; the journal logs a row when it changes.
  code: "no_data" | "volatile" | "falling" | "downtrend" | "overbought" | "trend" | "dip" | "range";
  // Distance from entry to stop for a position opened now, in percent.
  stopPct: number;
};

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
const HOUR = 3_600_000;

/** One market, judged. Pure: the same candles and price always give the same read. */
export function readMarket(market: MarketSnapshot, hourly: Candle[], now = Date.now()): Read {
  const candles = hourly.filter((c) => c.close > 0);
  const closes = candles.map((c) => c.close);
  const price = market.reference.mid;
  const base = {
    asset: market.base,
    price,
    change24hPct: market.reference.change24hPct,
    rsi: null as number | null,
    atrPct: null as number | null,
    sma20: null as number | null,
    sma50: null as number | null,
    score: 0,
    entry: null as Read["entry"],
    stopPct: RULES.minStopPct,
  };

  const lastCandle = candles.at(-1);
  if (!price || candles.length < RULES.minCandles || !lastCandle || now - lastCandle.t > RULES.maxCandleAgeHours * HOUR) {
    const why = !price
      ? "No mainnet price right now."
      : candles.length < RULES.minCandles
        ? `Only ${candles.length} hourly candles on mainnet; the rules need ${RULES.minCandles}.`
        : `No mainnet trades for over ${RULES.maxCandleAgeHours} hours.`;
    return { ...base, regime: "no_data", code: "no_data", note: `${why} Not trading it.` };
  }

  const sma20 = sma(closes, 20)!;
  const sma50 = sma(closes, 50)!;
  const r = rsi(closes) ?? 50;
  const atr = atrPct(candles) ?? 0;
  const read = { ...base, rsi: r, atrPct: atr, sma20, sma50, stopPct: clamp(RULES.stopAtr * atr, RULES.minStopPct, RULES.maxStopPct) };
  const rsiText = `RSI ${r.toFixed(0)}`;

  if (atr > RULES.maxAtrPct) {
    return { ...read, regime: "risk_off", code: "volatile", note: `Too volatile: moving ${atr.toFixed(1)}% an hour (limit ${RULES.maxAtrPct}%). Staying in USDC.` };
  }
  if (read.change24hPct < -RULES.maxDrop24hPct) {
    return { ...read, regime: "risk_off", code: "falling", note: `Down ${Math.abs(read.change24hPct).toFixed(1)}% in 24h (limit ${RULES.maxDrop24hPct}%). Staying in USDC.` };
  }
  if (price < sma50 && sma20 < sma50) {
    return { ...read, regime: "risk_off", code: "downtrend", note: `Downtrend: price and the 20h average are below the 50h average. Staying in USDC.` };
  }

  if (price > sma20 && sma20 > sma50) {
    if (r >= RULES.trendMaxRsi) {
      return { ...read, regime: "trend", code: "overbought", note: `Uptrend but overbought (${rsiText}). Waiting for RSI under ${RULES.trendMaxRsi} before buying.` };
    }
    const strength = clamp((sma20 / sma50 - 1) * 25, 0, 0.3);
    return {
      ...read,
      regime: "trend",
      code: "trend",
      entry: "trend",
      score: 0.5 + strength + (r >= 45 && r <= 65 ? 0.2 : 0),
      note: `Uptrend: price is above the 20h average, which is above the 50h average. ${rsiText}.`,
    };
  }

  if (r <= RULES.dipMaxRsi) {
    return {
      ...read,
      regime: "range",
      code: "dip",
      entry: "dip",
      score: 0.4 + ((RULES.dipMaxRsi - r) / RULES.dipMaxRsi) * 0.4,
      note: `Oversold in a range (${rsiText}). Buying the dip back toward the 50h average.`,
    };
  }
  return { ...read, regime: "range", code: "range", note: `No trend, ${rsiText}. Waiting for an uptrend or RSI ${RULES.dipMaxRsi} or lower.` };
}

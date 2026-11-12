import { BASE_ASSETS, type BaseAsset } from "../assets";
import { assetFor, horizon, mainnetAssetFor, mainnetHorizon, mainnetUsdc, usdc } from "./config";

export type Candle = { t: number; open: number; high: number; low: number; close: number; volume: number };

export type MarketSnapshot = {
  base: BaseAsset;
  pair: `${BaseAsset}/USDC`;
  // Mainnet: the real market, used as the fair-value reference.
  reference: {
    bid: number;
    ask: number;
    mid: number;
    // "book" when the mainnet spread is tight enough to trust the mid, else the last trade.
    priceSource: "book" | "last_trade";
    change24hPct: number;
    high24h: number;
    low24h: number;
    // In units of the base asset.
    volume24h: number;
    volume24hUsd: number;
    candles: Candle[];
  };
  // Testnet: where MINT actually trades.
  venue: {
    bid: number | null;
    ask: number | null;
    mid: number | null;
    spreadBps: number | null;
    bidDepth: number;
    askDepth: number;
    bids: { price: number; amount: number }[];
    asks: { price: number; amount: number }[];
  };
  // Venue mid vs reference mid, in basis points (+ = testnet is rich).
  deviationBps: number | null;
  takenAt: string;
};

const HOUR = 3_600_000;
// Wider than this and the book mid is noise (mainnet ETH/USDC often sits at 1600 / 2950).
const MAX_TRUSTED_SPREAD = 0.01;

/*
 * Public Horizon allows about 3,600 requests an hour per IP, per network. Every pair costs three
 * calls, and the market maker, the watchlist, the markets page and the portfolio all ask for every
 * pair, so each piece is cached for as long as it stays useful:
 *   mainnet order book  30 s   (8 pairs: ~960 calls an hour)
 *   mainnet 24h candles  5 min (~100 an hour)
 *   testnet order book  15 s   (~1,900 an hour at most)
 * A failed refresh keeps serving the last good value for up to STALE_LIMIT_MS, and a 429 pauses
 * that network for a minute instead of hammering it again.
 */
const TTL = { refBook: 30_000, refCandles: 5 * 60_000, venueBook: 15_000 };
const STALE_LIMIT_MS = 10 * 60_000;
const RATE_LIMIT_PAUSE_MS = 60_000;

type Network = "mainnet" | "testnet";
type Entry<T> = { at: number; value?: T; pending?: Promise<T> };
const entries = new Map<string, Entry<unknown>>();
const pausedUntil: Record<Network, number> = { mainnet: 0, testnet: 0 };

const isRateLimited = (error: unknown) => (error as { response?: { status?: number } })?.response?.status === 429;

/** Fresh within `ttl`; on failure, the last good value if it isn't too old. One request in flight per key. */
function cached<T>(network: Network, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const entry = (entries.get(key) ?? { at: 0 }) as Entry<T>;
  entries.set(key, entry);
  const now = Date.now();
  const stale = entry.value !== undefined && now - entry.at < STALE_LIMIT_MS ? entry.value : undefined;
  if (entry.value !== undefined && now - entry.at < ttl) return Promise.resolve(entry.value);
  if (entry.pending) return stale !== undefined ? Promise.resolve(stale) : entry.pending;
  if (now < pausedUntil[network]) {
    return stale !== undefined ? Promise.resolve(stale) : Promise.reject(new Error(`Stellar ${network} is rate limiting MINT; retrying shortly`));
  }
  // Wrapped so a loader that throws synchronously rejects like any other failure.
  entry.pending = new Promise<T>((resolve) => resolve(load()))
    .then((value) => {
      entry.value = value;
      entry.at = Date.now();
      return value;
    })
    .catch((error) => {
      if (isRateLimited(error) && Date.now() >= pausedUntil[network]) {
        pausedUntil[network] = Date.now() + RATE_LIMIT_PAUSE_MS;
        console.warn(`[mint] Stellar ${network} rate limit hit; pausing its market data for ${RATE_LIMIT_PAUSE_MS / 1000}s`);
      }
      if (stale !== undefined) return stale;
      throw error;
    })
    .finally(() => {
      entry.pending = undefined;
    });
  return stale !== undefined ? Promise.resolve(stale) : entry.pending;
}

/** Every market at once; a pair that fails to load is left out rather than failing the rest. */
export async function allMarkets() {
  const results = await Promise.allSettled(BASE_ASSETS.map((base) => marketSnapshot(base)));
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

/** USD price of every asset; USDC is 1 by definition. Missing markets price at 0. */
export async function referencePrices() {
  const prices = { USDC: 1 } as Record<BaseAsset | "USDC", number>;
  for (const m of await allMarkets()) prices[m.base] = m.reference.mid;
  for (const base of BASE_ASSETS) prices[base] ??= 0;
  return prices;
}

const toCandles = (records: { timestamp: number | string; open: string; high: string; low: string; close: string; base_volume: string }[]): Candle[] =>
  records.map((r) => ({
    t: Number(r.timestamp),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.base_volume),
  }));

export async function marketSnapshot(base: BaseAsset = "XLM"): Promise<MarketSnapshot> {
  const real = mainnetAssetFor(base);
  const [refBook, candles, venueBook] = await Promise.all([
    cached("mainnet", `ref-book:${base}`, TTL.refBook, () => mainnetHorizon().orderbook(real, mainnetUsdc()).limit(5).call()),
    cached("mainnet", `ref-candles:${base}`, TTL.refCandles, () => {
      const end = Date.now();
      const start = Math.floor((end - 24 * HOUR) / HOUR) * HOUR;
      return mainnetHorizon().tradeAggregation(real, mainnetUsdc(), start, end, HOUR, 0).limit(48).call().then((r) => toCandles(r.records));
    }),
    cached("testnet", `venue-book:${base}`, TTL.venueBook, () => horizon().orderbook(assetFor(base), usdc()).limit(20).call()),
  ]);

  const refBid = Number(refBook.bids[0]?.price ?? 0);
  const refAsk = Number(refBook.asks[0]?.price ?? 0);
  const bookMid = refBid && refAsk ? (refBid + refAsk) / 2 : 0;
  const lastTrade = candles.at(-1)?.close ?? 0;
  const tight = bookMid > 0 && (refAsk - refBid) / bookMid <= MAX_TRUSTED_SPREAD;
  const mid = tight || !lastTrade ? bookMid : lastTrade;
  const first = candles[0]?.open ?? mid;

  const bids = venueBook.bids.map((b) => ({ price: Number(b.price), amount: Number(b.amount) / Number(b.price) }));
  // Horizon reports bid amounts in the counter asset (USDC); converted above to the base asset.
  const asks = venueBook.asks.map((a) => ({ price: Number(a.price), amount: Number(a.amount) }));
  const venueBid = bids[0]?.price ?? null;
  const venueAsk = asks[0]?.price ?? null;
  const venueMid = venueBid && venueAsk ? (venueBid + venueAsk) / 2 : null;
  const volume24h = candles.reduce((sum, c) => sum + c.volume, 0);

  return {
    base,
    pair: `${base}/USDC`,
    reference: {
      bid: refBid,
      ask: refAsk,
      mid,
      priceSource: tight || !lastTrade ? "book" : "last_trade",
      change24hPct: first ? ((mid - first) / first) * 100 : 0,
      high24h: Math.max(...candles.map((c) => c.high), mid),
      low24h: Math.min(...candles.map((c) => c.low), mid),
      volume24h,
      volume24hUsd: candles.reduce((sum, c) => sum + c.volume * c.close, 0),
      candles,
    },
    venue: {
      bid: venueBid,
      ask: venueAsk,
      mid: venueMid,
      spreadBps: venueMid && venueBid && venueAsk ? ((venueAsk - venueBid) / venueMid) * 10_000 : null,
      bidDepth: bids.reduce((sum, b) => sum + b.amount, 0),
      askDepth: asks.reduce((sum, a) => sum + a.amount, 0),
      bids: bids.slice(0, 8),
      asks: asks.slice(0, 8),
    },
    deviationBps: venueMid && mid ? ((venueMid - mid) / mid) * 10_000 : null,
    takenAt: new Date().toISOString(),
  };
}

export function usdValue(balances: Partial<Record<string, number>>, prices: Record<string, number>) {
  return Object.entries(prices).reduce((sum, [code, price]) => sum + (balances[code] ?? 0) * price, 0);
}

// Horizon only aggregates at these resolutions.
export const INTERVALS = { "5m": 300_000, "15m": 900_000, "1h": HOUR, "1d": 24 * HOUR } as const;
export type Interval = keyof typeof INTERVALS;
export type ChartNetwork = "mainnet" | "testnet";

/** OHLCV for the terminal chart: mainnet is the real market, testnet is where MINT's orders fill. */
export function chartCandles(base: BaseAsset, network: ChartNetwork, interval: Interval, limit = 200): Promise<Candle[]> {
  const resolution = INTERVALS[interval];
  // Mainnet bars only need refreshing a few times per bar; testnet shows MINT's own fills, so sooner.
  const ttl = network === "mainnet" ? Math.min(Math.max(resolution / 10, 30_000), 5 * 60_000) : 15_000;
  return cached(network, `chart:${base}:${network}:${interval}:${limit}`, ttl, () => {
    const end = Date.now();
    const start = Math.floor((end - resolution * limit) / resolution) * resolution;
    return (network === "mainnet"
      ? mainnetHorizon().tradeAggregation(mainnetAssetFor(base), mainnetUsdc(), start, end, resolution, 0)
      : horizon().tradeAggregation(assetFor(base), usdc(), start, end, resolution, 0)
    )
      .limit(limit)
      .call()
      .then((r) => toCandles(r.records));
  });
}

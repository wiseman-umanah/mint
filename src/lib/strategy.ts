import { amountDigits, type AssetCode, type BaseAsset, priceDigits } from "./assets";
import type { Portfolio } from "./portfolio";
import type { MarketSnapshot } from "./stellar/market";

export type TradeIdea = {
  kind: "swap" | "limit_order";
  title: string;
  rationale: string;
  risk: "low" | "medium" | "high";
  expectedReturnPct: number;
  maxSlippageBps: number;
  notionalUsd: number;
  params:
    | { wallet: "vault"; from: AssetCode; to: AssetCode; amount: number }
    | { side: "buy" | "sell"; base: BaseAsset; amount: number; price: number };
};

export type Signals = {
  trend: "up" | "down" | "flat";
  smaFast: number;
  smaSlow: number;
  volatilityPct: number;
  mispricing: "venue_cheap" | "venue_rich" | "none";
  targetXlmWeight: number;
  currentXlmWeight: number | null;
};

// Venue must be at least this far from fair value before we call it an opportunity.
const MISPRICING_BPS = 40;
const REBALANCE_DRIFT = 0.12;
const MIN_TRADE_USD = 2;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);

export function computeSignals(market: MarketSnapshot, portfolio?: Portfolio): Signals {
  const closes = market.reference.candles.map((c) => c.close);
  const smaFast = mean(closes.slice(-6));
  const smaSlow = mean(closes);
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const avg = mean(returns);
  const volatilityPct = Math.sqrt(mean(returns.map((r) => (r - avg) ** 2))) * Math.sqrt(24) * 100;
  const gap = smaSlow ? (smaFast - smaSlow) / smaSlow : 0;
  const trend = gap > 0.004 ? "up" : gap < -0.004 ? "down" : "flat";

  const { venue, reference } = market;
  const mispricing =
    venue.ask && venue.ask < reference.mid * (1 - MISPRICING_BPS / 10_000)
      ? "venue_cheap"
      : venue.bid && venue.bid > reference.mid * (1 + MISPRICING_BPS / 10_000)
        ? "venue_rich"
        : "none";

  let currentXlmWeight: number | null = null;
  if (portfolio && portfolio.vault.valueUsd > 0) {
    currentXlmWeight = (portfolio.vault.balances.XLM * reference.mid) / portfolio.vault.valueUsd;
  }
  return {
    trend,
    smaFast,
    smaSlow,
    volatilityPct,
    mispricing,
    targetXlmWeight: trend === "up" ? 0.6 : trend === "down" ? 0.35 : 0.5,
    currentXlmWeight,
  };
}

/**
 * Deterministic strategy generator. The LLM explains and converses; it never invents trades.
 * Every idea is sized to the user's per-trade cap and still has to pass the guardrails.
 */
export function generateIdeas(markets: MarketSnapshot[], portfolio: Portfolio): TradeIdea[] {
  const ideas: TradeIdea[] = [];
  const vault = portfolio.vault;
  const g = portfolio.guardrails;
  const cap = g.maxTradeUsd;
  const slippage = Math.min(g.maxSlippageBps, 80);

  // 1. Venue mispricing vs. mainnet fair value, on every allowed market: lift a cheap ask or hit a rich bid.
  for (const market of markets) {
    const { base, venue, reference } = market;
    if (!g.allowedAssets.includes(base)) continue;
    const s = computeSignals(market);
    const digits = priceDigits(reference.mid);
    const held = base === "XLM" ? vault.balances.spendableXLM : vault.balances[base];
    if (s.mispricing === "venue_cheap" && venue.ask) {
      const usd = Math.min(cap, vault.balances.USDC, venue.asks[0].amount * venue.ask);
      if (usd < MIN_TRADE_USD) continue;
      const edge = ((reference.mid - venue.ask) / venue.ask) * 100;
      const amount = usd / venue.ask;
      ideas.push({
        kind: "limit_order",
        title: `Buy ${amount.toFixed(amountDigits(base))} ${base} at ${venue.ask.toFixed(digits)}`,
        rationale: `Testnet ${base} ask ${venue.ask.toFixed(digits)} is ${edge.toFixed(2)}% below the mainnet price ${reference.mid.toFixed(digits)}. Buying at the ask captures the gap.`,
        risk: "low",
        expectedReturnPct: edge,
        maxSlippageBps: 0,
        notionalUsd: usd,
        params: { side: "buy", base, amount, price: venue.ask },
      });
    } else if (s.mispricing === "venue_rich" && venue.bid) {
      const amount = Math.min(cap / venue.bid, held, venue.bids[0].amount);
      if (amount * venue.bid < MIN_TRADE_USD) continue;
      const edge = ((venue.bid - reference.mid) / reference.mid) * 100;
      ideas.push({
        kind: "limit_order",
        title: `Sell ${amount.toFixed(amountDigits(base))} ${base} at ${venue.bid.toFixed(digits)}`,
        rationale: `Testnet ${base} bid ${venue.bid.toFixed(digits)} is ${edge.toFixed(2)}% above the mainnet price ${reference.mid.toFixed(digits)}. Selling into the bid locks in the premium.`,
        risk: "low",
        expectedReturnPct: edge,
        maxSlippageBps: 0,
        notionalUsd: amount * venue.bid,
        params: { side: "sell", base, amount, price: venue.bid },
      });
    }
  }
  ideas.sort((a, b) => b.expectedReturnPct - a.expectedReturnPct);

  // 2. Trend-aware rebalance of the vault's XLM weight.
  const xlm = markets.find((m) => m.base === "XLM");
  const s = xlm && computeSignals(xlm, portfolio);
  if (xlm && s && g.allowedAssets.includes("XLM") && s.currentXlmWeight !== null && vault.valueUsd >= MIN_TRADE_USD * 2) {
    const { reference } = xlm;
    const drift = s.targetXlmWeight - s.currentXlmWeight;
    if (Math.abs(drift) >= REBALANCE_DRIFT) {
      const usd = Math.min(cap, Math.abs(drift) * vault.valueUsd);
      const buying = drift > 0;
      const amount = buying ? Math.min(usd, vault.balances.USDC) : Math.min(usd / reference.mid, vault.balances.spendableXLM);
      const notional = buying ? amount : amount * reference.mid;
      if (notional >= MIN_TRADE_USD) {
        ideas.push({
          kind: "swap",
          title: buying ? `Swap ${amount.toFixed(2)} USDC → XLM` : `Swap ${amount.toFixed(1)} XLM → USDC`,
          rationale: `24h trend is ${s.trend} (6h SMA ${s.smaFast.toFixed(4)} vs 24h SMA ${s.smaSlow.toFixed(4)}). Vault is ${(s.currentXlmWeight * 100).toFixed(0)}% XLM; target is ${(s.targetXlmWeight * 100).toFixed(0)}%. Rebalancing via Stellar path payment.`,
          risk: s.volatilityPct > 6 ? "high" : "medium",
          expectedReturnPct: 0,
          maxSlippageBps: slippage,
          notionalUsd: notional,
          params: buying
            ? { wallet: "vault", from: "USDC", to: "XLM", amount }
            : { wallet: "vault", from: "XLM", to: "USDC", amount },
        });
      }
    }
  }
  return ideas;
}

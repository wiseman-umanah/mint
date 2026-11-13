import { marketReads } from "@/lib/agent/run";
import { PAID_ENDPOINTS } from "@/lib/x402/catalog";
import { paywalled } from "@/lib/x402/seller";

const { priceUsd, description } = PAID_ENDPOINTS.signals;

/**
 * MINT Market Intelligence, sold per request over x402: every market MINT follows, read through
 * the agent's rulebook from mainnet data. Any agent with testnet USDC on Stellar can buy it; MINT's
 * own agent is the first customer.
 */
export const GET = paywalled({ priceUsd, description }, async () => {
  const reads = await marketReads();
  const judged = reads.filter((r) => r.regime !== "no_data");
  const uptrends = judged.filter((r) => r.regime === "trend").length;
  return {
    source: "MINT Market Intelligence",
    generated_at: new Date().toISOString(),
    basis: "Hourly candles and order books from Stellar mainnet",
    breadth: {
      markets: judged.length,
      uptrends,
      risk_off: judged.filter((r) => r.regime === "risk_off").length,
      // Share of markets in an uptrend; under 25% the agent halves the size of new positions.
      uptrend_share: judged.length ? uptrends / judged.length : 0,
    },
    markets: reads.map((r) => ({
      pair: `${r.asset}/USDC`,
      price: r.price,
      regime: r.regime,
      signal: r.entry,
      rsi_14h: r.rsi,
      hourly_range_pct: r.atrPct,
      change_24h_pct: r.change24hPct,
      suggested_stop_pct: r.stopPct,
      view: r.note,
    })),
  };
});

// Stellar settlement can take several seconds; allow for it on serverless hosts.
export const maxDuration = 60;

// What MINT sells over x402. Listed at /api/x402 so other agents can find it.
export const PAID_ENDPOINTS = {
  signals: {
    path: "/api/x402/signals",
    priceUsd: 0.01,
    name: "MINT Market Intelligence",
    description: "Regime, RSI, volatility and entry signals for 8 Stellar markets, read from mainnet data",
  },
} as const;

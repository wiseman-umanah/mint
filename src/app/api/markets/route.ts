import { authed } from "@/lib/api";
import { allMarkets } from "@/lib/stellar/market";
import { computeSignals } from "@/lib/strategy";

// Every market for the scanner; candles are dropped to keep the payload small.
export const GET = authed(async () =>
  (await allMarkets()).map((m) => ({ ...m, reference: { ...m.reference, candles: [] }, signals: computeSignals(m) })),
);

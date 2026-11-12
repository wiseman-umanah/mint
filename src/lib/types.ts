// JSON shapes the API returns to the client (dates arrive as ISO strings).
import type { activity, messages, proposals } from "./db/schema";
import type { Portfolio } from "./portfolio";
import type { MarketSnapshot } from "./stellar/market";
import type { Signals } from "./strategy";

type Jsonified<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };

export type ProposalDTO = Jsonified<typeof proposals.$inferSelect>;
export type ActivityDTO = Jsonified<typeof activity.$inferSelect>;
export type MessageDTO = Jsonified<typeof messages.$inferSelect>;
export type PortfolioDTO = Omit<Portfolio, "guardrails"> & { guardrails: Jsonified<Portfolio["guardrails"]> };
export type MarketDTO = MarketSnapshot & { signals: Signals };

export type Me = {
  id: string;
  email: string;
  handle: string;
  federationAddress: string;
  wallets: { main?: string; vault?: string };
};

// JSON shapes the API returns to the client (dates arrive as ISO strings).
import type { AgentStatus } from "./agent/status";
import type { activity, messages, proposals } from "./db/schema";
import type { Portfolio } from "./portfolio";
import type { MarketSnapshot } from "./stellar/market";
import type { Signals } from "./strategy";

// Dates at any depth arrive as ISO strings.
type DeepJsonified<T> = T extends Date ? string : T extends (infer U)[] ? DeepJsonified<U>[] : T extends object ? { [K in keyof T]: DeepJsonified<T[K]> } : T;
type Jsonified<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };

export type ProposalDTO = Jsonified<typeof proposals.$inferSelect>;
export type ActivityDTO = Jsonified<typeof activity.$inferSelect>;
export type MessageDTO = Jsonified<typeof messages.$inferSelect>;
export type PortfolioDTO = Omit<Portfolio, "guardrails"> & { guardrails: Jsonified<Portfolio["guardrails"]> };
export type MarketDTO = MarketSnapshot & { signals: Signals };
export type AgentStatusDTO = DeepJsonified<AgentStatus>;

export type Me = {
  id: string;
  email: string;
  handle: string;
  federationAddress: string;
  wallets: { main?: string; vault?: string };
};

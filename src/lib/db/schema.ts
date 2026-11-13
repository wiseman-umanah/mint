import { BASE_ASSETS } from "../assets";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  // Human-readable payment handle: @alex, or alex*<federation domain>.
  handle: text("handle").notNull().unique(),
  createdAt: createdAt(),
});

export const otpCodes = pgTable(
  "otp_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    // A code only works for what it was sent for: signing in, or confirming a guardrail change.
    purpose: text("purpose").$type<"login" | "confirm">().notNull().default("login"),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("otp_email_idx").on(t.email)],
);

export const sessions = pgTable("sessions", {
  // sha256 of the cookie token — the raw token never touches the database.
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

// "agent" is the agent's own budget wallet: the only key that ever signs a data payment.
export type WalletKind = "main" | "vault" | "agent";

export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<WalletKind>().notNull(),
    publicKey: text("public_key").notNull().unique(),
    // AES-256-GCM: base64(iv | tag | ciphertext), AAD = public key.
    encryptedSecret: text("encrypted_secret").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("wallet_user_kind_idx").on(t.userId, t.kind)],
);

export type TradingMode = "copilot" | "autonomous";

export const guardrails = pgTable("guardrails", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // Hard Capital Cap — the vault can never be funded beyond this (USD).
  capitalCapUsd: numeric("capital_cap_usd", { mode: "number" }).notNull().default(500),
  // Daily Loss Limit — % drawdown of the vault over a rolling 24h window.
  dailyLossPct: numeric("daily_loss_pct", { mode: "number" }).notNull().default(5),
  // Max Per-Trade Size (USD notional).
  maxTradeUsd: numeric("max_trade_usd", { mode: "number" }).notNull().default(50),
  maxSlippageBps: integer("max_slippage_bps").notNull().default(100),
  mode: text("mode").$type<TradingMode>().notNull().default("copilot"),
  // Assets the vault may trade. USDC, the quote currency, is always allowed.
  allowedAssets: jsonb("allowed_assets").$type<string[]>().notNull().default([...BASE_ASSETS]),
  // No single asset (other than USDC) may exceed this % of the capital cap.
  maxAssetPct: numeric("max_asset_pct", { mode: "number" }).notNull().default(50),
  halted: boolean("halted").notNull().default(false),
  haltedReason: text("halted_reason"),
  // Paying for data over x402. Off until the user gives the agent a budget wallet.
  dataEnabled: boolean("data_enabled").notNull().default(false),
  // The most USDC the agent's budget wallet may ever hold.
  agentBudgetUsd: numeric("agent_budget_usd", { mode: "number" }).notNull().default(2),
  // The most the agent may spend on data in 24 hours, and on a single request.
  dataDailyUsd: numeric("data_daily_usd", { mode: "number" }).notNull().default(0.5),
  dataMaxCallUsd: numeric("data_max_call_usd", { mode: "number" }).notNull().default(0.05),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProposalKind = "payment" | "swap" | "limit_order" | "cancel_orders" | "fund_vault" | "withdraw_vault";
export type ProposalStatus = "pending" | "executing" | "executed" | "rejected" | "failed" | "blocked";

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ProposalKind>().notNull(),
    source: text("source").$type<"chat" | "agent">().notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    title: text("title").notNull(),
    rationale: text("rationale"),
    risk: text("risk").$type<"low" | "medium" | "high">(),
    notionalUsd: numeric("notional_usd", { mode: "number" }),
    status: text("status").$type<ProposalStatus>().notNull().default("pending"),
    guardrail: jsonb("guardrail").$type<GuardrailVerdict>(),
    txHash: text("tx_hash"),
    error: text("error"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("proposal_user_idx").on(t.userId, t.createdAt)],
);

export type GuardrailVerdict = {
  ok: boolean;
  checks: { rule: string; ok: boolean; detail: string }[];
};

// Every on-chain action MINT performs, for the activity feed and loss accounting.
export const activity = pgTable(
  "activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    txHash: text("tx_hash"),
    // Signed USD flow into the vault (+ funding, − withdrawal); null for everything else.
    vaultFlowUsd: numeric("vault_flow_usd", { mode: "number" }),
    actor: text("actor").$type<"user" | "agent" | "system">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("activity_user_idx").on(t.userId, t.createdAt)],
);

export const vaultSnapshots = pgTable(
  "vault_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    valueUsd: numeric("value_usd", { mode: "number" }).notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("snapshot_user_idx").on(t.userId, t.takenAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    proposalIds: jsonb("proposal_ids").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("message_user_idx").on(t.userId, t.createdAt)],
);

export type PositionStrategy = "trend" | "dip" | "manual";
export type PositionPlan = { strategy: PositionStrategy; stopPrice: number; targetPrice: number; atrPct: number };

// What the vault holds of each asset and how the agent is managing it: cost basis, stop and target.
export const positions = pgTable(
  "positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    asset: text("asset").notNull(),
    status: text("status").$type<"open" | "closed">().notNull().default("open"),
    strategy: text("strategy").$type<PositionStrategy>().notNull(),
    qty: numeric("qty", { mode: "number" }).notNull(),
    // USDC paid for `qty`, so entry price = costUsd / qty.
    costUsd: numeric("cost_usd", { mode: "number" }).notNull(),
    stopPrice: numeric("stop_price", { mode: "number" }).notNull(),
    targetPrice: numeric("target_price", { mode: "number" }).notNull(),
    // Highest price seen since entry; the trailing stop follows it.
    highPrice: numeric("high_price", { mode: "number" }).notNull(),
    atrPct: numeric("atr_pct", { mode: "number" }).notNull(),
    // Running total over partial and final exits.
    realizedPnlUsd: numeric("realized_pnl_usd", { mode: "number" }).notNull().default(0),
    exitReason: text("exit_reason"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [index("position_user_idx").on(t.userId, t.status)],
);

export type DecisionAction = "buy" | "sell" | "suggest" | "watch" | "hold" | "blocked" | "failed" | "halt" | "info";

// The agent's journal: one row each time what it does or thinks about an asset changes.
export const agentDecisions = pgTable(
  "agent_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Null for decisions about the whole vault.
    asset: text("asset"),
    action: text("action").$type<DecisionAction>().notNull(),
    summary: text("summary").notNull(),
    // The numbers behind the decision, shown on request.
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    proposalId: uuid("proposal_id"),
    txHash: text("tx_hash"),
    createdAt: createdAt(),
  },
  (t) => [index("decision_user_idx").on(t.userId, t.createdAt)],
);

export type AssetRead = {
  asset: string;
  price: number;
  regime: "trend" | "range" | "risk_off" | "no_data";
  rsi: number | null;
  atrPct: number | null;
  change24hPct: number;
  // 0 to 1: how strongly the entry rules favour buying now.
  score: number;
  // What the agent is doing or waiting for on this asset, in words.
  note: string;
};

// Live status of each user's agent, rewritten every check.
export const agentState = pgTable("agent_state", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  tickCount: integer("tick_count").notNull().default(0),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
  headline: text("headline").notNull().default(""),
  reads: jsonb("reads").$type<AssetRead[]>().notNull().default([]),
  // Per asset, the journal key last written, so an unchanged view isn't logged again.
  lastKeys: jsonb("last_keys").$type<Record<string, string>>().notNull().default({}),
});

// Every time the agent tried to pay for data over x402: settled, refused by a guardrail, or failed.
export const agentPayments = pgTable(
  "agent_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    payTo: text("pay_to"),
    amountUsd: numeric("amount_usd", { mode: "number" }).notNull(),
    status: text("status").$type<"paid" | "blocked" | "failed">().notNull(),
    // Which guardrail refused it, or what went wrong.
    reason: text("reason"),
    txHash: text("tx_hash"),
    // What was bought, kept so the agent and the user can read it.
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("agent_payment_user_idx").on(t.userId, t.createdAt)],
);

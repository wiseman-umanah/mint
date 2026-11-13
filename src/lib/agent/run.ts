import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { amountDigits, type BaseAsset } from "../assets";
import { db, schema } from "../db";
import { env } from "../env";
import type { AssetRead, DecisionAction, PositionPlan } from "../db/schema";
import { haltTrading } from "../guardrails";
import { getPortfolio, lastSnapshot, recordSnapshot } from "../portfolio";
import { createProposal, executeProposal, type SwapParams } from "../proposals";
import { allMarkets, chartCandles } from "../stellar/market";
import { quoteSwap } from "../stellar/trade";
import { buyData, latestPaidData, recentPayments } from "./data";
import { planTick } from "./plan";
import { closedPositions, openPositions, syncPositions } from "./positions";
import { type Read, readMarket } from "./signals";

// The worker checks every minute; the "check now" button may run one sooner.
export const TICK_MS = 60_000;
const SNAPSHOT_EVERY_MS = { autonomous: 60_000, copilot: 5 * 60_000 };
// A trade that was blocked, failed or declined isn't retried for this long.
const RETRY_AFTER_MS = 15 * 60_000;
// A change of view on a market that is only being watched is logged at most this often.
const WATCH_QUIET_MS = 20 * 60_000;
// A vault smaller than this has nothing worth trading.
const MIN_VAULT_USD = 5;
// Skip a buy when the testnet book is this much worse than the mainnet price.
const MAX_VENUE_PREMIUM = 0.03;

/** Every market read through the rulebook. Market data is cached, so this is cheap to repeat. */
export async function marketReads(): Promise<Read[]> {
  const markets = await allMarkets();
  const reads = await Promise.all(
    markets.map(async (market) => readMarket(market, await chartCandles(market.base, "mainnet", "1h", 200).catch(() => []))),
  );
  return reads;
}

// How often the agent buys the market feed, and how long it waits after an attempt that didn't settle.
const DATA_EVERY_MS = 30 * 60_000;
const DATA_RETRY_MS = 10 * 60_000;
// Below this share of markets in an uptrend, new positions are opened at half size.
const WEAK_BREADTH = 0.25;

/** The paid market feed's breadth reading, turned into a position-size factor. */
export async function sizingFromPaidData(userId: string) {
  const paid = await latestPaidData(userId);
  const breadth = (paid?.data as { breadth?: { uptrend_share?: number; uptrends?: number; markets?: number } } | undefined)?.breadth;
  if (!breadth || typeof breadth.uptrend_share !== "number" || breadth.uptrend_share >= WEAK_BREADTH) return undefined;
  return { factor: 0.5, note: `Half size: the market feed the agent bought shows only ${breadth.uptrends} of ${breadth.markets} markets in an uptrend.` };
}

/** Buys the market feed over x402 when it is due. Never throws: a failed purchase must not stop trading. */
async function buyMarketData(userId: string, g: { dataEnabled: boolean; halted: boolean } & Parameters<typeof buyData>[2], journal: Journal[]) {
  if (!g.dataEnabled || g.halted) return;
  try {
    const [last] = await recentPayments(userId, 1);
    const age = last ? Date.now() - last.createdAt.getTime() : Infinity;
    if (age < (last?.status === "paid" ? DATA_EVERY_MS : DATA_RETRY_MS)) return;
    const url = env.x402DataSources[0];
    const payment = await buyData(userId, url, g);
    const seller = new URL(url).host;
    if (payment.status === "paid") {
      journal.push({ asset: null, action: "info", summary: `Paid ${payment.amountUsd.toFixed(2)} USDC from the agent wallet for market data from ${seller} (x402).`, txHash: payment.txHash });
    } else {
      journal.push({ asset: null, action: payment.status, summary: `Data payment to ${seller} ${payment.status === "blocked" ? "blocked by guardrails" : "failed"}. ${payment.reason ?? ""}` });
    }
  } catch (error) {
    console.error("[mint] buying market data failed", error);
  }
}

type Journal = { asset: string | null; action: DecisionAction; summary: string; detail?: Record<string, unknown>; proposalId?: string; txHash?: string | null };

const numbers = (read: Read | undefined) =>
  read && { price: read.price, regime: read.regime, rsi: read.rsi, atr_pct: read.atrPct, sma_20h: read.sma20, sma_50h: read.sma50, change_24h_pct: read.change24hPct, score: read.score };

/**
 * One check of one user's vault: value it, enforce the loss limit, bring positions up to date,
 * then act on the plan. In autonomous mode trades execute; in copilot mode they are staged for the
 * user to confirm. Returns null when another check ran too recently.
 */
export async function runAgent(userId: string, { minGapMs = TICK_MS - 10_000 } = {}) {
  const now = new Date();
  await db().insert(schema.agentState).values({ userId }).onConflictDoNothing();
  // Claim the check atomically, so the worker and a "check now" click never trade twice.
  const [state] = await db()
    .update(schema.agentState)
    .set({ lastTickAt: now, tickCount: sql`${schema.agentState.tickCount} + 1` })
    .where(
      and(
        eq(schema.agentState.userId, userId),
        or(isNull(schema.agentState.lastTickAt), lt(schema.agentState.lastTickAt, new Date(now.getTime() - minGapMs))),
      ),
    )
    .returning();
  if (!state) return null;

  const journal: Journal[] = [];
  const lastKeys = { ...state.lastKeys };
  const finish = async (headline: string, reads: AssetRead[] = state.reads) => {
    if (journal.length) await db().insert(schema.agentDecisions).values(journal.map((j) => ({ userId, ...j })));
    await db().update(schema.agentState).set({ headline, reads, lastKeys }).where(eq(schema.agentState.userId, userId));
    return { headline, journal };
  };
  // Vault-wide events are logged once, when they start.
  const vaultNote = (key: string, action: DecisionAction, summary: string) => {
    if (lastKeys.vault !== key) journal.push({ asset: null, action, summary });
    lastKeys.vault = key;
  };

  const portfolio = await getPortfolio(userId);
  const g = portfolio.guardrails;
  const vault = portfolio.vault;
  if (!vault.active) return finish("Your vault isn't on Stellar yet.");

  const last = await lastSnapshot(userId);
  if (vault.valueUsd > 0 && (!last || now.getTime() - last.takenAt.getTime() >= SNAPSHOT_EVERY_MS[g.mode] - 5_000)) {
    await recordSnapshot(userId, vault.valueUsd);
  }

  // The daily loss limit applies in every mode: breach it and trading halts.
  if (!g.halted && portfolio.loss.lossPct >= g.dailyLossPct) {
    const reason = `daily loss limit of ${g.dailyLossPct}% reached (${portfolio.loss.lossPct.toFixed(2)}%)`;
    await haltTrading(userId, reason);
    vaultNote("halted", "halt", `Trading halted: ${reason}. Open orders were cancelled.`);
    return finish(`Halted: ${reason}`);
  }

  const reads = await marketReads();
  const prices = Object.fromEntries(reads.map((r) => [r.asset, r.price]));
  const positions = await syncPositions(userId, vault.balances, prices);
  const closed = await closedPositions(userId, 10);
  const sizing = await sizingFromPaidData(userId);
  const plan = planTick({ reads, positions, closed, equityUsd: vault.valueUsd, usdc: vault.balances.USDC, guardrails: g, sizing, now: now.getTime() });
  for (const t of plan.trails) {
    await db().update(schema.positions).set({ highPrice: t.highPrice, stopPrice: t.stopPrice }).where(eq(schema.positions.id, t.id));
  }

  const noteFor = new Map(plan.notes.map((n) => [n.asset, n]));
  const stateReads = (): AssetRead[] =>
    reads.map((r) => ({ asset: r.asset, price: r.price, regime: r.regime, rsi: r.rsi, atrPct: r.atrPct, change24hPct: r.change24hPct, score: r.score, note: noteFor.get(r.asset)?.summary ?? r.note }));
  const logNotes = () => {
    for (const note of plan.notes) {
      const before = lastKeys[note.asset];
      if (before === note.key) continue;
      // A market sitting on the edge of two readings would otherwise fill the journal with flip-flops.
      const loggedAt = Number(lastKeys[`${note.asset}@`] ?? 0);
      if (note.action === "watch" && before?.startsWith("watch:") && now.getTime() - loggedAt < WATCH_QUIET_MS) continue;
      lastKeys[note.asset] = note.key;
      lastKeys[`${note.asset}@`] = String(now.getTime());
      journal.push({ asset: note.asset, action: note.action, summary: note.action === "watch" ? `${note.asset}: ${note.summary}` : note.summary, detail: numbers(reads.find((r) => r.asset === note.asset)) });
    }
  };

  if (g.halted) {
    vaultNote("halted", "halt", `Trading is halted: ${g.haltedReason ?? "kill switch on"}. The agent is watching but won't trade.`);
    logNotes();
    return finish(`Halted: ${g.haltedReason ?? "kill switch on"}`, stateReads());
  }
  if (vault.valueUsd < MIN_VAULT_USD && positions.length === 0) {
    vaultNote("empty", "info", `The vault holds $${vault.valueUsd.toFixed(2)}. Fund it with at least $${MIN_VAULT_USD} and the agent starts trading it.`);
    return finish("Waiting for funds: move USDC into the vault to start.", stateReads());
  }
  if (plan.pausedUntil) vaultNote(`paused:${plan.pausedUntil.toISOString()}`, "info", `Three losing trades in a row. New buys are paused until ${plan.pausedUntil.toISOString().slice(11, 16)} UTC; exits still run.`);
  else vaultNote(g.mode, "info", g.mode === "autonomous" ? "Autonomous mode: the agent is trading the vault inside your guardrails." : "Copilot mode: the agent suggests trades and waits for you to confirm.");

  // Trades the agent tried lately, so a blocked, failed or declined one isn't retried every minute.
  const recent = await db().query.proposals.findMany({
    where: and(eq(schema.proposals.userId, userId), eq(schema.proposals.source, "agent"), gte(schema.proposals.createdAt, new Date(now.getTime() - RETRY_AFTER_MS))),
    orderBy: desc(schema.proposals.createdAt),
  });
  const triedLately = (asset: string, side: "buy" | "sell") =>
    recent.some((p) => {
      const tag = (p.params as { agent?: { asset: string; side: string } }).agent;
      return tag?.asset === asset && tag.side === side && p.status !== "executed";
    });

  const trade = async (spec: { asset: BaseAsset; side: "buy" | "sell"; amount: number; title: string; rationale: string; risk: "low" | "medium" | "high"; plan?: PositionPlan; exitReason?: string }) => {
    const read = reads.find((r) => r.asset === spec.asset);
    const log = (action: DecisionAction, summary: string, extra: Partial<Journal> = {}) => {
      journal.push({ asset: spec.asset, action, summary, detail: numbers(read), ...extra });
      lastKeys[spec.asset] = `${action}:${extra.proposalId ?? now.getTime()}`;
    };
    try {
      const [from, to] = spec.side === "buy" ? (["USDC", spec.asset] as const) : ([spec.asset, "USDC"] as const);
      const slippageBps = Math.min(g.maxSlippageBps, 100);
      const quote = await quoteSwap(from, to, spec.amount, slippageBps);
      if (spec.side === "buy" && read && quote.sendAmount / quote.expectedAmount > read.price * (1 + MAX_VENUE_PREMIUM)) {
        const premium = (quote.sendAmount / quote.expectedAmount / read.price - 1) * 100;
        return log("failed", `Skipped buying ${spec.asset}: the testnet book is ${premium.toFixed(1)}% above the mainnet price.`);
      }
      const params: SwapParams = { wallet: "vault", quote, slippageBps, plan: spec.plan, exit: spec.exitReason ? { reason: spec.exitReason } : undefined, agent: { asset: spec.asset, side: spec.side } };
      const proposal = await createProposal(userId, { kind: "swap", source: "agent", title: spec.title, params, rationale: spec.rationale, risk: spec.risk }, portfolio);
      const failedChecks = (p: typeof proposal) => p.guardrail?.checks.filter((c) => !c.ok).map((c) => `${c.rule}: ${c.detail}`).join("; ");
      if (proposal.status !== "pending") {
        return log("blocked", `Guardrails blocked "${spec.title}". ${failedChecks(proposal)}`, { proposalId: proposal.id });
      }
      if (g.mode === "copilot") return log("suggest", `Suggested: ${spec.title}. Waiting for you to confirm.`, { proposalId: proposal.id });
      const result = await executeProposal(userId, proposal.id);
      if (result.status === "executed") {
        const got = quote.expectedAmount.toFixed(amountDigits(quote.destAsset));
        return log(spec.side, `${spec.title}. Received about ${got} ${quote.destAsset}.`, { proposalId: proposal.id, txHash: result.txHash });
      }
      if (result.status === "blocked") return log("blocked", `Guardrails blocked "${spec.title}". ${failedChecks(result)}`, { proposalId: proposal.id });
      return log("failed", `"${spec.title}" failed: ${result.error ?? "unknown error"}`, { proposalId: proposal.id });
    } catch (error) {
      return log("failed", `Couldn't ${spec.side} ${spec.asset}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  for (const exit of plan.exits) {
    if (triedLately(exit.asset, "sell")) continue;
    await trade({ asset: exit.asset, side: "sell", amount: exit.qty, title: exit.summary, rationale: exit.rationale, risk: "low", exitReason: exit.reason });
  }
  if (plan.entry && !triedLately(plan.entry.asset, "buy")) {
    const e = plan.entry;
    await trade({ asset: e.asset, side: "buy", amount: e.usd, title: e.summary, rationale: e.rationale, risk: e.risk, plan: e.plan });
  }
  logNotes();
  await buyMarketData(userId, g, journal);

  // Read the ledger again so the headline counts what this check just bought or sold.
  const held = await openPositions(userId);
  const invested = held.reduce((sum, p) => sum + p.qty * (prices[p.asset] ?? 0), 0);
  const signals = reads.filter((r) => r.entry && !held.some((p) => p.asset === r.asset)).length;
  const headline =
    held.length > 0
      ? `Managing ${held.length} position${held.length === 1 ? "" : "s"}, ${vault.valueUsd > 0 ? Math.round((invested / vault.valueUsd) * 100) : 0}% of the vault invested.`
      : signals > 0
        ? `${signals} buy signal${signals === 1 ? "" : "s"} across ${reads.length} markets.`
        : `Watching ${reads.length} markets. No buy signal right now, so the vault stays in USDC.`;
  return finish(headline, stateReads());
}

export type AgentRun = NonNullable<Awaited<ReturnType<typeof runAgent>>>;

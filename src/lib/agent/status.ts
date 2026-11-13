import { and, asc, desc, eq, gte } from "drizzle-orm";
import { db, schema } from "../db";
import { getGuardrails } from "../portfolio";
import { referencePrices } from "../stellar/market";
import { closedPositions, openPositions } from "./positions";
import { TICK_MS } from "./run";
import { RULES } from "./signals";

const DAY_MS = 86_400_000;
const MAX_CURVE_POINTS = 240;

/**
 * Everything the Agent page shows. Reads only the database and cached prices, so the page can
 * poll it every few seconds without touching Horizon.
 */
export async function agentStatus(userId: string) {
  const [state, guardrails, open, closed, decisions, snapshots, prices] = await Promise.all([
    db().query.agentState.findFirst({ where: eq(schema.agentState.userId, userId) }),
    getGuardrails(userId),
    openPositions(userId),
    closedPositions(userId, 50),
    db().query.agentDecisions.findMany({ where: eq(schema.agentDecisions.userId, userId), orderBy: desc(schema.agentDecisions.createdAt), limit: 80 }),
    db().query.vaultSnapshots.findMany({
      where: and(eq(schema.vaultSnapshots.userId, userId), gte(schema.vaultSnapshots.takenAt, new Date(Date.now() - DAY_MS))),
      orderBy: asc(schema.vaultSnapshots.takenAt),
    }),
    referencePrices(),
  ]);

  const positions = open.map((p) => {
    const entryPrice = p.costUsd / p.qty;
    const price = prices[p.asset as keyof typeof prices] || entryPrice;
    return {
      id: p.id,
      asset: p.asset,
      strategy: p.strategy,
      qty: p.qty,
      entryPrice,
      price,
      valueUsd: p.qty * price,
      pnlUsd: p.qty * price - p.costUsd,
      pnlPct: (price / entryPrice - 1) * 100,
      stopPrice: p.stopPrice,
      targetPrice: p.targetPrice,
      openedAt: p.openedAt,
    };
  });

  const wins = closed.filter((p) => p.realizedPnlUsd > 0).length;
  const step = Math.max(1, Math.ceil(snapshots.length / MAX_CURVE_POINTS));
  const lastTickAt = state?.lastTickAt ?? null;
  return {
    mode: guardrails.mode,
    halted: guardrails.halted,
    haltedReason: guardrails.haltedReason,
    // The worker (or an open Agent page) is checking this vault.
    online: Boolean(lastTickAt && Date.now() - lastTickAt.getTime() < TICK_MS * 2.5),
    lastTickAt,
    nextTickAt: lastTickAt ? new Date(lastTickAt.getTime() + TICK_MS) : null,
    tickCount: state?.tickCount ?? 0,
    headline: state?.headline ?? "",
    reads: state?.reads ?? [],
    positions,
    closed: closed.slice(0, 20).map((p) => ({ id: p.id, asset: p.asset, strategy: p.strategy, pnlUsd: p.realizedPnlUsd, exitReason: p.exitReason, openedAt: p.openedAt, closedAt: p.closedAt })),
    decisions,
    equity: snapshots.filter((_, i) => i % step === 0 || i === snapshots.length - 1).map((s) => ({ t: s.takenAt, v: s.valueUsd })),
    stats: {
      equityUsd: snapshots.at(-1)?.valueUsd ?? 0,
      investedUsd: positions.reduce((sum, p) => sum + p.valueUsd, 0),
      unrealizedUsd: positions.reduce((sum, p) => sum + p.pnlUsd, 0),
      realizedUsd: [...open, ...closed].reduce((sum, p) => sum + p.realizedPnlUsd, 0),
      closedTrades: closed.length,
      winRatePct: closed.length ? (wins / closed.length) * 100 : null,
    },
    rules: RULES,
  };
}

export type AgentStatus = Awaited<ReturnType<typeof agentStatus>>;

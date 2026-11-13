import { and, desc, eq } from "drizzle-orm";
import { BASE_ASSETS, type BaseAsset } from "../assets";
import { db, schema } from "../db";
import type { PositionPlan } from "../db/schema";
import type { Balances } from "../stellar/accounts";

export type Position = typeof schema.positions.$inferSelect;

// XLM the vault keeps for offer reserves; never counted as a position or sold by the agent.
export const XLM_FLOAT = 3;
// Holdings worth less than this are dust, not a position.
const DUST_USD = 0.5;
const ADOPT_USD = 1;
// Stop and target for holdings the agent didn't size itself.
const DEFAULT_STOP_PCT = 5;
const DEFAULT_REWARD = 1.5;

/** How much of an asset the vault holds that a position can account for. */
export function heldQty(balances: Balances, asset: BaseAsset) {
  return asset === "XLM" ? Math.max(0, Math.min(balances.spendableXLM, balances.XLM - XLM_FLOAT)) : balances[asset];
}

export const defaultPlan = (price: number, stopPct = DEFAULT_STOP_PCT): PositionPlan => ({
  strategy: "manual",
  stopPrice: price * (1 - stopPct / 100),
  targetPrice: price * (1 + (stopPct * DEFAULT_REWARD) / 100),
  atrPct: stopPct / 2,
});

export function openPositions(userId: string) {
  return db().query.positions.findMany({ where: and(eq(schema.positions.userId, userId), eq(schema.positions.status, "open")) });
}

export function closedPositions(userId: string, limit = 30) {
  return db().query.positions.findMany({
    where: and(eq(schema.positions.userId, userId), eq(schema.positions.status, "closed")),
    orderBy: desc(schema.positions.closedAt),
    limit,
  });
}

const openFor = (userId: string, asset: string) =>
  db().query.positions.findFirst({
    where: and(eq(schema.positions.userId, userId), eq(schema.positions.asset, asset), eq(schema.positions.status, "open")),
  });

/** The vault bought `qty` of an asset for `costUsd`: open a position or add to the one already open. */
export async function applyBuy(userId: string, asset: BaseAsset, qty: number, costUsd: number, plan?: PositionPlan) {
  if (qty <= 0) return;
  const price = costUsd / qty;
  const open = await openFor(userId, asset);
  if (open) {
    await db()
      .update(schema.positions)
      .set({ qty: open.qty + qty, costUsd: open.costUsd + costUsd, highPrice: Math.max(open.highPrice, price) })
      .where(eq(schema.positions.id, open.id));
    return;
  }
  const p = plan ?? defaultPlan(price);
  await db().insert(schema.positions).values({ userId, asset, strategy: p.strategy, qty, costUsd, stopPrice: p.stopPrice, targetPrice: p.targetPrice, highPrice: price, atrPct: p.atrPct });
}

/** The vault sold `qty` for `proceedsUsd`: book the profit or loss, and close the position once only dust is left. */
export async function applySell(userId: string, asset: BaseAsset, qty: number, proceedsUsd: number, reason: string) {
  const open = await openFor(userId, asset);
  if (!open || qty <= 0) return;
  const sold = Math.min(qty, open.qty);
  const costOfSold = open.costUsd * (sold / open.qty);
  const left = open.qty - sold;
  const price = proceedsUsd / qty;
  const closing = left * price < DUST_USD;
  await db()
    .update(schema.positions)
    .set({
      qty: closing ? 0 : left,
      costUsd: closing ? 0 : open.costUsd - costOfSold,
      realizedPnlUsd: open.realizedPnlUsd + proceedsUsd * (sold / qty) - costOfSold,
      ...(closing ? { status: "closed" as const, exitReason: reason, closedAt: new Date() } : {}),
    })
    .where(eq(schema.positions.id, open.id));
}

/**
 * Brings positions in line with what the vault really holds. Trades the agent makes are booked at
 * their actual cost when they execute; this catches everything else (limit orders filling, deposits
 * of other assets, withdrawals) and values the difference at the current price.
 */
export async function syncPositions(userId: string, balances: Balances, prices: Record<string, number>) {
  const open = await openPositions(userId);
  for (const asset of BASE_ASSETS) {
    const price = prices[asset];
    if (!price) continue;
    const held = heldQty(balances, asset);
    const position = open.find((p) => p.asset === asset);
    if (!position) {
      if (held * price >= ADOPT_USD) await applyBuy(userId, asset, held, held * price);
    } else if (held > position.qty * 1.001 && (held - position.qty) * price >= DUST_USD) {
      await applyBuy(userId, asset, held - position.qty, (held - position.qty) * price);
    } else if (held < position.qty * 0.999) {
      await applySell(userId, asset, position.qty - held, (position.qty - held) * price, "Sold outside the agent");
    }
  }
  return openPositions(userId);
}

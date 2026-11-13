import { amountDigits, type BaseAsset, priceDigits } from "../assets";
import type { DecisionAction, PositionPlan } from "../db/schema";
import type { Position } from "./positions";
import { type Read, RULES } from "./signals";

export type Exit = { asset: BaseAsset; position: Position; qty: number; reason: string; summary: string; rationale: string };
export type Entry = { asset: BaseAsset; usd: number; plan: PositionPlan; summary: string; rationale: string; risk: "low" | "medium" | "high" };
// What the agent thinks about one asset this check. `key` changes when the view changes.
export type Note = { asset: BaseAsset; action: DecisionAction; key: string; summary: string };

export type PlanInput = {
  reads: Read[];
  positions: Position[];
  // Recently closed positions, newest first.
  closed: Position[];
  equityUsd: number;
  usdc: number;
  guardrails: { maxTradeUsd: number; maxAssetPct: number; capitalCapUsd: number; allowedAssets: string[] };
  // Scales new positions down, with the reason, when the data the agent bought says to be careful.
  sizing?: { factor: number; note: string };
  now?: number;
};

const HOUR = 3_600_000;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const px = (n: number) => n.toFixed(priceDigits(n));

/**
 * One check of the vault, decided. Pure and deterministic: exits for open positions, at most one
 * new entry, tighter stops for winners, and a note per asset saying what the agent is doing or
 * waiting for. Nothing here signs anything; every trade it returns still has to pass the guardrails.
 */
export function planTick({ reads, positions, closed, equityUsd, usdc, guardrails: g, sizing, now = Date.now() }: PlanInput) {
  const exits: Exit[] = [];
  const trails: { id: string; highPrice: number; stopPrice: number }[] = [];
  const notes: Note[] = [];
  const allowed = (asset: string) => g.allowedAssets.includes(asset);

  // 1. Open positions: move the stop up behind winners, then check every exit rule.
  for (const position of positions) {
    const read = reads.find((r) => r.asset === position.asset);
    if (!read || !read.price) continue;
    const asset = read.asset;
    const entry = position.costUsd / position.qty;
    const price = read.price;
    const gain = (price / entry - 1) * 100;
    const stopPct = (1 - position.stopPrice / entry) * 100;
    const high = Math.max(position.highPrice, price);
    let stop = position.stopPrice;
    // Once the price has run far enough, the stop follows the high at the position's own distance.
    const distance = Math.max(RULES.minStopPct, position.atrPct * RULES.stopAtr);
    if (high >= entry * (1 + (RULES.trailAfter * distance) / 100)) stop = Math.max(stop, high * (1 - distance / 100));
    if (high > position.highPrice || stop > position.stopPrice) trails.push({ id: position.id, highPrice: high, stopPrice: stop });

    const managed = position.strategy !== "manual";
    const ageHours = (now - position.openedAt.getTime()) / HOUR;
    const reason = !allowed(asset)
      ? "Asset removed from your allowed list"
      : price <= stop
        ? stop > entry
          ? "Trailing stop"
          : "Stop-loss"
        : price >= position.targetPrice
          ? "Take profit"
          : managed && read.regime === "risk_off"
            ? "Risk-off"
            : managed && ageHours > RULES.timeStopHours && Math.abs(gain) < stopPct / 2
              ? "Time stop"
              : null;

    if (!reason) {
      notes.push({
        asset,
        action: "hold",
        key: stop > entry ? "hold:locked" : "hold",
        summary:
          stop > entry
            ? `Holding ${asset} (${pct(gain)}). The stop has trailed up to ${px(stop)}, above the entry, so this trade is locked in profit.`
            : `Holding ${asset} (${pct(gain)}). Stop ${px(stop)}, target ${px(position.targetPrice)}.`,
      });
      continue;
    }
    // A large position leaves in slices no bigger than the per-trade limit.
    const qty = Math.min(position.qty, (g.maxTradeUsd * 0.97) / price);
    const why: Record<string, string> = {
      "Stop-loss": `Price ${px(price)} fell to the stop at ${px(stop)}.`,
      "Trailing stop": `Price ${px(price)} fell back to the trailing stop at ${px(stop)}, locking in a gain.`,
      "Take profit": `Price ${px(price)} reached the target at ${px(position.targetPrice)}.`,
      "Risk-off": read.note,
      "Time stop": `Held ${Math.round(ageHours)}h without moving (${pct(gain)}); freeing the capital.`,
      "Asset removed from your allowed list": `${asset} is no longer on your allowed list.`,
    };
    exits.push({
      asset,
      position,
      qty,
      reason,
      summary: `${reason}: sell ${qty.toFixed(amountDigits(asset))} ${asset} at about ${px(price)} (${pct(gain)})`,
      rationale: `${why[reason]} Entry ${px(entry)}, now ${px(price)} (${pct(gain)}).`,
    });
  }

  // 2. New entries: the best candidate that fits every limit.
  const held = new Set(positions.map((p) => p.asset));
  const exposure = positions.reduce((sum, p) => sum + p.qty * (reads.find((r) => r.asset === p.asset)?.price ?? 0), 0);
  const losses = closed.slice(0, RULES.lossStreak);
  const pausedUntil =
    losses.length === RULES.lossStreak && losses.every((p) => p.realizedPnlUsd < 0) && losses[0].closedAt
      ? losses[0].closedAt.getTime() + RULES.lossPauseHours * HOUR
      : 0;
  const cooling = (asset: string) =>
    closed.some((p) => p.asset === asset && p.realizedPnlUsd < 0 && p.closedAt && now - p.closedAt.getTime() < RULES.cooldownHours * HOUR);

  let entry = null as Entry | null;
  const candidates = reads.filter((r) => r.entry && !held.has(r.asset)).sort((a, b) => b.score - a.score);
  for (const read of reads) {
    if (held.has(read.asset)) continue;
    const { asset } = read;
    const watch = (key: string, summary: string) => notes.push({ asset, action: "watch", key: `watch:${key}`, summary });
    if (!allowed(asset)) {
      watch("not_allowed", "Not on your allowed list.");
      continue;
    }
    if (!read.entry) {
      watch(read.code, read.note);
      continue;
    }
    if (now < pausedUntil) {
      watch("paused", `Buy signal, but new buys are paused for ${RULES.lossPauseHours}h after ${RULES.lossStreak} losses in a row.`);
      continue;
    }
    if (cooling(asset)) {
      watch("cooldown", `Buy signal, but it lost money in the last ${RULES.cooldownHours}h. Cooling off.`);
      continue;
    }
    if (positions.length >= RULES.maxPositions) {
      watch("full", `Buy signal, but the vault already holds ${RULES.maxPositions} positions.`);
      continue;
    }
    if (entry || candidates[0]?.asset !== asset) {
      watch("queued", `Buy signal (${read.entry}). Queued behind a stronger one; the agent opens one position per check.`);
      continue;
    }

    // Size so that hitting the stop costs about 1% of the vault, then apply every cap.
    const byRisk = ((equityUsd * RULES.riskPerTradePct) / read.stopPct) * (sizing?.factor ?? 1);
    const caps: [string, number][] = [
      ["risk per trade", byRisk],
      [`${RULES.maxPositionPct}% of the vault per position`, ((equityUsd * RULES.maxPositionPct) / 100) * (sizing?.factor ?? 1)],
      ["your max trade size", g.maxTradeUsd],
      [`${RULES.maxExposurePct}% total exposure`, (equityUsd * RULES.maxExposurePct) / 100 - exposure],
      ["your max per asset", (g.maxAssetPct / 100) * g.capitalCapUsd],
      ["free USDC", usdc * 0.995],
    ];
    const [limitedBy, usd] = caps.reduce((min, cap) => (cap[1] < min[1] ? cap : min));
    if (usd < RULES.minTradeUsd) {
      watch("no_room", `Buy signal, but only $${Math.max(0, usd).toFixed(2)} fits under ${limitedBy} (minimum $${RULES.minTradeUsd}).`);
      continue;
    }
    const stopPrice = read.price * (1 - read.stopPct / 100);
    const targetPrice = read.price * (1 + (read.stopPct * RULES.rewardToRisk) / 100);
    entry = {
      asset,
      usd,
      plan: { strategy: read.entry, stopPrice, targetPrice, atrPct: read.atrPct ?? read.stopPct / RULES.stopAtr },
      summary: `Buy ${asset} with ${usd.toFixed(2)} USDC (${read.entry === "trend" ? "trend" : "dip"} entry)`,
      rationale: `${read.note} Stop ${px(stopPrice)} (−${read.stopPct.toFixed(1)}%), target ${px(targetPrice)} (+${(read.stopPct * RULES.rewardToRisk).toFixed(1)}%). Sized by ${limitedBy}.${sizing && sizing.factor < 1 ? ` ${sizing.note}` : ""}`,
      risk: read.stopPct > 5 ? "high" : read.stopPct > 2.5 ? "medium" : "low",
    };
  }

  return { exits, entry, trails, notes, pausedUntil: now < pausedUntil ? new Date(pausedUntil) : null };
}

export type Plan = ReturnType<typeof planTick>;

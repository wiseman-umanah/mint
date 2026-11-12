import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import type { AssetCode } from "./assets";
import type { GuardrailVerdict, ProposalKind } from "./db/schema";
import type { Portfolio } from "./portfolio";
import { cancelAllOffers, walletKeypair } from "./stellar/accounts";

export type GuardedAction = {
  kind: ProposalKind;
  source: "chat" | "agent";
  wallet: "main" | "vault";
  notionalUsd: number;
  slippageBps?: number;
  // Exact balance the action spends, checked against what the wallet holds.
  spend?: { asset: AssetCode; amount: number };
  // Assets a vault trade touches, checked against the allowed list (USDC is always allowed).
  assets?: AssetCode[];
  // What a vault trade ends up holding more of, for the per-asset limit.
  buys?: { asset: AssetCode; usd: number };
};

const fmt = (n: number) => `$${n.toFixed(2)}`;
// Enough decimals that 0.0004 BTC doesn't print as 0.00.
const trim = (n: number) => (n === 0 ? "0" : n >= 1 ? n.toFixed(2) : n.toPrecision(3));

/**
 * The Guardrail Engine. Pure and deterministic: the AI proposes, this decides. It runs when a
 * proposal is created and again, against fresh balances, right before signing.
 */
export function evaluate(action: GuardedAction, portfolio: Portfolio): GuardrailVerdict {
  const g = portfolio.guardrails;
  const checks: GuardrailVerdict["checks"] = [];
  const check = (rule: string, ok: boolean, detail: string) => checks.push({ rule, ok, detail });

  // The agent may only ever act inside the vault.
  if (action.source === "agent") {
    check("Agent scope", action.wallet === "vault", "Autonomous actions are confined to the trading vault");
  }

  const trading = action.wallet === "vault" && (action.kind === "swap" || action.kind === "limit_order");
  if (trading || action.kind === "fund_vault") {
    check("Trading active", !g.halted, g.halted ? `Halted: ${g.haltedReason ?? "kill switch on"}` : "Kill switch off");
  }

  if (trading) {
    check(
      "Max trade size",
      action.notionalUsd <= g.maxTradeUsd,
      `${fmt(action.notionalUsd)} of ${fmt(g.maxTradeUsd)} per trade`,
    );
    check(
      "Daily loss limit",
      portfolio.loss.lossPct < g.dailyLossPct,
      `${portfolio.loss.lossPct.toFixed(2)}% lost of ${g.dailyLossPct}% allowed (24h)`,
    );
    const blocked = (action.assets ?? []).filter((a) => a !== "USDC" && !g.allowedAssets.includes(a));
    if (action.assets?.some((a) => a !== "USDC")) {
      check("Allowed assets", blocked.length === 0, blocked.length ? `${blocked.join(", ")} not on your allowed list` : "On your allowed list");
    }
    if (action.buys && action.buys.asset !== "USDC") {
      const { asset, usd } = action.buys;
      const after = (portfolio.vault.balances[asset] ?? 0) * (portfolio.prices[asset as keyof typeof portfolio.prices] ?? 0) + usd;
      const limit = (g.maxAssetPct / 100) * g.capitalCapUsd;
      check("Max per asset", after <= limit, `${asset} would be ${fmt(after)} of ${fmt(limit)} (${g.maxAssetPct}% of cap)`);
    }
  }

  if (action.kind === "fund_vault") {
    const after = portfolio.vault.valueUsd + action.notionalUsd;
    check("Hard capital cap", after <= g.capitalCapUsd, `Vault would hold ${fmt(after)} of ${fmt(g.capitalCapUsd)} cap`);
  }

  if (action.slippageBps !== undefined) {
    check(
      "Max slippage",
      action.slippageBps <= g.maxSlippageBps,
      `${(action.slippageBps / 100).toFixed(2)}% of ${(g.maxSlippageBps / 100).toFixed(2)}% allowed`,
    );
  }

  if (action.spend) {
    const wallet = portfolio[action.wallet];
    const available = action.spend.asset === "XLM" ? wallet.balances.spendableXLM : wallet.balances[action.spend.asset];
    check(
      "Sufficient balance",
      available >= action.spend.amount,
      `Needs ${trim(action.spend.amount)} ${action.spend.asset}, has ${trim(available)}`,
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// Kill switch: stop all trading and pull every resting order off the book.
export async function haltTrading(userId: string, reason: string) {
  await db()
    .update(schema.guardrails)
    .set({ halted: true, haltedReason: reason, updatedAt: new Date() })
    .where(eq(schema.guardrails.userId, userId));
  const result = await cancelAllOffers(await walletKeypair(userId, "vault")).catch(() => null);
  await db()
    .insert(schema.activity)
    .values({
      userId,
      kind: "halt",
      summary: `Trading halted — ${reason}${result ? "; open orders cancelled" : ""}`,
      txHash: result?.hash,
      actor: "system",
    });
}

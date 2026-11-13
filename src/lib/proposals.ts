import { and, eq } from "drizzle-orm";
import { amountDigits, type BaseAsset } from "./assets";
import { db, schema } from "./db";
import { applyBuy, applySell } from "./agent/positions";
import type { PositionPlan, ProposalKind } from "./db/schema";
import { evaluate, type GuardedAction, haltTrading } from "./guardrails";
import { getPortfolio, type Portfolio, recordSnapshot } from "./portfolio";
import { balancesOf, cancelAllOffers, walletKeypair, getWallet } from "./stellar/accounts";
import type { AssetCode } from "./stellar/config";
import { executeSwap, placeLimitOrder, quoteSwap, sendPayment, type SwapQuote } from "./stellar/trade";

export type PaymentParams = {
  recipient: string;
  recipientLabel: string;
  publicKey: string;
  asset: AssetCode;
  amount: number;
  deliverAsset?: AssetCode;
  memo?: string;
};
export type SwapParams = {
  wallet: "main" | "vault";
  quote: SwapQuote;
  slippageBps: number;
  // Set by the agent: how it will manage what it buys, why it is selling, and what it traded.
  plan?: PositionPlan;
  exit?: { reason: string };
  agent?: { asset: BaseAsset; side: "buy" | "sell" };
};
export type LimitOrderParams = { side: "buy" | "sell"; base: BaseAsset; amount: number; price: number };

// Orders staged before multi-asset support stored XLM amounts as amountXlm.
function limitOrder(params: Record<string, unknown>): LimitOrderParams {
  const x = params as Partial<LimitOrderParams> & { amountXlm?: number };
  return { side: x.side!, base: x.base ?? "XLM", amount: x.amount ?? x.amountXlm!, price: x.price! };
}
export type VaultTransferParams = { asset: AssetCode; amount: number };

type Draft = {
  kind: ProposalKind;
  source: "chat" | "agent";
  title: string;
  params: Record<string, unknown>;
  rationale?: string;
  risk?: "low" | "medium" | "high";
};

const usd = (asset: AssetCode, amount: number, prices: Portfolio["prices"]) =>
  asset === "USDC" ? amount : amount * (prices[asset as BaseAsset] ?? 0);

// Turn a proposal into the action the guardrail engine judges.
function toAction(draft: Pick<Draft, "kind" | "source" | "params">, portfolio: Portfolio): GuardedAction {
  const p = portfolio.prices;
  switch (draft.kind) {
    case "payment": {
      const x = draft.params as PaymentParams;
      return { kind: "payment", source: draft.source, wallet: "main", notionalUsd: usd(x.asset, x.amount, p), spend: { asset: x.asset, amount: x.amount } };
    }
    case "swap": {
      const x = draft.params as SwapParams;
      return {
        kind: "swap",
        source: draft.source,
        wallet: x.wallet,
        notionalUsd: usd(x.quote.sendAsset, x.quote.sendAmount, p),
        slippageBps: x.slippageBps,
        spend: { asset: x.quote.sendAsset, amount: x.quote.sendAmount },
        assets: [x.quote.sendAsset, x.quote.destAsset],
        buys: { asset: x.quote.destAsset, usd: usd(x.quote.destAsset, x.quote.expectedAmount, p) },
      };
    }
    case "limit_order": {
      const x = limitOrder(draft.params);
      return {
        kind: "limit_order",
        source: draft.source,
        wallet: "vault",
        notionalUsd: x.amount * x.price,
        spend: x.side === "buy" ? { asset: "USDC", amount: x.amount * x.price } : { asset: x.base, amount: x.amount },
        assets: [x.base],
        buys: x.side === "buy" ? { asset: x.base, usd: x.amount * x.price } : undefined,
      };
    }
    case "fund_vault": {
      const x = draft.params as VaultTransferParams;
      return { kind: "fund_vault", source: draft.source, wallet: "main", notionalUsd: usd(x.asset, x.amount, p), spend: { asset: x.asset, amount: x.amount } };
    }
    case "withdraw_vault": {
      const x = draft.params as VaultTransferParams;
      return { kind: "withdraw_vault", source: draft.source, wallet: "vault", notionalUsd: usd(x.asset, x.amount, p), spend: { asset: x.asset, amount: x.amount } };
    }
    case "cancel_orders":
      return { kind: "cancel_orders", source: draft.source, wallet: "vault", notionalUsd: 0 };
  }
}

/** The guardrail verdict on a draft, without saving anything. */
export const judge = (draft: Pick<Draft, "kind" | "source" | "params">, portfolio: Portfolio) => evaluate(toAction(draft, portfolio), portfolio);

export async function createProposal(userId: string, draft: Draft, portfolio?: Portfolio) {
  portfolio ??= await getPortfolio(userId);
  const action = toAction(draft, portfolio);
  const verdict = evaluate(action, portfolio);
  const [row] = await db()
    .insert(schema.proposals)
    .values({
      userId,
      kind: draft.kind,
      source: draft.source,
      title: draft.title,
      params: draft.params,
      rationale: draft.rationale,
      risk: draft.risk,
      notionalUsd: action.notionalUsd,
      status: verdict.ok ? "pending" : "blocked",
      guardrail: verdict,
    })
    .returning();
  return row;
}

export async function quoteSwapProposal(userId: string, wallet: "main" | "vault", from: AssetCode, to: AssetCode, amount: number) {
  const guardrails = (await getPortfolio(userId)).guardrails;
  const slippageBps = Math.min(guardrails.maxSlippageBps, 100);
  const quote = await quoteSwap(from, to, amount, slippageBps);
  return { wallet, quote, slippageBps } satisfies SwapParams;
}

/**
 * Signs and submits a pending proposal. Guardrails are re-checked against live balances
 * first — a proposal that was fine a minute ago may not be now.
 */
export async function executeProposal(userId: string, proposalId: string) {
  // Claim the proposal atomically so a double-click can't submit twice.
  const [claimed] = await db()
    .update(schema.proposals)
    .set({ status: "executing" })
    .where(and(eq(schema.proposals.id, proposalId), eq(schema.proposals.userId, userId), eq(schema.proposals.status, "pending")))
    .returning();
  if (!claimed) throw new Error("This proposal is no longer pending.");

  const finish = (values: Partial<typeof schema.proposals.$inferInsert>) =>
    db()
      .update(schema.proposals)
      .set({ ...values, resolvedAt: new Date() })
      .where(eq(schema.proposals.id, proposalId))
      .returning()
      .then((rows) => rows[0]);

  const portfolio = await getPortfolio(userId);
  const verdict = evaluate(toAction(claimed, portfolio), portfolio);
  if (!verdict.ok) {
    if (portfolio.loss.lossPct >= portfolio.guardrails.dailyLossPct && !portfolio.guardrails.halted) {
      await haltTrading(userId, `daily loss limit of ${portfolio.guardrails.dailyLossPct}% reached`);
    }
    return finish({ status: "blocked", guardrail: verdict });
  }

  try {
    const { hash, summary, vaultFlowUsd } = await perform(userId, claimed.kind, claimed.params, portfolio);
    if (claimed.kind === "swap") await bookVaultSwap(userId, claimed.params as unknown as SwapParams, portfolio).catch((error) => console.error("[mint] booking a vault swap failed", error));
    if (claimed.kind === "fund_vault" && portfolio.vault.valueUsd === 0) {
      // First funding: an empty-vault snapshot is the baseline the daily loss limit measures from.
      await recordSnapshot(userId, 0);
    }
    await db().insert(schema.activity).values({
      userId,
      kind: claimed.kind,
      summary,
      txHash: hash,
      vaultFlowUsd,
      actor: claimed.source === "agent" ? "agent" : "user",
    });
    return finish({ status: "executed", guardrail: verdict, txHash: hash });
  } catch (error) {
    return finish({ status: "failed", guardrail: verdict, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Books a vault swap into the position ledger at what it actually cost: the change in the vault's
 * balances across the trade, not the quote.
 */
async function bookVaultSwap(userId: string, x: SwapParams, before: Portfolio) {
  if (x.wallet !== "vault") return;
  const after = await balancesOf(before.vault.publicKey);
  if (!after) return;
  const { sendAsset, destAsset } = x.quote;
  const spent = before.vault.balances[sendAsset] - after[sendAsset];
  const got = after[destAsset] - before.vault.balances[destAsset];
  if (spent <= 0 || got <= 0) return;
  const reason = x.exit?.reason ?? "Sold by you";
  if (sendAsset === "USDC" && destAsset !== "USDC") return applyBuy(userId, destAsset, got, spent, x.plan);
  if (destAsset === "USDC" && sendAsset !== "USDC") return applySell(userId, sendAsset, spent, got, reason);
  if (sendAsset !== "USDC" && destAsset !== "USDC") {
    // Asset to asset: one position shrinks and another grows, both valued at the mainnet price.
    const value = usd(sendAsset, spent, before.prices);
    await applySell(userId, sendAsset, spent, value, reason);
    await applyBuy(userId, destAsset, got, value, x.plan);
  }
}

async function perform(userId: string, kind: ProposalKind, params: Record<string, unknown>, portfolio: Portfolio) {
  switch (kind) {
    case "payment": {
      const x = params as PaymentParams;
      const result = await sendPayment(await walletKeypair(userId, "main"), x.publicKey, x.asset, x.amount, {
        deliverAsset: x.deliverAsset,
        memo: x.memo,
        slippageBps: portfolio.guardrails.maxSlippageBps,
      });
      const delivered = x.deliverAsset && x.deliverAsset !== x.asset ? ` (delivered as ${x.deliverAsset})` : "";
      return { hash: result.hash, summary: `Sent ${x.amount} ${x.asset} to ${x.recipientLabel}${delivered}`, vaultFlowUsd: null };
    }
    case "swap": {
      const x = params as unknown as SwapParams;
      const result = await executeSwap(await walletKeypair(userId, x.wallet), x.quote);
      return {
        hash: result.hash,
        summary: `Swapped ${x.quote.sendAmount.toFixed(amountDigits(x.quote.sendAsset))} ${x.quote.sendAsset} → ≥${x.quote.destMin.toFixed(amountDigits(x.quote.destAsset))} ${x.quote.destAsset} (${x.wallet})`,
        vaultFlowUsd: null,
      };
    }
    case "limit_order": {
      const x = limitOrder(params);
      const result = await placeLimitOrder(await walletKeypair(userId, "vault"), x.base, x.side, x.amount, x.price);
      return {
        hash: result.hash,
        summary: `Placed ${x.side} order: ${x.amount.toFixed(amountDigits(x.base))} ${x.base} @ ${x.price} USDC`,
        vaultFlowUsd: null,
      };
    }
    case "fund_vault": {
      const x = params as VaultTransferParams;
      const vault = await getWallet(userId, "vault");
      const result = await sendPayment(await walletKeypair(userId, "main"), vault.publicKey, x.asset, x.amount, {
        recipient: await walletKeypair(userId, "vault"),
      });
      return { hash: result.hash, summary: `Moved ${x.amount} ${x.asset} into the trading vault`, vaultFlowUsd: usd(x.asset, x.amount, portfolio.prices) };
    }
    case "withdraw_vault": {
      const x = params as VaultTransferParams;
      // The vault can only ever pay out to its owner's main wallet.
      const main = await getWallet(userId, "main");
      const result = await sendPayment(await walletKeypair(userId, "vault"), main.publicKey, x.asset, x.amount, {
        recipient: await walletKeypair(userId, "main"),
      });
      return { hash: result.hash, summary: `Withdrew ${x.amount} ${x.asset} from the vault`, vaultFlowUsd: -usd(x.asset, x.amount, portfolio.prices) };
    }
    case "cancel_orders": {
      const result = await cancelAllOffers(await walletKeypair(userId, "vault"));
      if (!result) throw new Error("There are no open orders to cancel.");
      return { hash: result.hash, summary: "Cancelled all open vault orders", vaultFlowUsd: null };
    }
  }
}

export async function rejectProposal(userId: string, proposalId: string) {
  const [row] = await db()
    .update(schema.proposals)
    .set({ status: "rejected", resolvedAt: new Date() })
    .where(and(eq(schema.proposals.id, proposalId), eq(schema.proposals.userId, userId), eq(schema.proposals.status, "pending")))
    .returning();
  return row ?? null;
}

import { getPortfolio } from "../portfolio";
import { createProposal, type SwapParams } from "../proposals";
import { quoteSwap } from "../stellar/trade";
import { planTick } from "./plan";
import { closedPositions, syncPositions } from "./positions";
import { marketReads } from "./run";

/**
 * Runs the agent's rules once for a user who asked for a trade idea ("Find a trade"), and stages
 * the best one for them to confirm. Returns the per-market notes when nothing qualifies.
 */
export async function suggestTrade(userId: string) {
  const [portfolio, reads] = await Promise.all([getPortfolio(userId), marketReads()]);
  const g = portfolio.guardrails;
  const prices = Object.fromEntries(reads.map((r) => [r.asset, r.price]));
  const positions = await syncPositions(userId, portfolio.vault.balances, prices);
  const plan = planTick({ reads, positions, closed: await closedPositions(userId, 10), equityUsd: portfolio.vault.valueUsd, usdc: portfolio.vault.balances.USDC, guardrails: g });
  const pick = plan.exits.at(0) ?? plan.entry;
  if (!pick) return { proposal: null, notes: plan.notes.map((n) => (n.action === "watch" ? `${n.asset}: ${n.summary}` : n.summary)) };

  const selling = "position" in pick;
  const slippageBps = Math.min(g.maxSlippageBps, 100);
  const quote = selling ? await quoteSwap(pick.asset, "USDC", pick.qty, slippageBps) : await quoteSwap("USDC", pick.asset, pick.usd, slippageBps);
  const params: SwapParams = {
    wallet: "vault",
    quote,
    slippageBps,
    plan: selling ? undefined : pick.plan,
    exit: selling ? { reason: pick.reason } : undefined,
    agent: { asset: pick.asset, side: selling ? "sell" : "buy" },
  };
  const proposal = await createProposal(
    userId,
    { kind: "swap", source: "chat", title: pick.summary, params, rationale: pick.rationale, risk: selling ? "low" : pick.risk },
    portfolio,
  );
  return { proposal, notes: [] };
}

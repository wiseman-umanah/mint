import { z } from "zod";
import type { ChatCompletionTool } from "groq-sdk/resources/chat/completions";
import { amountDigits, ASSET_CODES, ASSETS, BASE_ASSETS } from "../assets";
import { agentStatus } from "../agent/status";
import { suggestTrade } from "../agent/suggest";
import { haltTrading } from "../guardrails";
import { technicals } from "../indicators";
import { getPortfolio } from "../portfolio";
import { createProposal, quoteSwapProposal } from "../proposals";
import { checkIssuer, checkLiquidity } from "../research";
import { allMarkets, chartCandles, marketSnapshot } from "../stellar/market";
import { resolveRecipient } from "../stellar/recipients";
import { computeSignals, generateIdeas } from "../strategy";

const asset = z.enum(ASSET_CODES);
const base = z.enum(BASE_ASSETS);
const positive = z.coerce.number().positive();
const ASSET_ENUM = { type: "string", enum: [...ASSET_CODES] };
const BASE_ENUM = { type: "string", enum: [...BASE_ASSETS] };

const schemas = {
  get_portfolio: z.object({}),
  scan_markets: z.object({}),
  get_market_analysis: z.object({ asset: base.default("XLM") }),
  check_liquidity: z.object({ asset: base, side: z.enum(["buy", "sell"]), amount_usd: positive }),
  check_issuer: z.object({ asset: asset }),
  propose_payment: z.object({
    recipient: z.string().min(1),
    amount: positive,
    asset,
    deliver_asset: asset.optional(),
    memo: z.string().max(28).optional(),
  }),
  propose_swap: z.object({ wallet: z.enum(["main", "vault"]), from_asset: asset, to_asset: asset, amount: positive }),
  propose_limit_order: z.object({ asset: base.default("XLM"), side: z.enum(["buy", "sell"]), amount: positive, price_usdc: positive }),
  propose_vault_transfer: z.object({ direction: z.enum(["fund", "withdraw"]), asset, amount: positive }),
  propose_cancel_orders: z.object({}),
  propose_strategy_trades: z.object({}),
  get_agent_status: z.object({}),
  halt_trading: z.object({ reason: z.string().optional() }),
};

type ToolName = keyof typeof schemas;

export const toolDefinitions: ChatCompletionTool[] = [
  fn("get_portfolio", "Balances of every asset with USD values for the main wallet and trading vault, allocation, guardrail settings, today's loss, and open orders.", {}),
  fn("scan_markets", "Overview of every market MINT trades (XLM, BTC, ETH, EURC, AQUA, yXLM, CETES, USTRY, all against USDC): price, 24h change, volume, volatility, and the testnet spread. Use for 'what's moving' questions.", {}),
  fn("get_market_analysis", "Deep technical read of one market from real mainnet data: price, 24h and 7d change, SMA 20h/50h, trend, RSI 14, ATR, volatility, 48h support and resistance, plus the testnet order book where MINT trades.", {
    asset: { ...BASE_ENUM, description: "Base asset of the market against USDC" },
  }),
  fn("check_liquidity", "What a trade of a given USD size would actually get on the testnet book: average fill price, slippage from the best price and from the mainnet price, and how much of it the book can fill.", {
    asset: BASE_ENUM,
    side: { type: "string", enum: ["buy", "sell"] },
    amount_usd: { type: "number" },
  }, ["asset", "side", "amount_usd"]),
  fn("check_issuer", "Due diligence on who issues a token on Stellar mainnet: home domain, organisation from its stellar.toml, account flags (freeze, clawback), holders and supply. Explains issuer risk.", {
    asset: ASSET_ENUM,
  }, ["asset"]),
  fn("propose_payment", "Stage a payment from the main wallet. Recipient can be @handle, name*domain federation address, or a G... public key. Use deliver_asset for cross-currency payments.", {
    recipient: { type: "string" },
    amount: { type: "number" },
    asset: ASSET_ENUM,
    deliver_asset: { ...ASSET_ENUM, description: "Asset the recipient receives, if different" },
    memo: { type: "string", description: "Text memo, max 28 chars" },
  }, ["recipient", "amount", "asset"]),
  fn("propose_swap", "Stage a swap via Stellar path payment. Use wallet 'main' for everyday swaps, 'vault' for trading.", {
    wallet: { type: "string", enum: ["main", "vault"] },
    from_asset: ASSET_ENUM,
    to_asset: ASSET_ENUM,
    amount: { type: "number", description: "Amount of from_asset to send" },
  }, ["wallet", "from_asset", "to_asset", "amount"]),
  fn("propose_limit_order", "Stage a limit order from the vault on a Stellar DEX market against USDC.", {
    asset: { ...BASE_ENUM, description: "Asset to buy or sell" },
    side: { type: "string", enum: ["buy", "sell"] },
    amount: { type: "number", description: "Amount of the asset" },
    price_usdc: { type: "number", description: "USDC per unit of the asset" },
  }, ["asset", "side", "amount", "price_usdc"]),
  fn("propose_vault_transfer", "Stage moving funds between the main wallet and the trading vault.", {
    direction: { type: "string", enum: ["fund", "withdraw"] },
    asset: ASSET_ENUM,
    amount: { type: "number" },
  }, ["direction", "asset", "amount"]),
  fn("propose_cancel_orders", "Stage cancelling every open order in the vault.", {}),
  fn("propose_strategy_trades", "Run the agent's trading rules across every allowed market and stage the best trade they find for the vault. If nothing qualifies, returns what the agent is waiting for on each market.", {}),
  fn("get_agent_status", "What the trading agent is doing with the vault right now: mode, whether it is running, open positions with profit and loss, stops and targets, its view of each market, and its most recent decisions with reasons. Use for 'what is the agent doing', 'why did it buy/sell', 'how is it performing'.", {}),
  fn("halt_trading", "Kill switch: immediately halt all vault trading and cancel open orders. Use when the user asks to stop.", {
    reason: { type: "string" },
  }),
];

function fn(name: ToolName, description: string, properties: Record<string, unknown>, required: string[] = []): ChatCompletionTool {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const round = (n: number, dp = 4) => Number(n.toFixed(dp));

function proposalResult(p: Awaited<ReturnType<typeof createProposal>>) {
  return {
    proposal_id: p.id,
    title: p.title,
    status: p.status,
    note:
      p.status === "pending"
        ? "Staged. The user must tap Confirm on the card for it to execute."
        : "Blocked by guardrails — explain which check failed.",
    guardrail_checks: p.guardrail?.checks,
  };
}

/** Runs one tool call. Returns the JSON for the model and any proposal it created. */
export async function runTool(userId: string, name: string, rawArgs: string): Promise<{ output: unknown; proposalId?: string }> {
  if (!(name in schemas)) return { output: { error: `Unknown tool ${name}` } };
  let args: unknown;
  try {
    args = schemas[name as ToolName].parse(JSON.parse(rawArgs || "{}"));
  } catch (error) {
    return { output: { error: `Invalid arguments: ${error instanceof Error ? error.message : error}` } };
  }

  try {
    switch (name as ToolName) {
      case "get_portfolio": {
        const p = await getPortfolio(userId);
        const holdings = (w: typeof p.main) =>
          Object.fromEntries(
            ASSET_CODES.filter((code) => w.balances[code] > 0).map((code) => {
              const value = w.balances[code] * (code === "USDC" ? 1 : p.prices[code]);
              return [code, { amount: w.balances[code], value_usd: round(value, 2), share_pct: w.valueUsd ? round((value / w.valueUsd) * 100, 1) : 0 }];
            }),
          );
        return {
          output: {
            prices_usd: Object.fromEntries(BASE_ASSETS.map((code) => [code, p.prices[code]])),
            main_wallet: { value_usd: round(p.main.valueUsd, 2), holdings: holdings(p.main), spendable_xlm: round(p.main.balances.spendableXLM, 2) },
            trading_vault: { value_usd: round(p.vault.valueUsd, 2), holdings: holdings(p.vault), spendable_xlm: round(p.vault.balances.spendableXLM, 2) },
            guardrails: {
              capital_cap_usd: p.guardrails.capitalCapUsd,
              daily_loss_limit_pct: p.guardrails.dailyLossPct,
              max_trade_usd: p.guardrails.maxTradeUsd,
              max_slippage_pct: p.guardrails.maxSlippageBps / 100,
              max_per_asset_pct_of_cap: p.guardrails.maxAssetPct,
              allowed_assets: p.guardrails.allowedAssets,
              mode: p.guardrails.mode,
              halted: p.guardrails.halted,
            },
            loss_24h_pct: round(p.loss.lossPct, 2),
            open_orders: p.offers,
          },
        };
      }
      case "scan_markets": {
        const markets = await allMarkets();
        return {
          output: {
            markets: markets.map((m) => {
              const s = computeSignals(m);
              return {
                pair: m.pair,
                name: ASSETS[m.base].name,
                group: ASSETS[m.base].group,
                price_usd: m.reference.mid,
                change_24h_pct: round(m.reference.change24hPct, 2),
                volume_24h_usd: Math.round(m.reference.volume24hUsd),
                daily_volatility_pct: round(s.volatilityPct, 2),
                trend_24h: s.trend,
                testnet_spread_bps: m.venue.spreadBps && round(m.venue.spreadBps, 1),
                testnet_vs_mainnet_bps: m.deviationBps && round(m.deviationBps, 1),
              };
            }),
          },
        };
      }
      case "get_market_analysis": {
        const a = args as z.infer<typeof schemas.get_market_analysis>;
        const [m, hourly] = await Promise.all([marketSnapshot(a.asset), chartCandles(a.asset, "mainnet", "1h", 200)]);
        const t = technicals(hourly);
        const r = (n: number | null) => (n === null ? null : round(n, 6));
        return {
          output: {
            pair: m.pair,
            about: ASSETS[a.asset].about,
            mainnet: {
              price: m.reference.mid,
              price_source: m.reference.priceSource,
              change_24h_pct: round(m.reference.change24hPct, 2),
              change_7d_pct: t.change_7d_pct === null ? null : round(t.change_7d_pct, 2),
              high_24h: m.reference.high24h,
              low_24h: m.reference.low24h,
              volume_24h_usd: Math.round(m.reference.volume24hUsd),
            },
            technicals_hourly: {
              trend: t.trend,
              sma_20h: r(t.sma_20h),
              sma_50h: r(t.sma_50h),
              rsi_14: t.rsi_14h === null ? null : round(t.rsi_14h, 1),
              atr_14_pct: t.atr_14h_pct === null ? null : round(t.atr_14h_pct, 2),
              daily_volatility_pct: t.daily_volatility_pct === null ? null : round(t.daily_volatility_pct, 2),
              support_48h: r(t.support_48h),
              resistance_48h: r(t.resistance_48h),
              candles_used: t.candles_used,
            },
            testnet_venue: {
              bid: m.venue.bid,
              ask: m.venue.ask,
              spread_bps: m.venue.spreadBps && round(m.venue.spreadBps, 1),
              deviation_from_mainnet_bps: m.deviationBps && round(m.deviationBps, 1),
              note: "MINT trades a testnet copy of this asset, quoted around the mainnet price.",
            },
          },
        };
      }
      case "check_liquidity": {
        const a = args as z.infer<typeof schemas.check_liquidity>;
        return { output: await checkLiquidity(a.asset, a.side, a.amount_usd) };
      }
      case "check_issuer": {
        const a = args as z.infer<typeof schemas.check_issuer>;
        return { output: await checkIssuer(a.asset) };
      }
      case "propose_payment": {
        const a = args as z.infer<typeof schemas.propose_payment>;
        const recipient = await resolveRecipient(a.recipient);
        if (recipient.userId === userId) return { output: { error: "That's the user's own wallet." } };
        const delivered = a.deliver_asset && a.deliver_asset !== a.asset ? `, delivered as ${a.deliver_asset}` : "";
        const p = await createProposal(userId, {
          kind: "payment",
          source: "chat",
          title: `Send ${a.amount} ${a.asset} to ${recipient.label}${delivered}`,
          params: {
            recipient: a.recipient,
            recipientLabel: recipient.label,
            publicKey: recipient.publicKey,
            asset: a.asset,
            amount: a.amount,
            deliverAsset: a.deliver_asset,
            memo: a.memo ?? recipient.memo,
          },
        });
        return { output: proposalResult(p), proposalId: p.id };
      }
      case "propose_swap": {
        const a = args as z.infer<typeof schemas.propose_swap>;
        if (a.from_asset === a.to_asset) return { output: { error: "Pick two different assets." } };
        const params = await quoteSwapProposal(userId, a.wallet, a.from_asset, a.to_asset, a.amount);
        const p = await createProposal(userId, {
          kind: "swap",
          source: "chat",
          title: `Swap ${a.amount} ${a.from_asset} → ~${params.quote.expectedAmount.toFixed(amountDigits(a.to_asset))} ${a.to_asset}`,
          params,
          rationale: `Best route: ${[a.from_asset, ...params.quote.hops, a.to_asset].join(" → ")}. Minimum received ${params.quote.destMin.toFixed(amountDigits(a.to_asset) + 2)} ${a.to_asset} (${params.slippageBps / 100}% slippage guard, enforced on-chain).`,
        });
        return { output: proposalResult(p), proposalId: p.id };
      }
      case "propose_limit_order": {
        const a = args as z.infer<typeof schemas.propose_limit_order>;
        const p = await createProposal(userId, {
          kind: "limit_order",
          source: "chat",
          title: `${a.side === "buy" ? "Buy" : "Sell"} ${a.amount} ${a.asset} @ ${a.price_usdc} USDC`,
          params: { side: a.side, base: a.asset, amount: a.amount, price: a.price_usdc },
        });
        return { output: proposalResult(p), proposalId: p.id };
      }
      case "propose_vault_transfer": {
        const a = args as z.infer<typeof schemas.propose_vault_transfer>;
        const fund = a.direction === "fund";
        const p = await createProposal(userId, {
          kind: fund ? "fund_vault" : "withdraw_vault",
          source: "chat",
          title: fund ? `Move ${a.amount} ${a.asset} into the trading vault` : `Withdraw ${a.amount} ${a.asset} from the vault`,
          params: { asset: a.asset, amount: a.amount },
        });
        return { output: proposalResult(p), proposalId: p.id };
      }
      case "propose_cancel_orders": {
        const p = await createProposal(userId, { kind: "cancel_orders", source: "chat", title: "Cancel all open vault orders", params: {} });
        return { output: proposalResult(p), proposalId: p.id };
      }
      case "propose_strategy_trades": {
        // The agent's own rulebook first; if it has nothing, a testnet-vs-mainnet price gap.
        const suggestion = await suggestTrade(userId);
        if (suggestion.proposal) {
          const p = suggestion.proposal;
          return { output: { ...proposalResult(p), rationale: p.rationale, risk: p.risk }, proposalId: p.id };
        }
        const [markets, portfolio] = await Promise.all([allMarkets(), getPortfolio(userId)]);
        const idea = generateIdeas(markets, portfolio).find((i) => i.kind === "limit_order");
        if (!idea) return { output: { ideas: [], note: "No trade qualifies right now.", what_the_agent_is_waiting_for: suggestion.notes } };
        const p = await createProposal(userId, { kind: idea.kind, source: "chat", title: idea.title, params: idea.params, rationale: idea.rationale, risk: idea.risk }, portfolio);
        return { output: { ...proposalResult(p), rationale: idea.rationale, risk: idea.risk, expected_return_pct: round(idea.expectedReturnPct, 2) }, proposalId: p.id };
      }
      case "get_agent_status": {
        const a = await agentStatus(userId);
        return {
          output: {
            mode: a.mode,
            halted: a.halted,
            running: a.online,
            last_check: a.lastTickAt,
            checks_so_far: a.tickCount,
            headline: a.headline,
            open_positions: a.positions.map((p) => ({
              asset: p.asset,
              strategy: p.strategy,
              value_usd: round(p.valueUsd, 2),
              pnl_usd: round(p.pnlUsd, 2),
              pnl_pct: round(p.pnlPct, 2),
              entry: p.entryPrice,
              stop: p.stopPrice,
              target: p.targetPrice,
            })),
            realized_pnl_usd: round(a.stats.realizedUsd, 2),
            unrealized_pnl_usd: round(a.stats.unrealizedUsd, 2),
            closed_trades: a.stats.closedTrades,
            win_rate_pct: a.stats.winRatePct === null ? null : round(a.stats.winRatePct, 0),
            markets: a.reads.map((r) => ({ asset: r.asset, regime: r.regime, rsi: r.rsi === null ? null : round(r.rsi, 0), view: r.note })),
            data_budget: {
              enabled: a.data.enabled,
              agent_wallet_usd: round(a.data.balanceUsd, 2),
              spent_24h_usd: round(a.data.spent24hUsd, 2),
              daily_limit_usd: a.data.dailyUsd,
              max_per_request_usd: a.data.maxCallUsd,
              recent_payments: a.data.payments.slice(0, 5).map((p) => ({ at: p.createdAt, status: p.status, amount_usd: p.amountUsd, seller: p.url, reason: p.reason })),
            },
            recent_decisions: a.decisions.slice(0, 12).map((d) => ({ at: d.createdAt, action: d.action, summary: d.summary })),
          },
        };
      }
      case "halt_trading": {
        const a = args as z.infer<typeof schemas.halt_trading>;
        await haltTrading(userId, a.reason ?? "stopped from chat");
        return { output: { halted: true } };
      }
    }
  } catch (error) {
    return { output: { error: error instanceof Error ? error.message : String(error) } };
  }
}

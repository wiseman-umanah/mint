/**
 * MINT background loops:
 *   market maker  mirrors every real (mainnet) market onto the testnet order books
 *   agent         snapshots vaults, enforces the daily loss limit, and trades for autonomous users
 *   oracle        publishes mainnet reference prices to MINT's on-chain price feed (if deployed)
 *
 * Runs standalone via `pnpm worker`, or inside the Next server when using the local database.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { Keypair, Operation, type xdr } from "@stellar/stellar-sdk";
import type { BaseAsset } from "./assets";
import { db, schema } from "./db";
import { env } from "./env";
import { haltTrading } from "./guardrails";
import { getPortfolio, lastSnapshot, recordSnapshot } from "./portfolio";
import { createProposal, executeProposal, quoteSwapProposal } from "./proposals";
import { cancelOfferOps, hasTrustline, openOffers, readBalances } from "./stellar/accounts";
import { amount7, assetFor, codeOf, horizon, issuerKeypair, usdc } from "./stellar/config";
import { publishPrices } from "./stellar/contracts";
import { allMarkets, referencePrices } from "./stellar/market";
import { build, submitSigned } from "./stellar/submit";
import { generateIdeas } from "./strategy";

const MM_INTERVAL_MS = 25_000;
const AGENT_INTERVAL_MS = 60_000;
const SNAPSHOT_EVERY_MS = 5 * 60_000;
const AGENT_COOLDOWN_MS = 5 * 60_000;
// Matches the price feed's 300s resolution; guardrail vaults refuse prices older than their limit.
const ORACLE_INTERVAL_MS = 5 * 60_000;

// Ladders: distance from mid (bps) and size (USD) per level, each side. XLM/USDC is the deepest market.
const LADDERS = {
  XLM: [
    { bps: 15, usd: 25 },
    { bps: 40, usd: 45 },
    { bps: 80, usd: 90 },
    { bps: 150, usd: 150 },
  ],
  other: [
    { bps: 20, usd: 40 },
    { bps: 60, usd: 90 },
    { bps: 140, usd: 180 },
  ],
};
// The issuer keeps the market maker stocked with each testnet copy (USD worth).
const INVENTORY_FLOOR_USD = 1_500;
const INVENTORY_TARGET_USD = 5_000;
// Stellar allows 100 operations per transaction; pairs are batched under this.
const MAX_OPS = 90;

const log = (scope: string, message: string) => console.log(`${new Date().toISOString().slice(11, 19)} [${scope}] ${message}`);

type Offer = Awaited<ReturnType<typeof openOffers>>[number];

/** The non-USDC side of one of the maker's offers. */
function offerBase(offer: Offer): BaseAsset | null {
  const selling = codeOf(offer.selling);
  const buying = codeOf(offer.buying);
  if (selling === "USDC" && buying && buying !== "USDC") return buying as BaseAsset;
  if (buying === "USDC" && selling && selling !== "USDC") return selling as BaseAsset;
  return null;
}

/** USDC the offer has locked up, if it sells USDC. */
const usdcLocked = (offer: Offer) => (codeOf(offer.selling) === "USDC" ? Number(offer.amount) : 0);

/**
 * Mirrors every mainnet market onto the testnet book: cancels the maker's quotes on each pair and
 * re-quotes a ladder around the mainnet price, in as few transactions as Stellar's op limit allows.
 */
async function marketMakerTick(maker: Keypair) {
  const markets = (await allMarkets()).filter((m) => m.reference.mid > 0 && (m.base === "XLM" || process.env.ISSUER_SECRET));
  if (markets.length === 0) return log("mm", "no mainnet prices — skipping");

  const account = await horizon().loadAccount(maker.publicKey());
  const balances = readBalances(account);
  const offers = await openOffers(maker.publicKey());
  const issuer = process.env.ISSUER_SECRET ? issuerKeypair() : null;
  const ladder = (base: BaseAsset) => (base === "XLM" ? LADDERS.XLM : LADDERS.other);

  // Batch pairs under the op limit: cancels + a possible trustline and top-up + two offers per level.
  const batches: (typeof markets)[] = [[]];
  let opsInBatch = 0;
  for (const market of markets) {
    const estimate = offers.filter((o) => offerBase(o) === market.base).length + 2 + ladder(market.base).length * 2;
    if (opsInBatch + estimate > MAX_OPS && batches.at(-1)!.length) {
      batches.push([]);
      opsInBatch = 0;
    }
    batches.at(-1)!.push(market);
    opsInBatch += estimate;
  }

  // USDC each pair's quotes lock up right now; updated as batches are re-quoted.
  const locked = new Map<BaseAsset, number>();
  for (const o of offers) {
    const base = offerBase(o);
    if (base) locked.set(base, (locked.get(base) ?? 0) + usdcLocked(o));
  }
  let xlmLeft = balances.XLM - 100 - (2 + account.subentry_count + 10) * 0.5;

  for (const batch of batches) {
    const ops: xdr.Operation[] = [];
    let needsIssuer = false;
    // Only USDC not tied up by other batches' quotes can fund this batch's bids.
    const elsewhere = [...locked].filter(([base]) => !batch.some((m) => m.base === base)).reduce((sum, [, v]) => sum + v, 0);
    const free = Math.max(0, balances.USDC - elsewhere - 1);
    const weight = (base: BaseAsset) => (base === "XLM" ? 2 : 1);
    const totalWeight = batch.reduce((sum, m) => sum + weight(m.base), 0);

    for (const market of batch) {
      const { base } = market;
      const mid = market.reference.mid;
      ops.push(...cancelOfferOps(offers.filter((o) => offerBase(o) === base)));

      // Inventory of the base asset for asks (cancelled offers free theirs in the same tx).
      let baseLeft: number;
      if (base === "XLM") {
        baseLeft = xlmLeft;
      } else {
        if (!hasTrustline(account, base)) ops.push(Operation.changeTrust({ asset: assetFor(base) }));
        baseLeft = balances[base];
        if (issuer && baseLeft * mid < INVENTORY_FLOOR_USD) {
          const topUp = (INVENTORY_TARGET_USD - baseLeft * mid) / mid;
          ops.push(Operation.payment({ source: issuer.publicKey(), destination: maker.publicKey(), asset: assetFor(base), amount: amount7(topUp) }));
          baseLeft += topUp;
          needsIssuer = true;
        }
      }

      let usdcLeft = (free * weight(base)) / totalWeight;
      let bidTotal = 0;
      for (const level of ladder(base)) {
        const ask = mid * (1 + level.bps / 10_000);
        const bid = mid * (1 - level.bps / 10_000);
        const askAmount = Math.min(level.usd / ask, baseLeft);
        if (askAmount * ask > 1) {
          ops.push(Operation.manageSellOffer({ selling: assetFor(base), buying: usdc(), amount: amount7(askAmount), price: ask.toFixed(7) }));
          baseLeft -= askAmount;
        }
        const bidUsdc = Math.min(level.usd, usdcLeft);
        if (bidUsdc > 1) {
          ops.push(Operation.manageSellOffer({ selling: usdc(), buying: assetFor(base), amount: amount7(bidUsdc), price: (1 / bid).toFixed(7) }));
          usdcLeft -= bidUsdc;
          bidTotal += bidUsdc;
        }
      }
      if (base === "XLM") xlmLeft = baseLeft;
      locked.set(base, bidTotal);
    }

    try {
      await submitSigned(await build(maker.publicKey(), ops), needsIssuer && issuer ? [maker, issuer] : [maker]);
    } catch (error) {
      log("mm", `${batch.map((m) => m.base).join(", ")} failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
      // The old quotes are still on the book.
      for (const m of batch) locked.set(m.base, offers.filter((o) => offerBase(o) === m.base).reduce((sum, o) => sum + usdcLocked(o), 0));
    }
  }
  log("mm", `quoted ${markets.map((m) => m.base).join(", ")} in ${batches.length} tx · ${balances.USDC.toFixed(2)} USDC for bids`);
}

async function agentTick() {
  const users = await db().query.guardrails.findMany();
  const markets = await allMarkets();
  for (const g of users) {
    try {
      const portfolio = await getPortfolio(g.userId);
      if (!portfolio.vault.active) continue;

      const last = await lastSnapshot(g.userId);
      if (portfolio.vault.valueUsd > 0 && (!last || Date.now() - last.takenAt.getTime() > SNAPSHOT_EVERY_MS)) {
        await recordSnapshot(g.userId, portfolio.vault.valueUsd);
      }

      // Daily loss limit applies in every mode: breach → halt and pull orders.
      if (!g.halted && portfolio.loss.lossPct >= g.dailyLossPct) {
        await haltTrading(g.userId, `daily loss limit of ${g.dailyLossPct}% reached (${portfolio.loss.lossPct.toFixed(2)}%)`);
        log("agent", `halted ${g.userId.slice(0, 8)} — loss ${portfolio.loss.lossPct.toFixed(2)}%`);
        continue;
      }
      if (g.mode !== "autonomous" || g.halted) continue;

      const recent = await db().query.proposals.findFirst({
        where: and(
          eq(schema.proposals.userId, g.userId),
          eq(schema.proposals.source, "agent"),
          gte(schema.proposals.createdAt, new Date(Date.now() - AGENT_COOLDOWN_MS)),
        ),
        orderBy: desc(schema.proposals.createdAt),
      });
      if (recent) continue;

      const idea = generateIdeas(markets, portfolio)[0];
      if (!idea) continue;
      const params =
        idea.kind === "swap" && "from" in idea.params
          ? await quoteSwapProposal(g.userId, "vault", idea.params.from, idea.params.to, idea.params.amount)
          : idea.params;
      const proposal = await createProposal(
        g.userId,
        { kind: idea.kind, source: "agent", title: idea.title, params, rationale: idea.rationale, risk: idea.risk },
        portfolio,
      );
      if (proposal.status !== "pending") {
        log("agent", `${g.userId.slice(0, 8)} idea blocked by guardrails: ${idea.title}`);
        continue;
      }
      const result = await executeProposal(g.userId, proposal.id);
      log("agent", `${g.userId.slice(0, 8)} ${result?.status}: ${idea.title}${result?.txHash ? ` (${result.txHash.slice(0, 10)}…)` : ""}`);
    } catch (error) {
      log("agent", `${g.userId.slice(0, 8)} error: ${error instanceof Error ? error.message : error}`);
    }
  }
}

function every(ms: number, scope: string, fn: () => Promise<unknown>) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (error) {
      log(scope, `error: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(run, ms);
}

const store = globalThis as typeof globalThis & { __mintWorker?: boolean };

export function startWorker({ marketMaker = true, agent = true, oracle = true } = {}) {
  // Once per process, even across hot reloads.
  if (store.__mintWorker) return;
  store.__mintWorker = true;
  if (marketMaker) {
    if (!process.env.MARKET_MAKER_SECRET) {
      log("mm", "MARKET_MAKER_SECRET not set — run pnpm stellar:bootstrap; market maker skipped");
    } else {
      const maker = Keypair.fromSecret(env.marketMakerSecret);
      log("mm", `market maker ${maker.publicKey()}`);
      every(MM_INTERVAL_MS, "mm", () => marketMakerTick(maker));
    }
  }
  if (agent) {
    log("agent", "autonomous agent started");
    every(AGENT_INTERVAL_MS, "agent", agentTick);
  }
  if (oracle && env.priceFeedContractId) {
    log("oracle", `price feed ${env.priceFeedContractId}`);
    every(ORACLE_INTERVAL_MS, "oracle", async () => {
      const result = await publishPrices(await referencePrices());
      if (result) log("oracle", `published prices (${result.hash.slice(0, 10)}…)`);
    });
  }
}

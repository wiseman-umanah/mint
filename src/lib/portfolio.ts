import { and, asc, desc, eq, gte, sum } from "drizzle-orm";
import { db, schema } from "./db";
import { type BaseAsset } from "./assets";
import { activateWallets, balancesOf, type Balances, emptyBalances, openOffers } from "./stellar/accounts";
import { codeOf } from "./stellar/config";
import { referencePrices, usdValue } from "./stellar/market";

const DAY_MS = 86_400_000;

export async function getGuardrails(userId: string) {
  const row = await db().query.guardrails.findFirst({ where: eq(schema.guardrails.userId, userId) });
  if (row) return row;
  const [created] = await db().insert(schema.guardrails).values({ userId }).onConflictDoNothing().returning();
  return created ?? (await db().query.guardrails.findFirst({ where: eq(schema.guardrails.userId, userId) }))!;
}

/**
 * Rolling 24h drawdown of the vault, net of deposits and withdrawals:
 *   loss = (value 24h ago + net flows since) − value now
 */
export async function dailyLoss(userId: string, currentValueUsd: number) {
  const since = new Date(Date.now() - DAY_MS);
  const baseline = await db().query.vaultSnapshots.findFirst({
    where: and(eq(schema.vaultSnapshots.userId, userId), gte(schema.vaultSnapshots.takenAt, since)),
    orderBy: asc(schema.vaultSnapshots.takenAt),
  });
  if (!baseline) return { lossUsd: 0, lossPct: 0, baselineUsd: currentValueUsd };
  const [flows] = await db()
    .select({ total: sum(schema.activity.vaultFlowUsd) })
    .from(schema.activity)
    .where(and(eq(schema.activity.userId, userId), gte(schema.activity.createdAt, baseline.takenAt)));
  const invested = baseline.valueUsd + Number(flows?.total ?? 0);
  const lossUsd = Math.max(0, invested - currentValueUsd);
  return { lossUsd, lossPct: invested > 0 ? (lossUsd / invested) * 100 : 0, baselineUsd: invested };
}

export async function recordSnapshot(userId: string, valueUsd: number) {
  await db().insert(schema.vaultSnapshots).values({ userId, valueUsd });
}

export async function lastSnapshot(userId: string) {
  return db().query.vaultSnapshots.findFirst({
    where: eq(schema.vaultSnapshots.userId, userId),
    orderBy: desc(schema.vaultSnapshots.takenAt),
  });
}

export type WalletView = {
  publicKey: string;
  active: boolean;
  balances: Balances;
  valueUsd: number;
};

export async function getPortfolio(userId: string) {
  const [wallets, prices, guardrails] = await Promise.all([
    db().query.wallets.findMany({ where: eq(schema.wallets.userId, userId) }),
    referencePrices(),
    getGuardrails(userId),
  ]);

  let views = await Promise.all(wallets.map(async (w) => ({ kind: w.kind, publicKey: w.publicKey, balances: await balancesOf(w.publicKey) })));
  // Self-heal: if account creation failed at signup, retry it now.
  if (views.some((v) => !v.balances)) {
    await activateWallets(userId).catch(() => null);
    views = await Promise.all(views.map(async (v) => ({ ...v, balances: await balancesOf(v.publicKey) })));
  }

  const toView = (kind: "main" | "vault"): WalletView => {
    const v = views.find((x) => x.kind === kind)!;
    const balances = v.balances ?? emptyBalances();
    return { publicKey: v.publicKey, active: Boolean(v.balances), balances, valueUsd: usdValue(balances, prices) };
  };
  const main = toView("main");
  const vault = toView("vault");
  const [offers, loss] = await Promise.all([
    vault.active ? openOffers(vault.publicKey) : Promise.resolve([]),
    dailyLoss(userId, vault.valueUsd),
  ]);

  return {
    // USD price of every asset, from mainnet.
    prices,
    xlmPrice: prices.XLM,
    main,
    vault,
    totalUsd: main.valueUsd + vault.valueUsd,
    guardrails,
    loss,
    // Every offer is stored as a sell; selling USDC means buying the base asset.
    offers: offers.flatMap((o) => {
      const selling = codeOf(o.selling);
      const buying = codeOf(o.buying);
      if (!selling || !buying || (selling !== "USDC") === (buying !== "USDC")) return [];
      const buy = selling === "USDC";
      const base = (buy ? buying : selling) as BaseAsset;
      const price = buy ? 1 / Number(o.price) : Number(o.price);
      const amount = buy ? Number(o.amount) / price : Number(o.amount);
      return [{ id: String(o.id), base, side: buy ? ("buy" as const) : ("sell" as const), amount, price }];
    }),
  };
}

export type Portfolio = Awaited<ReturnType<typeof getPortfolio>>;

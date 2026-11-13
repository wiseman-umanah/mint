import { and, desc, eq, gte, sum } from "drizzle-orm";
import { Keypair } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { encryptSecret } from "../crypto";
import { db, schema } from "../db";
import type { GuardrailVerdict } from "../db/schema";
import { env } from "../env";
import { activateWallets, balancesOf, getWallet, walletKeypair } from "../stellar/accounts";
import { sendPayment } from "../stellar/trade";
import { fromAtomic, X402_NETWORK, X402_USDC } from "../x402/facilitator";

const DAY_MS = 86_400_000;
type Guardrails = typeof schema.guardrails.$inferSelect;

/*
 * The agent's budget wallet. Paying for data needs a key that can move money without the user in
 * the loop, so that key gets its own account holding a few dollars and nothing else. It is not a
 * signer on the vault or the main wallet: if the agent is hijacked, the most it can lose is what
 * this wallet holds, and "revoke" empties it back to the user.
 */
export const agentWallet = (userId: string) =>
  db().query.wallets.findFirst({ where: and(eq(schema.wallets.userId, userId), eq(schema.wallets.kind, "agent")) });

export async function agentBalance(userId: string) {
  const wallet = await agentWallet(userId);
  const balances = wallet ? await balancesOf(wallet.publicKey) : null;
  return { wallet: wallet ?? null, usdc: balances?.USDC ?? 0 };
}

export async function spentOnData(userId: string, sinceMs = DAY_MS) {
  const [row] = await db()
    .select({ total: sum(schema.agentPayments.amountUsd) })
    .from(schema.agentPayments)
    .where(and(eq(schema.agentPayments.userId, userId), eq(schema.agentPayments.status, "paid"), gte(schema.agentPayments.createdAt, new Date(Date.now() - sinceMs))));
  return Number(row?.total ?? 0);
}

const log = (userId: string, kind: string, summary: string, txHash?: string) =>
  db().insert(schema.activity).values({ userId, kind, summary, txHash, actor: "user" });

/** Creates the agent's wallet on Stellar if needed and tops it up from the main wallet, never past the budget. */
export async function fundAgentWallet(userId: string, g: Guardrails) {
  if (!(await agentWallet(userId))) {
    const keypair = Keypair.random();
    await db()
      .insert(schema.wallets)
      .values({ userId, kind: "agent", publicKey: keypair.publicKey(), encryptedSecret: encryptSecret(keypair.secret(), keypair.publicKey()) })
      .onConflictDoNothing();
  }
  await activateWallets(userId);
  const { wallet, usdc } = await agentBalance(userId);
  const main = await balancesOf((await getWallet(userId, "main")).publicKey);
  const amount = Math.floor(Math.min(g.agentBudgetUsd - usdc, main?.USDC ?? 0) * 100) / 100;
  if (amount < 0.01) {
    if (usdc < 0.01) throw new Error("Your main wallet has no USDC to give the agent. Add test USDC first.");
    return { funded: 0, balance: usdc };
  }
  const result = await sendPayment(await walletKeypair(userId, "main"), wallet!.publicKey, "USDC", amount);
  await log(userId, "fund_agent", `Gave the agent a data budget of ${amount.toFixed(2)} USDC`, result.hash);
  return { funded: amount, balance: usdc + amount, txHash: result.hash };
}

/** Kill switch for data spending: turn it off and send everything in the agent's wallet back to the user. */
export async function revokeAgentWallet(userId: string) {
  await db().update(schema.guardrails).set({ dataEnabled: false, updatedAt: new Date() }).where(eq(schema.guardrails.userId, userId));
  const { wallet, usdc } = await agentBalance(userId);
  if (!wallet || usdc < 0.0000001) {
    await log(userId, "revoke_agent", "Revoked the agent's data budget");
    return { returned: 0 };
  }
  const main = await getWallet(userId, "main");
  const result = await sendPayment(await walletKeypair(userId, "agent"), main.publicKey, "USDC", usdc);
  await log(userId, "revoke_agent", `Revoked the agent's data budget: ${usdc.toFixed(2)} USDC returned to your wallet`, result.hash);
  return { returned: usdc, txHash: result.hash };
}

export const allowedSellers = () => env.x402DataSources.map((url) => new URL(url).host);

export type DataOffer = { url: string; priceUsd: number; network: string; asset: string };

/** The guardrails on a data payment. Pure: the same inputs always give the same verdict. */
export function evaluateDataPayment(
  offer: DataOffer,
  ctx: { g: Pick<Guardrails, "dataEnabled" | "halted" | "dataMaxCallUsd" | "dataDailyUsd">; spent24hUsd: number; balanceUsd: number; sellers: string[] },
): GuardrailVerdict {
  const { g } = ctx;
  const host = (() => {
    try {
      return new URL(offer.url).host;
    } catch {
      return offer.url;
    }
  })();
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const checks = [
    { rule: "Data purchases on", ok: g.dataEnabled, detail: g.dataEnabled ? "You gave the agent a data budget" : "The agent has no data budget" },
    { rule: "Kill switch", ok: !g.halted, detail: g.halted ? "Halted: the agent can't spend" : "Off" },
    { rule: "Known seller", ok: ctx.sellers.includes(host), detail: ctx.sellers.includes(host) ? host : `${host} is not on the seller list` },
    {
      rule: "Testnet USDC only",
      ok: offer.network === X402_NETWORK && offer.asset === X402_USDC,
      detail: offer.network === X402_NETWORK && offer.asset === X402_USDC ? "USDC on Stellar testnet" : `Asked for ${offer.asset.slice(0, 8)}… on ${offer.network}`,
    },
    { rule: "Max per request", ok: offer.priceUsd <= g.dataMaxCallUsd, detail: `${usd(offer.priceUsd)} of ${usd(g.dataMaxCallUsd)} per request` },
    {
      rule: "Daily data budget",
      ok: ctx.spent24hUsd + offer.priceUsd <= g.dataDailyUsd,
      detail: `${usd(ctx.spent24hUsd + offer.priceUsd)} of ${usd(g.dataDailyUsd)} in 24h`,
    },
    { rule: "Agent wallet balance", ok: ctx.balanceUsd >= offer.priceUsd, detail: `Needs ${usd(offer.priceUsd)}, holds ${usd(ctx.balanceUsd)}` },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

const record = (userId: string, row: Omit<typeof schema.agentPayments.$inferInsert, "userId">) =>
  db().insert(schema.agentPayments).values({ userId, ...row }).returning().then((rows) => rows[0]);

/**
 * Buys one paid resource over x402 with the agent's wallet: ask, read the price from the 402,
 * run the guardrails, and only then sign. Every attempt is recorded, paid or not.
 */
export async function buyData(userId: string, url: string, g: Guardrails) {
  const first = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (first.status !== 402) {
    if (!first.ok) return record(userId, { url, amountUsd: 0, status: "failed", reason: `The seller answered ${first.status}` });
    return record(userId, { url, amountUsd: 0, status: "paid", reason: "Free: no payment asked", data: await first.json().catch(() => null) });
  }

  const { wallet, usdc } = await agentBalance(userId);
  const client = new x402Client();
  const http = new x402HTTPClient(client);
  const required = http.getPaymentRequiredResponse((name) => first.headers.get(name), await first.json().catch(() => undefined));
  const offer = required.accepts.find((a) => a.scheme === "exact" && a.network === X402_NETWORK) ?? required.accepts[0];
  if (!offer) return record(userId, { url, amountUsd: 0, status: "failed", reason: "The seller offered no way to pay" });
  const priceUsd = fromAtomic(offer.amount);

  const verdict = evaluateDataPayment(
    { url, priceUsd, network: offer.network, asset: offer.asset },
    { g, spent24hUsd: await spentOnData(userId), balanceUsd: usdc, sellers: allowedSellers() },
  );
  if (!verdict.ok || !wallet) {
    const reason = verdict.checks.filter((c) => !c.ok).map((c) => `${c.rule}: ${c.detail}`).join("; ") || "The agent has no wallet";
    return record(userId, { url, payTo: offer.payTo, amountUsd: priceUsd, status: "blocked", reason });
  }

  client.register("stellar:*", new ExactStellarScheme(createEd25519Signer((await walletKeypair(userId, "agent")).secret(), X402_NETWORK), { url: env.rpcUrl }));
  let reason = "Payment failed";
  // Testnet settlement fails now and then with nothing spent; a fresh signature usually goes through.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const payload = await client.createPaymentPayload({ ...required, accepts: [offer] });
      const paid = await fetch(url, { headers: http.encodePaymentSignatureHeader(payload), signal: AbortSignal.timeout(90_000) });
      if (paid.ok) {
        const receipt = http.getPaymentSettleResponse((name) => paid.headers.get(name));
        const data = (await paid.json().catch(() => null)) as Record<string, unknown> | null;
        const row = await record(userId, { url, payTo: offer.payTo, amountUsd: priceUsd, status: "paid", txHash: receipt.transaction, data });
        await db().insert(schema.activity).values({ userId, kind: "data_payment", summary: `Agent paid ${priceUsd.toFixed(2)} USDC for data from ${new URL(url).host} (x402)`, txHash: receipt.transaction, actor: "agent" });
        return row;
      }
      reason = ((await paid.json().catch(() => null)) as { error?: string } | null)?.error ?? `The seller answered ${paid.status}`;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  return record(userId, { url, payTo: offer.payTo, amountUsd: priceUsd, status: "failed", reason });
}

export function recentPayments(userId: string, limit = 12) {
  return db().query.agentPayments.findMany({ where: eq(schema.agentPayments.userId, userId), orderBy: desc(schema.agentPayments.createdAt), limit });
}

/** The newest data the agent paid for, if it is still fresh enough to act on. */
export async function latestPaidData(userId: string, maxAgeMs = 2 * 3_600_000) {
  const row = await db().query.agentPayments.findFirst({
    where: and(eq(schema.agentPayments.userId, userId), eq(schema.agentPayments.status, "paid"), gte(schema.agentPayments.createdAt, new Date(Date.now() - maxAgeMs))),
    orderBy: desc(schema.agentPayments.createdAt),
  });
  return row?.data ? { at: row.createdAt, data: row.data } : null;
}

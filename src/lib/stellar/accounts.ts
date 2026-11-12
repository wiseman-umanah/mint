import { and, eq } from "drizzle-orm";
import { Asset, Keypair, NotFoundError, Operation, type Horizon, type xdr } from "@stellar/stellar-sdk";
import { ASSET_CODES, type AssetCode } from "../assets";
import { decryptSecret, encryptSecret } from "../crypto";
import { db, schema } from "../db";
import type { WalletKind } from "../db/schema";
import { assetFor, codeOf, horizon, treasuryKeypair, usdc } from "./config";
import { build, submitSigned, submitSponsored } from "./submit";

// XLM each new account receives on top of its sponsored reserves, so it can open SDEX offers.
const STARTING_XLM = "3";

export async function createWallets(userId: string) {
  const rows = (["main", "vault"] as const).map((kind) => {
    const keypair = Keypair.random();
    return {
      userId,
      kind,
      publicKey: keypair.publicKey(),
      encryptedSecret: encryptSecret(keypair.secret(), keypair.publicKey()),
    };
  });
  await db().insert(schema.wallets).values(rows).onConflictDoNothing();
}

export async function getWallet(userId: string, kind: WalletKind) {
  const wallet = await db().query.wallets.findFirst({
    where: and(eq(schema.wallets.userId, userId), eq(schema.wallets.kind, kind)),
  });
  if (!wallet) throw new Error(`No ${kind} wallet for user`);
  return wallet;
}

export async function walletKeypair(userId: string, kind: WalletKind) {
  const wallet = await getWallet(userId, kind);
  return Keypair.fromSecret(decryptSecret(wallet.encryptedSecret, wallet.publicKey));
}

export async function loadAccountOrNull(publicKey: string) {
  try {
    return await horizon().loadAccount(publicKey);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/**
 * Puts the user's wallets on-chain. The treasury sponsors the base reserve and the USDC
 * trustline reserve (CAP-33), so the user never needs XLM to get started. Idempotent.
 */
export async function activateWallets(userId: string) {
  const wallets = await db().query.wallets.findMany({ where: eq(schema.wallets.userId, userId) });
  const missing = [];
  for (const wallet of wallets) {
    if (!(await loadAccountOrNull(wallet.publicKey))) missing.push(wallet);
  }
  if (missing.length === 0) return false;

  const treasury = treasuryKeypair();
  const ops = missing.flatMap((wallet) => [
    Operation.beginSponsoringFutureReserves({ sponsoredId: wallet.publicKey }),
    Operation.createAccount({ destination: wallet.publicKey, startingBalance: STARTING_XLM }),
    Operation.changeTrust({ asset: usdc(), source: wallet.publicKey }),
    Operation.endSponsoringFutureReserves({ source: wallet.publicKey }),
  ]);
  const tx = await build(treasury.publicKey(), ops);
  const signers = missing.map((wallet) => Keypair.fromSecret(decryptSecret(wallet.encryptedSecret, wallet.publicKey)));
  const result = await submitSigned(tx, [treasury, ...signers]);
  await db()
    .insert(schema.activity)
    .values({
      userId,
      kind: "wallet_created",
      summary: `Created ${missing.map((w) => w.kind).join(" + ")} wallet on Stellar (reserves sponsored by MINT)`,
      txHash: result.hash,
      actor: "system",
    });
  return true;
}

/** Balance of every MINT asset (0 when there's no trustline), plus XLM free to spend. */
export type Balances = Record<AssetCode, number> & { spendableXLM: number };

export const emptyBalances = (): Balances =>
  ({ ...Object.fromEntries(ASSET_CODES.map((code) => [code, 0])), spendableXLM: 0 }) as Balances;

export function readBalances(account: Horizon.AccountResponse): Balances {
  const balances = emptyBalances();
  let xlmLiabilities = 0;
  for (const line of account.balances) {
    if (line.asset_type === "liquidity_pool_shares") continue;
    const code = codeOf(line);
    if (!code) continue;
    balances[code] = Number(line.balance);
    if (code === "XLM") xlmLiabilities = Number(line.selling_liabilities);
  }
  // Minimum balance: (2 + subentries + sponsoring − sponsored) × 0.5 XLM, plus XLM locked in offers.
  const reserveUnits =
    2 + account.subentry_count + (account.num_sponsoring ?? 0) - (account.num_sponsored ?? 0);
  balances.spendableXLM = Math.max(0, balances.XLM - reserveUnits * 0.5 - xlmLiabilities);
  return balances;
}

export function hasTrustline(account: Horizon.AccountResponse, code: AssetCode) {
  if (code === "XLM") return true;
  const asset = assetFor(code);
  return account.balances.some(
    (line) => "asset_code" in line && line.asset_code === asset.getCode() && line.asset_issuer === asset.getIssuer(),
  );
}

/**
 * Trustline-on-demand: ops that open any missing trustlines for these accounts, with the reserve
 * sponsored by the treasury (CAP-33). The treasury must co-sign when `ops` is non-empty.
 */
export async function trustlineOps(needs: { publicKey: string; code: AssetCode }[]) {
  const treasury = treasuryKeypair().publicKey();
  const ops: xdr.Operation[] = [];
  const seen = new Set<string>();
  for (const { publicKey, code } of needs) {
    const key = `${publicKey}:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const account = await loadAccountOrNull(publicKey);
    if (!account || hasTrustline(account, code)) continue;
    ops.push(
      Operation.beginSponsoringFutureReserves({ sponsoredId: publicKey, source: treasury }),
      Operation.changeTrust({ asset: assetFor(code), source: publicKey }),
      Operation.endSponsoringFutureReserves({ source: publicKey }),
    );
  }
  return ops;
}

export async function balancesOf(publicKey: string): Promise<Balances | null> {
  const account = await loadAccountOrNull(publicKey);
  return account ? readBalances(account) : null;
}

export async function openOffers(publicKey: string) {
  const page = await horizon().offers().forAccount(publicKey).limit(200).call();
  return page.records;
}

function assetFromOffer(side: Horizon.ServerApi.OfferRecord["selling"]) {
  return side.asset_type === "native" ? Asset.native() : new Asset(side.asset_code!, side.asset_issuer!);
}

// Deleting a stored offer means re-submitting it with amount 0 and the same asset pair.
export function cancelOfferOps(offers: Horizon.ServerApi.OfferRecord[]) {
  return offers.map((offer) =>
    Operation.manageSellOffer({
      selling: assetFromOffer(offer.selling),
      buying: assetFromOffer(offer.buying),
      amount: "0",
      price: offer.price_r,
      offerId: offer.id,
    }),
  );
}

export async function cancelAllOffers(keypair: Keypair) {
  const offers = await openOffers(keypair.publicKey());
  if (offers.length === 0) return null;
  const tx = await build(keypair.publicKey(), cancelOfferOps(offers));
  return submitSponsored(tx, [keypair]);
}

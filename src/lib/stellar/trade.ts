import { Asset, type Keypair, Memo, Operation, type xdr } from "@stellar/stellar-sdk";
import type { BaseAsset } from "../assets";
import { trustlineOps } from "./accounts";
import { amount7, type AssetCode, assetFor, horizon, treasuryKeypair, usdc } from "./config";
import { build, submitSponsored } from "./submit";

export type SwapQuote = {
  sendAsset: AssetCode;
  sendAmount: number;
  destAsset: AssetCode;
  expectedAmount: number;
  destMin: number;
  price: number;
  hops: string[];
};

// Stellar's own path-finding: routes across SDEX order books and AMM liquidity pools.
async function bestPath(from: AssetCode, to: AssetCode, sendAmount: number) {
  const { records } = await horizon().strictSendPaths(assetFor(from), amount7(sendAmount), [assetFor(to)]).call();
  const best = records.sort((a, b) => Number(b.destination_amount) - Number(a.destination_amount))[0];
  if (!best) throw new Error(`No route found to swap ${from} → ${to} right now.`);
  return {
    destinationAmount: Number(best.destination_amount),
    path: best.path.map((p) => (p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code!, p.asset_issuer!))),
  };
}

/**
 * Builds and submits a fee-bumped transaction, first opening any trustline the account needs to
 * receive `receives` (sponsored by the treasury, which then co-signs).
 */
async function submitWithTrust(keypair: Keypair, receives: AssetCode[], ops: xdr.Operation[], memo?: Memo) {
  const trust = await trustlineOps(receives.map((code) => ({ publicKey: keypair.publicKey(), code })));
  const tx = await build(keypair.publicKey(), [...trust, ...ops], memo);
  return submitSponsored(tx, trust.length ? [keypair, treasuryKeypair()] : [keypair]);
}

export async function quoteSwap(
  from: AssetCode,
  to: AssetCode,
  sendAmount: number,
  slippageBps: number,
): Promise<SwapQuote> {
  const { destinationAmount, path } = await bestPath(from, to, sendAmount);
  return {
    sendAsset: from,
    sendAmount,
    destAsset: to,
    expectedAmount: destinationAmount,
    destMin: destinationAmount * (1 - slippageBps / 10_000),
    price: destinationAmount / sendAmount,
    hops: path.map((asset) => asset.getCode()),
  };
}

// A swap is a path payment to yourself; destMin enforces slippage on-chain.
export async function executeSwap(keypair: Keypair, quote: SwapQuote) {
  // Fresh route at execution time; the destMin the user agreed to still bounds the price.
  const { path } = await bestPath(quote.sendAsset, quote.destAsset, quote.sendAmount);
  return submitWithTrust(keypair, [quote.destAsset], [
    Operation.pathPaymentStrictSend({
      sendAsset: assetFor(quote.sendAsset),
      sendAmount: amount7(quote.sendAmount),
      destination: keypair.publicKey(),
      destAsset: assetFor(quote.destAsset),
      destMin: amount7(quote.destMin),
      path,
    }),
  ]);
}

/**
 * Limit order on a BASE/USDC book. Both sides are stored as sell offers so a single cancel path
 * works for everything: buying BASE = selling USDC at the inverse price.
 */
export async function placeLimitOrder(keypair: Keypair, base: BaseAsset, side: "buy" | "sell", amount: number, priceUsdc: number) {
  const op =
    side === "sell"
      ? Operation.manageSellOffer({ selling: assetFor(base), buying: usdc(), amount: amount7(amount), price: priceUsdc.toFixed(7) })
      : Operation.manageSellOffer({
          selling: usdc(),
          buying: assetFor(base),
          amount: amount7(amount * priceUsdc),
          price: (1 / priceUsdc).toFixed(7),
        });
  // A resting buy needs the trustline before it can fill.
  return submitWithTrust(keypair, side === "buy" ? [base] : [], [op]);
}

export async function sendPayment(
  keypair: Keypair,
  destination: string,
  asset: AssetCode,
  amount: number,
  options: { deliverAsset?: AssetCode; slippageBps?: number; memo?: string; recipient?: Keypair } = {},
) {
  const memo = options.memo ? Memo.text(options.memo.slice(0, 28)) : undefined;
  const delivered = options.deliverAsset ?? asset;
  // Payments between a user's own wallets can open the receiving trustline too.
  const trust = options.recipient ? await trustlineOps([{ publicKey: destination, code: delivered }]) : [];
  const signers = trust.length ? [keypair, options.recipient!, treasuryKeypair()] : [keypair];

  if (delivered === asset) {
    const tx = await build(keypair.publicKey(), [...trust, Operation.payment({ destination, asset: assetFor(asset), amount: amount7(amount) })], memo);
    return submitSponsored(tx, signers);
  }
  // Cross-currency: send `asset`, recipient receives `deliverAsset`.
  const { destinationAmount, path } = await bestPath(asset, delivered, amount);
  const destMin = destinationAmount * (1 - (options.slippageBps ?? 100) / 10_000);
  const tx = await build(
    keypair.publicKey(),
    [
      ...trust,
      Operation.pathPaymentStrictSend({
        sendAsset: assetFor(asset),
        sendAmount: amount7(amount),
        destination,
        destAsset: assetFor(delivered),
        destMin: amount7(destMin),
        path,
      }),
    ],
    memo,
  );
  return submitSponsored(tx, signers);
}

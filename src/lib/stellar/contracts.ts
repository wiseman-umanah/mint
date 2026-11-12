// MINT's Soroban contracts (contracts/ in the repo root) as seen from the app.
//
//   price-feed          SEP-40 oracle; the worker publishes mainnet reference prices to it
//   recurring-payments  pull-payment schedules (PRD §4.4)
//   guardrail-vault     one per user: on-chain hard caps for the autonomous agent
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { ASSET_CODES, type AssetCode } from "../assets";
import { env } from "../env";
import { assetFor, NETWORK_PASSPHRASE } from "./config";
import { call, invoke } from "./soroban";

/** Oracle prices carry 14 decimals, like Reflector's. */
export const ORACLE_DECIMALS = 14;

/** Stellar Asset Contract address of the testnet asset MINT trades as `code`. */
export const sacId = (code: AssetCode) => assetFor(code).contractId(NETWORK_PASSPHRASE);

const enumVariant = (name: string, value: xdr.ScVal) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), value]);

/** SEP-40 `Asset::Stellar(address)`. */
export const stellarAsset = (contractId: string) => enumVariant("Stellar", new Address(contractId).toScVal());

/**
 * SEP-40 `Asset::Other(symbol)`. MINT keys prices by ticker so a vault can later point at
 * Reflector's external-price feed, which uses the same keys.
 */
export const oracleAsset = (code: AssetCode) => enumVariant("Other", xdr.ScVal.scvSymbol(code));

// 10 decimal places survive the float (prices up to ~900k stay below 2^53), then scale to 14.
const toFixed = (price: number) => BigInt(Math.round(price * 1e10)) * BigInt(10 ** (ORACLE_DECIMALS - 10));

/** Publishes USD prices (USDC = 1) to the price feed. Skips assets without a price. */
export async function publishPrices(prices: Partial<Record<AssetCode, number>>) {
  const feed = env.priceFeedContractId;
  if (!feed) throw new Error("PRICE_FEED_CONTRACT_ID is not set — run pnpm contracts:deploy");
  const updates = ASSET_CODES.filter((code) => code !== "USDC" && (prices[code] ?? 0) > 0).map((code) =>
    xdr.ScVal.scvVec([oracleAsset(code), nativeToScVal(toFixed(prices[code]!), { type: "i128" })]),
  );
  if (updates.length === 0) return null;
  return invoke(call(feed, "set_prices", [xdr.ScVal.scvVec(updates)]));
}

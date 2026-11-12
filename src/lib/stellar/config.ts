import { Asset, Horizon, Keypair, Networks } from "@stellar/stellar-sdk";
import { ASSETS, type AssetCode } from "../assets";
import { env } from "../env";

export type { AssetCode } from "../assets";

export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const EXPLORER = "https://testnet.stellarchain.io";

let testnet: Horizon.Server | null = null;
let mainnet: Horizon.Server | null = null;

// Trading, payments and accounts live on testnet.
export function horizon() {
  testnet ??= new Horizon.Server(env.horizonUrl);
  return testnet;
}

// Read-only: real market prices for analysis and valuation.
export function mainnetHorizon() {
  mainnet ??= new Horizon.Server(env.mainnetHorizonUrl);
  return mainnet;
}

export const XLM = Asset.native();
export const usdc = () => new Asset("USDC", env.usdcIssuer);
export const mainnetUsdc = () => new Asset("USDC", env.mainnetUsdcIssuer);

/** MINT's testnet issuer, which issues the testnet copies of BTC, ETH, EURC and the rest. */
export function issuerPublicKey() {
  if (!process.env.ISSUER_SECRET) throw new Error("ISSUER_SECRET is not set — run pnpm stellar:bootstrap to create MINT's testnet issuer.");
  return Keypair.fromSecret(env.issuerSecret).publicKey();
}

export function issuerKeypair() {
  return Keypair.fromSecret(env.issuerSecret);
}

/** The asset as it exists on testnet, where MINT trades. */
export function assetFor(code: AssetCode): Asset {
  if (code === "XLM") return XLM;
  if (code === "USDC") return usdc();
  return new Asset(code, issuerPublicKey());
}

/** The real asset on mainnet, used only for prices and analysis. */
export function mainnetAssetFor(code: AssetCode): Asset {
  const issuer = ASSETS[code].mainnetIssuer;
  return issuer ? new Asset(code, issuer) : XLM;
}

/** Which of our codes a Horizon asset line refers to, or null if it isn't one of MINT's assets. */
export function codeOf(line: { asset_type: string; asset_code?: string; asset_issuer?: string }): AssetCode | null {
  if (line.asset_type === "native") return "XLM";
  if (line.asset_code === "USDC" && line.asset_issuer === env.usdcIssuer) return "USDC";
  const code = line.asset_code as AssetCode | undefined;
  if (code && code in ASSETS && process.env.ISSUER_SECRET && line.asset_issuer === issuerPublicKey()) return code;
  return null;
}

export function treasuryKeypair() {
  return Keypair.fromSecret(env.treasurySecret);
}

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const accountUrl = (publicKey: string) => `${EXPLORER}/account/${publicKey}`;

// Stellar amounts carry 7 decimal places.
export const amount7 = (n: number) => (Math.floor(n * 1e7) / 1e7).toFixed(7);

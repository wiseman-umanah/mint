// The markets MINT trades. Plain data, safe to import from client components.
//
// Analysis reads each asset's real mainnet market. Trades settle on testnet, where XLM is native,
// USDC is Circle's testnet USDC, and every other asset is a testnet copy issued by MINT's issuer
// account (pnpm stellar:bootstrap) and quoted by the market maker around the mainnet price.

export const ASSET_CODES = ["XLM", "USDC", "BTC", "ETH", "EURC", "AQUA", "yXLM", "CETES", "USTRY"] as const;
export type AssetCode = (typeof ASSET_CODES)[number];

export type AssetInfo = {
  name: string;
  group: "Major coins" | "Stablecoins and FX" | "Stellar ecosystem" | "Real-world assets";
  // Mainnet issuer of the real asset; null for native XLM.
  mainnetIssuer: string | null;
  about: string;
};

export const ASSETS: Record<AssetCode, AssetInfo> = {
  XLM: { name: "Stellar Lumens", group: "Major coins", mainnetIssuer: null, about: "Stellar's native asset, used for fees and reserves." },
  USDC: {
    name: "USD Coin",
    group: "Stablecoins and FX",
    mainnetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    about: "Circle's dollar stablecoin; the quote currency of every MINT market.",
  },
  BTC: {
    name: "Bitcoin",
    group: "Major coins",
    mainnetIssuer: "GDPJALI4AZKUU2W426U5WKMAT6CN3AJRPIIRYR2YM54TL2GDWO5O2MZM",
    about: "Bitcoin as a Stellar token, backed by an anchor that holds the real coins.",
  },
  ETH: {
    name: "Ether",
    group: "Major coins",
    mainnetIssuer: "GBFXOHVAS43OIWNIO7XLRJAHT3BICFEIKOJLZVXNT572MISM4CMGSOCC",
    about: "Ether as a Stellar token, backed by an anchor that holds the real coins.",
  },
  EURC: {
    name: "Euro Coin",
    group: "Stablecoins and FX",
    mainnetIssuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
    about: "Circle's euro stablecoin; EURC/USDC tracks the euro against the dollar.",
  },
  AQUA: {
    name: "Aquarius",
    group: "Stellar ecosystem",
    mainnetIssuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
    about: "Governance and rewards token of Aquarius, Stellar's liquidity incentive layer.",
  },
  yXLM: {
    name: "Yield XLM",
    group: "Stellar ecosystem",
    mainnetIssuer: "GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55",
    about: "XLM wrapped by Ultra Stellar to earn yield; trades close to 1 XLM.",
  },
  CETES: {
    name: "CETES",
    group: "Real-world assets",
    mainnetIssuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC",
    about: "Tokenized Mexican government bonds (Etherfuse); price accrues the bond yield.",
  },
  USTRY: {
    name: "US Treasury",
    group: "Real-world assets",
    mainnetIssuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC",
    about: "Tokenized US Treasury bills (Etherfuse); price accrues the bill yield.",
  },
};

/** Every asset MINT trades against USDC. */
export const BASE_ASSETS = ASSET_CODES.filter((code): code is Exclude<AssetCode, "USDC"> => code !== "USDC");
export type BaseAsset = (typeof BASE_ASSETS)[number];

/** Assets that are MINT-issued testnet copies (everything except native XLM and Circle's USDC). */
export const ISSUED_ASSETS = ASSET_CODES.filter((code) => code !== "XLM" && code !== "USDC");

export const isAssetCode = (value: string): value is AssetCode => (ASSET_CODES as readonly string[]).includes(value);
export const isBaseAsset = (value: string): value is BaseAsset => isAssetCode(value) && value !== "USDC";

/** URL slug of a market: BTC → "BTC-USDC". */
export const pairSlug = (base: BaseAsset) => `${base}-USDC`;
export function baseFromSlug(slug: string): BaseAsset | null {
  const [base, quote] = decodeURIComponent(slug).split("-");
  return quote === "USDC" && isBaseAsset(base) ? base : null;
}

/** Decimal places for a USDC price: BTC at 74,000 needs 2, AQUA at 0.00025 needs 7. */
export function priceDigits(price: number) {
  if (price >= 1000) return 2;
  if (price >= 1) return 4;
  if (price >= 0.01) return 5;
  return 7;
}

/** Decimal places for an amount of an asset, so 0.0004 BTC doesn't round to zero. */
export function amountDigits(code: AssetCode) {
  return code === "BTC" || code === "ETH" ? 6 : code === "AQUA" ? 0 : 2;
}

import { ASSETS, type AssetCode, type BaseAsset } from "./assets";
import { assetFor, horizon, mainnetHorizon, usdc } from "./stellar/config";
import { marketSnapshot } from "./stellar/market";

const round = (n: number, dp = 6) => Number(n.toFixed(dp));

/**
 * Walks the testnet order book to price a market order of `amountUsd`: the average fill, slippage
 * from the best price and from the mainnet price, and how much the book can absorb.
 */
export async function checkLiquidity(base: BaseAsset, side: "buy" | "sell", amountUsd: number) {
  const [book, market] = await Promise.all([horizon().orderbook(assetFor(base), usdc()).limit(50).call(), marketSnapshot(base)]);
  // Buying walks the asks; selling walks the bids (bid amounts are quoted in USDC).
  const levels =
    side === "buy"
      ? book.asks.map((l) => ({ price: Number(l.price), usd: Number(l.amount) * Number(l.price) }))
      : book.bids.map((l) => ({ price: Number(l.price), usd: Number(l.amount) }));
  let usdLeft = amountUsd;
  let units = 0;
  for (const level of levels) {
    if (usdLeft <= 0) break;
    const take = Math.min(usdLeft, level.usd);
    units += take / level.price;
    usdLeft -= take;
  }
  const filledUsd = amountUsd - usdLeft;
  const best = levels[0]?.price ?? null;
  const average = units ? filledUsd / units : null;
  const mid = market.reference.mid;
  const cost = (from: number | null) => (average && from ? round(((side === "buy" ? average - from : from - average) / from) * 10_000, 1) : null);
  return {
    pair: `${base}/USDC`,
    side,
    requested_usd: amountUsd,
    fillable_usd: round(filledUsd, 2),
    fully_fillable: usdLeft <= 0.005,
    average_price: average && round(average),
    best_price: best,
    slippage_from_best_bps: cost(best),
    cost_vs_mainnet_bps: cost(mid),
    levels_in_book: levels.length,
    note: "Positive bps means you pay more (buy) or receive less (sell) than the reference.",
  };
}

const FLAG_NOTES = {
  auth_required: "the issuer must approve every holder",
  auth_revocable: "the issuer can freeze holdings",
  auth_clawback_enabled: "the issuer can claw tokens back",
  auth_immutable: "these settings can never change",
} as const;

async function fetchToml(domain: string) {
  try {
    const response = await fetch(`https://${domain}/.well-known/stellar.toml`, { signal: AbortSignal.timeout(10_000) });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

const tomlValue = (text: string, key: string) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? null;

/** The [[CURRENCIES]] block in a stellar.toml that describes this code and issuer. */
function currencyBlock(text: string, code: string, issuer: string) {
  return text.split(/\[\[CURRENCIES\]\]/).slice(1).map((block) => block.split(/^\s*\[/m)[0]).find((block) => tomlValue(block, "code") === code && tomlValue(block, "issuer") === issuer) ?? null;
}

/** Issuer due diligence from mainnet: who stands behind the token and what they can do to holders. */
export async function checkIssuer(code: AssetCode) {
  const info = ASSETS[code];
  if (!info.mainnetIssuer) {
    return { asset: code, native: true, note: "XLM is Stellar's native asset. No issuer, no counterparty risk beyond the network itself." };
  }
  const issuer = info.mainnetIssuer;
  const [account, assets] = await Promise.all([
    mainnetHorizon().loadAccount(issuer),
    mainnetHorizon().assets().forCode(code).forIssuer(issuer).call(),
  ]);
  const stats = assets.records[0];
  const domain = account.home_domain ?? null;
  const toml = domain ? await fetchToml(domain) : null;
  const currency = toml ? currencyBlock(toml, code, issuer) : null;
  const flags = Object.entries(FLAG_NOTES)
    .filter(([flag]) => account.flags[flag as keyof typeof account.flags])
    .map(([, note]) => note);

  return {
    asset: code,
    name: info.name,
    about: info.about,
    mainnet_issuer: issuer,
    home_domain: domain,
    organisation: toml ? tomlValue(toml, "ORG_NAME") : null,
    toml_found: Boolean(toml),
    toml_lists_this_asset: Boolean(currency),
    anchored: currency ? tomlValue(currency, "is_asset_anchored") ?? currency.match(/is_asset_anchored\s*=\s*(true|false)/)?.[1] ?? null : null,
    anchor_asset: currency ? tomlValue(currency, "anchor_asset") : null,
    description: currency ? tomlValue(currency, "desc") : null,
    issuer_powers: flags.length ? flags : ["none: holders can't be frozen or clawed back"],
    holders: stats ? stats.accounts.authorized : null,
    supply: stats ? Number(stats.balances.authorized) : null,
    testnet_note: "On testnet, MINT trades its own copy of this asset, issued by MINT and quoted around the mainnet price.",
  };
}

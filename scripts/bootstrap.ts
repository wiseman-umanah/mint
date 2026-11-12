/**
 * One-time (and re-runnable) testnet setup:
 *   - creates the treasury and market-maker accounts with Friendbot, saves secrets to .env.local
 *   - adds Circle testnet USDC trustlines
 *   - tops up XLM by merging extra Friendbot accounts into the treasury
 *   - buys USDC inventory on the testnet SDEX for the faucet and the market maker
 *   - creates MINT's issuer for the testnet copies (BTC, ETH, EURC, AQUA, yXLM, CETES, USTRY) and
 *     opens the market maker's trustlines to them; the worker mints inventory as it quotes
 *
 *   pnpm stellar:bootstrap
 */
import { Keypair, Operation } from "@stellar/stellar-sdk";
import { ISSUED_ASSETS } from "../src/lib/assets";
import { hasTrustline, readBalances, loadAccountOrNull } from "../src/lib/stellar/accounts";
import { amount7, assetFor, horizon, usdc, XLM } from "../src/lib/stellar/config";
import { build, submitSigned } from "../src/lib/stellar/submit";
import { ENV_FILE, saveEnv } from "./env-file";

// The market maker splits its USDC across the bid side of all eight markets.
const TARGET_USDC = { TREASURY_SECRET: 1500, MARKET_MAKER_SECRET: 1200, ISSUER_SECRET: 0 } as const;
const XLM_FLOOR = 2500;

async function friendbot(publicKey: string) {
  await horizon().friendbot(publicKey).call();
}

async function ensureAccount(name: keyof typeof TARGET_USDC) {
  let secret = process.env[name];
  if (!secret) {
    secret = Keypair.random().secret();
    saveEnv(name, secret);
    console.log(`• generated ${name} and saved it to ${ENV_FILE}`);
  }
  const keypair = Keypair.fromSecret(secret);
  if (!(await loadAccountOrNull(keypair.publicKey()))) {
    await friendbot(keypair.publicKey());
    console.log(`• funded ${name} (${keypair.publicKey()}) with Friendbot`);
  }
  return keypair;
}

async function ensureTrustline(keypair: Keypair) {
  const account = await horizon().loadAccount(keypair.publicKey());
  const has = account.balances.some((b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === usdc().getIssuer());
  if (has) return;
  await submitSigned(await build(keypair.publicKey(), [Operation.changeTrust({ asset: usdc() })]), [keypair]);
  console.log(`• added USDC trustline for ${keypair.publicKey().slice(0, 6)}…`);
}

// Friendbot gives 10k XLM per new account; merging donors in tops the target up.
async function topUpXlm(keypair: Keypair, donors: number) {
  for (let i = 0; i < donors; i++) {
    const donor = Keypair.random();
    await friendbot(donor.publicKey());
    const tx = await build(donor.publicKey(), [Operation.accountMerge({ destination: keypair.publicKey() })]);
    await submitSigned(tx, [donor]);
  }
  if (donors) console.log(`• merged ${donors} Friendbot account(s) into ${keypair.publicKey().slice(0, 6)}…`);
}

async function buyUsdc(keypair: Keypair, wantUsdc: number) {
  const { USDC, spendableXLM } = readBalances(await horizon().loadAccount(keypair.publicKey()));
  const missing = wantUsdc - USDC;
  if (missing <= 1) return console.log(`• ${keypair.publicKey().slice(0, 6)}… already holds ${USDC.toFixed(2)} USDC`);

  // Ask the network how much XLM it costs to receive the missing USDC.
  const { records } = await horizon().strictReceivePaths([XLM], usdc(), amount7(missing)).call();
  const best = records.sort((a, b) => Number(a.source_amount) - Number(b.source_amount))[0];
  if (!best) return console.warn("! no XLM→USDC liquidity on testnet right now — use https://faucet.circle.com instead");
  const cost = Number(best.source_amount);
  if (cost > spendableXLM - XLM_FLOOR) {
    return console.warn(`! buying ${missing.toFixed(0)} USDC would cost ${cost.toFixed(0)} XLM — not enough XLM; re-run later or use faucet.circle.com`);
  }
  const tx = await build(keypair.publicKey(), [
    Operation.pathPaymentStrictReceive({
      sendAsset: XLM,
      sendMax: amount7(cost * 1.02),
      destination: keypair.publicKey(),
      destAsset: usdc(),
      destAmount: amount7(missing),
      path: [],
    }),
  ]);
  await submitSigned(tx, [keypair]);
  console.log(`• bought ${missing.toFixed(2)} USDC for ~${cost.toFixed(0)} XLM`);
}

// The issuer's own account can't hold its assets, so only the maker needs trustlines to the copies.
async function ensureCopyTrustlines(maker: Keypair) {
  const account = await horizon().loadAccount(maker.publicKey());
  const missing = ISSUED_ASSETS.filter((code) => !hasTrustline(account, code));
  if (missing.length === 0) return;
  const ops = missing.map((code) => Operation.changeTrust({ asset: assetFor(code) }));
  await submitSigned(await build(maker.publicKey(), ops), [maker]);
  console.log(`• market maker now trusts ${missing.join(", ")} from the MINT issuer`);
}

async function main() {
  const treasury = await ensureAccount("TREASURY_SECRET");
  const maker = await ensureAccount("MARKET_MAKER_SECRET");
  const issuer = await ensureAccount("ISSUER_SECRET");
  await ensureTrustline(treasury);
  await ensureTrustline(maker);
  await ensureCopyTrustlines(maker);

  const treasuryXlm = readBalances(await horizon().loadAccount(treasury.publicKey())).XLM;
  await topUpXlm(treasury, treasuryXlm < 25_000 ? 2 : 0);
  const makerXlm = readBalances(await horizon().loadAccount(maker.publicKey())).XLM;
  await topUpXlm(maker, makerXlm < 15_000 ? 1 : 0);

  await buyUsdc(treasury, TARGET_USDC.TREASURY_SECRET);
  await buyUsdc(maker, TARGET_USDC.MARKET_MAKER_SECRET);

  console.log(`Issuer        ${issuer.publicKey()}  (testnet copies of ${ISSUED_ASSETS.join(", ")})`);
  for (const [label, kp] of [["Treasury", treasury], ["Market maker", maker]] as const) {
    const b = readBalances(await horizon().loadAccount(kp.publicKey()));
    console.log(`${label.padEnd(13)} ${kp.publicKey()}  ${b.XLM.toFixed(0)} XLM  ${b.USDC.toFixed(2)} USDC`);
  }
}

main().catch((error) => {
  console.error(error?.response?.data?.extras?.result_codes ?? error);
  process.exit(1);
});

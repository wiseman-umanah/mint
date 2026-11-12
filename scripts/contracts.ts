/**
 * Deploys MINT's Soroban contracts to testnet (re-runnable; skips what already exists):
 *   - wraps USDC and MINT's testnet copies in Stellar Asset Contracts so contracts can move them
 *   - uploads the price-feed, recurring-payments and guardrail-vault wasm
 *   - deploys the price feed (admin: treasury, base: USDC, 14 decimals) and publishes prices once
 *   - deploys the recurring-payments contract
 *   - saves contract ids and the vault wasm hash to .env.local (vaults are deployed per user)
 *
 * Testnet is wiped periodically (next: 2026-12-16); after a reset, clear the ids and re-run.
 *
 *   pnpm contracts:build && pnpm contracts:deploy
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Address, nativeToScVal, Operation } from "@stellar/stellar-sdk";
import { ASSET_CODES, type AssetCode } from "../src/lib/assets";
import { env } from "../src/lib/env";
import { assetFor, treasuryKeypair } from "../src/lib/stellar/config";
import { ORACLE_DECIMALS, publishPrices, sacId, stellarAsset } from "../src/lib/stellar/contracts";
import { referencePrices } from "../src/lib/stellar/market";
import { contractExists, invoke, wasmUploaded } from "../src/lib/stellar/soroban";
import { saveEnv } from "./env-file";

const WASM_DIR = "contracts/target/wasm32v1-none/release";
const CONTRACTS = ["price_feed", "recurring_payments", "guardrail_vault"] as const;
// The feed expects a fresh price every 5 minutes.
const FEED_RESOLUTION = 300;

function readWasm(name: (typeof CONTRACTS)[number]) {
  const path = `${WASM_DIR}/${name}.wasm`;
  if (!existsSync(path)) throw new Error(`${path} not found — run pnpm contracts:build first`);
  const wasm = readFileSync(path);
  return { wasm, hash: createHash("sha256").update(wasm).digest("hex") };
}

async function ensureSac(code: AssetCode) {
  const id = sacId(code);
  if (await contractExists(id)) return id;
  await invoke(Operation.createStellarAssetContract({ asset: assetFor(code) }));
  console.log(`• wrapped ${code} in its Stellar Asset Contract ${id}`);
  return id;
}

async function upload(name: (typeof CONTRACTS)[number]) {
  const { wasm, hash } = readWasm(name);
  if (!(await wasmUploaded(hash))) {
    await invoke(Operation.uploadContractWasm({ wasm }));
    console.log(`• uploaded ${name}.wasm (${(wasm.length / 1024).toFixed(1)} KB, ${hash.slice(0, 12)}…)`);
  }
  return hash;
}

async function deploy(envName: string, label: string, wasmHash: string, constructorArgs: Parameters<typeof Operation.createCustomContract>[0]["constructorArgs"] = []) {
  const existing = process.env[envName];
  if (existing && (await contractExists(existing))) {
    console.log(`• ${label} already deployed at ${existing}`);
    return existing;
  }
  const { value } = await invoke<string>(
    Operation.createCustomContract({
      address: new Address(treasuryKeypair().publicKey()),
      wasmHash: Buffer.from(wasmHash, "hex"),
      salt: randomBytes(32),
      constructorArgs,
    }),
  );
  saveEnv(envName, value);
  console.log(`• deployed ${label} at ${value}`);
  return value;
}

async function main() {
  for (const name of CONTRACTS) readWasm(name); // fail before touching the network
  const treasury = treasuryKeypair().publicKey();
  console.log(`Deployer/admin: treasury ${treasury}\nRPC: ${env.rpcUrl}\n`);

  const sacs = {} as Record<AssetCode, string>;
  for (const code of ASSET_CODES) sacs[code] = await ensureSac(code);

  const hashes = {} as Record<(typeof CONTRACTS)[number], string>;
  for (const name of CONTRACTS) hashes[name] = await upload(name);

  await deploy("PRICE_FEED_CONTRACT_ID", "price feed", hashes.price_feed, [
    new Address(treasury).toScVal(),
    stellarAsset(sacs.USDC),
    nativeToScVal(ORACLE_DECIMALS, { type: "u32" }),
    nativeToScVal(FEED_RESOLUTION, { type: "u32" }),
  ]);
  await deploy("RECURRING_PAYMENTS_CONTRACT_ID", "recurring payments", hashes.recurring_payments);

  if (process.env.GUARDRAIL_VAULT_WASM_HASH !== hashes.guardrail_vault) {
    saveEnv("GUARDRAIL_VAULT_WASM_HASH", hashes.guardrail_vault);
    console.log(`• guardrail vault wasm ${hashes.guardrail_vault.slice(0, 12)}… saved (deployed per user)`);
  }

  const prices = await referencePrices();
  const published = await publishPrices(prices);
  console.log(published ? `• published ${Object.keys(prices).length - 1} prices (tx ${published.hash.slice(0, 10)}…)` : "! no prices to publish");

  console.log("\nAsset contracts:");
  for (const code of ASSET_CODES) console.log(`  ${code.padEnd(6)} ${sacs[code]}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

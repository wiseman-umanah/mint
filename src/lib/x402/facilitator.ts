import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { createEd25519Signer, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { env } from "../env";
import { treasuryKeypair } from "../stellar/config";

/*
 * x402 on Stellar: the buyer signs only a Soroban authorisation for one USDC transfer; a
 * facilitator checks it, wraps it in a transaction, pays the fee and submits it. MINT settles
 * through the configured public facilitator and falls back to one running in this process (fees
 * paid by the treasury), so a third party being down never stops a payment.
 */
export const X402_NETWORK = "stellar:testnet" as const;
export const X402_USDC = USDC_TESTNET_ADDRESS;
// USDC has 7 decimals on Stellar.
export const toAtomic = (usd: number) => String(Math.round(usd * 1e7));
export const fromAtomic = (amount: string) => Number(amount) / 1e7;

export function requirementsFor(priceUsd: number): PaymentRequirements {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    asset: X402_USDC,
    amount: toAtomic(priceUsd),
    payTo: treasuryKeypair().publicKey(),
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
}

type Facilitator = { verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse>; settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> };

let local: Facilitator | null = null;
function localFacilitator(): Facilitator {
  local ??= new x402Facilitator().register(
    X402_NETWORK,
    new ExactStellarScheme([createEd25519Signer(env.treasurySecret, X402_NETWORK)], { rpcConfig: { url: env.rpcUrl } }),
  );
  return local;
}

let remote: Facilitator | null = null;
function remoteFacilitator(): Facilitator | null {
  if (!env.x402FacilitatorUrl) return null;
  remote ??= new HTTPFacilitatorClient({ url: env.x402FacilitatorUrl, timeoutMs: 45_000 });
  return remote;
}

/** Verifies with the public facilitator; if it can't be reached, with the local one. */
export async function verifyPayment(payload: PaymentPayload, requirements: PaymentRequirements) {
  const via = remoteFacilitator();
  if (via) {
    try {
      return { ...(await via.verify(payload, requirements)), facilitator: env.x402FacilitatorUrl! };
    } catch (error) {
      console.warn(`[mint] x402 facilitator ${env.x402FacilitatorUrl} failed to verify, using the local one:`, error instanceof Error ? error.message : error);
    }
  }
  return { ...(await localFacilitator().verify(payload, requirements)), facilitator: "local" };
}

/**
 * Settles on-chain. A signed authorisation can only be used once, so retrying through the local
 * facilitator after the public one errors can never charge the buyer twice.
 */
export async function settlePayment(payload: PaymentPayload, requirements: PaymentRequirements) {
  const via = remoteFacilitator();
  if (via) {
    try {
      const settled = await via.settle(payload, requirements);
      if (settled.success) return { ...settled, facilitator: env.x402FacilitatorUrl! };
      console.warn(`[mint] x402 facilitator ${env.x402FacilitatorUrl} could not settle (${settled.errorReason}), using the local one`);
    } catch (error) {
      console.warn(`[mint] x402 facilitator ${env.x402FacilitatorUrl} failed to settle, using the local one:`, error instanceof Error ? error.message : error);
    }
  }
  return { ...(await localFacilitator().settle(payload, requirements)), facilitator: "local" };
}

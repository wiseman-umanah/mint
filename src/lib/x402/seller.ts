import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { connection } from "next/server";
import { requirementsFor, settlePayment, verifyPayment } from "./facilitator";

/**
 * Puts an x402 paywall on a route. No payment header: answer 402 with the price. A signed payment:
 * verify it, run the handler, settle on Stellar, and return the data with the receipt.
 * The handler runs before settlement and the response is only sent if settlement succeeds.
 */
export function paywalled(options: { priceUsd: number; description: string }, handler: (request: Request) => Promise<unknown>) {
  return async (request: Request) => {
    await connection();
    const requirements = requirementsFor(options.priceUsd);
    const url = new URL(request.url);
    const required = (error?: string): PaymentRequired => ({
      x402Version: 2,
      error,
      resource: { url: `${url.origin}${url.pathname}`, description: options.description, mimeType: "application/json" },
      accepts: [requirements],
    });
    const demand = (error: string) =>
      Response.json(required(error), { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required(error)) } });

    const header = request.headers.get("PAYMENT-SIGNATURE");
    if (!header) return demand("Payment required");

    try {
      const payload = decodePaymentSignatureHeader(header);
      const verified = await verifyPayment(payload, requirements);
      if (!verified.isValid) return demand(verified.invalidMessage ?? verified.invalidReason ?? "Payment could not be verified");
      const body = await handler(request);
      const settled = await settlePayment(payload, requirements);
      if (!settled.success) return demand(settled.errorMessage ?? settled.errorReason ?? "Payment could not be settled");
      return Response.json(body, { headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) } });
    } catch (error) {
      console.error("[mint] x402 payment failed", error);
      return demand("Payment could not be processed");
    }
  };
}

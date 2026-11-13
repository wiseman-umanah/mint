import { connection } from "next/server";
import { env } from "@/lib/env";
import { PAID_ENDPOINTS } from "@/lib/x402/catalog";
import { requirementsFor } from "@/lib/x402/facilitator";

// Free: what this server sells over x402 and how to pay for it.
export async function GET() {
  await connection();
  return Response.json({
    x402Version: 2,
    facilitator: env.x402FacilitatorUrl ?? "in-process",
    resources: Object.values(PAID_ENDPOINTS).map((e) => ({
      url: `${env.appUrl}${e.path}`,
      name: e.name,
      description: e.description,
      price_usd: e.priceUsd,
      accepts: [requirementsFor(e.priceUsd)],
    })),
  });
}

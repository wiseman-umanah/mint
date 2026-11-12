import type { NextRequest } from "next/server";
import { ASSETS, ISSUED_ASSETS } from "@/lib/assets";
import { env } from "@/lib/env";
import { issuerPublicKey } from "@/lib/stellar/config";

// SEP-1: advertises the federation server and declares MINT's testnet asset copies.
export function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const issuer = process.env.ISSUER_SECRET ? issuerPublicKey() : null;
  const currencies = issuer
    ? ISSUED_ASSETS.map(
        (code) => `
[[CURRENCIES]]
code="${code}"
issuer="${issuer}"
name="${ASSETS[code].name} (MINT testnet copy)"
desc="Testnet stand-in for ${code}, quoted by MINT around the mainnet price. It has no value."
is_asset_anchored=false
status="test"
`,
      ).join("")
    : "";
  const body = `NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
FEDERATION_SERVER="${origin}/federation"

[DOCUMENTATION]
ORG_NAME="MINT"
ORG_DESCRIPTION="AI-guarded payments and trading on Stellar"

[[CURRENCIES]]
code="USDC"
issuer="${env.usdcIssuer}"
name="USD Coin (Circle testnet)"
status="test"
${currencies}`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}

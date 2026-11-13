// Read lazily so scripts and builds don't fail on variables they never use.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} — see .env.example`);
  return value;
}

export const env = {
  get walletEncryptionKey() {
    return required("WALLET_ENCRYPTION_KEY");
  },
  get sessionSecret() {
    return required("SESSION_SECRET");
  },
  get groqApiKey() {
    return required("GROQ_API_KEY");
  },
  get groqModel() {
    return process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  },
  get resendApiKey() {
    return process.env.RESEND_API_KEY || null;
  },
  /**
   * No real email: the code goes back to the browser, which types it in for you. On by default in
   * development; a production server (even `next start` locally) needs SIMULATE_EMAIL=true, because
   * it lets anyone sign in as any address.
   */
  get simulateEmail() {
    return !this.resendApiKey && (process.env.NODE_ENV !== "production" || process.env.SIMULATE_EMAIL === "true");
  },
  get emailFrom() {
    return process.env.EMAIL_FROM || "MINT <onboarding@resend.dev>";
  },
  get horizonUrl() {
    return process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";
  },
  get mainnetHorizonUrl() {
    return process.env.STELLAR_MAINNET_HORIZON_URL || "https://horizon.stellar.org";
  },
  get usdcIssuer() {
    return process.env.USDC_ISSUER || "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  },
  get mainnetUsdcIssuer() {
    return process.env.MAINNET_USDC_ISSUER || "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  },
  get issuerSecret() {
    return required("ISSUER_SECRET");
  },
  get treasurySecret() {
    return required("TREASURY_SECRET");
  },
  get marketMakerSecret() {
    return required("MARKET_MAKER_SECRET");
  },
  get rpcUrl() {
    return process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
  },
  /** Soroban contracts deployed by `pnpm contracts:deploy`; null until then. */
  get priceFeedContractId() {
    return process.env.PRICE_FEED_CONTRACT_ID || null;
  },
  get recurringPaymentsContractId() {
    return process.env.RECURRING_PAYMENTS_CONTRACT_ID || null;
  },
  get guardrailVaultWasmHash() {
    return process.env.GUARDRAIL_VAULT_WASM_HASH || null;
  },
  get soroswapRouterId() {
    return process.env.SOROSWAP_ROUTER_ID || "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
  },
  /** Where this app is reachable; the agent buys MINT's own paid feed from here by default. */
  get appUrl() {
    return process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${process.env.PORT || 3000}`);
  },
  /**
   * x402 facilitator that verifies and settles payments. Any facilitator speaking x402 v2 on
   * Stellar works (x402.org, OpenZeppelin, Vellar's on mainnet). "local" settles in-process.
   */
  get x402FacilitatorUrl() {
    const url = process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
    return url === "local" ? null : url;
  },
  /** Paid endpoints the agent may buy from, comma-separated. Defaults to MINT's own market feed. */
  get x402DataSources() {
    return (process.env.X402_DATA_SOURCES || `${this.appUrl}/api/x402/signals`).split(",").map((s) => s.trim()).filter(Boolean);
  },
  get federationDomain() {
    return process.env.FEDERATION_DOMAIN || "localhost:3000";
  },
};

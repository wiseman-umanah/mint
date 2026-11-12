# MINT — Market Intelligence & Network Transfers

AI-guarded payments and trading on Stellar. Email login, a platform-created wallet, Circle testnet
USDC, and an AI that proposes trades a deterministic guardrail engine must approve before anything
is signed. Market analysis reads **real mainnet** XLM/USDC prices; every transaction settles on
**testnet** and links to StellarChain.

## How it fits together

| Piece | Where | What it does |
|---|---|---|
| Web app | `src/app`, `src/components` | Next.js 16 (Cache Components on), Tailwind 4, black and white with HoverAi-style glass. Routes: `/assistant`, `/wallet/send` `/wallet/swap` `/wallet/receive`, `/trading`, `/vault`, `/agent`, `/guardrails`, `/activity` |
| Terminal | `src/components/terminal.tsx`, `chart.tsx` | TradingView Lightweight Charts (mainnet price or testnet fills, 5m to 1d), DEX order book, limit and market orders, open orders |
| Accounts | `src/lib/stellar/accounts.ts` | Two accounts per user: **main wallet** and **trading vault**. Reserves sponsored by the treasury (CAP-33); secrets AES-256-GCM encrypted at rest |
| Fees | `src/lib/stellar/submit.ts` | Every user transaction is fee-bumped by the treasury — users never hold XLM for gas |
| Markets | `src/lib/assets.ts`, `src/lib/stellar/market.ts` | XLM, BTC, ETH, EURC, AQUA, yXLM, CETES, USTRY against USDC. Analysis reads the real mainnet markets; trades settle on testnet, where every asset but XLM and USDC is a MINT-issued copy |
| Trading | `src/lib/stellar/trade.ts` | Any-to-any path-payment swaps (slippage enforced on-chain via `destMin`), SDEX limit orders on every pair, cancels, cross-currency payments. Missing trustlines open in the same transaction, sponsored by the treasury |
| Research | `src/lib/indicators.ts`, `src/lib/research.ts` | SMA, RSI, ATR, volatility, support and resistance; order-book liquidity checks; issuer due diligence from mainnet and the issuer's stellar.toml |
| Guardrails | `src/lib/guardrails.ts` | Capital cap, daily loss limit (rolling 24h, net of deposits), max trade size, max slippage, allowed assets, max per asset, agent scope, kill switch. Re-checked right before signing |
| Strategy | `src/lib/strategy.ts` | Deterministic ideas: testnet-vs-mainnet mispricing and trend-aware rebalancing. The LLM explains; it never invents trades |
| AI | `src/lib/ai` | Groq tool calling. Every money-moving tool only *stages* a proposal |
| Handles | `src/app/federation`, `.well-known/stellar.toml` | SEP-2 federation: anyone on Stellar can pay `alex*your-domain` |
| Worker | `src/lib/worker.ts` | Market maker quoting all eight pairs around the mainnet price (the issuer keeps it stocked with copies) + autonomous agent loop |

The Hard Capital Cap is structural: the agent can only sign for the vault, and the vault can only pay
out to its owner's main wallet. Loosening any guardrail or enabling autonomous mode needs a second
code sent to the user's email.

## Setup

```bash
pnpm install
cp .env.example .env.local
pnpm secrets                 # paste WALLET_ENCRYPTION_KEY and SESSION_SECRET into .env.local
pnpm stellar:bootstrap       # testnet treasury, market maker and asset issuer, secrets saved to .env.local
```

Then put your Groq key in `GROQ_API_KEY`. Without `RESEND_API_KEY`, email codes print in the server console.

### Local mode (default) — no external database

Leave `DATABASE_URL` empty. MINT runs **PGlite**, a real Postgres compiled to WASM, inside the Next
process, stored in `.data/pglite`. Migrations from `drizzle/` apply on startup.

```bash
pnpm dev                     # app + local database + market maker + agent, one process
pnpm db:reset                # wipe the local database (stop pnpm dev first)
pnpm db:studio               # browse it (stop pnpm dev first)
```

The embedded database can only be opened by one process, so in local mode the market maker and
agent run inside `pnpm dev` (set `MINT_EMBEDDED_WORKER=false` to turn them off) and `pnpm worker`
refuses to start.

### Neon mode

Set `DATABASE_URL` to your Neon pooled connection string, then:

```bash
pnpm db:migrate              # apply drizzle/ migrations to Neon
pnpm dev                     # the app
pnpm worker                  # market maker + agent (or --mm / --agent)
```

Schema changes: edit `src/lib/db/schema.ts`, run `pnpm db:generate`, commit the new file in `drizzle/`.
Both modes run the same migrations.

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm build`.

## Notes

- Testnet resets periodically — re-run `pnpm stellar:bootstrap` afterwards. Existing users keep their
  keys; the portfolio endpoint re-creates their accounts on-chain on next load.
- Wallets are custodial in this build. The production path is passkey smart wallets (Soroban) for the
  main wallet with a co-signed classic vault — see the PRD review notes.

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
| Agent | `src/lib/agent` | Rule-based and deterministic; the LLM explains, it never invents trades. Reads each market from mainnet hourly candles (regime, RSI, ATR), buys uptrends and oversold dips, sizes each trade to risk 1% of the vault, and gives every position a stop, target, trailing stop and time limit. Positions, a decision journal and the vault's value over time are stored and shown on `/agent` |
| x402 | `src/lib/x402`, `src/app/api/x402` | MINT sells its market read per request over [x402](https://www.x402.org) (`/api/x402/signals`, 0.01 USDC on testnet; catalog at `/api/x402`). Its own agent buys it from a separate budget wallet, behind per-request and daily caps |
| AI | `src/lib/ai` | Groq tool calling. Every money-moving tool only *stages* a proposal |
| Handles | `src/app/federation`, `.well-known/stellar.toml` | SEP-2 federation: anyone on Stellar can pay `alex*your-domain` |
| Worker | `src/lib/worker.ts` | Market maker quoting all eight pairs around the mainnet price (the issuer keeps it stocked with copies), the agent's check of every vault each minute, and the price feed |

The Hard Capital Cap is structural: the agent can only sign for the vault, and the vault can only pay
out to its owner's main wallet. Loosening any guardrail or enabling autonomous mode needs a second
code sent to the user's email.

## Run it with Docker (one command)

```bash
docker compose up
```

Open http://localhost:3000 and sign in with any email; no email is sent, the code types itself in.
The container holds the app, an embedded Postgres, the market maker and the trading agent.

- **Fresh machine, no setup:** the first start generates its secrets, creates its own Stellar
  testnet treasury, market maker and issuer with Friendbot (about two minutes), and keeps them
  with the database in the `mint-data` volume.
- **Chat assistant:** put `GROQ_API_KEY=...` in `.env.local` next to `docker-compose.yml` (free key
  at console.groq.com). Without it everything but the chat works.
- **Already bootstrapped?** Your `.env.local` is read, so the container reuses your testnet
  accounts. Don't run `pnpm worker` or `pnpm dev` against the same accounts at the same time: two
  market makers on one account cancel each other's quotes.
- `MINT_PORT=8080 docker compose up` changes the port. `docker compose down -v` wipes the volume.

## What a user sees the agent do

`/agent` is the answer to "it executed on-chain, but what is it doing with my money?":

- a heartbeat: when the agent last checked the vault and when it will next
- the vault's value over the last 24 hours, open positions against their stop and target, and
  closed trades with the reason each was closed
- its read of every market and what it is waiting for
- a decision journal: every buy, sell, block and change of mind, with the numbers behind it and
  the transaction on StellarChain

Fund the vault, switch to autonomous mode in Guardrails, and the agent opens its first position
within a minute if a market qualifies. In copilot mode the same trades wait for your confirmation.

## What happens if the agent is hijacked

Three layers, and a drill on `/agent` that attacks them live (nothing is signed):

1. **The agent can only stage actions the guardrail engine accepts.** Payments out of the vault,
   oversized trades and unlisted assets are refused in code, again right before signing.
2. **Trades are decided from prices, not text.** A prompt injected into market data or a memo
   changes nothing: the rules never read it.
3. **Money the agent spends on its own lives in a separate account.** Paying for data over x402
   needs a key with no human in the loop, so that key holds only a small budget (default $2), is
   capped per request and per day, may only pay listed sellers, and is not a signer on the vault
   or the main wallet. "Revoke" sends the balance back in one transaction.

This is the same model as a [Vellar](https://www.vellar.xyz) agent key (a scoped key with a
spending limit and a revoke), built from separate classic accounts so it works with email-login
wallets today. Payments follow the x402 v2 Stellar spec that Vellar's facilitator implements;
`X402_FACILITATOR_URL` selects the facilitator (x402.org by default, with an in-process fallback).
Vellar's hosted facilitator serves mainnet only, so it is the switch for a mainnet deploy. The
limits on the agent wallet are enforced by MINT's server; moving them on-chain means a Vellar
smart account with a spending-limit policy, which needs passkey wallets (see Notes).

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

# MINT demo script and judge answers

Everything below is real in this build. Trades and payments settle on Stellar testnet; market
analysis reads Stellar mainnet.

## One line

MINT is an AI that trades and pays for you on Stellar. It can suggest anything; only code can say yes.

## Five-minute demo

Start with `docker compose up` (or `pnpm dev` and `pnpm worker`). Have one account already funded
and running in autonomous mode for a while, so the Agent page has history.

1. **Sign in with an email.** No wallet to import, no seed phrase, no XLM for fees. The code types
   itself in because email is simulated; with a Resend key it arrives by email.
2. **Wallet → get test USDC → Vault → fund it.** The proposal card shows each guardrail check
   passing before anything is signed.
3. **Guardrails → Autonomous.** Loosening needs the email code. Point out that the agent cannot do
   this itself.
4. **Agent page.** This is the answer to "it executed on-chain, so what?":
   - the heartbeat counts down to the next check
   - within a minute the agent opens a position if a market qualifies; the journal says why, with
     the RSI and averages behind it, and links the transaction
   - the position shows its stop and target; the vault value chart moves
   - "What the agent sees" shows why it is *not* trading the other markets
5. **Run the hijack drill.** Six attacks against the live guardrails, each stopped, with the rule
   that stopped it.
6. **Agent wallet → give the agent a data budget.** Within the next check it pays 0.01 USDC over
   x402 for market data; show the transaction. Then press **Revoke**: the money comes back.
7. **Assistant.** Ask "what is the agent doing and why?" and "send 5 USDC to @someone".

If the market is quiet and no asset qualifies, say so: the agent holding USDC in a downtrend is
the rule working. "Ask for a trade" on the Agent page shows what it is waiting for.

## Questions judges ask

**It executed on-chain. Is that enough for a user?**
No, and that is what the Agent page is for. A user sees when the agent last looked, what it holds,
what each position is worth against its stop and target, and a journal of every decision in plain
words. The transaction link is the proof, not the product.

**What if the agent is hijacked?**
Three things bound the damage. The agent can only stage actions that pass the guardrail engine,
which is re-run right before signing: it cannot send vault money out, exceed the trade size, or buy
unlisted assets. Trades come from fixed rules over prices, so injected text cannot steer them. And
the only key that spends without a human, for buying data, sits in a separate account holding a
couple of dollars, capped per request and per day, revocable in one tap. The drill on the Agent
page runs these attacks live.

**How does Vellar come in?**
MINT speaks x402, the payment standard Vellar builds on: it sells its market intelligence per
request and its agent pays for data the same way, settled on Stellar by a facilitator. The agent
budget wallet copies Vellar's model of a scoped agent key with a spending limit and a revoke.
Today those limits are enforced by MINT's server on a separate classic account, because Vellar's
on-chain policies need passkey smart wallets and its hosted facilitator is mainnet-only. The next
step is a Vellar smart account for the agent budget so the limit is enforced on-chain.

**Where do trades come from? Is the AI picking them?**
No. Fixed rules: buy uptrends and oversold dips, stay out of downtrends and violent markets, risk
about 1% of the vault per trade, always with a stop, a target and a trailing stop. The language
model explains and takes requests; it never invents a trade.

**Is it real money?**
Testnet. Prices and analysis are real mainnet data; execution is on testnet, where every asset
except XLM and USDC is a MINT-issued copy quoted around the mainnet price. Profit and loss shown
is testnet profit and loss.

**Who holds the keys?**
MINT does in this build, encrypted with AES-256-GCM. The production path is passkey smart wallets.
The Soroban guardrail vault contract is written, tested and uploaded to testnet, but users' vaults
do not run on it yet; guardrails are enforced by the server and by the two-account structure.

## What is not built

- On-chain enforcement of trading guardrails (the vault contract is not wired in).
- Recurring payments in the app (the contract is deployed; there is no UI yet).
- Fiat on and off ramps.
- A backtest. The rules are standard, not proven profitable.

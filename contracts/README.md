# MINT Soroban contracts

| Contract | What it does |
|---|---|
| `guardrail-vault` | One per user. Holds the agent's trading capital and enforces the guardrails on-chain: the agent key can only `swap` (via a Soroswap-compatible router) and `halt`; `withdraw` only pays the owner; capital cap, max trade, oracle-bounded slippage, 24h loss floor, allowed assets, max per asset and a kill switch are checked by the contract. |
| `recurring-payments` | Pull-payment schedules over any SEP-41 token (PRD §4.4). The payer approves an allowance and signs `create`; MINT's worker calls `execute` when due; at most one payment per interval, missed periods are skipped. |
| `price-feed` | Minimal SEP-40 oracle (Reflector's interface). The worker publishes mainnet reference prices every 5 minutes; on mainnet a vault can point at Reflector instead. |

## Commands

```bash
pnpm contracts:test     # cargo test (no CLI needed)
pnpm contracts:build    # stellar contract build → contracts/target/wasm32v1-none/release/*.wasm
pnpm contracts:deploy   # wraps assets, uploads wasm, deploys feed + recurring payments, saves ids to .env.local
```

Requires Rust with the `wasm32v1-none` target and Stellar CLI ≥ 25.2 (soroban-sdk 28 refuses to
build a contract without it). Testnet is reset periodically (next: 2026-12-16): clear the
`*_CONTRACT_ID` lines in `.env.local` and re-run the deploy.

## Trust model

- **Owner key** (the user's main wallet): everything — withdraw, limits, router, oracle, upgrade.
- **Agent key**: swaps within the limits, or halt. A leaked agent key cannot move funds out.
- **Oracle**: trusted. On testnet it is MINT's own feed (admin: treasury); whoever controls it can
  mis-value the vault. Mainnet should use Reflector plus a sanity check against a second source.

"use client";

import Link from "next/link";
import { useState } from "react";
import { ASSETS, type AssetCode, BASE_ASSETS } from "@/lib/assets";
import { accountUrl, api, num, usd, useApi, useSimulatedAutofill } from "@/lib/client";
import type { PortfolioDTO } from "@/lib/types";
import { AssetSelect, FormShell, Segmented, SwapForm, useProposal } from "./forms";
import { OtherHoldings } from "./wallet";
import { GuardrailMeters, KillSwitch } from "./rail";
import { Badge, Card, CardHeader, cx, ErrorState, Field, Skeleton } from "./ui";

function PageHead({ title, body, aside }: { title: string; body: string; aside?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-[32px] leading-tight font-extrabold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-[60ch] text-ink-2">{body}</p>
      </div>
      {aside}
    </header>
  );
}

function ModeBadge({ p }: { p: PortfolioDTO | null }) {
  if (!p) return null;
  return (
    <Badge tone={p.guardrails.halted ? "danger" : p.guardrails.mode === "autonomous" ? "accent" : "neutral"}>
      {p.guardrails.halted ? "Halted" : p.guardrails.mode === "autonomous" ? "Autonomous mode" : "Copilot mode"}
    </Badge>
  );
}

export function VaultPage() {
  const portfolio = useApi<PortfolioDTO>("/api/portfolio", 15_000);
  const p = portfolio.data;
  return (
    <div className="mx-auto max-w-[880px] space-y-6">
      <PageHead title="Trading vault" body="The only money MINT can trade. Fund it from your wallet; it pays out only back to you." aside={<ModeBadge p={p} />} />
      {portfolio.error && <ErrorState message={portfolio.error} onRetry={portfolio.refresh} />}
      <VaultCard p={p} onSettled={portfolio.refresh} />
      <Link
        href="/agent"
        className="glass-card flex items-center gap-3 rounded-card px-5 py-4 text-[15px] text-ink transition-colors duration-[var(--dur-micro)] hover:bg-well"
      >
        <i className="ri-robot-2-line text-xl" aria-hidden />
        <span className="min-w-0 flex-1">
          See what the agent is doing with this money
          <span className="block text-sm text-muted">Open positions, profit and loss, and every decision with its reason.</span>
        </span>
        <i className="ri-arrow-right-line" aria-hidden />
      </Link>
      <Card>
        <CardHeader title="Risk" hint="Measured live against mainnet prices." action={<Link href="/guardrails" className="rounded text-sm text-ink underline-offset-4 hover:underline">Adjust</Link>} />
        <div className="px-5 pt-4 pb-5">{p ? <GuardrailMeters p={p} /> : <Skeleton className="h-20" />}</div>
      </Card>
    </div>
  );
}

export function GuardrailsPage() {
  const portfolio = useApi<PortfolioDTO>("/api/portfolio", 15_000);
  const p = portfolio.data;
  return (
    <div className="mx-auto max-w-[880px] space-y-6">
      <PageHead title="Guardrails" body="Limits the AI cannot cross. Tightening applies at once; loosening needs a code from your email." aside={<ModeBadge p={p} />} />
      {portfolio.error && <ErrorState message={portfolio.error} onRetry={portfolio.refresh} />}
      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Risk now" hint="Measured live against mainnet prices." />
          <div className="space-y-5 px-5 pt-4 pb-5">
            {p ? (
              <>
                <GuardrailMeters p={p} />
                <KillSwitch p={p} onDone={portfolio.refresh} />
              </>
            ) : (
              <Skeleton className="h-28" />
            )}
          </div>
        </Card>
        {p ? <GuardrailForm p={p} onSaved={portfolio.refresh} /> : <Skeleton className="h-96 rounded-card" />}
      </div>
    </div>
  );
}

function VaultCard({ p, onSettled }: { p: PortfolioDTO | null; onSettled: () => void }) {
  const [tab, setTab] = useState<"transfer" | "swap">("transfer");
  const [direction, setDirection] = useState<"fund" | "withdraw">("fund");
  const [asset, setAsset] = useState<AssetCode>("USDC");
  const [amount, setAmount] = useState("");
  const transfer = useProposal(onSettled);

  return (
    <Card>
      <div className="grid divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {[
          ["Vault value", p ? usd(p.vault.valueUsd) : null],
          ["USDC", p ? num(p.vault.balances.USDC) : null],
          ["XLM", p ? num(p.vault.balances.XLM) : null],
        ].map(([label, value]) => (
          <div key={label} className="px-5 py-4">
            <p className="text-sm text-muted">{label}</p>
            {value === null ? <Skeleton className="mt-1.5 h-8 w-24" /> : <p className="tabular mt-0.5 text-[26px] leading-tight font-bold tracking-tight">{value}</p>}
          </div>
        ))}
      </div>
      {p && <OtherHoldings wallet={p.vault} prices={p.prices} />}
      <div className="space-y-5 border-t border-line p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            label="Vault actions"
            value={tab}
            onChange={setTab}
            options={[
              { value: "transfer", label: "Fund or withdraw" },
              { value: "swap", label: "Swap" },
            ]}
          />
          {p && (
            <a href={accountUrl(p.vault.publicKey)} target="_blank" rel="noreferrer" className="rounded text-sm text-ink underline-offset-4 hover:underline">
              Vault on StellarChain
            </a>
          )}
        </div>
        {tab === "transfer" ? (
          <div className="space-y-4">
            <FormShell
              submit={direction === "fund" ? "Review deposit" : "Review withdrawal"}
              busy={transfer.busy}
              error={transfer.error}
              onSubmit={() => transfer.stage("propose_vault_transfer", { direction, asset, amount: Number(amount) })}
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <label htmlFor="vault-direction" className="block">
                  <span className="mb-1.5 block text-sm text-ink-2">Direction</span>
                  <select
                    id="vault-direction"
                    value={direction}
                    onChange={(e) => setDirection(e.target.value as "fund" | "withdraw")}
                    className="h-11 w-full rounded-control border border-line-strong bg-well px-3 text-[15px] text-ink hover:border-ink-2 focus:border-ink"
                  >
                    <option value="fund">Wallet to vault</option>
                    <option value="withdraw">Vault to wallet</option>
                  </select>
                </label>
                <AssetSelect id="vault-asset" label="Asset" value={asset} onChange={setAsset} />
                <Field label="Amount" inputMode="decimal" placeholder="100" value={amount} onChange={(e) => setAmount(e.target.value)} required pattern="[0-9]*[.]?[0-9]+" />
              </div>
            </FormShell>
            {transfer.card}
          </div>
        ) : (
          <SwapForm wallet="vault" onSettled={onSettled} />
        )}
      </div>
    </Card>
  );
}

function GuardrailForm({ p, onSaved }: { p: PortfolioDTO; onSaved: () => void }) {
  const g = p.guardrails;
  const [values, setValues] = useState({
    capitalCapUsd: String(g.capitalCapUsd),
    dailyLossPct: String(g.dailyLossPct),
    maxTradeUsd: String(g.maxTradeUsd),
    maxSlippagePct: String(g.maxSlippageBps / 100),
    maxAssetPct: String(g.maxAssetPct),
    agentBudgetUsd: String(g.agentBudgetUsd),
    dataDailyUsd: String(g.dataDailyUsd),
    dataMaxCallUsd: String(g.dataMaxCallUsd),
    mode: g.mode,
  });
  const [allowed, setAllowed] = useState<string[]>(g.allowedAssets);
  const toggle = (code: string) => setAllowed((list) => (list.includes(code) ? list.filter((c) => c !== code) : [...list, code]));
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [simulated, setSimulated] = useState(false);
  const { autofill, typing, cancel } = useSimulatedAutofill();
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: boolean }>({ busy: false, error: null, saved: false });

  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));

  async function save() {
    setState({ busy: true, error: null, saved: false });
    try {
      const result = await api<{ needsConfirmation?: boolean; devCode?: string }>("/api/guardrails", {
        method: "PUT",
        body: {
          capitalCapUsd: Number(values.capitalCapUsd),
          dailyLossPct: Number(values.dailyLossPct),
          maxTradeUsd: Number(values.maxTradeUsd),
          maxSlippageBps: Math.round(Number(values.maxSlippagePct) * 100),
          maxAssetPct: Number(values.maxAssetPct),
          agentBudgetUsd: Number(values.agentBudgetUsd),
          dataDailyUsd: Number(values.dataDailyUsd),
          dataMaxCallUsd: Number(values.dataMaxCallUsd),
          allowedAssets: allowed,
          mode: values.mode,
          code: needsCode ? code : undefined,
        },
      });
      if (result.needsConfirmation) {
        setNeedsCode(true);
        setSimulated(Boolean(result.devCode));
        if (result.devCode) autofill(result.devCode, setCode);
        setState({ busy: false, error: null, saved: false });
        return;
      }
      setNeedsCode(false);
      setCode("");
      setState({ busy: false, error: null, saved: true });
      onSaved();
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : "Couldn't save", saved: false });
    }
  }

  return (
    <Card>
      <CardHeader title="Your limits" hint="Loosening a limit or going autonomous needs a code from your email." />
      <div className="px-5 pt-4 pb-5">
        <FormShell submit={needsCode ? "Confirm change" : "Save guardrails"} busy={state.busy || typing} error={state.error} onSubmit={save}>
          <div>
            <span className="mb-1.5 block text-sm text-ink-2">Mode</span>
            <Segmented
              label="Trading mode"
              value={values.mode}
              onChange={(mode) => setValues((v) => ({ ...v, mode }))}
              options={[
                { value: "copilot", label: "Copilot" },
                { value: "autonomous", label: "Autonomous" },
              ]}
            />
            <p className="mt-1.5 text-sm text-muted">
              {values.mode === "copilot" ? "MINT proposes, you confirm every trade." : "The agent trades the vault on its own, inside these limits."}
            </p>
          </div>
          <Field label="Hard capital cap (USD)" inputMode="decimal" value={values.capitalCapUsd} onChange={set("capitalCapUsd")} hint="The vault can never be funded past this." />
          <Field label="Daily loss limit (%)" inputMode="decimal" value={values.dailyLossPct} onChange={set("dailyLossPct")} hint="Reached: trading halts and orders are cancelled." />
          <Field label="Max per trade (USD)" inputMode="decimal" value={values.maxTradeUsd} onChange={set("maxTradeUsd")} />
          <Field label="Max slippage (%)" inputMode="decimal" value={values.maxSlippagePct} onChange={set("maxSlippagePct")} hint="Enforced on-chain through path payment minimums." />
          <Field
            label="Max per asset (% of cap)"
            inputMode="decimal"
            value={values.maxAssetPct}
            onChange={set("maxAssetPct")}
            hint="No single asset other than USDC can grow past this share of your capital cap."
          />
          <fieldset>
            <legend className="mb-1.5 text-sm text-ink-2">Assets the vault may trade</legend>
            <div className="flex flex-wrap gap-2">
              {BASE_ASSETS.map((code) => (
                <button
                  key={code}
                  type="button"
                  aria-pressed={allowed.includes(code)}
                  onClick={() => toggle(code)}
                  title={ASSETS[code].name}
                  className={cx(
                    "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-sm transition-colors duration-[var(--dur-micro)]",
                    allowed.includes(code) ? "border-ink bg-ink text-paper" : "border-line-strong text-muted hover:text-ink",
                  )}
                >
                  {allowed.includes(code) && <i className="ri-check-line" aria-hidden />}
                  {code}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-sm text-muted">USDC is always allowed. Adding an asset needs the email code.</p>
          </fieldset>
          <fieldset className="space-y-4 border-t border-line pt-4">
            <legend className="float-left mb-1 w-full text-sm text-ink-2">Agent data budget (x402)</legend>
            <p className="clear-both text-sm text-muted">What the agent may spend buying market data on its own. It pays from a separate wallet that holds only this budget.</p>
            <Field label="Agent wallet holds at most (USD)" inputMode="decimal" value={values.agentBudgetUsd} onChange={set("agentBudgetUsd")} hint="The most you can lose if the agent's key is stolen." />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Per day (USD)" inputMode="decimal" value={values.dataDailyUsd} onChange={set("dataDailyUsd")} />
              <Field label="Per request (USD)" inputMode="decimal" value={values.dataMaxCallUsd} onChange={set("dataMaxCallUsd")} />
            </div>
          </fieldset>
          {needsCode && (
            <Field
              label="Code from your email"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => {
                cancel();
                setCode(e.target.value.replace(/\D/g, ""));
              }}
              hint={
                typing
                  ? "Filling in the code…"
                  : simulated
                    ? "Development mode: no email is sent, so the code was filled in for you."
                    : "We sent a 6-digit code to confirm loosening your guardrails."
              }
              required
            />
          )}
          {state.saved && (
            <p role="status" className="flex gap-1.5 text-sm text-ink">
              <i className="ri-check-line" aria-hidden />
              Guardrails saved.
            </p>
          )}
        </FormShell>
      </div>
    </Card>
  );
}

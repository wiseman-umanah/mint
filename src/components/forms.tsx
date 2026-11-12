"use client";

import { type FormEvent, type ReactNode, useState } from "react";
import { ASSET_CODES, ASSETS, type AssetCode } from "@/lib/assets";
import { api } from "@/lib/client";
import type { ProposalDTO } from "@/lib/types";
import { ProposalCard } from "./proposal-card";
import { Button, cx, Field } from "./ui";

type Tool = "propose_payment" | "propose_swap" | "propose_vault_transfer" | "propose_limit_order" | "propose_cancel_orders" | "propose_strategy_trades";

/** Stages a proposal through the same guarded tools the AI uses, then shows the card to confirm. */
export function useProposal(onSettled?: () => void) {
  const [proposal, setProposal] = useState<ProposalDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function stage(tool: Tool, args: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      setProposal(await api<ProposalDTO>("/api/proposals", { body: { tool, args } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't stage that");
    } finally {
      setBusy(false);
    }
  }

  const card = proposal ? (
    <ProposalCard
      nested
      proposal={proposal}
      onChange={(p) => {
        setProposal(p);
        if (p.status === "executed") onSettled?.();
      }}
    />
  ) : null;

  return { stage, busy, error, card, reset: () => setProposal(null), proposal };
}

export function AssetSelect({
  id,
  label,
  value,
  onChange,
  options = ASSET_CODES,
}: {
  id: string;
  label: string;
  value: AssetCode;
  onChange: (v: AssetCode) => void;
  options?: readonly AssetCode[];
}) {
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1.5 block text-sm text-ink-2">{label}</span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as AssetCode)}
        className="h-11 w-full rounded-control border border-line-strong bg-well px-3 text-[15px] text-ink transition-[border-color] duration-[var(--dur-micro)] hover:border-ink-2 focus:border-ink"
      >
        {options.map((code) => (
          <option key={code} value={code}>
            {code} {code !== "USDC" && code !== "XLM" ? `(${ASSETS[code].name})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FormShell({ onSubmit, children, submit, busy, error }: { onSubmit: () => void; children: ReactNode; submit: string; busy: boolean; error: string | null }) {
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-4"
    >
      {children}
      {error && (
        <p role="alert" className="flex gap-2 rounded-control border border-line-strong bg-danger-soft px-3 py-2 text-sm text-ink">
          <i className="ri-error-warning-line" aria-hidden />
          {error}
        </p>
      )}
      <Button type="submit" loading={busy} className="w-full sm:w-auto">
        {submit}
      </Button>
    </form>
  );
}

export function SendForm({ onSettled }: { onSettled: () => void }) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [asset, setAsset] = useState<AssetCode>("USDC");
  const [deliver, setDeliver] = useState<AssetCode>("USDC");
  const [memo, setMemo] = useState("");
  const p = useProposal(onSettled);

  return (
    <div className="space-y-4">
      <FormShell
        submit="Review payment"
        busy={p.busy}
        error={p.error}
        onSubmit={() =>
          p.stage("propose_payment", {
            recipient,
            amount: Number(amount),
            asset,
            deliver_asset: deliver !== asset ? deliver : undefined,
            memo: memo || undefined,
          })
        }
      >
        <Field label="Recipient" placeholder="@alex, alex*domain or G…" value={recipient} onChange={(e) => setRecipient(e.target.value)} required autoComplete="off" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" inputMode="decimal" placeholder="25.00" value={amount} onChange={(e) => setAmount(e.target.value)} required pattern="[0-9]*[.]?[0-9]+" />
          <AssetSelect id="send-asset" label="You send" value={asset} onChange={setAsset} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <AssetSelect id="send-deliver" label="They receive" value={deliver} onChange={setDeliver} />
          <Field label="Memo (optional)" maxLength={28} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>
      </FormShell>
      {p.card}
    </div>
  );
}

/** Any-to-any swap via path payment; `assets` narrows the choice (the terminal passes its pair). */
export function SwapForm({ wallet, assets = ASSET_CODES, onSettled }: { wallet: "main" | "vault"; assets?: readonly AssetCode[]; onSettled: () => void }) {
  const [from, setFrom] = useState<AssetCode>(assets.includes("USDC") ? "USDC" : assets[0]);
  const [to, setTo] = useState<AssetCode>(assets.find((a) => a !== (assets.includes("USDC") ? "USDC" : assets[0]))!);
  const [amount, setAmount] = useState("");
  const p = useProposal(onSettled);
  const pick = (next: AssetCode, side: "from" | "to") => {
    // Picking the asset already on the other side flips the pair.
    if (side === "from") {
      if (next === to) setTo(from);
      setFrom(next);
    } else {
      if (next === from) setFrom(to);
      setTo(next);
    }
  };

  return (
    <div className="space-y-4">
      <FormShell submit="Get a quote" busy={p.busy} error={p.error} onSubmit={() => p.stage("propose_swap", { wallet, from_asset: from, to_asset: to, amount: Number(amount) })}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2">
          <AssetSelect id={`swap-from-${wallet}`} label="From" value={from} onChange={(v) => pick(v, "from")} options={assets} />
          <button
            type="button"
            onClick={() => {
              setFrom(to);
              setTo(from);
            }}
            aria-label="Flip direction"
            className="mb-0.5 grid size-10 place-items-center rounded-full border border-line-strong text-ink-2 transition-colors duration-[var(--dur-micro)] hover:border-ink-2 hover:text-ink"
          >
            <i className="ri-arrow-left-right-line" aria-hidden />
          </button>
          <AssetSelect id={`swap-to-${wallet}`} label="To" value={to} onChange={(v) => pick(v, "to")} options={assets} />
        </div>
        <Field label={`Amount of ${from}`} inputMode="decimal" placeholder="10.00" value={amount} onChange={(e) => setAmount(e.target.value)} required pattern="[0-9]*[.]?[0-9]+" />
      </FormShell>
      {p.card}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-full border border-line bg-well p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-8 rounded-full px-4 text-sm transition-colors duration-[var(--dur-micro)]",
            value === o.value ? "bg-ink font-medium text-paper" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

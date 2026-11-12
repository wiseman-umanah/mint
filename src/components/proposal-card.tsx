"use client";

import { useState } from "react";
import { api, txUrl, usd } from "@/lib/client";
import type { ProposalDTO } from "@/lib/types";
import { Badge, Button, cx } from "./ui";

const KIND_ICON: Record<ProposalDTO["kind"], string> = {
  payment: "ri-send-plane-line",
  swap: "ri-arrow-left-right-line",
  limit_order: "ri-stack-line",
  cancel_orders: "ri-close-circle-line",
  fund_vault: "ri-safe-2-line",
  withdraw_vault: "ri-wallet-3-line",
};

const STATUS: Record<ProposalDTO["status"], { label: string; tone: "neutral" | "accent" | "danger" | "warn" }> = {
  pending: { label: "Awaiting your confirmation", tone: "neutral" },
  executing: { label: "Submitting to Stellar", tone: "neutral" },
  executed: { label: "Settled on Stellar", tone: "accent" },
  rejected: { label: "Dismissed", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  blocked: { label: "Blocked by guardrails", tone: "warn" },
};

/**
 * The signature object: the AI proposes, the guardrail engine shows its verdict rule by rule,
 * and only then can the user confirm. Settled proposals link to the real testnet transaction.
 */
export function ProposalCard({
  proposal,
  onChange,
  nested,
  preview,
}: {
  proposal: ProposalDTO;
  onChange?: (p: ProposalDTO) => void;
  // Inside another card: drop the frame and sit on the paper tone instead.
  nested?: boolean;
  // Marketing illustration: no actions.
  preview?: boolean;
}) {
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = STATUS[proposal.status];
  const checks = proposal.guardrail?.checks ?? [];

  async function act(action: "confirm" | "reject") {
    setBusy(action);
    setError(null);
    try {
      onChange?.(await api<ProposalDTO>(`/api/proposals/${proposal.id}`, { body: { action } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className={cx("enter overflow-hidden", nested ? "rounded-control bg-well" : "glass-card rounded-card")}>
      <header className="flex items-start gap-3 px-4 pt-4">
        <span className={cx("grid size-9 shrink-0 place-items-center rounded-full text-lg text-ink-2", "bg-well")} aria-hidden>
          <i className={KIND_ICON[proposal.kind]} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-medium leading-snug text-ink">{proposal.title}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={status.tone}>{status.label}</Badge>
            {proposal.source === "agent" && <Badge>Autonomous agent</Badge>}
            {proposal.risk && <Badge tone={proposal.risk === "high" ? "warn" : "neutral"}>{proposal.risk} risk</Badge>}
            {proposal.notionalUsd ? <span className="tabular text-sm text-muted">{usd(proposal.notionalUsd)}</span> : null}
          </div>
        </div>
      </header>

      {proposal.rationale && <p className="px-4 pt-3 text-sm leading-relaxed text-ink-2">{proposal.rationale}</p>}

      {checks.length > 0 && (
        <ul className="mx-4 mt-3 divide-y divide-line rounded-control border border-line" aria-label="Guardrail checks">
          {checks.map((check) => (
            <li key={check.rule} className="flex items-start gap-2.5 px-3 py-2 text-sm">
              <i
                className={cx("mt-0.5", check.ok ? "ri-checkbox-circle-fill text-ink" : "ri-close-circle-line text-ink")}
                aria-label={check.ok ? "passed" : "failed"}
              />
              <span className={cx("min-w-0 flex-1", check.ok ? "text-ink" : "font-medium text-ink")}>{check.rule}</span>
              <span className="tabular text-right text-muted">{check.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {(proposal.error || error) && (
        <p role="alert" className="mx-4 mt-3 flex gap-2 rounded-control border border-line-strong bg-danger-soft px-3 py-2 text-sm text-ink">
          <i className="ri-error-warning-line" aria-hidden />
          {proposal.error ?? error}
        </p>
      )}

      <footer className="flex flex-wrap items-center justify-end gap-2 px-4 py-4">
        {proposal.txHash && (
          <a
            href={txUrl(proposal.txHash)}
            target="_blank"
            rel="noreferrer"
            className="mr-auto inline-flex items-center gap-1.5 rounded-full text-sm text-ink underline-offset-4 hover:underline"
          >
            <i className="ri-external-link-line" aria-hidden />
            View transaction on StellarChain
          </a>
        )}
        {proposal.status === "pending" && !preview && (
          <>
            <Button variant="ghost" size="sm" onClick={() => act("reject")} loading={busy === "reject"} disabled={busy !== null}>
              Dismiss
            </Button>
            <Button size="sm" icon="ri-shield-check-line" onClick={() => act("confirm")} loading={busy === "confirm"} disabled={busy !== null}>
              Confirm and sign
            </Button>
          </>
        )}
      </footer>
    </article>
  );
}

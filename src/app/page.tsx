import Link from "next/link";
import { GlassHeader, Wordmark } from "@/components/app-shell";
import { ProposalCard } from "@/components/proposal-card";
import type { ProposalDTO } from "@/lib/types";

// Illustration of the product: the real component, fed an example proposal.
const EXAMPLE: ProposalDTO = {
  id: "example",
  userId: "",
  kind: "limit_order",
  source: "chat",
  params: {},
  title: "Buy 300 XLM at 0.1462 USDC",
  rationale: "The testnet ask sits 0.6% under the mainnet mid. Buying at the ask captures the gap.",
  risk: "low",
  notionalUsd: 43.86,
  status: "pending",
  guardrail: {
    ok: true,
    checks: [
      { rule: "Agent scope", ok: true, detail: "Vault only" },
      { rule: "Max trade size", ok: true, detail: "$43.86 of $50.00" },
      { rule: "Daily loss limit", ok: true, detail: "0.00% of 5%" },
      { rule: "Sufficient balance", ok: true, detail: "Needs 43.86 USDC" },
    ],
  },
  txHash: null,
  error: null,
  createdAt: "",
  resolvedAt: null,
};

const RULES = [
  { name: "Hard capital cap", value: "$500", note: "The vault can never hold more than this. Nothing outside it is tradable." },
  { name: "Daily loss limit", value: "5%", note: "Cross it and trading halts and every open order is cancelled." },
  { name: "Max per trade", value: "$50", note: "No single order is sized above it, however strong the signal." },
  { name: "Max slippage", value: "1%", note: "Written into each path payment as a minimum, so the network enforces it." },
];

const STELLAR = [
  { title: "No gas to hold", body: "MINT sponsors your account reserves and pays every fee with fee-bump transactions." },
  { title: "Best route, every swap", body: "Path payments route across the Stellar DEX order books and liquidity pools." },
  { title: "Proof on-chain", body: "Every payment and trade links to its transaction on StellarChain." },
];

const CTA =
  "inline-flex h-12 items-center gap-2 rounded-full bg-ink px-6 text-base font-medium text-paper transition-colors duration-[var(--dur-micro)] hover:bg-accent-hover active:translate-y-px";

export default function Landing() {
  return (
    <div className="min-h-dvh">
      <GlassHeader
        brandHref="/"
        label="Site"
        links={[
          { href: "/#guardrails", label: "Guardrails" },
          { href: "/#stellar", label: "Stellar" },
        ]}
        actions={
          <Link
            href="/login"
            className="inline-flex h-10 items-center rounded-full bg-ink px-5 text-[15px] font-medium text-paper transition-colors duration-[var(--dur-micro)] hover:bg-accent-hover"
          >
            Sign in
          </Link>
        }
      />

      <main>
        <section className="mx-auto grid max-w-[1240px] items-center gap-12 px-4 pt-36 pb-24 sm:px-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:pt-44">
          <div>
            <h1 className="font-display text-[44px] leading-[1.02] font-extrabold tracking-tight text-ink sm:text-[64px] lg:text-[76px]">
              Money with an AI on guard.
            </h1>
            <p className="mt-6 max-w-[34ch] text-lg text-ink-2 sm:text-xl">Pay, swap and trade on Stellar inside limits the AI cannot cross.</p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link href="/login" className={CTA}>
                <i className="ri-mail-line" aria-hidden />
                Continue with email
              </Link>
              <span className="text-sm text-muted">Runs on Stellar testnet.</span>
            </div>
          </div>
          <div className="mx-auto w-full max-w-[460px]">
            <div className="glass rounded-[24px] p-3">
              <ProposalCard proposal={EXAMPLE} preview />
            </div>
            <p className="mt-3 text-center text-sm text-muted">Example proposal. Nothing is signed until every check passes.</p>
          </div>
        </section>

        <section id="guardrails" className="mx-auto max-w-[1240px] scroll-mt-28 px-4 py-20 sm:px-6">
          <h2 className="font-display max-w-[18ch] text-[32px] leading-tight font-extrabold tracking-tight sm:text-[44px]">
            Four rules, enforced in code.
          </h2>
          <p className="mt-4 max-w-[52ch] text-ink-2">The AI proposes. A deterministic guardrail engine decides. These are the defaults; you set your own.</p>
          <dl className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {RULES.map((r) => (
              <div key={r.name} className="glass-card rounded-card p-6">
                <dt className="text-ink-2">{r.name}</dt>
                <dd className="tabular mt-2 text-[44px] leading-none font-bold tracking-tight text-ink">{r.value}</dd>
                <dd className="mt-4 text-sm text-muted">{r.note}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="stellar" className="mx-auto max-w-[1240px] scroll-mt-28 px-4 py-20 sm:px-6">
          <h2 className="font-display text-[32px] leading-tight font-extrabold tracking-tight sm:text-[44px]">Built on Stellar.</h2>
          <div className="mt-10 grid gap-10 md:grid-cols-3">
            {STELLAR.map((s) => (
              <div key={s.title} className="border-t border-line-strong pt-5">
                <h3 className="text-lg font-medium text-ink">{s.title}</h3>
                <p className="mt-2 text-ink-2">{s.body}</p>
              </div>
            ))}
          </div>
          <Link href="/login" className={`${CTA} mt-14`}>
            Open your wallet
          </Link>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-muted sm:px-6">
          <Wordmark className="text-lg" />
          <p>Testnet build. Not financial advice.</p>
        </div>
      </footer>
    </div>
  );
}

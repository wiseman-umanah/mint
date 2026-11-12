"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import QRCode from "qrcode";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { amountDigits, ASSETS, ISSUED_ASSETS } from "@/lib/assets";
import { accountUrl, api, num, usd, useApi } from "@/lib/client";
import type { Me, PortfolioDTO } from "@/lib/types";
import { SendForm, SwapForm } from "./forms";
import { Badge, Button, Card, cx, ErrorState, Skeleton } from "./ui";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={copied ? "ri-check-line" : "ri-file-copy-line"}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

function Receive({ me }: { me: Me }) {
  const [svg, setSvg] = useState<string | null>(null);
  const address = me.wallets.main ?? "";

  useEffect(() => {
    if (!address) return;
    // SEP-7 payment request, readable by any Stellar wallet's scanner.
    void QRCode.toString(`web+stellar:pay?destination=${address}`, { type: "svg", margin: 1 }).then(setSvg);
  }, [address]);

  return (
    <div className="grid gap-6 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center">
      <div className="mx-auto size-[180px] overflow-hidden rounded-control bg-ink p-2" aria-label="QR code of your wallet address" role="img">
        {svg ? <div className="size-full [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} /> : <Skeleton className="size-full rounded-none" />}
      </div>
      <div className="min-w-0 space-y-4">
        <div>
          <p className="text-sm text-muted">Your handle</p>
          <p className="mt-0.5 text-ink">@{me.handle}</p>
          <p className="text-sm break-all text-muted">{me.federationAddress}</p>
        </div>
        <div>
          <p className="text-sm text-muted">Stellar address</p>
          <p className="mt-0.5 font-mono text-sm break-all text-ink">{address}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton value={address} label="Copy address" />
          <CopyButton value={me.federationAddress} label="Copy handle" />
        </div>
        <p className="text-sm text-muted">Send Circle testnet USDC or XLM from any Stellar wallet. Your USDC trustline is already set up.</p>
      </div>
    </div>
  );
}

type WalletContext = { portfolio: ReturnType<typeof useApi<PortfolioDTO>> };
const Ctx = createContext<WalletContext | null>(null);

export function useWallet() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside WalletLayout");
  return ctx.portfolio;
}

const WALLET_TABS = [
  { href: "/wallet/send", label: "Send" },
  { href: "/wallet/swap", label: "Swap" },
  { href: "/wallet/receive", label: "Receive" },
];

/** Shared frame for /wallet/send, /wallet/swap and /wallet/receive: balances on top, one route per action. */
export function WalletLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const portfolio = useApi<PortfolioDTO>("/api/portfolio", 20_000);
  const [faucet, setFaucet] = useState<{ busy: boolean; message: string | null; error: boolean }>({ busy: false, message: null, error: false });
  const p = portfolio.data;

  async function claim() {
    setFaucet({ busy: true, message: null, error: false });
    try {
      const r = await api<{ amount: number }>("/api/faucet", { method: "POST" });
      setFaucet({ busy: false, message: `${r.amount} test USDC is on its way.`, error: false });
      void portfolio.refresh();
    } catch (e) {
      setFaucet({ busy: false, message: e instanceof Error ? e.message : "Faucet failed", error: true });
    }
  }

  return (
    <Ctx.Provider value={{ portfolio }}>
      <div className="mx-auto max-w-[880px] space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[32px] leading-tight font-extrabold tracking-tight">Wallet</h1>
            <p className="mt-1 text-ink-2">Everyday money. MINT pays the network fees.</p>
          </div>
          <Button variant="secondary" icon="ri-drop-line" loading={faucet.busy} onClick={claim}>
            Get 50 test USDC
          </Button>
        </header>
        {faucet.message && (
          <p role="status" className="flex gap-2 rounded-control border border-line-strong bg-well px-4 py-3 text-sm text-ink">
            <i className={faucet.error ? "ri-error-warning-line" : "ri-check-line"} aria-hidden />
            {faucet.message}
          </p>
        )}

        <Card>
          <div className="grid divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Balance label="Value" value={p ? usd(p.main.valueUsd) : null} />
            <Balance label="USDC" value={p ? num(p.main.balances.USDC) : null} />
            <Balance label="XLM" value={p ? num(p.main.balances.XLM) : null} sub={p ? `${num(p.main.balances.spendableXLM)} spendable` : undefined} />
          </div>
          {p && <OtherHoldings wallet={p.main} prices={p.prices} />}
          {portfolio.error && (
            <div className="p-4">
              <ErrorState message={portfolio.error} onRetry={portfolio.refresh} />
            </div>
          )}
          {p && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3 text-sm">
              {p.main.active ? <Badge tone="accent">Active on Stellar testnet</Badge> : <Badge tone="warn">Activating</Badge>}
              <a href={accountUrl(p.main.publicKey)} target="_blank" rel="noreferrer" className="ml-auto rounded text-ink underline-offset-4 hover:underline">
                View account on StellarChain
              </a>
            </div>
          )}
        </Card>

        <Card>
          <div className="space-y-5 p-5">
            <nav aria-label="Wallet actions" className="inline-flex rounded-full border border-line bg-well p-1">
              {WALLET_TABS.map((tab) => (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={pathname === tab.href ? "page" : undefined}
                  className={cx(
                    "inline-flex h-8 items-center rounded-full px-4 text-sm transition-colors duration-[var(--dur-micro)]",
                    pathname === tab.href ? "bg-ink font-medium text-paper" : "text-muted hover:text-ink",
                  )}
                >
                  {tab.label}
                </Link>
              ))}
            </nav>
            {children}
          </div>
        </Card>
      </div>
    </Ctx.Provider>
  );
}

export function WalletSend() {
  const portfolio = useWallet();
  return <SendForm onSettled={portfolio.refresh} />;
}

export function WalletSwap() {
  const portfolio = useWallet();
  return <SwapForm wallet="main" onSettled={portfolio.refresh} />;
}

export function WalletReceive() {
  const me = useApi<Me>("/api/me");
  return me.data ? <Receive me={me.data} /> : <Skeleton className="h-44" />;
}

/** Every asset besides USDC and XLM the wallet holds, with its USD value at mainnet prices. */
export function OtherHoldings({ wallet, prices }: { wallet: PortfolioDTO["main"]; prices: PortfolioDTO["prices"] }) {
  const held = ISSUED_ASSETS.filter((code) => wallet.balances[code] > 0);
  if (held.length === 0) return null;
  return (
    <ul className="divide-y divide-line border-t border-line" aria-label="Other assets">
      {held.map((code) => (
        <li key={code} className="flex items-baseline justify-between gap-3 px-5 py-2.5 text-sm">
          <Link href={`/trading/${code}-USDC`} className="rounded">
            <span className="font-medium text-ink">{code}</span> <span className="text-muted">{ASSETS[code].name}</span>
          </Link>
          <span className="tabular text-right">
            <span className="text-ink">{num(wallet.balances[code], amountDigits(code))}</span>{" "}
            <span className="text-muted">{usd(wallet.balances[code] * prices[code as keyof typeof prices])}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Balance({ label, value, sub }: { label: string; value: string | null; sub?: string }) {
  return (
    <div className="px-5 py-4">
      <p className="text-sm text-muted">{label}</p>
      {value === null ? <Skeleton className="mt-1.5 h-8 w-28" /> : <p className="tabular mt-0.5 text-[26px] leading-tight font-bold tracking-tight">{value}</p>}
      {sub && <p className="tabular mt-0.5 text-sm text-muted">{sub}</p>}
    </div>
  );
}

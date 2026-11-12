"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { api, useApi } from "@/lib/client";
import type { Me } from "@/lib/types";
import { Badge, cx } from "./ui";

export const NAV = [
  { href: "/assistant", label: "Assistant", icon: "ri-sparkling-2-line" },
  { href: "/wallet", label: "Wallet", icon: "ri-wallet-3-line" },
  { href: "/markets", label: "Markets", icon: "ri-bar-chart-box-line" },
  { href: "/trading", label: "Trading", icon: "ri-line-chart-line" },
  { href: "/vault", label: "Vault", icon: "ri-safe-2-line" },
  { href: "/agent", label: "Agent", icon: "ri-robot-2-line" },
  { href: "/guardrails", label: "Guardrails", icon: "ri-shield-check-line" },
  { href: "/activity", label: "Activity", icon: "ri-history-line" },
];

export function Wordmark({ className }: { className?: string }) {
  return <span className={cx("font-display text-[22px] leading-none font-extrabold tracking-tight text-ink", className)}>mint.</span>;
}

const subscribeScroll = (onChange: () => void) => {
  window.addEventListener("scroll", onChange, { passive: true });
  return () => window.removeEventListener("scroll", onChange);
};

/** True once the page has scrolled: the pill docks closer to the top, as on HoverAi. */
export function useScrolled() {
  return useSyncExternalStore(
    subscribeScroll,
    () => window.scrollY > 10,
    () => false,
  );
}

/**
 * The floating glass pill. Docks upward on scroll (transform only) and, below xl,
 * folds its links into a full-screen glass menu.
 */
export function GlassHeader({ brandHref, links, actions, label }: { brandHref: string; links: { href: string; label: string; icon?: string }[]; actions: ReactNode; label: string }) {
  const pathname = usePathname();
  const scrolled = useScrolled();
  const [open, setOpen] = useState(false);
  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 px-3 pt-3 sm:px-4">
        <div
          className={cx(
            "glass mx-auto flex h-16 max-w-[1320px] items-center gap-6 rounded-full pr-2.5 pl-5 sm:pl-6",
            "transition-transform duration-300 ease-out",
            scrolled ? "translate-y-0" : "xl:translate-y-3",
          )}
        >
          <Link href={brandHref} aria-label="MINT home" className="rounded-md" onClick={() => setOpen(false)}>
            <Wordmark />
          </Link>
          <nav aria-label={label} className="hidden h-full items-center gap-1 xl:flex">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active(link.href) ? "page" : undefined}
                className={cx(
                  "inline-flex h-9 items-center rounded-full px-3.5 text-[15px] transition-colors duration-[var(--dur-micro)]",
                  active(link.href) ? "bg-accent-soft text-ink" : "text-ink/65 hover:text-ink",
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {actions}
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls="site-menu"
              aria-label={open ? "Close menu" : "Open menu"}
              className="grid size-10 place-items-center rounded-full text-xl text-ink transition-colors duration-[var(--dur-micro)] hover:bg-well xl:hidden"
            >
              <i className={open ? "ri-close-line" : "ri-menu-line"} aria-hidden />
            </button>
          </div>
        </div>
      </header>

      <div
        id="site-menu"
        inert={!open}
        className={cx(
          "glass fixed inset-0 z-30 flex flex-col rounded-none px-6 pt-28 pb-10 xl:hidden",
          "transition-[opacity,transform] duration-300 ease-out",
          open ? "opacity-100" : "pointer-events-none -translate-y-4 opacity-0",
        )}
      >
        <nav aria-label={`${label} menu`} className="flex flex-col">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              aria-current={active(link.href) ? "page" : undefined}
              className={cx(
                "flex items-center gap-3 border-b border-line py-4 text-[22px] font-medium transition-colors duration-[var(--dur-micro)]",
                active(link.href) ? "text-ink" : "text-ink/70 hover:text-ink",
              )}
            >
              {link.icon && <i className={cx(link.icon, "text-xl text-muted")} aria-hidden />}
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: me } = useApi<Me>("/api/me");
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    router.replace("/login");
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <GlassHeader
        brandHref="/assistant"
        links={NAV}
        label="Primary"
        actions={
          <>
            <Badge>Testnet</Badge>
            {me && <span className="hidden text-sm text-ink-2 sm:inline">@{me.handle}</span>}
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className="grid size-10 place-items-center rounded-full text-lg text-muted transition-colors duration-[var(--dur-micro)] hover:bg-well hover:text-ink disabled:opacity-50"
              aria-label="Sign out"
              title="Sign out"
            >
              <i className="ri-logout-box-r-line" aria-hidden />
            </button>
          </>
        }
      />
      <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 pt-28 pb-16 sm:px-6 xl:pt-32">{children}</main>
    </div>
  );
}

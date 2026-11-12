"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { priceDigits } from "./assets";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(url, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth")) {
    // Clear the stale cookie first, or the proxy would bounce /login straight back into the app.
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    window.location.assign("/login");
  }
  if (!response.ok) throw new ApiError(data.error ?? "Something went wrong", response.status);
  return data as T;
}

/**
 * Stands in for the phone's one-time-code autofill while email is simulated: types the code into a
 * field a digit at a time, or all at once for people who prefer reduced motion. `typing` is true
 * until the last digit lands; a new call or unmounting cancels the one in progress.
 */
export function useSimulatedAutofill() {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [typing, setTyping] = useState(false);
  useEffect(() => () => clearTimeout(timer.current), []);

  const autofill = useCallback((code: string, onChange: (value: string) => void) => {
    clearTimeout(timer.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onChange(code);
      return;
    }
    setTyping(true);
    const step = (i: number) => {
      timer.current = setTimeout(
        () => {
          onChange(code.slice(0, i));
          if (i < code.length) step(i + 1);
          else setTyping(false);
        },
        i === 1 ? 700 : 140,
      );
    };
    step(1);
  }, []);

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    setTyping(false);
  }, []);

  return { autofill, typing, cancel };
}

/** Fetches JSON, optionally polling. Polling pauses while the tab is hidden. */
export function useApi<T>(url: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const load = () =>
      api<T>(url).then(
        (next) => {
          if (cancelled) return;
          setData(next);
          setError(null);
          setLoading(false);
        },
        (e) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : "Failed to load");
          setLoading(false);
        },
      );
    void load();
    const id = pollMs
      ? setInterval(() => {
          if (document.visibilityState === "visible") void load();
        }, pollMs)
      : undefined;
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [url, pollMs, version]);

  return { data, error, loading, refresh };
}

export const usd = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

export const num = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Signed number that never prints "-0.00": tiny values round to an unsigned zero. */
export const signed = (n: number, digits = 2) => {
  const rounded = Number(n.toFixed(digits));
  return `${rounded > 0 ? "+" : ""}${num(rounded === 0 ? 0 : rounded, digits)}`;
};

/** A USDC price with as many decimals as its size needs. */
export const price = (n: number) => num(n, priceDigits(n));

export const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;

export const EXPLORER = "https://testnet.stellarchain.io";
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const accountUrl = (key: string) => `${EXPLORER}/account/${key}`;

export function timeAgo(iso: string | Date) {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

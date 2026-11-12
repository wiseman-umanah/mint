"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Wordmark } from "@/components/app-shell";
import { Button, Field } from "@/components/ui";
import { api, useSimulatedAutofill } from "@/lib/client";

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [simulated, setSimulated] = useState(false);
  const { autofill, typing, cancel } = useSimulatedAutofill();

  async function requestCode() {
    setBusy(true);
    setError(null);
    try {
      const { devCode } = await api<{ devCode?: string }>("/api/auth/request", { body: { email } });
      setStep("code");
      setSimulated(Boolean(devCode));
      if (devCode) autofill(devCode, setCode);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the code");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    setCreating(true);
    try {
      await api("/api/auth/verify", { body: { email, code } });
      router.replace("/assistant");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't sign you in");
      setBusy(false);
      setCreating(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="glass w-full max-w-[440px] rounded-[28px] px-6 py-8 sm:px-9 sm:py-10">
        <Link href="/" aria-label="MINT home" className="inline-block rounded-md">
          <Wordmark className="text-[28px]" />
        </Link>
        <h1 className="mt-8 text-[26px] leading-tight font-bold tracking-tight">{step === "email" ? "Sign in or create a wallet" : simulated ? "Enter your code" : "Check your email"}</h1>
        <p className="mt-2 text-ink-2">
          {step === "email"
            ? "No seed phrase. New accounts get a Stellar wallet and a trading vault."
            : simulated
              ? `Development mode: no email is sent. The code for ${email} fills in below, like your phone's autofill would.`
              : `We sent a 6-digit code to ${email}.`}
        </p>

        <form
          className="mt-8 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void (step === "email" ? requestCode() : verify());
          }}
        >
          {step === "email" ? (
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={error}
              required
              autoFocus
            />
          ) : (
            <Field
              label="Login code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={6}
              value={code}
              onChange={(e) => {
                cancel();
                setCode(e.target.value.replace(/\D/g, ""));
              }}
              error={error}
              hint={creating ? "Setting up your wallet on Stellar. This takes a few seconds." : typing ? "Filling in the code…" : undefined}
              required
              autoFocus
            />
          )}
          <Button type="submit" size="lg" loading={busy} className="w-full" disabled={step === "code" && (code.length !== 6 || typing)}>
            {step === "email" ? "Email me a code" : "Continue"}
          </Button>
          {step === "code" && (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                cancel();
                setStep("email");
                setCode("");
                setError(null);
              }}
            >
              Use a different email
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}

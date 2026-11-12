import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { hmac, randomCode, safeEqual } from "../crypto";
import { db, schema } from "../db";
import { env } from "../env";

const CODE_TTL_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 45_000;
const MAX_ATTEMPTS = 5;

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

/** Sends a code. Returns it only when email is simulated (see env.simulateEmail), for the UI to type in. */
export async function issueCode(rawEmail: string, purpose: "login" | "confirm" = "login"): Promise<{ devCode?: string }> {
  const email = normaliseEmail(rawEmail);
  const latest = await db().query.otpCodes.findFirst({
    where: and(eq(schema.otpCodes.email, email), eq(schema.otpCodes.purpose, purpose)),
    orderBy: desc(schema.otpCodes.createdAt),
  });
  if (latest && Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new Error("Please wait a few seconds before requesting another code.");
  }
  const code = randomCode();
  await db()
    .insert(schema.otpCodes)
    .values({ email, purpose, codeHash: hmac(`${email}:${purpose}:${code}`), expiresAt: new Date(Date.now() + CODE_TTL_MS) });
  if (env.simulateEmail) {
    console.info(`[mint] email simulated: ${purpose} code for ${email} sent back to the browser`);
    return { devCode: code };
  }
  await sendCode(email, code, purpose);
  return {};
}

export async function verifyCode(rawEmail: string, code: string, purpose: "login" | "confirm" = "login") {
  const email = normaliseEmail(rawEmail);
  const row = await db().query.otpCodes.findFirst({
    where: and(
      eq(schema.otpCodes.email, email),
      eq(schema.otpCodes.purpose, purpose),
      isNull(schema.otpCodes.consumedAt),
      gt(schema.otpCodes.expiresAt, new Date()),
    ),
    orderBy: desc(schema.otpCodes.createdAt),
  });
  if (!row || row.attempts >= MAX_ATTEMPTS) return false;
  if (!safeEqual(row.codeHash, hmac(`${email}:${purpose}:${code.trim()}`))) {
    await db().update(schema.otpCodes).set({ attempts: row.attempts + 1 }).where(eq(schema.otpCodes.id, row.id));
    return false;
  }
  await db().update(schema.otpCodes).set({ consumedAt: new Date() }).where(eq(schema.otpCodes.id, row.id));
  return true;
}

async function sendCode(email: string, code: string, purpose: "login" | "confirm") {
  const subject = purpose === "login" ? `${code} is your MINT login code` : `${code} confirms your MINT guardrail change`;
  const line =
    purpose === "login"
      ? "Use this code to sign in to MINT."
      : "Someone (hopefully you) asked to loosen your MINT trading guardrails. Enter this code to confirm.";

  if (!env.resendApiKey) {
    console.info(`\n[mint] ${purpose} code for ${email}: ${code}\n`);
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.emailFrom,
      to: email,
      subject,
      html: `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:32px">
        <p style="font-size:15px;color:#3f3f46">${line}</p>
        <p style="font-size:34px;letter-spacing:8px;font-weight:700;color:#0b1215;margin:24px 0">${code}</p>
        <p style="font-size:13px;color:#71717a">It expires in 10 minutes. If you didn't request it, ignore this email.</p>
      </div>`,
    }),
  });
  if (!response.ok) throw new Error("Couldn't send the email. Please try again.");
}

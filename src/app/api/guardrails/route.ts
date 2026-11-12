import { eq } from "drizzle-orm";
import { z } from "zod";
import { authed } from "@/lib/api";
import { BASE_ASSETS } from "@/lib/assets";
import { issueCode, verifyCode } from "@/lib/auth/otp";
import { db, schema } from "@/lib/db";
import { getGuardrails } from "@/lib/portfolio";

export const GET = authed((user) => getGuardrails(user.id));

const body = z
  .object({
    capitalCapUsd: z.number().min(1).max(10_000),
    dailyLossPct: z.number().min(0.5).max(50),
    maxTradeUsd: z.number().min(1).max(10_000),
    maxSlippageBps: z.number().int().min(10).max(500),
    mode: z.enum(["copilot", "autonomous"]),
    allowedAssets: z.array(z.enum(BASE_ASSETS)).transform((list) => [...new Set(list)]),
    maxAssetPct: z.number().min(5).max(100),
    code: z.string().regex(/^\d{6}$/).optional(),
  })
  .refine((v) => v.maxTradeUsd <= v.capitalCapUsd, { message: "Max trade size can't exceed the capital cap" });

/**
 * Tightening guardrails applies instantly. Loosening them — or turning on autonomous mode —
 * needs a second factor: a code sent to the user's email.
 */
export const PUT = authed(async (user, request) => {
  const { code, ...next } = body.parse(await request.json());
  const current = await getGuardrails(user.id);
  const loosening =
    next.capitalCapUsd > current.capitalCapUsd ||
    next.dailyLossPct > current.dailyLossPct ||
    next.maxTradeUsd > current.maxTradeUsd ||
    next.maxSlippageBps > current.maxSlippageBps ||
    next.maxAssetPct > current.maxAssetPct ||
    next.allowedAssets.some((a) => !current.allowedAssets.includes(a)) ||
    (next.mode === "autonomous" && current.mode !== "autonomous");

  if (loosening) {
    if (!code) {
      const { devCode } = await issueCode(user.email, "confirm");
      return { needsConfirmation: true, devCode };
    }
    if (!(await verifyCode(user.email, code, "confirm"))) {
      return Response.json({ error: "That code is wrong or has expired." }, { status: 400 });
    }
  }
  const [row] = await db()
    .update(schema.guardrails)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(schema.guardrails.userId, user.id))
    .returning();
  await db().insert(schema.activity).values({
    userId: user.id,
    kind: "guardrails",
    summary: `Guardrails updated — cap $${row.capitalCapUsd}, loss ${row.dailyLossPct}%, trade $${row.maxTradeUsd}, ${row.maxAssetPct}% per asset, ${row.allowedAssets.length} assets allowed, ${row.mode} mode`,
    actor: "user",
  });
  return row;
});

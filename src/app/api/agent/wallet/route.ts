import { eq } from "drizzle-orm";
import { z } from "zod";
import { fundAgentWallet, revokeAgentWallet } from "@/lib/agent/data";
import { forgetAgentBalance } from "@/lib/agent/status";
import { authed } from "@/lib/api";
import { issueCode, verifyCode } from "@/lib/auth/otp";
import { db, schema } from "@/lib/db";
import { getGuardrails } from "@/lib/portfolio";

const body = z.object({ action: z.enum(["enable", "topup", "revoke"]), code: z.string().regex(/^\d{6}$/).optional() });

/**
 * The agent's data budget. Giving the agent money it can spend on its own loosens the guardrails,
 * so turning it on needs the email code; topping up stays inside the budget; revoking is instant.
 */
export const POST = authed(async (user, request) => {
  const { action, code } = body.parse(await request.json());
  const g = await getGuardrails(user.id);
  forgetAgentBalance(user.id);

  if (action === "revoke") return revokeAgentWallet(user.id);
  if (action === "topup") {
    if (!g.dataEnabled) throw new Error("Turn on the data budget first.");
    return fundAgentWallet(user.id, g);
  }
  if (!g.dataEnabled) {
    if (!code) {
      const { devCode } = await issueCode(user.email, "confirm");
      return { needsConfirmation: true, devCode };
    }
    if (!(await verifyCode(user.email, code, "confirm"))) return Response.json({ error: "That code is wrong or has expired." }, { status: 400 });
  }
  const funded = await fundAgentWallet(user.id, g);
  await db().update(schema.guardrails).set({ dataEnabled: true, updatedAt: new Date() }).where(eq(schema.guardrails.userId, user.id));
  return funded;
});

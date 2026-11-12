import { eq } from "drizzle-orm";
import { z } from "zod";
import { authed } from "@/lib/api";
import { db, schema } from "@/lib/db";
import { haltTrading } from "@/lib/guardrails";
import { getPortfolio } from "@/lib/portfolio";

const body = z.object({ halted: z.boolean() });

export const POST = authed(async (user, request) => {
  const { halted } = body.parse(await request.json());
  if (halted) {
    await haltTrading(user.id, "kill switch pressed");
    return { halted: true };
  }
  const portfolio = await getPortfolio(user.id);
  if (portfolio.loss.lossPct >= portfolio.guardrails.dailyLossPct) {
    throw new Error("The daily loss limit is still breached — trading resumes once the 24h window rolls over.");
  }
  await db()
    .update(schema.guardrails)
    .set({ halted: false, haltedReason: null, updatedAt: new Date() })
    .where(eq(schema.guardrails.userId, user.id));
  await db().insert(schema.activity).values({ userId: user.id, kind: "resume", summary: "Trading resumed", actor: "user" });
  return { halted: false };
});

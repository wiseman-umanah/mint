import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { runTool } from "@/lib/ai/tools";
import { authed } from "@/lib/api";
import { db, schema } from "@/lib/db";

export const GET = authed((user, request) => {
  const source = new URL(request.url).searchParams.get("source");
  return db().query.proposals.findMany({
    where: and(
      eq(schema.proposals.userId, user.id),
      source === "agent" || source === "chat" ? eq(schema.proposals.source, source) : undefined,
    ),
    orderBy: desc(schema.proposals.createdAt),
    limit: 40,
  });
});

// Forms in the UI stage proposals through the same tools the AI uses, so every path is guarded.
const body = z.object({
  tool: z.enum(["propose_payment", "propose_swap", "propose_limit_order", "propose_vault_transfer", "propose_cancel_orders", "propose_strategy_trades"]),
  args: z.record(z.string(), z.unknown()).default({}),
});

export const POST = authed(async (user, request) => {
  const { tool, args } = body.parse(await request.json());
  const { output, proposalId } = await runTool(user.id, tool, JSON.stringify(args));
  if (!proposalId) {
    const message = (output as { error?: string; note?: string }).error ?? (output as { note?: string }).note;
    return Response.json({ error: message ?? "Nothing to propose." }, { status: 400 });
  }
  return db().query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
});

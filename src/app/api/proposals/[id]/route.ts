import { z } from "zod";
import { authed } from "@/lib/api";
import { executeProposal, rejectProposal } from "@/lib/proposals";

const body = z.object({ action: z.enum(["confirm", "reject"]) });

export const POST = authed(async (user, request, ctx: RouteContext<"/api/proposals/[id]">) => {
  const { id } = await ctx.params;
  const { action } = body.parse(await request.json());
  if (action === "reject") {
    const row = await rejectProposal(user.id, id);
    if (!row) throw new Error("This proposal is no longer pending.");
    return row;
  }
  return executeProposal(user.id, id);
});

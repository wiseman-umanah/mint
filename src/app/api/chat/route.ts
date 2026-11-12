import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { chat } from "@/lib/ai/assistant";
import { authed } from "@/lib/api";
import { db, schema } from "@/lib/db";

export const GET = authed(async (user) => {
  const messages = (
    await db().query.messages.findMany({
      where: eq(schema.messages.userId, user.id),
      orderBy: desc(schema.messages.createdAt),
      limit: 60,
    })
  ).reverse();
  const ids = messages.flatMap((m) => m.proposalIds);
  const proposals = ids.length ? await db().query.proposals.findMany({ where: inArray(schema.proposals.id, ids) }) : [];
  return { messages, proposals };
});

const body = z.object({ message: z.string().trim().min(1).max(2000) });

export const POST = authed(async (user, request) => {
  const { message } = body.parse(await request.json());
  const reply = await chat(user.id, user.handle, message);
  const proposals = reply.proposalIds.length
    ? await db().query.proposals.findMany({ where: inArray(schema.proposals.id, reply.proposalIds) })
    : [];
  return { reply, proposals };
});

import { runAgent } from "@/lib/agent/run";
import { authed } from "@/lib/api";

// "Check now": runs this user's agent once, unless a check ran in the last few seconds.
export const POST = authed(async (user) => {
  const run = await runAgent(user.id, { minGapMs: 15_000 });
  return { ran: Boolean(run), headline: run?.headline ?? null };
});

// Stellar settlement can take several seconds; allow for it on serverless hosts.
export const maxDuration = 60;

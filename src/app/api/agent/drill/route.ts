import { runDrill } from "@/lib/agent/drill";
import { authed } from "@/lib/api";

// Plays a hijacked agent against the user's real guardrails. Nothing is signed or sent.
export const POST = authed(async (user) => ({ results: await runDrill(user.id) }));

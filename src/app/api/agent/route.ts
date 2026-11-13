import { agentStatus } from "@/lib/agent/status";
import { authed } from "@/lib/api";

export const GET = authed((user) => agentStatus(user.id));

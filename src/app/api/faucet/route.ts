import { authed } from "@/lib/api";
import { claimTestUsdc } from "@/lib/faucet";

export const POST = authed((user) => claimTestUsdc(user.id));

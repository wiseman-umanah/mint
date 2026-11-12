import { authed } from "@/lib/api";
import { getPortfolio } from "@/lib/portfolio";

export const GET = authed((user) => getPortfolio(user.id));

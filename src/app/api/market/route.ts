import { z } from "zod";
import { authed } from "@/lib/api";
import { BASE_ASSETS } from "@/lib/assets";
import { marketSnapshot } from "@/lib/stellar/market";
import { computeSignals } from "@/lib/strategy";

const query = z.object({ asset: z.enum(BASE_ASSETS).default("XLM") });

export const GET = authed(async (_user, request) => {
  const { asset } = query.parse(Object.fromEntries(new URL(request.url).searchParams));
  const market = await marketSnapshot(asset);
  return { ...market, signals: computeSignals(market) };
});

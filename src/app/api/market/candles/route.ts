import { z } from "zod";
import { authed } from "@/lib/api";
import { BASE_ASSETS } from "@/lib/assets";
import { chartCandles, INTERVALS } from "@/lib/stellar/market";

const query = z.object({
  asset: z.enum(BASE_ASSETS).default("XLM"),
  network: z.enum(["mainnet", "testnet"]).default("mainnet"),
  interval: z.enum(Object.keys(INTERVALS) as [keyof typeof INTERVALS, ...(keyof typeof INTERVALS)[]]).default("1h"),
});

export const GET = authed(async (_user, request) => {
  const { asset, network, interval } = query.parse(Object.fromEntries(new URL(request.url).searchParams));
  return chartCandles(asset, network, interval);
});

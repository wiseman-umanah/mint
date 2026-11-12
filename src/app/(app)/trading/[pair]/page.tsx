import { notFound } from "next/navigation";
import { TradingTerminal } from "@/components/terminal";
import { BASE_ASSETS, baseFromSlug, pairSlug } from "@/lib/assets";

export function generateStaticParams() {
  return BASE_ASSETS.map((base) => ({ pair: pairSlug(base) }));
}

export default async function Page({ params }: PageProps<"/trading/[pair]">) {
  const base = baseFromSlug((await params).pair);
  if (!base) notFound();
  // Keyed so switching pairs starts from a clean chart and empty forms.
  return <TradingTerminal key={base} base={base} />;
}

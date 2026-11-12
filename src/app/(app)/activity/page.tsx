"use client";

import { timeAgo, txUrl, useApi } from "@/lib/client";
import type { ActivityDTO } from "@/lib/types";
import { Badge, Card, ErrorState, Skeleton } from "@/components/ui";

const ACTOR = { user: "You", agent: "Agent", system: "MINT" } as const;

export default function ActivityPage() {
  const { data, error, loading, refresh } = useApi<ActivityDTO[]>("/api/activity", 20_000);

  return (
    <div className="mx-auto max-w-[960px] space-y-6">
      <header>
        <h1 className="font-display text-[32px] leading-tight font-extrabold tracking-tight">Activity</h1>
        <p className="mt-1 text-ink-2">Everything MINT did for you, each with its transaction on Stellar.</p>
      </header>
      {error && <ErrorState message={error} onRetry={refresh} />}
      <Card>
        {loading && (
          <div className="space-y-3 p-5">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        )}
        {data && data.length === 0 && <p className="p-5 text-muted">No activity yet. Claim test USDC in your wallet to get started.</p>}
        {data && data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-line text-muted">
                  <th scope="col" className="px-5 py-3 text-left font-normal">When</th>
                  <th scope="col" className="px-2 py-3 text-left font-normal">By</th>
                  <th scope="col" className="px-2 py-3 text-left font-normal">What happened</th>
                  <th scope="col" className="px-5 py-3 text-right font-normal">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id} className="border-b border-line last:border-0">
                    <td className="px-5 py-3 whitespace-nowrap text-muted">
                      <time dateTime={a.createdAt}>{timeAgo(a.createdAt)}</time>
                    </td>
                    <td className="px-2 py-3">
                      <Badge tone={a.actor === "agent" ? "accent" : a.kind === "halt" ? "danger" : "neutral"}>{ACTOR[a.actor]}</Badge>
                    </td>
                    <td className="px-2 py-3 text-ink">{a.summary}</td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      {a.txHash ? (
                        <a href={txUrl(a.txHash)} target="_blank" rel="noreferrer" className="rounded font-mono text-ink underline-offset-4 hover:underline">
                          {a.txHash.slice(0, 8)}
                        </a>
                      ) : (
                        <span className="text-muted">Off-chain</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

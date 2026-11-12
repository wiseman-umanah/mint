"use client";

import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, useApi } from "@/lib/client";
import type { MessageDTO, ProposalDTO } from "@/lib/types";
import { ProposalCard } from "./proposal-card";
import { Rail } from "./rail";
import { Button, ErrorState, Skeleton, cx } from "./ui";

type History = { messages: MessageDTO[]; proposals: ProposalDTO[] };

const SUGGESTIONS = [
  "What's moving in the markets today?",
  "Is BTC overbought right now?",
  "Who issues CETES, and what's the risk?",
  "Move 50 USDC into my trading vault",
  "Find a trade for my vault",
];

export function Assistant() {
  const history = useApi<History>("/api/chat");
  // Messages and proposal updates from this session, layered over the loaded history.
  const [sent, setSent] = useState<MessageDTO[]>([]);
  const [updated, setUpdated] = useState<Record<string, ProposalDTO>>({});
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const localId = useRef(0);

  const messages = useMemo(() => [...(history.data?.messages ?? []), ...sent], [history.data, sent]);
  const proposals = useMemo(
    () => ({ ...Object.fromEntries((history.data?.proposals ?? []).map((p) => [p.id, p])), ...updated }),
    [history.data, updated],
  );
  const setProposals = (list: ProposalDTO[]) => setUpdated((all) => ({ ...all, ...Object.fromEntries(list.map((p) => [p.id, p])) }));

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, sending]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending) return;
    setDraft("");
    setError(null);
    setSending(true);
    const optimistic: MessageDTO = {
      id: `local-${++localId.current}`,
      userId: "",
      role: "user",
      content: message,
      proposalIds: [],
      createdAt: "",
    };
    setSent((m) => [...m, optimistic]);
    try {
      const { reply, proposals: created } = await api<{ reply: MessageDTO; proposals: ProposalDTO[] }>("/api/chat", { body: { message } });
      setProposals(created);
      setSent((m) => [...m, reply]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "MINT couldn't reply");
      setDraft(message);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  };

  const empty = !history.loading && messages.length === 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section aria-label="Conversation with MINT" className="flex min-h-[calc(100dvh-12rem)] min-w-0 flex-col">
        <div className="flex-1 space-y-5" aria-live="polite">
          {history.loading && (
            <div className="space-y-4">
              <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
              <Skeleton className="h-20 w-4/5 rounded-2xl" />
            </div>
          )}
          {history.error && <ErrorState message={history.error} onRetry={history.refresh} />}

          {empty && (
            <div className="pt-6 sm:pt-12">
              <h1 className="font-display text-[32px] leading-tight font-extrabold tracking-tight text-ink sm:text-[40px]">
                What should we do with your money?
              </h1>
              <p className="mt-3 max-w-[52ch] text-ink-2">
                Ask in plain words. I stage every payment or trade as a proposal, the guardrails check it, and nothing moves until you confirm.
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="glass-card rounded-full px-4 py-2 text-left text-sm text-ink-2 transition-colors duration-[var(--dur-micro)] hover:text-ink"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className={cx("enter", m.role === "user" && "flex justify-end")}>
              {m.role === "user" ? (
                <p className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 whitespace-pre-wrap text-paper">
                  {m.content}
                </p>
              ) : (
                <div className="max-w-[640px] space-y-3">
                  <p className="leading-relaxed whitespace-pre-wrap text-ink">{m.content}</p>
                  {m.proposalIds.map((id) =>
                    proposals[id] ? (
                      <ProposalCard key={id} proposal={proposals[id]} onChange={(p) => setProposals([p])} />
                    ) : null,
                  )}
                </div>
              )}
            </div>
          ))}

          {sending && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <i className="ri-loader-4-line animate-spin" aria-hidden />
              MINT is checking the network
            </p>
          )}
          <div ref={endRef} />
        </div>

        <form onSubmit={onSubmit} className="sticky bottom-4 mt-6">
          {error && (
            <p role="alert" className="glass mb-2 flex gap-2 rounded-control px-3 py-2 text-sm text-ink">
              <i className="ri-error-warning-line" aria-hidden />
              {error}
            </p>
          )}
          <div className="glass flex items-end gap-2 rounded-[26px] p-2">
            <label htmlFor="composer" className="sr-only">
              Message MINT
            </label>
            <textarea
              id="composer"
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Send $25 USDC to @alex"
              className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-3 py-2 text-[15px] text-ink outline-none placeholder:text-muted"
            />
            <Button type="submit" aria-label="Send message" disabled={!draft.trim()} loading={sending} className="size-10 px-0">
              {!sending && <i className="ri-arrow-up-line text-lg" aria-hidden />}
            </Button>
          </div>
        </form>
      </section>

      <aside className="hidden lg:block" aria-label="Your accounts">
        <div className="sticky top-28">
          <Rail />
        </div>
      </aside>
    </div>
  );
}

"use client";

import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
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

const MESSAGE_COMPONENTS: Components = {
  h1: ({ children }) => <h2 className="font-display text-lg font-bold tracking-tight text-ink">{children}</h2>,
  h2: ({ children }) => <h2 className="font-display text-lg font-bold tracking-tight text-ink">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[15px] font-semibold text-ink">{children}</h3>,
  p: ({ children }) => <p className="leading-7 whitespace-pre-line text-ink">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1.5 pl-5 marker:text-muted">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1.5 pl-5 marker:text-muted">{children}</ol>,
  li: ({ children }) => <li className="pl-1 leading-7 text-ink">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="text-ink-2">{children}</em>,
  a: ({ children, href }) => {
    const external = href?.startsWith("http://") || href?.startsWith("https://");
    return (
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noreferrer" : undefined}
        className="break-words text-ink underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-ink"
      >
        {children}
      </a>
    );
  },
  blockquote: ({ children }) => <blockquote className="border-l-2 border-line-strong pl-4 text-ink-2">{children}</blockquote>,
  code: ({ children, className }) => (
    <code className={cx("rounded bg-well px-1.5 py-0.5 font-mono text-[0.9em] text-ink", className)}>{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-control border border-line bg-well p-4 text-sm leading-6 [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  hr: () => <hr className="border-line" />,
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-control border border-line">
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  tr: ({ children }) => <tr className="border-b border-line last:border-b-0">{children}</tr>,
  th: ({ children }) => <th className="bg-well px-3 py-2 font-medium text-ink">{children}</th>,
  td: ({ children }) => <td className="px-3 py-2 text-ink-2">{children}</td>,
};

function MessageContent({ content }: { content: string }) {
  return (
    <div className="min-w-0 space-y-3 break-words text-[15px] [&_li>p]:inline">
      <Markdown components={MESSAGE_COMPONENTS} skipHtml>
        {content}
      </Markdown>
    </div>
  );
}

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
                  <MessageContent content={m.content} />
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

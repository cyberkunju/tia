import { useState, useMemo } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { MessageSquare, Building2, Clock } from "lucide-react";
import { api } from "../api";
import { PageHeader, EmptyState, Badge } from "../ui";
import type { QueryThread } from "../types";

export function ClientQueries() {
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: api.listClients });
  const codes = useMemo(() => (clients ?? []).map((c) => c.code), [clients]);

  const queryResults = useQueries({
    queries: codes.map((code) => ({
      queryKey: ["queries", code],
      queryFn: () => api.listQueries(code),
      refetchInterval: 5_000,
    })),
  });

  const all: { client: string; thread: QueryThread }[] = useMemo(() => {
    const rows: { client: string; thread: QueryThread }[] = [];
    queryResults.forEach((r, i) => {
      if (r.data) r.data.forEach((q) => rows.push({ client: codes[i], thread: q }));
    });
    rows.sort((a, b) => (b.thread.raised_at ?? "").localeCompare(a.thread.raised_at ?? ""));
    return rows;
  }, [queryResults, codes]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => all.find((r) => r.thread.id === selectedId) ?? all[0] ?? null,
    [all, selectedId],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        icon={MessageSquare}
        title="Your queries"
        description="Conversations with TASC's FinOps team about specific invoices."
      />

      {all.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={MessageSquare}
            title="No queries yet"
            hint="Open Invoices and use 'Raise query' on any invoice to start a thread."
          />
        </div>
      ) : (
        <div className="grid lg:grid-cols-[280px_1fr] gap-4">
          {/* List */}
          <div className="card-flush overflow-hidden">
            <ul className="divide-y divide-ink-100">
              {all.map(({ client, thread }) => {
                const active = selected?.thread.id === thread.id;
                return (
                  <li key={thread.id}>
                    <button
                      onClick={() => setSelectedId(thread.id)}
                      className={`w-full text-left px-3 py-3 transition-colors ${active ? "bg-brand-50" : "hover:bg-ink-50"}`}
                    >
                      <div className="flex items-center gap-1.5 text-2xs text-ink-500 mb-0.5">
                        <Building2 size={11} /> {client}
                        <span className="ml-auto">
                          <ThreadStatus status={thread.status} />
                        </span>
                      </div>
                      <p className="text-sm font-medium text-ink-900 truncate">{thread.subject}</p>
                      {thread.raised_at && (
                        <p className="text-2xs text-ink-400 mt-0.5">
                          <Clock size={9} className="inline" /> {thread.raised_at.slice(0, 16).replace("T", " ")}
                        </p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Detail */}
          {selected && <ThreadView client={selected.client} thread={selected.thread} />}
        </div>
      )}
    </div>
  );
}

function ThreadStatus({ status }: { status: QueryThread["status"] }) {
  if (status === "open") return <Badge tone="amber">Open</Badge>;
  if (status === "answered") return <Badge tone="blue">Answered</Badge>;
  return <Badge tone="green">Closed</Badge>;
}

function ThreadView({ client, thread }: { client: string; thread: QueryThread }) {
  return (
    <div className="card overflow-hidden flex flex-col">
      <header className="px-5 py-4 border-b border-ink-200 bg-ink-50/40">
        <div className="flex items-center gap-2 text-2xs text-ink-500 mb-1">
          <Building2 size={12} /> {client}
          {thread.invoice_id && <span className="text-2xs">· invoice {thread.invoice_id.slice(0, 8)}</span>}
        </div>
        <h2 className="text-base font-semibold text-ink-900">{thread.subject}</h2>
      </header>
      <div className="flex-1 px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
        {(thread.thread ?? []).map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "client" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 ${
              msg.role === "client"
                ? "bg-brand-50 border border-brand-100 text-ink-900"
                : "bg-teal-50 border border-teal-100 text-ink-900"
            }`}>
              <p className="text-2xs font-medium opacity-70 mb-0.5">
                {msg.role === "client" ? `${msg.by} (you)` : `${msg.by} · TASC FinOps`}
                <span className="ml-1.5 opacity-70">· {msg.at.slice(11, 16)}</span>
              </p>
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.body || <em className="text-ink-400">(empty)</em>}</p>
            </div>
          </div>
        ))}
        {thread.status === "open" && (
          <p className="text-2xs text-ink-400 text-center pt-2">FinOps will reply here.</p>
        )}
      </div>
    </div>
  );
}

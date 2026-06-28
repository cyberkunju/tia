import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Send } from "lucide-react";
import { api } from "../api";
import { cn, fmtAge } from "../lib";
import { PageHeader, Panel, Badge, EmptyState, Spinner } from "../ui";
import { Select } from "../components/Select";
import { usePersona } from "../store";

export function ClientQueries() {
  const qc = useQueryClient();
  const { currentClientCode } = usePersona();
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: api.listClients });
  // Local override lets the user inspect another client's threads without
  // changing the global "Acting as" identity. Defaults to the global pick.
  const [override, setOverride] = useState<string>("");
  const code = override || currentClientCode || clients?.[0]?.code || "";

  const { data: threads, isLoading } = useQuery({
    queryKey: ["queries", code], queryFn: () => api.listQueries(code), enabled: !!code, refetchInterval: 5_000,
  });

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const raise = useMutation({
    mutationFn: () => api.raiseQuery(code, { subject, body, raised_by: "client" }),
    onSuccess: () => { setSubject(""); setBody(""); qc.invalidateQueries({ queryKey: ["queries", code] }); },
  });

  return (
    <div>
      <PageHeader icon={MessageSquare} title="Queries" description="Raise a billing question for FinOps and track the conversation."
        actions={
          <Select
            className="w-auto min-w-[220px]"
            value={code}
            onChange={(v) => setOverride(v)}
            options={(clients ?? []).map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))}
            align="right"
            ariaLabel="Select client"
          />
        } />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4">
        <div className="space-y-3">
          {isLoading && <div className="text-ink-500 text-sm flex items-center gap-2"><Spinner /> Loading…</div>}
          {!isLoading && (!threads || threads.length === 0) && <Panel><EmptyState icon={MessageSquare} title="No queries yet" hint="Raise one on the right." /></Panel>}
          {threads?.map((q) => <Thread key={q.id} q={q} code={code} />)}
        </div>

        <Panel title="Raise a query">
          <label className="field-label">Subject</label>
          <input className="input mb-3" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Overtime on invoice #…" />
          <label className="field-label">Details</label>
          <textarea className="textarea h-28" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Describe the question…" />
          <div className="flex justify-end mt-3">
            <button className="btn-primary btn-sm" disabled={!subject || raise.isPending} onClick={() => raise.mutate()}>
              {raise.isPending ? <Spinner /> : <Send size={14} />} Submit
            </button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Thread({ q, code }: { q: import("../types").QueryThread; code: string }) {
  const qc = useQueryClient();
  const [reply, setReply] = useState("");
  const send = useMutation({
    mutationFn: () => api.replyToQuery(q.id, { body: reply, by_user: "client" }),
    onSuccess: () => { setReply(""); qc.invalidateQueries({ queryKey: ["queries", code] }); },
  });
  const tone = q.status === "closed" ? "slate" : q.status === "answered" ? "green" : "amber";
  return (
    <Panel title={q.subject} subtitle={`Raised ${fmtAge(q.raised_at)} ago`} actions={<Badge tone={tone}>{q.status}</Badge>}>
      <div className="space-y-2">
        {q.body && <Bubble role="client" by={q.raised_by ?? "client"} body={q.body} />}
        {q.thread.map((m, i) => <Bubble key={i} role={m.role} by={m.by} body={m.body} />)}
      </div>
      <div className="flex items-center gap-2 mt-3">
        <input className="input" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" onKeyDown={(e) => e.key === "Enter" && reply && send.mutate()} />
        <button className="btn-outline btn-sm" disabled={!reply || send.isPending} onClick={() => send.mutate()}><Send size={14} /></button>
      </div>
    </Panel>
  );
}

function Bubble({ role, by, body }: { role: string; by: string; body: string }) {
  const mine = role === "client";
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[80%] rounded-lg px-3 py-2 text-sm", mine ? "bg-brand-50 text-ink-800 rounded-br-sm" : "bg-ink-100 text-ink-700 rounded-bl-sm")}>
        <div className="text-2xs text-ink-400 mb-0.5">{by} · {role}</div>{body}
      </div>
    </div>
  );
}

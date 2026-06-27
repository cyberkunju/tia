import { useState, useRef, useEffect } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { MessageSquare as _MessageSquare, X, Send, Loader2, Sparkles, ExternalLink } from "lucide-react";
void _MessageSquare;
import { api } from "../api";
import type { QAResponse } from "../types";
import { cn } from "../lib";

type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; citations?: QAResponse["citations"]; tools?: QAResponse["tool_calls"]; model?: string };

function deriveContext(pathname: string, params: { docId?: string; clientCode?: string; code?: string }): { kind: string; id: string } | undefined {
  if (params.docId && pathname.includes("/review/")) return { kind: "doc", id: params.docId };
  if ((params.clientCode || params.code) && pathname.includes("/clients/")) return { kind: "client", id: params.clientCode ?? params.code! };
  if (pathname.includes("/finance")) return undefined;
  return undefined;
}

export function ChatWidget() {
  const loc = useLocation();
  const params = useParams<{ docId?: string; clientCode?: string; code?: string }>();
  const ctx = deriveContext(loc.pathname, params);
  const [open, setOpen] = useState(false);
  const [question, setQ] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  const ask = useMutation({
    mutationFn: (q: string) => api.qa(q, ctx),
    onSuccess: (resp) => setMessages((m) => [
      ...m,
      { role: "assistant", text: resp.answer, citations: resp.citations, tools: resp.tool_calls, model: resp.model },
    ]),
    onError: (e) => setMessages((m) => [
      ...m,
      { role: "assistant", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
    ]),
  });

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, ask.isPending]);

  function submit() {
    const q = question.trim();
    if (!q || ask.isPending) return;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setQ("");
    ask.mutate(q);
  }

  return (
    <>
      {/* Floating launcher (right edge) */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-30 inline-flex items-center gap-2 rounded-full bg-brand-500 text-teal-950 font-semibold pl-4 pr-5 py-2.5 shadow-lg hover:bg-brand-400 hover:scale-[1.02] transition-all"
          aria-label="Open TIA chat"
        >
          <Sparkles size={18} strokeWidth={2.5} />
          Ask TIA
        </button>
      )}

      {/* Panel */}
      {open && (
        <div className="fixed bottom-5 right-5 z-30 w-[380px] max-w-[calc(100vw-2.5rem)] h-[560px] max-h-[calc(100vh-2.5rem)] flex flex-col rounded-xl bg-white border border-ink-200 shadow-lg animate-slide-in-right">
          <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-ink-200 bg-teal-900 rounded-t-xl">
            <div className="flex items-center gap-2 text-white">
              <Sparkles size={16} className="text-brand-400" />
              <div>
                <div className="text-sm font-semibold tracking-tight">TIA · Ask anything</div>
                <div className="text-2xs text-teal-200">
                  {ctx ? `Context: ${ctx.kind}/${ctx.id.slice(0, 8)}` : "Grounded · cited · refuses without evidence"}
                </div>
              </div>
            </div>
            <button onClick={() => setOpen(false)} className="grid place-items-center h-8 w-8 rounded-md text-white hover:bg-teal-800" aria-label="Close chat">
              <X size={16} />
            </button>
          </header>

          <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3 bg-ink-50/40">
            {messages.length === 0 && (
              <div className="text-xs text-ink-500 leading-relaxed">
                <p className="font-medium text-ink-700 mb-1">Try:</p>
                <ul className="space-y-1">
                  <li>• "Why is this timesheet in HITL?"</li>
                  <li>• "What's the rate card for CL001?"</li>
                  <li>• "List events for invoice X"</li>
                </ul>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cn(
                "rounded-lg px-3 py-2 text-sm leading-relaxed",
                m.role === "user" ? "ml-6 bg-brand-50 border border-brand-100 text-ink-900" : "mr-6 bg-white border border-ink-200 text-ink-800",
              )}>
                {m.text || <span className="text-ink-400">(empty)</span>}
                {m.role === "assistant" && m.citations && m.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {m.citations.map((c, ci) => (
                      <span key={ci} className="inline-flex items-center gap-1 rounded-md bg-teal-50 text-teal-800 border border-teal-200 px-1.5 py-0.5 text-2xs font-medium">
                        <ExternalLink size={10} />{c.kind}:{c.id.length > 10 ? c.id.slice(0, 8) + "…" : c.id}
                      </span>
                    ))}
                  </div>
                )}
                {m.role === "assistant" && m.tools && m.tools.length > 0 && (
                  <div className="mt-2 text-2xs text-ink-500">
                    <span className="font-medium">Tools:</span>{" "}
                    {m.tools.map((t) => t.name).join(", ")}
                    {m.model && <span className="ml-2 opacity-70">· {m.model}</span>}
                  </div>
                )}
              </div>
            ))}
            {ask.isPending && (
              <div className="mr-6 inline-flex items-center gap-2 rounded-lg bg-white border border-ink-200 px-3 py-2 text-sm text-ink-500">
                <Loader2 size={14} className="animate-spin" /> Thinking…
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); submit(); }}
            className="border-t border-ink-200 p-3 bg-white rounded-b-xl"
          >
            <div className="flex items-end gap-2">
              <textarea
                value={question}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
                rows={2}
                placeholder="Ask TIA — grounded in your DB"
                className="textarea text-sm flex-1 resize-none"
              />
              <button
                type="submit"
                disabled={!question.trim() || ask.isPending}
                className="grid place-items-center h-10 w-10 rounded-md bg-brand-500 text-teal-950 hover:bg-brand-400 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Send"
              >
                <Send size={16} />
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

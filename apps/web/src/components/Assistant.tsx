/**
 * AIDA — the side-panel chat. Now with:
 *  - structured-event SSE consumer (`/qa/stream`)
 *  - live "tool-call strip" inside each AIDA bubble (Cursor-style)
 *  - token-by-token streaming render of the final answer
 *  - contextual icebreakers via `generateIcebreakers(ctx)` — two 3-prompt cards
 *  - entity pill in the header (reflects `?aida=` URL param)
 *  - resizable left edge (360–640px), persisted in localStorage
 *  - per-persona conversation persistence (cap 50 turns)
 *  - "New chat" button + entity-clear button
 *  - auto-grow textarea (Enter sends, Shift-Enter newline)
 *  - auto-scroll only when user is already near the bottom
 *  - pipe-table → <table> rendering after streaming completes
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  GripVertical,
  Loader2,
  Lock,
  MessageSquarePlus,
  X,
} from "lucide-react";
import { api } from "../api";
import { stripMarkdown } from "../lib";
import { Logo } from "./Logo";
import { usePersona } from "../store";
import { generateIcebreakers } from "../icebreakers";
import type { FocusedEntity, QaStreamEvent } from "../types";

// ---------- Types -----------------------------------------------------------

type ToolEvent = {
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  result_summary?: string;
  error?: string;
};

type Msg = {
  role: "user" | "aida";
  text: string;
  tools?: ToolEvent[];
  cites?: { kind: string; id: string }[];
  model?: string;
  /** `true` while AIDA is still streaming this message. */
  streaming?: boolean;
};

// ---------- localStorage persistence ---------------------------------------

const HISTORY_CAP = 50;

function historyKey(persona: string) {
  return `tia.chat.history.${persona}`;
}

function loadHistory(persona: string): Msg[] {
  try {
    const raw = localStorage.getItem(historyKey(persona));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Msg[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-HISTORY_CAP);
  } catch {
    return [];
  }
}

function saveHistory(persona: string, msgs: Msg[]) {
  try {
    localStorage.setItem(historyKey(persona), JSON.stringify(msgs.slice(-HISTORY_CAP)));
  } catch {
    /* quota or private mode — silently ignore */
  }
}

const WIDTH_KEY = "tia.chat.width";
const WIDTH_MIN = 360;
const WIDTH_MAX = 640;

function loadWidth(): number {
  const raw = Number(localStorage.getItem(WIDTH_KEY));
  if (Number.isFinite(raw) && raw >= WIDTH_MIN && raw <= WIDTH_MAX) return raw;
  return 410;
}

// ---------- URL ?aida= decoding --------------------------------------------

function decodeAida(raw: string | null): FocusedEntity | null {
  if (!raw) return null;
  if (raw.includes(":")) {
    const [kind, ...rest] = raw.split(":");
    const id = rest.join(":");
    if (!id) return null;
    if (kind === "doc" || kind === "document") return { kind: "document", id };
    if (kind === "timesheet" || kind === "ts") return { kind: "timesheet", id };
    if (kind === "invoice" || kind === "inv") return { kind: "invoice", id };
  }
  // bare id → invoice
  return { kind: "invoice", id: raw };
}

// ---------- Tiny UI atoms ---------------------------------------------------

function AidaMark({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const glyph = size === "lg" ? "h-10" : size === "sm" ? "h-4" : "h-5";
  return <Logo className={`${glyph} text-brand-500 shrink-0`} accent="fill-brand-500" />;
}

function CiteChip({ kind, id }: { kind: string; id: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-brand-100 bg-brand-50 px-1.5 py-0.5 text-2xs font-medium text-brand-700">
      <span className="uppercase tracking-wide opacity-70">{kind}</span>
      <code className="font-mono">{id.slice(0, 8)}</code>
    </span>
  );
}

/**
 * Live tool-call strip — one row per tool the agent has fired this turn.
 * Status icons: spinner (running) → check (done) → "!" (error).
 */
function ToolStrip({ tools }: { tools: ToolEvent[] }) {
  if (tools.length === 0) return null;
  return (
    <div className="mt-2 rounded-lg border border-ink-200 bg-ink-50/60 px-2.5 py-1.5">
      <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">
        TIA called {tools.length} tool{tools.length === 1 ? "" : "s"}
      </div>
      <ul className="space-y-0.5">
        {tools.map((t, j) => (
          <li key={j} className="flex items-center gap-1.5 font-mono text-2xs text-ink-700">
            <span className="grid place-items-center h-3.5 w-3.5 shrink-0">
              {t.status === "running" ? (
                <Loader2 size={9} className="animate-spin text-brand-500" />
              ) : t.status === "done" ? (
                <Check size={10} className="text-emerald-600" />
              ) : (
                <span className="text-rose-600">!</span>
              )}
            </span>
            <span className="font-medium text-ink-800 truncate">{t.name}</span>
            <span className="text-ink-400 truncate">
              ({Object.values(t.args || {}).map(String).join(", ").slice(0, 50)})
            </span>
            {t.result_summary && (
              <span className="ml-auto text-ink-500 truncate pl-2 max-w-[50%] text-right">
                {t.result_summary}
              </span>
            )}
            {t.error && (
              <span className="ml-auto text-rose-600 truncate pl-2 max-w-[50%] text-right">
                {t.error}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Render a pipe-style markdown table verbatim, but only after streaming has
 * settled — during streaming we render plain text so partial tables don't flicker.
 */
function renderBody(text: string, streaming: boolean): ReactNode {
  if (streaming) return <>{text}</>;
  const lines = text.split("\n");
  const tableStart = lines.findIndex((l) => /^\s*\|.+\|\s*$/.test(l));
  if (tableStart < 0) return <>{stripMarkdown(text)}</>;
  // Find end of table block
  let end = tableStart;
  while (end < lines.length && /^\s*\|.+\|\s*$/.test(lines[end])) end++;
  const before = lines.slice(0, tableStart).join("\n");
  const tableLines = lines.slice(tableStart, end);
  const after = lines.slice(end).join("\n");

  const rows = tableLines
    .map((l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()))
    .filter((r) => !r.every((c) => /^-{2,}$/.test(c) || c === ""));
  const [header, ...body] = rows;

  return (
    <>
      {before && <div>{stripMarkdown(before)}</div>}
      <table className="mt-2 mb-2 w-full text-2xs border-collapse">
        <thead>
          <tr className="border-b border-ink-200">
            {header?.map((h, i) => (
              <th key={i} className="text-left font-semibold text-ink-700 py-1 pr-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className="border-b border-ink-100 last:border-0">
              {r.map((c, j) => (
                <td key={j} className="py-1 pr-2 text-ink-800 font-mono">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {after && <div>{stripMarkdown(after)}</div>}
    </>
  );
}

// ---------- Main panel ------------------------------------------------------

export function Assistant({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { persona, currentClientCode, focusedEntity, setFocusedEntity } = usePersona();
  const [msgs, setMsgs] = useState<Msg[]>(() => loadHistory(persona));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState<number>(() => loadWidth());
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [sp, setSp] = useSearchParams();
  const loc = useLocation();

  // Sync focusedEntity ↔ URL ?aida=
  useEffect(() => {
    const aida = sp.get("aida");
    const decoded = decodeAida(aida);
    if (!decoded) {
      if (focusedEntity != null) setFocusedEntity(null);
    } else if (
      !focusedEntity ||
      focusedEntity.id !== decoded.id ||
      focusedEntity.kind !== decoded.kind
    ) {
      setFocusedEntity(decoded);
    }
    // run on sp changes only — focusedEntity is reactive to URL
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);

  // Persona switch → load that persona's history
  useEffect(() => {
    setMsgs(loadHistory(persona));
  }, [persona]);

  // Persist on every msg change
  useEffect(() => {
    saveHistory(persona, msgs);
  }, [msgs, persona]);

  // Persist width
  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      /* ignore */
    }
  }, [width]);

  // Focus the composer on open
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 220);
  }, [open]);

  // Auto-scroll only if user is already near the bottom (within 100px of end)
  useEffect(() => {
    const s = scrollerRef.current;
    if (!s) return;
    const nearBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 100;
    if (nearBottom) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs, busy]);

  // Auto-grow textarea
  useEffect(() => {
    const t = inputRef.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 6 * 22) + "px";
  }, [input]);

  // Resize drag (left edge)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onDragStart = (e: React.PointerEvent) => {
    dragRef.current = { startX: e.clientX, startW: width };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const delta = dragRef.current.startX - e.clientX; // pulling LEFT widens
    const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, dragRef.current.startW + delta));
    setWidth(next);
  };
  const onDragEnd = () => {
    dragRef.current = null;
  };

  const ctx = useMemo(
    () => ({
      persona,
      route: loc.pathname,
      focusedEntity,
      invoiceStatus: undefined,
    }),
    [persona, loc.pathname, focusedEntity],
  );
  const icebreakers = useMemo(() => generateIcebreakers(ctx), [ctx]);

  const clientScoped = persona === "client" && currentClientCode;

  // Build the entity_context payload from the focused entity (the agent uses
  // this as a hint to know which entity to look up first).
  const entityContext = useMemo<{ kind: string; id: string } | undefined>(() => {
    if (focusedEntity) return { kind: focusedEntity.kind, id: focusedEntity.id };
    // legacy fallback: ?doc=<id> from older screens
    const doc = sp.get("doc");
    return doc ? { kind: "document", id: doc } : undefined;
  }, [focusedEntity, sp]);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setMsgs((m) => [...m, { role: "user", text: t }]);
    setInput("");
    setBusy(true);

    // Snapshot prior turns so the agent can answer follow-ups ("why?", "show
    // me that one again"). We send the LAST 12 messages (mirrors the backend
    // cap inside _build_messages). Tool/cite metadata is dropped — only the
    // user/assistant text matters for context.
    const history: { role: "user" | "assistant"; content: string }[] = msgs
      .slice(-12)
      .filter((m) => m.text && m.text.trim())
      .map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      }));

    // Append a placeholder AIDA bubble that we'll populate as events arrive
    const aidaIdx = msgs.length + 1;
    setMsgs((m) => [...m, { role: "aida", text: "", tools: [], streaming: true }]);

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      let textBuf = "";
      const tools: ToolEvent[] = [];

      for await (const ev of api.qaStream(
        t,
        entityContext,
        clientScoped ? currentClientCode : null,
        ac.signal,
        history,
      )) {
        if ((ev as QaStreamEvent).type === "tool") {
          const tev = ev as Extract<QaStreamEvent, { type: "tool" }>;
          if (tev.status === "running") {
            tools.push({ name: tev.name, args: tev.args, status: "running" });
          } else if (tev.status === "done") {
            // mark the most recent matching running tool as done
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i].name === tev.name && tools[i].status === "running") {
                tools[i] = {
                  ...tools[i],
                  status: "done",
                  result_summary: tev.result_summary,
                };
                break;
              }
            }
          } else if (tev.status === "error") {
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i].name === tev.name && tools[i].status === "running") {
                tools[i] = { ...tools[i], status: "error", error: tev.error };
                break;
              }
            }
          }
          setMsgs((m) => {
            const next = [...m];
            next[aidaIdx] = { ...next[aidaIdx], tools: [...tools] };
            return next;
          });
        } else if (ev.type === "token") {
          textBuf += ev.content;
          setMsgs((m) => {
            const next = [...m];
            next[aidaIdx] = { ...next[aidaIdx], text: textBuf };
            return next;
          });
        } else if (ev.type === "done") {
          setMsgs((m) => {
            const next = [...m];
            next[aidaIdx] = {
              ...next[aidaIdx],
              cites: ev.citations,
              model: ev.model,
              streaming: false,
            };
            return next;
          });
        } else if (ev.type === "error") {
          // Surface the agent's error verbatim so the user sees what failed —
          // generic localAnswer fallback hides root causes (missing API key,
          // model 4xx, etc).
          const msg =
            ev.message && ev.message.length
              ? `TIA couldn't answer this one: ${ev.message}`
              : "TIA couldn't answer that. Try again or rephrase.";
          setMsgs((m) => {
            const next = [...m];
            next[aidaIdx] = {
              ...next[aidaIdx],
              text: textBuf || msg,
              streaming: false,
            };
            return next;
          });
        }
      }
    } catch (e) {
      // Hard transport failure (CORS, network, fetch abort that isn't
      // the abort signal we set). Show the message so the user knows
      // it's an environment issue, not the prompt's fault.
      const errMsg = (e as Error)?.name === "AbortError"
        ? "(cancelled)"
        : `Network error reaching TIA: ${(e as Error).message || e}`;
      setMsgs((m) => {
        const next = [...m];
        if (next[aidaIdx]) {
          next[aidaIdx] = {
            ...next[aidaIdx],
            text: next[aidaIdx].text || errMsg,
            streaming: false,
          };
        }
        return next;
      });
      void e;
    } finally {
      setBusy(false);
      setMsgs((m) => {
        const next = [...m];
        if (next[aidaIdx]) {
          next[aidaIdx] = { ...next[aidaIdx], streaming: false };
        }
        return next;
      });
    }
  };

  const clearFocus = () => {
    setFocusedEntity(null);
    const next = new URLSearchParams(sp);
    next.delete("aida");
    setSp(next, { replace: true });
  };

  const newChat = () => {
    abortRef.current?.abort();
    setMsgs([]);
    saveHistory(persona, []);
    clearFocus();
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 bg-ink-950/25 backdrop-blur-[1px] z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            style={{
              transformOrigin: "bottom right",
              width: `min(${width}px, calc(100vw - 24px))`,
            }}
            className="fixed z-50 flex flex-col bg-white overflow-hidden
                       inset-x-3 top-3 bottom-3
                       sm:inset-x-auto sm:left-auto sm:right-4 sm:top-4 sm:bottom-4
                       rounded-2xl border border-brand-200/80 shadow-2xl shadow-brand-900/15"
            initial={{ opacity: 0, scale: 0.98, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 10 }}
            transition={{ type: "spring", stiffness: 340, damping: 32 }}
          >
            {/* Resize handle on the left edge - hidden on small screens (touch UI doesn't need it). */}
            <div
              onPointerDown={onDragStart}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onPointerCancel={onDragEnd}
              className="hidden sm:flex absolute left-0 top-1/2 -translate-y-1/2 -translate-x-2 z-10 h-12 w-3 cursor-ew-resize items-center justify-center rounded-l-md bg-ink-100/0 hover:bg-ink-100 transition-colors"
              aria-label="Resize chat panel"
              role="separator"
            >
              <GripVertical size={12} className="text-ink-400" />
            </div>

            {/* Header */}
            <header className="flex items-center justify-between gap-3 px-4 h-14 border-b border-ink-100 shrink-0">
              <div className="leading-tight min-w-0">
                <div className="text-sm font-semibold text-ink-900 tracking-tight">TIA</div>
                <div className="text-2xs text-ink-400 truncate">
                  {clientScoped ? (
                    <>
                      Scoped to{" "}
                      <span className="font-mono text-brand-600">{currentClientCode}</span> · live data
                    </>
                  ) : (
                    "Grounded in live data"
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={newChat}
                  aria-label="New chat"
                  title="Start a fresh conversation"
                  className="grid place-items-center h-8 w-8 rounded-lg text-ink-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                >
                  <MessageSquarePlus size={15} />
                </button>
                <button
                  onClick={onClose}
                  aria-label="Close chat"
                  className="grid place-items-center h-8 w-8 rounded-lg text-ink-400 hover:text-ink-700 hover:bg-ink-100 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </header>

            {/* Entity pill */}
            {focusedEntity && (
              <div className="flex items-center justify-between gap-2 px-4 py-1.5 bg-brand-50/70 border-b border-brand-100 text-2xs text-brand-800">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="uppercase tracking-wide opacity-70 shrink-0">
                    Focused
                  </span>
                  <span className="font-mono truncate">
                    {focusedEntity.ref ?? `${focusedEntity.kind}:${focusedEntity.id.slice(0, 12)}`}
                  </span>
                </div>
                <button
                  onClick={clearFocus}
                  aria-label="Clear focused entity"
                  className="grid place-items-center h-5 w-5 rounded text-brand-500 hover:text-brand-700 hover:bg-brand-100 transition-colors shrink-0"
                >
                  <X size={11} />
                </button>
              </div>
            )}

            {clientScoped && (
              <div className="flex items-center gap-1.5 px-4 py-1.5 bg-brand-50/70 border-b border-brand-100 text-2xs text-brand-800">
                <Lock size={11} className="text-brand-500 shrink-0" />
                Data isolation active - TIA only reads{" "}
                <span className="font-mono">{currentClientCode}</span>'s records.
              </div>
            )}

            {/* Conversation */}
            <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-4">
              {msgs.length === 0 ? (
                <div className="h-full flex flex-col">
                  <div className="flex-1 flex flex-col items-center justify-center text-center px-2">
                    <AidaMark size="lg" />
                    <h3 className="mt-4 text-base font-semibold text-ink-900">Ask TIA anything</h3>
                    <p className="mt-1.5 text-sm text-ink-500 max-w-[19rem] leading-relaxed">
                      Grounded answers from the live pipeline — and now, when you ask for it, real
                      actions taken on the audit chain.
                    </p>
                  </div>
                  <div className="w-full mx-auto mt-4 space-y-3">
                    {icebreakers.groups.map((g, gi) => (
                      <div key={gi}>
                        <div className="eyebrow mb-1.5">{g.title}</div>
                        <div className="space-y-1.5">
                          {g.items.map((it) => (
                            <button
                              key={it.label}
                              type="button"
                              disabled={busy}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                send(it.prompt);
                              }}
                              className="group w-full flex items-center justify-between gap-2 rounded-xl border border-ink-200 bg-white px-3.5 py-2.5 text-left text-sm text-ink-700 shadow-xs hover:border-brand-300 hover:bg-brand-50/50 hover:text-ink-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <span>{it.label}</span>
                              <ArrowUpRight
                                size={14}
                                className="text-ink-300 group-hover:text-brand-500 transition-colors shrink-0"
                              />
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {msgs.map((m, i) =>
                    m.role === "user" ? (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.18 }}
                        className="flex justify-end"
                      >
                        <div className="max-w-[85%] rounded-2xl rounded-br-md brand-band text-white px-3.5 py-2.5 text-sm leading-relaxed shadow-sm">
                          {m.text}
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.18 }}
                        className="flex justify-start"
                      >
                        <div className="min-w-0 max-w-[92%]">
                          <div className="rounded-2xl rounded-tl-md border border-ink-200 bg-white text-ink-800 px-3.5 py-2.5 text-sm leading-relaxed shadow-xs whitespace-pre-wrap">
                            {m.text ? (
                              renderBody(m.text, !!m.streaming)
                            ) : m.streaming ? (
                              <span className="aida-thinking text-sm font-medium">Thinking…</span>
                            ) : (
                              <span className="text-ink-400">no response</span>
                            )}
                            {m.streaming && m.text && (
                              <span className="inline-block w-1.5 h-3 ml-0.5 bg-brand-500 animate-pulse align-middle" />
                            )}
                          </div>
                          {m.tools && m.tools.length > 0 && <ToolStrip tools={m.tools} />}
                          {m.cites && m.cites.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {m.cites.map((c, j) => (
                                <CiteChip key={j} kind={c.kind} id={c.id} />
                              ))}
                            </div>
                          )}
                          {m.model && (
                            <div className="mt-1 pl-0.5 font-mono text-[10px] text-ink-400">
                              {m.model}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    ),
                  )}
                  <div ref={endRef} />
                </div>
              )}
            </div>

            {/* Composer */}
            <div className="border-t border-ink-100 p-3 shrink-0">
              <div className="flex items-end gap-2 rounded-2xl border border-ink-200 bg-white pl-3 pr-1.5 py-1 transition-shadow focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-500/15">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  placeholder="Ask TIA…   (Shift-Enter = newline)"
                  rows={1}
                  className="flex-1 min-w-0 resize-none bg-transparent py-1.5 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none max-h-[132px]"
                />
                <button
                  onClick={() => send(input)}
                  disabled={busy || !input.trim()}
                  aria-label="Send"
                  className="grid place-items-center h-8 w-8 rounded-xl brand-band text-white shadow-sm transition-all hover:shadow disabled:opacity-40 disabled:saturate-50 disabled:shadow-none shrink-0"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={16} />}
                </button>
              </div>
              <p className="mt-2 text-center text-2xs text-ink-400">
                Answers are grounded in TIA's data — never fabricated.
              </p>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

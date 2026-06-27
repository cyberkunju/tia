import { useEffect, useState } from "react";
import { Activity, Radio } from "lucide-react";
import { API_BASE } from "../api";
import { Panel } from "../ui";
import { cn, fmtAge } from "../lib";
import type { EventRow } from "../types";

const ACTION_TONE: Record<string, string> = {
  ingested: "bg-ink-100 text-ink-700",
  extracted: "bg-sky-50 text-sky-700",
  resolved: "bg-sky-50 text-sky-700",
  rules_evaluated: "bg-teal-50 text-teal-700",
  routed: "bg-amber-50 text-amber-700",
  generated: "bg-emerald-50 text-emerald-700",
  dispatched: "bg-emerald-50 text-emerald-700",
  auto_dispatched_within_tolerance: "bg-brand-100 text-brand-900",
  client_approved: "bg-brand-50 text-brand-800",
  client_rejected: "bg-red-50 text-red-700",
  finance_approved: "bg-brand-50 text-brand-800",
  finance_rejected: "bg-red-50 text-red-700",
};

/**
 * LiveActivityRail — Server-Sent Events stream from /events/stream.
 *
 * Keeps a rolling window of the latest 30 events. The Radio dot pulses while
 * connected. ponytail: a single EventSource with no reconnect backoff — the
 * browser handles reconnects automatically.
 */
export function LiveActivityRail({ max = 25 }: { max?: number }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/events/stream`);
    es.addEventListener("hello", () => setConnected(true));
    es.addEventListener("event", (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data) as EventRow;
        setEvents((prev) => [ev, ...prev].slice(0, max));
      } catch { /* ignore */ }
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [max]);

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Activity size={13} /> Live activity
          <span className={cn("inline-flex items-center gap-1 text-2xs font-medium", connected ? "text-emerald-700" : "text-ink-400")}>
            <span className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-500 animate-pulse" : "bg-ink-300")} />
            <Radio size={10} /> {connected ? "streaming" : "connecting…"}
          </span>
        </span>
      }
      subtitle="SSE feed of every event TIA emits — auto-reconnects."
    >
      {events.length === 0 ? (
        <p className="text-xs text-ink-400">Waiting for events…</p>
      ) : (
        <ol className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
          {events.map((e) => (
            <li key={e.id} className="flex items-start gap-2 text-xs">
              <span className="text-2xs font-mono text-ink-400 tnum w-10 shrink-0">{e.at.slice(11, 19)}</span>
              <span className={cn("rounded px-1.5 py-0.5 text-2xs font-medium", ACTION_TONE[e.action] ?? "bg-ink-100 text-ink-700")}>
                {e.action.replace(/_/g, " ")}
              </span>
              <span className="text-ink-600 truncate min-w-0">
                {e.kind}/{e.entity_id.slice(0, 8)}
                <span className="ml-1 text-ink-400">· {e.actor ?? "system"}</span>
                <span className="ml-1 text-ink-400">· {fmtAge(e.at)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Inbox, ChevronLeft } from "lucide-react";
import { api } from "../api";
import { cn, fmtAge, fmtPct } from "../lib";
import { ConfidenceBadge, Badge, EmptyState, Spinner } from "../ui";
import { DocFocus } from "../components/DocFocus";
import type { DocSummary, Invoice } from "../types";

type StageId = "intake" | "review" | "validate" | "invoice" | "dispatch";
const STAGES: { id: StageId; label: string }[] = [
  { id: "intake", label: "Intake" },
  { id: "review", label: "Review" },
  { id: "validate", label: "Validated" },
  { id: "invoice", label: "Invoice" },
  { id: "dispatch", label: "Dispatch" },
];

function stageOf(d: DocSummary, invByTs: Record<string, Invoice>): StageId {
  if (d.status === "ingested") return "intake";
  if (d.status === "awaiting_review" || d.status === "rejected") return "review";
  const inv = d.timesheet_id ? invByTs[d.timesheet_id] : undefined;
  if (inv?.status === "dispatched") return "dispatch";
  if (inv?.status === "generated") return "invoice";
  if (d.status === "invoice_generated" || d.status === "approved") return "invoice";
  return "validate";
}

export function Console() {
  const [params, setParams] = useSearchParams();
  const { data: docs, isLoading } = useQuery({ queryKey: ["docs"], queryFn: api.listDocs, refetchInterval: 4_000 });
  const { data: invoices } = useQuery({ queryKey: ["invoices"], queryFn: () => api.listInvoices(), refetchInterval: 4_000 });

  const invByTs = useMemo(() => {
    const m: Record<string, Invoice> = {};
    (invoices ?? []).forEach((i) => { if (i.timesheet_id) m[i.timesheet_id] = i; });
    return m;
  }, [invoices]);

  const buckets = useMemo(() => {
    const b: Record<StageId, DocSummary[]> = { intake: [], review: [], validate: [], invoice: [], dispatch: [] };
    (docs ?? []).forEach((d) => b[stageOf(d, invByTs)].push(d));
    return b;
  }, [docs, invByTs]);

  const touchless = useMemo(() => {
    const routed = (docs ?? []).filter((d) => d.routing != null);
    const auto = routed.filter((d) => d.routing === "auto").length;
    return routed.length ? auto / routed.length : 0;
  }, [docs]);

  const docParam = params.get("doc");
  const stage = (params.get("stage") as StageId) || (buckets.review.length ? "review" : "invoice");
  const queue = buckets[stage] ?? [];
  const selectedId = docParam ?? queue[0]?.doc_id ?? null;

  const setStage = (s: StageId) => { const p = new URLSearchParams(params); p.set("stage", s); p.delete("doc"); setParams(p); };
  const setDoc = (id: string) => { const p = new URLSearchParams(params); p.set("doc", id); setParams(p); };
  const clearDoc = () => { const p = new URLSearchParams(params); p.delete("doc"); setParams(p); };

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col">
      {/* Stage rail = navigation */}
      <div className="border-b border-ink-200 bg-white px-3 sm:px-4 py-2.5 flex items-center gap-1.5 sm:gap-2 overflow-x-auto">
        {STAGES.map((s, i) => (
          <div key={s.id} className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {i > 0 && <span className="text-ink-300 select-none hidden sm:inline">→</span>}
            <button className={cn("stage", stage === s.id ? "stage-on" : "stage-off")} onClick={() => setStage(s.id)}>
              {s.label}<span className="stage-count">{buckets[s.id].length}</span>
            </button>
          </div>
        ))}
        <div className="ml-auto hidden md:flex items-center gap-2 pl-3 shrink-0">
          <span className="eyebrow">Touchless</span>
          <span className={cn("text-sm font-semibold tnum", touchless >= 0.8 ? "text-emerald-600" : "text-ink-700")}>{fmtPct(touchless)}</span>
        </div>
      </div>

      {/* Queue + focus — master/detail on small, split on large */}
      <div className="flex-1 lg:grid lg:grid-cols-[minmax(300px,360px)_1fr] min-h-0 overflow-hidden">
        {/* Queue */}
        <div className={cn("border-r border-ink-200 bg-white overflow-y-auto p-2 h-full", docParam ? "hidden lg:block" : "block")}>
          {isLoading && <div className="p-4 flex items-center gap-2 text-ink-500 text-sm"><Spinner /> Loading…</div>}
          {!isLoading && queue.length === 0 && (
            <EmptyState icon={Inbox} title="Nothing in this stage" hint="Documents flow through here as they're processed." />
          )}
          <div className="space-y-1">
            {queue.map((d) => (
              <button key={d.doc_id} onClick={() => setDoc(d.doc_id)} className={cn("qrow", selectedId === d.doc_id && "qrow-on")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink-900 truncate">{d.client_code ?? "Unknown client"}</span>
                  <span className="text-2xs text-ink-400 shrink-0">{fmtAge(d.uploaded_at)}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  <Badge tone="slate" dot={false}>{d.channel}</Badge>
                  <span className="text-2xs text-ink-500">{d.period ?? "—"}</span>
                  {d.confidence != null && <ConfidenceBadge value={d.confidence} />}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Focus */}
        <div className={cn("overflow-y-auto bg-ink-50 h-full", docParam ? "block" : "hidden lg:block")}>
          {selectedId ? (
            <>
              <button onClick={clearDoc} className="lg:hidden sticky top-0 z-10 w-full flex items-center gap-1.5 px-4 py-2.5 bg-white border-b border-ink-200 text-sm font-medium text-ink-600 hover:text-ink-900">
                <ChevronLeft size={16} /> Queue
              </button>
              <div className="mx-3 mt-3 mb-20 card-flush"><DocFocus docId={selectedId} /></div>
            </>
          ) : (
            <div className="h-full grid place-items-center"><EmptyState icon={Inbox} title="Select a document" hint="Pick an item from the queue to review it inline." /></div>
          )}
        </div>
      </div>
    </div>
  );
}

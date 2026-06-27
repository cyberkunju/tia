import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Loader2, FileText, ExternalLink, Sparkles, ArrowRight } from "lucide-react";
import { api, API_BASE } from "../api";
import { cn, fmtAED } from "../lib";
import { usePersona } from "../store";

/**
 * UploadReceipt — what the client sees the moment a file goes in.
 *
 * The orchestrator on the backend is synchronous, so by the time this card
 * mounts the doc is already at its final stage. That's not useful for a demo
 * audience — the eye can't follow a 50ms snap to Invoiced. So we animate the
 * visible cursor through the five stages at ~600ms each, capped by the real
 * backend state from the poll. The numbers below the strip stay real; only
 * the visual cursor is paced.
 */
export function UploadReceipt({ docId }: { docId: string }) {
  const nav = useNavigate();
  const { setPersona } = usePersona();
  const { data } = useQuery({
    queryKey: ["doc", docId],
    queryFn: () => api.getDoc(docId),
    enabled: !!docId,
    refetchInterval: 1500,
  });

  const ts = data?.timesheet;
  const inv = data?.invoices?.[0];
  const conf = ts?.confidence ?? 0;
  const routing = ts?.routing;
  const fails = (ts?.validations ?? []).filter((v) => !v.passed && v.severity !== "warning").length;

  // Target stage — derived from the real backend state. 1..5.
  // 1 received → 2 read → 3 matched → 4 checked → 5 invoiced.
  let backendStage = 1;
  if (ts?.extraction?.rows && ts.extraction.rows.length > 0) backendStage = 2;
  if (ts?.match_result?.matches && ts.match_result.matches.length > 0) backendStage = 3;
  if ((ts?.validations ?? []).length > 0) backendStage = 4;
  if (inv) backendStage = 5;
  const dispatched = inv?.status === "dispatched";
  const awaitingReview = ts?.status === "awaiting_review";

  // Visible cursor — animates toward backendStage at ~600ms per step. New
  // demos start at stage 1; if the backend jumps ahead the cursor catches up
  // at the next tick, so we never overshoot.
  const [visibleStage, setVisibleStage] = useState(1);
  useEffect(() => {
    // Reset when a new doc lands.
    setVisibleStage(1);
  }, [docId]);
  useEffect(() => {
    if (visibleStage >= backendStage) return;
    const t = setTimeout(() => setVisibleStage((v) => Math.min(v + 1, 5)), 600);
    return () => clearTimeout(t);
  }, [visibleStage, backendStage]);

  // Headline + emerald-final state only fire when the cursor catches up.
  // This is what keeps "Working on it…" on the screen long enough for the
  // viewer to read the per-stage labels.
  const animationCaughtUp = visibleStage >= backendStage;
  const showFinal = animationCaughtUp && (dispatched || (inv && !awaitingReview) || awaitingReview);

  const STAGES = [
    { id: 1, label: "Received" },
    { id: 2, label: "Read" },
    { id: 3, label: "Matched" },
    { id: 4, label: "Checked" },
    { id: 5, label: "Invoiced" },
  ];

  const trackInPipeline = () => {
    setPersona("finops");
    nav(`/console?doc=${docId}`);
  };

  return (
    <div className="card overflow-hidden">
      {/* Headline — what's happening right now, in plain English. */}
      <div className={cn(
        "px-4 py-3 border-b",
        showFinal && dispatched ? "bg-emerald-50 border-emerald-200" :
        showFinal && inv ? "bg-brand-50 border-brand-200" :
        showFinal && awaitingReview ? "bg-amber-50 border-amber-200" :
        "bg-ink-50 border-ink-200",
      )}>
        <div className="flex items-center gap-2 text-sm font-semibold">
          {showFinal && dispatched ? <><CheckCircle2 size={15} className="text-emerald-700" /> Auto-dispatched · invoice sent</>
            : showFinal && inv ? <><Sparkles size={15} className="text-brand-700" /> Tax invoice ready</>
            : showFinal && awaitingReview ? <><Loader2 size={15} className="text-amber-700" /> A FinOps reviewer is taking a look</>
            : <><Loader2 size={15} className="text-ink-500 animate-spin" /> Working on it…</>}
        </div>
        <p className="text-xs text-ink-600 mt-0.5">
          {showFinal && dispatched ? `Confidence ${(conf * 100).toFixed(0)}% — every contract check passed, so no human was needed.`
            : showFinal && inv ? "Ready for your approval — open the PDF below."
            : showFinal && awaitingReview ? `Confidence ${(conf * 100).toFixed(0)}% · ${fails} item${fails === 1 ? "" : "s"} need${fails === 1 ? "s" : ""} a quick look.`
            : STAGE_PROSE[visibleStage] ?? "Reading the timesheet and matching associates."}
        </p>
      </div>

      {/* Live 5-step strip — paced cursor, see comment at the top of the file. */}
      <div className="px-4 py-3 flex items-center justify-between gap-1 overflow-x-auto">
        {STAGES.map((s, i) => {
          const reached = s.id <= visibleStage;
          const current = s.id === visibleStage && !showFinal;
          return (
            <div key={s.id} className="flex items-center gap-1.5 shrink-0">
              <span
                className={cn(
                  "grid place-items-center h-6 w-6 rounded-full text-[10px] font-semibold border transition-colors",
                  reached && !current && "bg-emerald-100 text-emerald-800 border-emerald-200",
                  current && "bg-brand-500 text-teal-950 border-brand-600 ring-2 ring-brand-200 animate-pulse",
                  !reached && "bg-ink-50 text-ink-400 border-ink-200",
                )}
              >
                {reached && !current ? <CheckCircle2 size={11} /> : s.id}
              </span>
              <span className={cn("text-2xs font-medium", reached ? "text-ink-800" : "text-ink-400")}>{s.label}</span>
              {i < STAGES.length - 1 && (
                <span className={cn("h-px w-3 sm:w-5 transition-colors", s.id < visibleStage ? "bg-emerald-300" : "bg-ink-200")} />
              )}
            </div>
          );
        })}
      </div>

      {/* Summary chips + actions — gated on showFinal so they appear when the strip lands. */}
      <div className="px-4 pb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs min-h-[24px]">
          {showFinal && ts?.client_code && <span className="badge-slate">{ts.client_code}</span>}
          {showFinal && ts?.period && <span className="badge-blue">{ts.period}</span>}
          {showFinal && routing === "auto" && <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-brand-50 text-brand-800 border border-brand-200 font-medium">auto</span>}
          {showFinal && routing === "hitl" && <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-amber-50 text-amber-900 border border-amber-200 font-medium">needs review</span>}
          {showFinal && inv?.total_incl_vat != null && (
            <span className="ml-auto tnum font-semibold text-ink-900">{fmtAED(inv.total_incl_vat)}</span>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          {showFinal && inv?.pdf_available && (
            <a
              href={`${API_BASE}/invoices/${inv.id}/pdf`}
              target="_blank"
              rel="noreferrer"
              className="btn-primary btn-sm justify-center flex-1"
            >
              <FileText size={13} /> Open tax invoice (PDF) <ExternalLink size={11} />
            </a>
          )}
          {showFinal && (
            <button onClick={trackInPipeline} className={cn("btn-outline btn-sm justify-center", !inv?.pdf_available && "flex-1")}>
              Track in pipeline <ArrowRight size={13} />
            </button>
          )}
        </div>

        {showFinal && (
          <p className="text-2xs text-ink-400 leading-snug">
            Every step above is recorded in TIA's tamper-evident audit chain. Click <em>Track in pipeline</em> to see the full timeline and rationale.
          </p>
        )}
      </div>
    </div>
  );
}

/** Per-stage prose for the headline subtitle while the animation walks through. */
const STAGE_PROSE: Record<number, string> = {
  1: "Received the timesheet.",
  2: "Reading the document with OCR / parser.",
  3: "Matching each row to a known associate.",
  4: "Running every contract check.",
  5: "Generating the tax invoice.",
};

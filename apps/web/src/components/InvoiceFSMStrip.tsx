import { Check } from "lucide-react";
import { cn } from "../lib";

/**
 * InvoiceFSMStrip — visual breadcrumb of the invoice lifecycle.
 *
 * Two parallel paths from `generated`:
 *   generated → finance_approved → dispatched    (over-threshold path)
 *   generated → dispatched                       (auto-path)
 * Terminal forks: void  (pre-dispatch clawback) and credit_note (post-dispatch).
 *
 * We render the canonical happy path inline + show a fork chip when the current
 * status is `void` or `credit_note_issued`.
 */
const PATH: { id: string; label: string }[] = [
  { id: "generated", label: "Generated" },
  { id: "finance_approved", label: "Finance approved" },
  { id: "dispatched", label: "Dispatched" },
];

const PATH_ORDER: Record<string, number> = {
  generated: 0,
  finance_approved: 1,
  dispatched: 2,
};

export function InvoiceFSMStrip({ status }: { status: string }) {
  const isVoid = status === "void" || status === "voided";
  const isCN = status === "credit_note_issued" || status === "credit_noted";
  const currentIdx = PATH_ORDER[status] ?? (isVoid || isCN ? 2 : 0);

  return (
    <div className="flex items-center gap-1.5 flex-wrap text-2xs">
      {PATH.map((p, i) => {
        const reached = i <= currentIdx;
        const isCurrent = i === currentIdx && !isVoid && !isCN;
        return (
          <span key={p.id} className="inline-flex items-center gap-1.5">
            <span className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium border",
              isCurrent && "bg-brand-500 text-teal-950 border-brand-600",
              reached && !isCurrent && "bg-emerald-50 text-emerald-800 border-emerald-200",
              !reached && "bg-ink-50 text-ink-400 border-ink-200",
            )}>
              {reached && !isCurrent && <Check size={10} />}
              {p.label}
            </span>
            {i < PATH.length - 1 && (
              <span className={cn(
                "h-px w-3",
                i < currentIdx ? "bg-emerald-300" : "bg-ink-200",
              )} />
            )}
          </span>
        );
      })}
      {(isVoid || isCN) && (
        <>
          <span className="text-ink-300">→</span>
          <span className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 font-semibold border",
            isVoid ? "bg-red-50 text-red-800 border-red-200" : "bg-amber-50 text-amber-900 border-amber-200",
          )}>
            {isVoid ? "VOIDED" : "CREDIT NOTE ISSUED"}
          </span>
        </>
      )}
    </div>
  );
}

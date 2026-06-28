/**
 * Sparkle entry point — click to scope the AIDA panel to one entity and open it.
 *
 * Writes the entity into the URL as `?aida=<id>` (or `?aida=doc:<id>` etc.)
 * so the panel state survives a page refresh + is shareable. The panel reads
 * the URL on mount and re-scopes automatically.
 *
 * Two visual variants:
 *   - `inline` (default): tiny icon-only button for table rows
 *   - `prominent`: pill button with label, for hero cards
 */

import { Sparkles } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { usePersona } from "../store";

export type SparkleVariant = "inline" | "prominent";

interface InvoiceChatTriggerProps {
  /** What kind of entity is being focused. */
  kind: "invoice" | "document" | "timesheet";
  /** The entity id (UUID or sequence_no). */
  id: string;
  /** Human-readable ref shown on the panel's entity pill. Optional. */
  ref?: string;
  variant?: SparkleVariant;
  label?: string;
  className?: string;
}

/**
 * URL encoding: invoices are bare ids (`?aida=<id>`); other kinds use a
 * `<kind>:<id>` prefix so the panel can tell them apart without ambiguity.
 */
function encodeAida(kind: InvoiceChatTriggerProps["kind"], id: string): string {
  if (kind === "invoice") return id;
  return `${kind}:${id}`;
}

export function InvoiceChatTrigger({
  kind,
  id,
  ref: entityRef,
  variant = "inline",
  label = "Ask AIDA",
  className = "",
}: InvoiceChatTriggerProps) {
  const [sp, setSp] = useSearchParams();
  const { setAidaOpen, setFocusedEntity } = usePersona();

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const next = new URLSearchParams(sp);
    next.set("aida", encodeAida(kind, id));
    setSp(next, { replace: true });
    setFocusedEntity({ kind, id, ref: entityRef });
    setAidaOpen(true);
  };

  if (variant === "prominent") {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`${label} about this ${kind}`}
        className={
          "inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50/80 px-2.5 py-1.5 text-xs font-medium text-brand-700 shadow-xs hover:bg-brand-100 hover:text-brand-800 transition-colors " +
          className
        }
      >
        <Sparkles size={12} className="text-brand-500" />
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={`Ask AIDA about this ${kind}`}
      aria-label={`Ask AIDA about this ${kind}`}
      className={
        "inline-grid place-items-center h-6 w-6 rounded-md text-ink-400 hover:text-brand-600 hover:bg-brand-50 transition-colors " +
        className
      }
    >
      <Sparkles size={12} />
    </button>
  );
}

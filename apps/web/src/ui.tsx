import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import { cn } from "./lib";

/* ─────────────────────────── Status semantics ─────────────────────────── */

type Tone = "green" | "amber" | "red" | "blue" | "brand" | "slate";

const STATUS_TONE: Record<string, Tone> = {
  invoice_generated: "green",
  approved: "green",
  generated: "blue",
  dispatched: "green",
  validated: "blue",
  awaiting_review: "amber",
  hitl: "amber",
  rejected: "red",
  escalated: "red",
  escalate: "red",
  ingested: "slate",
};

const ROUTING_TONE: Record<string, Tone> = { auto: "green", hitl: "amber", escalate: "red" };

function humanize(s?: string | null): string {
  if (!s) return "-";
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function confidenceTone(c?: number | null): Tone {
  if (c == null) return "slate";
  if (c >= 0.85) return "green";
  if (c >= 0.6) return "blue";
  if (c >= 0.4) return "amber";
  return "red";
}

export function Badge({ tone = "slate", dot = true, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return <span className={cn(`badge-${tone}`, !dot && "badge-plain")}>{children}</span>;
}

export function StatusBadge({ status }: { status?: string | null }) {
  return <Badge tone={status ? STATUS_TONE[status] ?? "slate" : "slate"}>{humanize(status)}</Badge>;
}

export function RoutingBadge({ routing }: { routing?: string | null }) {
  if (!routing) return <span className="text-ink-400">-</span>;
  const label = routing === "hitl" ? "Needs review" : humanize(routing);
  return <Badge tone={ROUTING_TONE[routing] ?? "slate"}>{label}</Badge>;
}

export function ConfidenceBadge({ value }: { value?: number | null }) {
  if (value == null) return <span className="text-ink-400">-</span>;
  return <Badge tone={confidenceTone(value)} dot={false}><span className="tnum">{(value * 100).toFixed(1)}%</span></Badge>;
}

/* ─────────────────────────── Layout primitives ────────────────────────── */

export function PageHeader({
  title, description, actions, icon: Icon,
}: { title: string; description?: ReactNode; actions?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 mb-5">
      <div className="flex items-start gap-3 min-w-0">
        {Icon && (
          <span className="mt-0.5 grid place-items-center h-9 w-9 rounded-lg bg-brand-50 text-brand-600 ring-1 ring-brand-100 shrink-0">
            <Icon size={18} strokeWidth={2} />
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-ink-900 leading-tight">{title}</h1>
          {description && <p className="text-sm text-ink-500 mt-0.5">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap shrink-0">{actions}</div>}
    </div>
  );
}

export function Panel({
  title, subtitle, actions, children, className, bodyClassName,
}: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode;
  children: ReactNode; className?: string; bodyClassName?: string;
}) {
  return (
    <section className={cn("card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-ink-200">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink-900">{title}</h2>}
            {subtitle && <p className="text-xs text-ink-500 mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 flex-wrap shrink-0">{actions}</div>}
        </header>
      )}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Metric({
  label, value, hint, accent,
}: { label: string; value: ReactNode; hint?: ReactNode; accent?: boolean }) {
  return (
    <div className={cn("card p-4", accent && "ring-1 ring-brand-200 bg-brand-50/40")}>
      <div className="eyebrow">{label}</div>
      <div className={cn("mt-1.5 text-xl sm:text-2xl font-semibold tnum tracking-tight break-words", accent ? "text-brand-700" : "text-ink-900")}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-ink-500">{hint}</div>}
    </div>
  );
}

/* ─────────────────────────── State primitives ─────────────────────────── */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("animate-spin", className)} size={16} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4 w-full", className)} />;
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c} className="px-4 py-3 border-b border-ink-100">
              <Skeleton className={c === 0 ? "w-24" : "w-16"} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

export function EmptyState({
  icon: Icon, title, hint, action,
}: { icon?: LucideIcon; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-14">
      {Icon && (
        <span className="grid place-items-center h-11 w-11 rounded-xl bg-ink-100 text-ink-400 mb-3">
          <Icon size={20} />
        </span>
      )}
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {hint && <p className="text-sm text-ink-400 mt-1 max-w-sm">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

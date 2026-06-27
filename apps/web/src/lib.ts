import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: (string | number | boolean | null | undefined)[]) {
  return twMerge(clsx(inputs));
}

export function fmtMoney(n: number, currency = "AED"): string {
  return `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

export function statusBadgeClass(status: string): string {
  if (status === "invoice_generated" || status === "approved" || status === "dispatched") return "badge-green";
  if (status === "awaiting_review" || status === "hitl") return "badge-amber";
  if (status === "rejected" || status === "escalated") return "badge-red";
  return "badge-slate";
}

export function routingBadgeClass(routing: string | null | undefined): string {
  if (routing === "auto") return "badge-green";
  if (routing === "hitl") return "badge-amber";
  if (routing === "escalate") return "badge-red";
  return "badge-slate";
}

export function confidenceBadgeClass(c: number | null | undefined): string {
  if (c == null) return "badge-slate";
  if (c >= 0.85) return "badge-green";
  if (c >= 0.6) return "badge-blue";
  if (c >= 0.4) return "badge-amber";
  return "badge-red";
}

// ── TASC domain helpers ──────────────────────────────────────────────────────
export const VAT_RATE = 0.05; // UAE standard VAT

/** A TASC tax-invoice breakdown. Backend `amount` is the net (pre-VAT) subtotal. */
export function vatBreakdown(net: number, rate = VAT_RATE) {
  const vat = Math.round(net * rate * 100) / 100;
  return { subtotal: net, vat, total: Math.round((net + vat) * 100) / 100 };
}

/** "AED 12,345.67" with grouping + two decimals. */
export function fmtAED(n: number): string {
  return `AED ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact "3m", "2h", "4d" relative age from an ISO timestamp. */
export function fmtAge(s: string | null | undefined): string {
  if (!s) return "—";
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export function humanize(s?: string | null): string {
  if (!s) return "—";
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// TASC billing entity shown on tax invoices (sample/demo entity).
export const TASC_ENTITY = { name: "TASC Outsourcing LLC", trn: "100312345600003" } as const;

/**
 * Visual heuristic for the ⚡ AUTO chip — matches the auto-dispatch concept
 * (an invoice that went straight from validation to dispatched with no human
 * click). The authoritative signal lives in the audit chain
 * (event `auto_dispatched_within_tolerance`); the chip is only a hint, the
 * Why? affordance reads the real chain.
 *
 * ponytail: status-only heuristic; tighten when an over-counting case shows up.
 */
export function isAutoDispatched(status: string | null | undefined): boolean {
  return status === "dispatched";
}

/**
 * Strip the common markdown tokens an LLM tends to emit even when told not to —
 * `**bold**`, `*italics*`, leading `#` headers, `- ` bullets, inline `\`code\``,
 * fenced code blocks. The AIDA panel renders text verbatim, so raw asterisks
 * look broken. Belt-and-suspenders with the system prompt.
 */
export function stripMarkdown(text: string): string {
  if (!text) return text;
  return text
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\s)([*_])(?!\s)([^*_\n]+?)\2(?=\s|[.,;:!?)]|$)/g, "$1$3")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

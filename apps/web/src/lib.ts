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

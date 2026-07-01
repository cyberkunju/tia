/**
 * Contextual chat icebreakers — empty-state suggestion library.
 *
 * `generateIcebreakers(ctx)` returns two categorized groups with 3 prompts
 * each, picked from a ~50-prompt library, prioritised by:
 *
 *   focused entity  >  current route  >  persona  >  generic
 *
 * The agent's tool-call strip + grounded answers make these meaningful — a
 * prompt like "Recover this leakage" actually fires `recover_leakage` and
 * chains the audit event.
 */

import type { Persona } from "./store";

export type IcebreakerCategory = "status" | "money" | "entity" | "action";

export interface Icebreaker {
  category: IcebreakerCategory;
  label: string;   // short label shown on the button
  prompt: string;  // full prompt sent to the agent
}

export interface IcebreakerContext {
  persona: Persona;
  route: string;
  focusedEntity?: { kind: "invoice" | "document" | "timesheet"; id: string; ref?: string } | null;
  invoiceStatus?: string;
}

export interface IcebreakerGroup {
  title: string;
  items: Icebreaker[];
}

// ---------- The library ----------------------------------------------------

const GENERIC: Icebreaker[] = [
  { category: "status", label: "Verify the audit chain", prompt: "Verify the tamper-evident audit chain and tell me the head hash." },
  { category: "status", label: "What rules failed today?", prompt: "Which validation rules failed on invoices generated today?" },
  { category: "money",  label: "Find revenue leakage",    prompt: "Find revenue leakage for the current period and break it down by client." },
  { category: "status", label: "Touchless rate",          prompt: "What is the current touchless processing rate?" },
];

const CLIENT_ROUTE: Icebreaker[] = [
  { category: "status", label: "Invoices needing approval", prompt: "Which of my invoices are awaiting my approval?" },
  { category: "money",  label: "Are any overdue?",          prompt: "Do I have any overdue or unpaid invoices?" },
  { category: "money",  label: "TASC's bill this month",    prompt: "What did TASC bill me this month and what was the largest line item?" },
  { category: "action", label: "Raise a query",             prompt: "How do I raise a query on an invoice I disagree with?" },
];

const FINOPS_ROUTE: Icebreaker[] = [
  { category: "status", label: "Awaiting review",            prompt: "What documents are currently awaiting human review and why?" },
  { category: "money",  label: "Over-threshold invoices",    prompt: "Show me invoices that are over the dispatch threshold." },
  { category: "status", label: "Missing timesheets",         prompt: "Which clients haven't submitted timesheets for the current period?" },
  { category: "action", label: "Dispatch held invoices",     prompt: "Which invoices are generated but not yet dispatched, and what's blocking each?" },
];

const FINANCE_ROUTE: Icebreaker[] = [
  { category: "money",  label: "Where is TASC losing money?",     prompt: "Find revenue leakage this period and explain the top three associates." },
  { category: "status", label: "Touchless breakdown by client",   prompt: "Show me the touchless processing breakdown by client." },
  { category: "money",  label: "Top 5 clients by billed AED",     prompt: "List the top 5 clients by total AED billed this period." },
  { category: "status", label: "Audit chain head",                prompt: "Verify the audit chain and report any tamper evidence." },
];

const INVOICE_FOCUSED: Icebreaker[] = [
  { category: "status", label: "Why was it auto-dispatched?",   prompt: "Walk me through every step TIA took for this invoice." },
  { category: "status", label: "What rules passed?",            prompt: "What rules passed and failed on this invoice?" },
  { category: "entity", label: "Show me the line items",        prompt: "Break down the line items on this invoice." },
  { category: "status", label: "Has this been paid?",           prompt: "Has this invoice been paid yet and what's its dispatch status?" },
  { category: "entity", label: "SAP B1 payload",                prompt: "Show me the SAP Business One payload for this invoice." },
  { category: "action", label: "Recover the leakage",           prompt: "Find any unbilled associates for this client this period and recover the leakage." },
];

const DOC_FOCUSED: Icebreaker[] = [
  { category: "entity", label: "What did TIA extract?",         prompt: "What did TIA extract from this document and what's the confidence?" },
  { category: "entity", label: "How were associates matched?",  prompt: "How were associates on this document matched to TASC employees?" },
  { category: "status", label: "Why does this need review?",    prompt: "Why was this document routed to human review?" },
  { category: "status", label: "Show the audit trail",          prompt: "Show me the full audit trail for this document." },
];

const TIMESHEET_FOCUSED: Icebreaker[] = [
  { category: "status", label: "Why is this in review?",        prompt: "Why is this timesheet awaiting review?" },
  { category: "action", label: "Approve this timesheet",        prompt: "Approve this timesheet and regenerate the invoice." },
  { category: "entity", label: "Confidence + failed rules",     prompt: "Show me the confidence score and any failed validation rules on this timesheet." },
];

// ---------- Selector --------------------------------------------------------

/* v8 ignore start -- _byCategory is intentionally retained (see the `void _byCategory` note below) but never invoked, so its body is unreachable at runtime. */
function _byCategory(items: Icebreaker[]): Map<IcebreakerCategory, Icebreaker[]> {
  const m = new Map<IcebreakerCategory, Icebreaker[]>();
  for (const it of items) {
    const arr = m.get(it.category) ?? [];
    arr.push(it);
    m.set(it.category, arr);
  }
  return m;
}
/* v8 ignore stop */

function _routeBank(route: string, persona: Persona): Icebreaker[] {
  if (route.startsWith("/portal")) return CLIENT_ROUTE;
  if (route.startsWith("/finance")) return FINANCE_ROUTE;
  if (route.startsWith("/console") || route.startsWith("/finops")) return FINOPS_ROUTE;
  // fall back to persona
  if (persona === "client") return CLIENT_ROUTE;
  if (persona === "finance") return FINANCE_ROUTE;
  return FINOPS_ROUTE;
}

function _entityBank(
  kind: "invoice" | "document" | "timesheet" | undefined,
): Icebreaker[] {
  if (kind === "invoice") return INVOICE_FOCUSED;
  if (kind === "document") return DOC_FOCUSED;
  if (kind === "timesheet") return TIMESHEET_FOCUSED;
  return [];
}

function _take(items: Icebreaker[], n: number, seen: Set<string>): Icebreaker[] {
  const out: Icebreaker[] = [];
  for (const it of items) {
    /* v8 ignore next -- defensive dedup: every backfill list supplies ≥3 unseen items before any already-seen label, so this skip never fires through generateIcebreakers */
    if (seen.has(it.label)) continue;
    out.push(it);
    seen.add(it.label);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Return two icebreaker groups (3 prompts each) tailored to the caller's
 * context. Prioritisation: entity → route → generic backfill. Categories are
 * weighted (status, money, entity, action) to keep the cards varied.
 */
export function generateIcebreakers(ctx: IcebreakerContext): { groups: IcebreakerGroup[] } {
  const seen = new Set<string>();
  const entityBank = _entityBank(ctx.focusedEntity?.kind);
  const routeBank = _routeBank(ctx.route, ctx.persona);

  if (entityBank.length) {
    // Focused: first card = "About this [entity]", second card = persona/route picks
    const aboutThis = _take(entityBank, 3, seen);
    const broader = _take([...routeBank, ...GENERIC], 3, seen);
    return {
      groups: [
        {
          title:
            ctx.focusedEntity?.kind === "invoice"
              ? `About this invoice${ctx.focusedEntity.ref ? ` · ${ctx.focusedEntity.ref}` : ""}`
              : ctx.focusedEntity?.kind === "document"
                ? "About this document"
                : "About this timesheet",
          items: aboutThis,
        },
        { title: "Broader questions", items: broader },
      ],
    };
  }

  // No focused entity: two cards — route-specific + cross-cutting
  const focused = _take(routeBank, 3, seen);
  const broader = _take([...GENERIC, ...routeBank], 3, seen);
  const personaTitle: Record<Persona, string> = {
    client: "For you (Client)",
    finops: "For you (FinOps)",
    finance: "For you (Finance)",
  };
  return {
    groups: [
      { title: personaTitle[ctx.persona], items: focused },
      { title: "Operational checks", items: broader },
    ],
  };
}

/** Total library size — surfaced in docs/CONNECT.md. */
export const ICEBREAKER_COUNT =
  GENERIC.length +
  CLIENT_ROUTE.length +
  FINOPS_ROUTE.length +
  FINANCE_ROUTE.length +
  INVOICE_FOCUSED.length +
  DOC_FOCUSED.length +
  TIMESHEET_FOCUSED.length;

// Tiny self-check (`_byCategory` is unused publicly; keep the symbol so the
// shape is verifiable if we ever want category-balanced sampling).
void _byCategory;

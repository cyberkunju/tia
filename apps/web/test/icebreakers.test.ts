import { describe, expect, it } from "vitest";
import {
  generateIcebreakers,
  ICEBREAKER_COUNT,
  type IcebreakerContext,
} from "../src/icebreakers";

/**
 * generateIcebreakers is a pure prioritiser: focused entity → route → persona →
 * generic backfill, always emitting two groups of exactly three de-duplicated
 * prompts. These tests pin every branch of that selection tree.
 */

const ctx = (over: Partial<IcebreakerContext> = {}): IcebreakerContext => ({
  persona: "finops",
  route: "/console",
  ...over,
});

function labels(groups: ReturnType<typeof generateIcebreakers>["groups"]): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.label));
}

describe("generateIcebreakers — structure", () => {
  it("always returns two groups of three items", () => {
    const { groups } = generateIcebreakers(ctx());
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.items).toHaveLength(3);
  });

  it("never repeats a prompt label across the two groups", () => {
    const all = labels(generateIcebreakers(ctx({ route: "/portal" })).groups);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("route-driven selection (no focused entity)", () => {
  it("uses the client bank on /portal and titles the first card for the persona", () => {
    const { groups } = generateIcebreakers(ctx({ persona: "client", route: "/portal" }));
    expect(groups[0].title).toBe("For you (Client)");
    expect(groups[1].title).toBe("Operational checks");
    expect(labels([groups[0]])).toContain("Invoices needing approval");
  });

  it("uses the finance bank on /finance", () => {
    const { groups } = generateIcebreakers(ctx({ persona: "finance", route: "/finance" }));
    expect(groups[0].title).toBe("For you (Finance)");
    expect(labels([groups[0]])).toContain("Where is TASC losing money?");
  });

  it("uses the finops bank on /console", () => {
    const { groups } = generateIcebreakers(ctx({ persona: "finops", route: "/console" }));
    expect(groups[0].title).toBe("For you (FinOps)");
    expect(labels([groups[0]])).toContain("Awaiting review");
  });

  it("treats /finops as a finops route too", () => {
    const { groups } = generateIcebreakers(ctx({ persona: "finops", route: "/finops" }));
    expect(labels([groups[0]])).toContain("Awaiting review");
  });
});

describe("persona fallback when the route is unknown", () => {
  it("falls back to the client bank for the client persona", () => {
    const { groups } = generateIcebreakers(ctx({ persona: "client", route: "/unknown" }));
    expect(labels([groups[0]])).toContain("Invoices needing approval");
  });

  it("falls back to the finance bank for the finance persona", () => {
    const { groups } = generateIcebreakers(ctx({ persona: "finance", route: "/unknown" }));
    expect(labels([groups[0]])).toContain("Where is TASC losing money?");
  });

  it("falls back to the finops bank otherwise", () => {
    const { groups } = generateIcebreakers(ctx({ persona: "finops", route: "/unknown" }));
    expect(labels([groups[0]])).toContain("Awaiting review");
  });
});

describe("focused-entity selection", () => {
  it("leads with an invoice card (including the ref) and a broader card", () => {
    const { groups } = generateIcebreakers(
      ctx({ focusedEntity: { kind: "invoice", id: "I1", ref: "INV-0001" } }),
    );
    expect(groups[0].title).toBe("About this invoice · INV-0001");
    expect(groups[1].title).toBe("Broader questions");
    expect(labels([groups[0]])).toContain("Why was it auto-dispatched?");
  });

  it("titles the invoice card without a ref when none is given", () => {
    const { groups } = generateIcebreakers(ctx({ focusedEntity: { kind: "invoice", id: "I1" } }));
    expect(groups[0].title).toBe("About this invoice");
  });

  it("leads with a document card for a focused document", () => {
    const { groups } = generateIcebreakers(ctx({ focusedEntity: { kind: "document", id: "D1" } }));
    expect(groups[0].title).toBe("About this document");
    expect(labels([groups[0]])).toContain("What did TIA extract?");
  });

  it("leads with a timesheet card for a focused timesheet", () => {
    const { groups } = generateIcebreakers(ctx({ focusedEntity: { kind: "timesheet", id: "T1" } }));
    expect(groups[0].title).toBe("About this timesheet");
    expect(labels([groups[0]])).toContain("Why is this in review?");
  });
});

describe("ICEBREAKER_COUNT", () => {
  it("sums every bank in the library", () => {
    // 4 generic + 4 client + 4 finops + 4 finance + 6 invoice + 4 doc + 3 timesheet
    expect(ICEBREAKER_COUNT).toBe(29);
  });
});

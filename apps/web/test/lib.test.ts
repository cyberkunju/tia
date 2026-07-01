import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cn,
  confidenceBadgeClass,
  fmtAED,
  fmtAge,
  fmtDate,
  fmtMoney,
  fmtPct,
  humanize,
  isAutoDispatched,
  routingBadgeClass,
  statusBadgeClass,
  stripMarkdown,
  TASC_ENTITY,
  VAT_RATE,
  vatBreakdown,
} from "../src/lib";

// The runtime locale is en-US on this machine and on CI (Ubuntu + full ICU),
// so the locale-formatted assertions below are deterministic. Guarded so a
// non-en-US runner reports a clear skip reason instead of a confusing failure.
const EN_US = Intl.NumberFormat().resolvedOptions().locale.startsWith("en");

describe("cn", () => {
  it("joins truthy class tokens", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("drops falsy values (false/null/undefined)", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("resolves conflicting tailwind utilities keeping the last one", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("returns an empty string with no inputs", () => {
    expect(cn()).toBe("");
  });
});

describe("fmtMoney", () => {
  it.runIf(EN_US)("formats with default AED currency, grouping and 2 decimals", () => {
    expect(fmtMoney(1234.5)).toBe("AED 1,234.50");
    expect(fmtMoney(1000000)).toBe("AED 1,000,000.00");
    expect(fmtMoney(99)).toBe("AED 99.00");
  });

  it.runIf(EN_US)("formats zero and negatives", () => {
    expect(fmtMoney(0)).toBe("AED 0.00");
    expect(fmtMoney(-2500.5)).toBe("AED -2,500.50");
  });

  it.runIf(EN_US)("honours a custom currency prefix", () => {
    expect(fmtMoney(50, "USD")).toBe("USD 50.00");
  });

  it("always yields exactly two decimal places (locale-agnostic structural check)", () => {
    // Strip grouping/decimal separators and assert a 2-digit fractional tail.
    expect(fmtMoney(1234.5)).toMatch(/\d[.,]\d{2}$/);
    expect(fmtMoney(7)).toMatch(/\d[.,]\d{2}$/);
  });

  it("prefixes the currency code", () => {
    expect(fmtMoney(1)).toContain("AED ");
    expect(fmtMoney(1, "EUR")).toContain("EUR ");
  });
});

describe("fmtAED", () => {
  it.runIf(EN_US)("is AED-prefixed with grouping + 2 decimals", () => {
    expect(fmtAED(1234.5)).toBe("AED 1,234.50");
    expect(fmtAED(0)).toBe("AED 0.00");
  });
});

describe("fmtPct", () => {
  it("multiplies by 100 with one decimal and a % suffix", () => {
    expect(fmtPct(0.5)).toBe("50.0%");
    expect(fmtPct(0.1234)).toBe("12.3%");
  });

  it("handles the 0 and 1 boundaries", () => {
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(1)).toBe("100.0%");
  });

  it("rounds 0.9999 up to 100.0%", () => {
    expect(fmtPct(0.9999)).toBe("100.0%");
  });

  it("supports negative rates", () => {
    expect(fmtPct(-0.05)).toBe("-5.0%");
  });
});

describe("fmtDate", () => {
  it("returns '-' for null, undefined and empty string", () => {
    expect(fmtDate(null)).toBe("-");
    expect(fmtDate(undefined)).toBe("-");
    expect(fmtDate("")).toBe("-");
  });

  it("returns 'Invalid Date' for an unparseable string", () => {
    expect(fmtDate("not-a-date")).toBe("Invalid Date");
  });

  it("localises a valid ISO timestamp (not the raw input)", () => {
    const out = fmtDate("2026-06-15T12:00:00Z");
    expect(out).not.toBe("2026-06-15T12:00:00Z");
    expect(out).toContain("2026");
  });

  it.runIf(EN_US)("formats a valid ISO timestamp in en-US locale", () => {
    expect(fmtDate("2026-06-15T12:00:00Z")).toBe("6/15/2026, 12:00:00 PM");
  });
});

describe("statusBadgeClass", () => {
  it.each([
    ["invoice_generated", "badge-green"],
    ["approved", "badge-green"],
    ["dispatched", "badge-green"],
    ["awaiting_review", "badge-amber"],
    ["hitl", "badge-amber"],
    ["rejected", "badge-red"],
    ["escalated", "badge-red"],
  ])("maps %s -> %s", (status, cls) => {
    expect(statusBadgeClass(status)).toBe(cls);
  });

  it("falls back to badge-slate for unknown statuses", () => {
    expect(statusBadgeClass("ingested")).toBe("badge-slate");
    expect(statusBadgeClass("")).toBe("badge-slate");
    expect(statusBadgeClass("whatever")).toBe("badge-slate");
  });
});

describe("routingBadgeClass", () => {
  it.each([
    ["auto", "badge-green"],
    ["hitl", "badge-amber"],
    ["escalate", "badge-red"],
  ])("maps %s -> %s", (routing, cls) => {
    expect(routingBadgeClass(routing)).toBe(cls);
  });

  it("falls back to badge-slate for null/undefined/unknown", () => {
    expect(routingBadgeClass(null)).toBe("badge-slate");
    expect(routingBadgeClass(undefined)).toBe("badge-slate");
    expect(routingBadgeClass("other")).toBe("badge-slate");
  });
});

describe("confidenceBadgeClass", () => {
  it("returns badge-slate for null/undefined", () => {
    expect(confidenceBadgeClass(null)).toBe("badge-slate");
    expect(confidenceBadgeClass(undefined)).toBe("badge-slate");
  });

  it("classifies by threshold band", () => {
    expect(confidenceBadgeClass(0.9)).toBe("badge-green");
    expect(confidenceBadgeClass(0.7)).toBe("badge-blue");
    expect(confidenceBadgeClass(0.5)).toBe("badge-amber");
    expect(confidenceBadgeClass(0.2)).toBe("badge-red");
  });

  it("uses inclusive lower bounds at each boundary", () => {
    expect(confidenceBadgeClass(0.85)).toBe("badge-green");
    expect(confidenceBadgeClass(0.6)).toBe("badge-blue");
    expect(confidenceBadgeClass(0.4)).toBe("badge-amber");
    expect(confidenceBadgeClass(0.3999)).toBe("badge-red");
    expect(confidenceBadgeClass(0)).toBe("badge-red");
  });
});

describe("vatBreakdown", () => {
  it("exposes the UAE 5% VAT rate constant", () => {
    expect(VAT_RATE).toBe(0.05);
  });

  it("computes 5% VAT and the gross total for a round net", () => {
    expect(vatBreakdown(100)).toEqual({ subtotal: 100, vat: 5, total: 105 });
    expect(vatBreakdown(1000000)).toEqual({ subtotal: 1000000, vat: 50000, total: 1050000 });
  });

  it("rounds VAT and total to 2 decimals", () => {
    // 99.99 * 0.05 = 4.9995 -> rounds to 5.00; total 104.99
    expect(vatBreakdown(99.99)).toEqual({ subtotal: 99.99, vat: 5, total: 104.99 });
    // 10.1 * 0.05 = 0.505 -> 0.51; total 10.61
    expect(vatBreakdown(10.1)).toEqual({ subtotal: 10.1, vat: 0.51, total: 10.61 });
  });

  it("handles a zero net", () => {
    expect(vatBreakdown(0)).toEqual({ subtotal: 0, vat: 0, total: 0 });
  });

  it("accepts a custom rate override", () => {
    expect(vatBreakdown(100, 0.1)).toEqual({ subtotal: 100, vat: 10, total: 110 });
  });

  it("keeps the subtotal exactly equal to the input net", () => {
    expect(vatBreakdown(1234.56).subtotal).toBe(1234.56);
  });
});

describe("fmtAge", () => {
  const base = Date.parse("2026-06-15T12:00:00Z");
  const ago = (ms: number) => new Date(base - ms).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(base));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns '-' for missing/invalid input", () => {
    expect(fmtAge(null)).toBe("-");
    expect(fmtAge(undefined)).toBe("-");
    expect(fmtAge("")).toBe("-");
    expect(fmtAge("garbage")).toBe("-");
  });

  it("returns 'just now' below 60 seconds", () => {
    expect(fmtAge(ago(0))).toBe("just now");
    expect(fmtAge(ago(30_000))).toBe("just now");
    expect(fmtAge(ago(59_000))).toBe("just now");
  });

  it("returns minutes between 1m and 59m", () => {
    expect(fmtAge(ago(60_000))).toBe("1m");
    expect(fmtAge(ago(5 * 60_000))).toBe("5m");
    expect(fmtAge(ago(59 * 60_000))).toBe("59m");
  });

  it("returns hours between 1h and 23h", () => {
    expect(fmtAge(ago(3_600_000))).toBe("1h");
    expect(fmtAge(ago(3 * 3_600_000))).toBe("3h");
    expect(fmtAge(ago(23 * 3_600_000))).toBe("23h");
  });

  it("returns days at and beyond 24h", () => {
    expect(fmtAge(ago(86_400_000))).toBe("1d");
    expect(fmtAge(ago(5 * 86_400_000))).toBe("5d");
  });

  it("clamps future timestamps to 'just now'", () => {
    expect(fmtAge(new Date(base + 3_600_000).toISOString())).toBe("just now");
  });
});

describe("humanize", () => {
  it("returns '-' for falsy input", () => {
    expect(humanize(undefined)).toBe("-");
    expect(humanize(null)).toBe("-");
    expect(humanize("")).toBe("-");
  });

  it("replaces underscores with spaces and capitalises the first letter only", () => {
    expect(humanize("awaiting_review")).toBe("Awaiting review");
    expect(humanize("hello_world_foo")).toBe("Hello world foo");
  });

  it("capitalises a single character", () => {
    expect(humanize("a")).toBe("A");
  });
});

describe("isAutoDispatched", () => {
  it("is true only for the 'dispatched' status", () => {
    expect(isAutoDispatched("dispatched")).toBe(true);
  });

  it("is false for any other / missing status", () => {
    expect(isAutoDispatched("approved")).toBe(false);
    expect(isAutoDispatched("hitl")).toBe(false);
    expect(isAutoDispatched(null)).toBe(false);
    expect(isAutoDispatched(undefined)).toBe(false);
    expect(isAutoDispatched("")).toBe(false);
  });
});

describe("TASC_ENTITY", () => {
  it("holds the demo billing entity name and TRN", () => {
    expect(TASC_ENTITY.name).toBe("TASC Outsourcing LLC");
    expect(TASC_ENTITY.trn).toBe("100312345600003");
  });
});

describe("stripMarkdown", () => {
  it("returns empty input unchanged", () => {
    expect(stripMarkdown("")).toBe("");
  });

  it("leaves plain text (trimmed) alone", () => {
    expect(stripMarkdown("just plain text")).toBe("just plain text");
    expect(stripMarkdown("   spaced   ")).toBe("spaced");
  });

  it("strips bold (** and __)", () => {
    expect(stripMarkdown("**bold**")).toBe("bold");
    expect(stripMarkdown("__bold__")).toBe("bold");
  });

  it("strips single-token italics/emphasis", () => {
    expect(stripMarkdown("hello *world*")).toBe("hello world");
    expect(stripMarkdown("an _emphasis_ here")).toBe("an emphasis here");
  });

  it("strips inline code backticks", () => {
    expect(stripMarkdown("use `code` now")).toBe("use code now");
  });

  it("unwraps fenced code blocks (with and without a language)", () => {
    expect(stripMarkdown("```js\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(stripMarkdown("```\nplain\n```")).toBe("plain");
  });

  it("removes leading ATX headers", () => {
    expect(stripMarkdown("# Title")).toBe("Title");
    expect(stripMarkdown("### Heading three")).toBe("Heading three");
  });

  it("converts list bullets to • ", () => {
    expect(stripMarkdown("- item one\n- item two")).toBe("• item one\n• item two");
    expect(stripMarkdown("* item")).toBe("• item");
  });

  it("collapses 3+ blank lines to a double newline", () => {
    expect(stripMarkdown("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("handles a combined markdown blob", () => {
    expect(stripMarkdown("# H\n\nSome **bold** and `code`.\n\n- point")).toBe(
      "H\n\nSome bold and code.\n• point",
    );
  });
});

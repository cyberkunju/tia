import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: {
    listRules: vi.fn(),
    getContract: vi.fn(),
    status: vi.fn(),
    listEvents: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { PlainEnglishStatus } from "../../src/components/PlainEnglishStatus";
import { ContractPanel } from "../../src/components/ContractPanel";
import { SystemStatusFooter } from "../../src/components/SystemStatusFooter";
import { TouchlessRationale } from "../../src/components/TouchlessRationale";
import type { ValidationResult } from "../../src/types";

function renderQ(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.listRules).mockReset().mockResolvedValue({ count: 0, rules: [], friendly_message_table: {} } as never);
  vi.mocked(api.getContract).mockReset();
  vi.mocked(api.status).mockReset();
  vi.mocked(api.listEvents).mockReset().mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe("PlainEnglishStatus — friendly fallback chain", () => {
  it("falls back through rule_name and finally the generic message", async () => {
    const fails: ValidationResult[] = [
      { rule: "r98", rule_id: "R98", rule_name: "Named rule", passed: false, severity: "error" } as ValidationResult,
      { rule: "r99", rule_id: "R99", passed: false, severity: "error" } as ValidationResult,
    ];
    renderQ(<PlainEnglishStatus results={fails} />);
    expect(await screen.findByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText("Named rule")).toBeInTheDocument();
    expect(screen.getByText("An issue was found.")).toBeInTheDocument();
  });
});

describe("ContractPanel — unknown jurisdiction/type + full body", () => {
  it("renders jurisdiction/type fallbacks with SoWs and rate cards", async () => {
    vi.mocked(api.getContract).mockResolvedValue({
      name: "Acme Contract",
      jurisdiction: "XX", // not in JURISDICTION_TONE → fallback tone
      type: "WEIRD_TYPE", // not in TYPE_LABEL → raw type
      currency: "AED",
      max_ot_pct: 0.2,
      markup_pct: 0.15,
      vat_rate: 0.05,
      payment_terms_days: 30,
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      authorized_emp_count: 5,
      sac_code: "998515",
      sows: [
        { deliverable: "Phase 1", status: "COMPLETED", hours_consumed: 100, hours_expected: 100 },
        { deliverable: "Phase 2", status: "ACTIVE", hours_consumed: 40, hours_expected: 120 },
      ],
      rate_cards: [
        { labor_category: "Welder", regular_rate: 55 },
        { labor_category: "Foreman", regular_rate: 80 },
      ],
    } as never);
    renderQ(<ContractPanel clientCode="CL001" />);
    expect(await screen.findByText("Acme Contract")).toBeInTheDocument();
    expect(screen.getByText("XX")).toBeInTheDocument();
    expect(screen.getByText("WEIRD_TYPE")).toBeInTheDocument();
    expect(screen.getByText("Phase 1")).toBeInTheDocument();
    expect(screen.getByText("Welder")).toBeInTheDocument();
  });

  it("renders nothing when no clientCode is supplied", () => {
    const { container } = renderQ(<ContractPanel clientCode={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("SystemStatusFooter — both variants + dot classes", () => {
  it("renders the compact variant with mixed status values", async () => {
    vi.mocked(api.status).mockResolvedValue({
      api: "ok", db: "missing_key", openai: "configured", modal_ocr: undefined, zoho_mail: "unreachable", rust_dispatch: "in_process",
    } as never);
    const { container } = renderQ(<SystemStatusFooter compact tone="dark" />);
    // 6 dots regardless of value
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelectorAll("span[title]").length).toBeGreaterThanOrEqual(6);
  });

  it("renders the default variant with labels", async () => {
    vi.mocked(api.status).mockResolvedValue({
      api: "ok", db: "ok", openai: "missing_key", modal_ocr: "unreachable", zoho_mail: undefined, rust_dispatch: "configured",
    } as never);
    renderQ(<SystemStatusFooter />);
    expect(await screen.findByText("api")).toBeInTheDocument();
    expect(screen.getByText("dispatch")).toBeInTheDocument();
  });
});

describe("TouchlessRationale — AutoCard payload fallbacks", () => {
  it("uses default threshold/engine/hash and 'No rule IDs' when payload is sparse", async () => {
    vi.mocked(api.listEvents).mockResolvedValue([
      { id: "auto-evt", kind: "invoice", entity_id: "i1", action: "auto_dispatched_within_tolerance", actor: "system", at: "2026-06-01T10:00:00Z", payload: {} },
    ] as never);
    renderQ(
      <TouchlessRationale
        invoice={{ id: "i1", invoice_sequence_no: "INV-1", amount: 1000, total_incl_vat: 1050, currency: "AED", status: "dispatched", client_code: "CL001", period: "2026-06", timesheet_id: "t1", line_items: [], pdf_available: false, dispatched_at: null } as never}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("Auto-dispatched within tolerance")).toBeInTheDocument();
    expect(screen.getByText("No rule IDs recorded.")).toBeInTheDocument();
    expect(screen.getByText("in_process")).toBeInTheDocument();
  });

  it("shows the manual-review message when there is no auto event", async () => {
    vi.mocked(api.listEvents).mockResolvedValue([
      { id: "e1", kind: "invoice", entity_id: "i1", action: "generated", actor: "system", at: "2026-06-01T10:00:00Z", payload: {} },
    ] as never);
    renderQ(
      <TouchlessRationale
        invoice={{ id: "i1", invoice_sequence_no: null, amount: 1000, currency: "AED", status: "generated", client_code: "CL001", period: "2026-06", timesheet_id: "t1", line_items: [], pdf_available: false, dispatched_at: null } as never}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(/went through manual review/)).toBeInTheDocument();
  });
});

describe("ContractPanel / TouchlessRationale — remaining fallbacks", () => {
  it("ContractPanel: authorized_emp_count fallback + no sows/rate cards", async () => {
    vi.mocked(api.getContract).mockResolvedValue({
      name: "Sparse Contract", jurisdiction: "UAE", type: "RETAINER", currency: "AED",
      max_ot_pct: 0.1, markup_pct: 0.1, vat_rate: 0.05, payment_terms_days: 30,
      start_date: "2026-01-01", end_date: null, // end_date null → "open"
      sows: [], rate_cards: [], // empty → sections skipped
    } as never);
    renderQ(<ContractPanel clientCode="CL001" />);
    expect(await screen.findByText("Sparse Contract")).toBeInTheDocument();
    // authorized_emp_count undefined → "0 emp"
    expect(screen.getByText("0 emp")).toBeInTheDocument();
  });

  it("TouchlessRationale: null payload and missing invoice amount fall back to 0", async () => {
    vi.mocked(api.listEvents).mockResolvedValue([
      { id: "auto-evt", kind: "invoice", entity_id: "i1", action: "auto_dispatched_within_tolerance", actor: "system", at: "2026-06-01T10:00:00Z", payload: null },
    ] as never);
    renderQ(
      <TouchlessRationale
        invoice={{ id: "i1", invoice_sequence_no: "INV-1", total_incl_vat: 1050, currency: "AED", status: "dispatched", client_code: "CL001", period: "2026-06", timesheet_id: "t1", line_items: [], pdf_available: false, dispatched_at: null } as never}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("Auto-dispatched within tolerance")).toBeInTheDocument();
  });
});

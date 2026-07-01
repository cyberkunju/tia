import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventTimeline } from "../../src/components/EventTimeline";
import type { EventRow } from "../../src/types";

const ev = (over: Partial<EventRow> = {}): EventRow => ({
  id: crypto.randomUUID(),
  at: "2026-06-01T09:15:30Z",
  actor: "system",
  kind: "invoice",
  entity_id: "e1",
  action: "ingested",
  payload: {},
  idempotency_key: null,
  ...over,
});

describe("EventTimeline", () => {
  it("renders the empty state when there are no events", () => {
    render(<EventTimeline events={[]} />);
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });

  it("renders the empty state when events is nullish", () => {
    // @ts-expect-error intentionally passing undefined to hit the guard
    render(<EventTimeline events={undefined} />);
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });

  it("renders event actions humanised, the time slice, actor, and a Live footer", () => {
    render(<EventTimeline events={[ev({ action: "rules_evaluated", actor: "finops" })]} />);
    expect(screen.getByText("rules evaluated")).toBeInTheDocument();
    expect(screen.getByText("09:15:30")).toBeInTheDocument();
    expect(screen.getByText("by finops")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("falls back to 'system' when actor is null", () => {
    render(<EventTimeline events={[ev({ actor: null })]} />);
    expect(screen.getByText("by system")).toBeInTheDocument();
  });

  it("sorts ascending by timestamp and keeps only the last `max` events", () => {
    const events = [
      ev({ id: "a", at: "2026-06-01T01:00:00Z", action: "ingested" }),
      ev({ id: "b", at: "2026-06-01T02:00:00Z", action: "extracted" }),
      ev({ id: "c", at: "2026-06-01T03:00:00Z", action: "generated" }),
    ];
    render(<EventTimeline events={events} max={2} />);
    // max=2 keeps the two latest: extracted + generated; drops ingested
    expect(screen.getByText("extracted")).toBeInTheDocument();
    expect(screen.getByText("generated")).toBeInTheDocument();
    expect(screen.queryByText("ingested")).not.toBeInTheDocument();
  });

  it("summarises a rich payload (amount, client, sequence, rules, engine, mode)", () => {
    render(
      <EventTimeline
        events={[
          ev({
            action: "routed",
            payload: {
              amount: 1234.5,
              client: "Acme LLC",
              sequence_no: "INV-2026-0007",
              rule_id: "VAT_01",
              engine: "in_process",
              intake_mode: "email",
              rules_run: 12,
              blocking_failures: 2,
            },
          }),
        ]}
      />,
    );
    expect(
      screen.getByText(
        /AED 1234\.50 · Acme LLC · INV-2026-0007 · rule VAT_01 · engine: in_process · mode: email · 12 rules · 2 failed/,
      ),
    ).toBeInTheDocument();
  });

  it("summarises partial credit-note, adjustment, threshold and consolidated payloads", () => {
    render(
      <EventTimeline
        events={[
          ev({
            action: "invoice.credit_note_issued",
            payload: {
              credit_note_sequence_no: "CN-99",
              rules_passed_count: 5,
              is_partial: true,
              credit_note_amount: 100,
              invoice_amount: 400,
              adjustment_type: "DEDUCT_FROM_NEXT_INVOICE",
              threshold: 50000,
              consolidated_excel: true,
              friendly: "netted off next run",
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText(/CN CN-99/)).toBeInTheDocument();
    expect(screen.getByText(/5 rules passed/)).toBeInTheDocument();
    expect(screen.getByText(/partial - AED 100\.00 of AED 400\.00/)).toBeInTheDocument();
    expect(screen.getByText(/deduct from next invoice/)).toBeInTheDocument();
    expect(screen.getByText(/threshold AED 50000/)).toBeInTheDocument();
    expect(screen.getByText(/consolidated\.xlsx \+ WPS\.sif written/)).toBeInTheDocument();
    expect(screen.getByText(/\(netted off next run\)/)).toBeInTheDocument();
  });

  it("omits the payload summary line when the payload has no summarisable fields", () => {
    const { container } = render(<EventTimeline events={[ev({ action: "dispatched", payload: {} })]} />);
    // action chip + time + actor render, but no extra summary <div> with text
    expect(screen.getByText("dispatched")).toBeInTheDocument();
    // the only mt-0.5 truncate summary divs should be absent
    expect(container.querySelector(".truncate")).toBeNull();
  });

  it("falls back to the invoice_amount '?' branch when it is missing on a partial", () => {
    render(
      <EventTimeline
        events={[
          ev({
            action: "routed",
            payload: { is_partial: true, credit_note_amount: 100 },
          }),
        ]}
      />,
    );
    expect(screen.getByText(/partial - AED 100\.00 of AED \?/)).toBeInTheDocument();
  });
});

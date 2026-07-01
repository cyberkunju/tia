import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { InvoiceChatTrigger } from "../../src/components/InvoiceChatTrigger";
import { usePersona } from "../../src/store";

/** Surfaces the current ?aida= param so we can assert URL writes. */
function AidaProbe() {
  const [sp] = useSearchParams();
  return <output data-testid="aida">{sp.get("aida") ?? ""}</output>;
}

function renderTrigger(node: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={["/portal/invoices"]}>
      {node}
      <AidaProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  usePersona.setState({ aidaOpen: false, focusedEntity: null });
});

describe("InvoiceChatTrigger", () => {
  it("renders the inline (icon-only) variant with an accessible label", () => {
    renderTrigger(<InvoiceChatTrigger kind="invoice" id="inv-1" />);
    expect(
      screen.getByRole("button", { name: "Ask AIDA about this invoice" }),
    ).toBeInTheDocument();
  });

  it("renders the prominent variant with a visible label", () => {
    renderTrigger(<InvoiceChatTrigger kind="invoice" id="inv-1" variant="prominent" />);
    const btn = screen.getByRole("button", { name: /Ask AIDA/ });
    expect(btn).toHaveTextContent("Ask AIDA");
    expect(btn).toHaveAttribute("title", "Ask AIDA about this invoice");
  });

  it("supports a custom label on the prominent variant", () => {
    renderTrigger(
      <InvoiceChatTrigger kind="document" id="doc-1" variant="prominent" label="Chat" />,
    );
    expect(screen.getByRole("button", { name: /Chat/ })).toHaveAttribute(
      "title",
      "Chat about this document",
    );
  });

  it("on click for an invoice writes a bare ?aida=<id> and opens the panel focused", async () => {
    const user = userEvent.setup();
    renderTrigger(<InvoiceChatTrigger kind="invoice" id="inv-42" ref="INV-2026-0042" />);

    await user.click(screen.getByRole("button", { name: /Ask AIDA/ }));

    expect(screen.getByTestId("aida")).toHaveTextContent("inv-42");
    expect(usePersona.getState().aidaOpen).toBe(true);
    expect(usePersona.getState().focusedEntity).toEqual({
      kind: "invoice",
      id: "inv-42",
      ref: "INV-2026-0042",
    });
  });

  it("prefixes non-invoice kinds in the URL (document:<id>)", async () => {
    const user = userEvent.setup();
    renderTrigger(<InvoiceChatTrigger kind="document" id="doc-9" />);

    await user.click(screen.getByRole("button", { name: /Ask AIDA/ }));

    expect(screen.getByTestId("aida")).toHaveTextContent("document:doc-9");
    expect(usePersona.getState().focusedEntity).toEqual({
      kind: "document",
      id: "doc-9",
      ref: undefined,
    });
  });

  it("prefixes timesheet kinds too", async () => {
    const user = userEvent.setup();
    renderTrigger(<InvoiceChatTrigger kind="timesheet" id="ts-3" />);

    await user.click(screen.getByRole("button", { name: /Ask AIDA/ }));
    expect(screen.getByTestId("aida")).toHaveTextContent("timesheet:ts-3");
  });
});

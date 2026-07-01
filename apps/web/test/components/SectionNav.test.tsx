import { beforeEach, describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SectionNav } from "../../src/components/SectionNav";
import { usePersona } from "../../src/store";

function renderNav(initialPath = "/console", node: ReactElement = <SectionNav />) {
  return render(<MemoryRouter initialEntries={[initialPath]}>{node}</MemoryRouter>);
}

beforeEach(() => {
  usePersona.setState({ persona: "finops" });
});

describe("SectionNav", () => {
  it("renders the full finops link set", () => {
    usePersona.setState({ persona: "finops" });
    renderNav("/console");
    for (const label of ["Pipeline", "Approvals", "Clients", "Rules", "Dispatch", "Tracking", "Evaluation"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("renders the client link set and none of the finops-only links", () => {
    usePersona.setState({ persona: "client" });
    renderNav("/portal");
    expect(screen.getByRole("link", { name: "Submit" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Invoices" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Queries" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Pipeline" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Rules" })).not.toBeInTheDocument();
  });

  it("renders the finance link set", () => {
    usePersona.setState({ persona: "finance" });
    renderNav("/finance");
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Approvals" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Submit" })).not.toBeInTheDocument();
  });

  it("marks the active link with the brand underline classes", () => {
    usePersona.setState({ persona: "finops" });
    renderNav("/console");
    const active = screen.getByRole("link", { name: "Pipeline" });
    expect(active.className).toMatch(/border-brand-500/);
    expect(active.className).toMatch(/text-ink-900/);
    // an inactive link uses the transparent border style
    const inactive = screen.getByRole("link", { name: "Rules" });
    expect(inactive.className).toMatch(/border-transparent/);
  });
});

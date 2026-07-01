import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileText } from "lucide-react";
import {
  Badge,
  ConfidenceBadge,
  EmptyState,
  Metric,
  PageHeader,
  Panel,
  RoutingBadge,
  Skeleton,
  Spinner,
  StatusBadge,
  TableSkeleton,
} from "../../src/ui";

describe("Badge", () => {
  it("applies the tone class and shows a dot by default", () => {
    const { container } = render(<Badge tone="green">Hi</Badge>);
    const el = container.firstElementChild!;
    expect(el).toHaveClass("badge-green");
    expect(el).not.toHaveClass("badge-plain");
    expect(el).toHaveTextContent("Hi");
  });

  it("adds badge-plain when dot is disabled", () => {
    const { container } = render(<Badge tone="red" dot={false}>X</Badge>);
    expect(container.firstElementChild).toHaveClass("badge-red", "badge-plain");
  });
});

describe("StatusBadge", () => {
  it.each([
    ["dispatched", "badge-green", "Dispatched"],
    ["awaiting_review", "badge-amber", "Awaiting review"],
    ["rejected", "badge-red", "Rejected"],
    ["validated", "badge-blue", "Validated"],
    ["ingested", "badge-slate", "Ingested"],
  ])("maps %s to %s with humanized label", (status, cls, label) => {
    const { container } = render(<StatusBadge status={status} />);
    expect(container.querySelector(`.${cls}`)).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("falls back to slate + '-' for an unknown or missing status", () => {
    const { container: c1 } = render(<StatusBadge status="mystery" />);
    expect(c1.querySelector(".badge-slate")).toBeInTheDocument();

    const { container: c2 } = render(<StatusBadge status={null} />);
    expect(c2.querySelector(".badge-slate")).toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
  });
});

describe("RoutingBadge", () => {
  it("renders a plain dash (no badge) when routing is missing", () => {
    const { container } = render(<RoutingBadge routing={null} />);
    expect(container.querySelector("[class*='badge-']")).not.toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  it("relabels hitl as 'Needs review' with an amber tone", () => {
    const { container } = render(<RoutingBadge routing="hitl" />);
    expect(container.querySelector(".badge-amber")).toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
  });

  it("maps auto -> green and escalate -> red", () => {
    const { container: c1 } = render(<RoutingBadge routing="auto" />);
    expect(c1.querySelector(".badge-green")).toBeInTheDocument();
    expect(screen.getByText("Auto")).toBeInTheDocument();

    const { container: c2 } = render(<RoutingBadge routing="escalate" />);
    expect(c2.querySelector(".badge-red")).toBeInTheDocument();
  });
});

describe("ConfidenceBadge", () => {
  it("renders a plain dash when the value is null/undefined", () => {
    const { container } = render(<ConfidenceBadge value={null} />);
    expect(container.querySelector("[class*='badge-']")).not.toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  it("formats the percentage and picks the tone band", () => {
    const { container } = render(<ConfidenceBadge value={0.9} />);
    expect(container.querySelector(".badge-green")).toBeInTheDocument();
    expect(screen.getByText("90.0%")).toBeInTheDocument();
  });

  it("uses amber for a mid-band confidence", () => {
    const { container } = render(<ConfidenceBadge value={0.5} />);
    expect(container.querySelector(".badge-amber")).toBeInTheDocument();
    expect(screen.getByText("50.0%")).toBeInTheDocument();
  });
});

describe("layout + state primitives", () => {
  it("PageHeader shows title, description and actions", () => {
    render(
      <PageHeader
        icon={FileText}
        title="Finance approvals"
        description="needs sign-off"
        actions={<button type="button">Do it</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "Finance approvals" })).toBeInTheDocument();
    expect(screen.getByText("needs sign-off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Do it" })).toBeInTheDocument();
  });

  it("Panel renders a header only when a title is provided", () => {
    const { container: withTitle } = render(<Panel title="T">body</Panel>);
    expect(withTitle.querySelector("header")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "T" })).toBeInTheDocument();

    const { container: noTitle } = render(<Panel>body</Panel>);
    expect(noTitle.querySelector("header")).not.toBeInTheDocument();
  });

  it("Metric shows label + value and applies the accent ring when set", () => {
    const { container } = render(<Metric label="Touchless" value="90%" hint="target 90%" accent />);
    expect(screen.getByText("Touchless")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByText("target 90%")).toBeInTheDocument();
    expect(container.querySelector(".ring-brand-200")).toBeInTheDocument();
  });

  it("EmptyState shows title, hint and optional action", () => {
    render(<EmptyState title="Nothing here" hint="all clear" action={<span>reset</span>} />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("all clear")).toBeInTheDocument();
    expect(screen.getByText("reset")).toBeInTheDocument();
  });

  it("TableSkeleton renders rows x cols placeholder cells", () => {
    const { container } = render(
      <table>
        <TableSkeleton rows={3} cols={4} />
      </table>,
    );
    expect(container.querySelectorAll("td")).toHaveLength(12);
  });

  it("Spinner and Skeleton render with their marker classes", () => {
    const { container: s1 } = render(<Spinner />);
    expect(s1.querySelector(".animate-spin")).toBeInTheDocument();
    const { container: s2 } = render(<Skeleton />);
    expect(s2.querySelector(".skeleton")).toBeInTheDocument();
  });
});

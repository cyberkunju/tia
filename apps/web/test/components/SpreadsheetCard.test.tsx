import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SpreadsheetCard } from "../../src/components/SpreadsheetCard";

describe("SpreadsheetCard", () => {
  it("renders the workbook placeholder, header and a download link to the source", () => {
    render(<SpreadsheetCard sourceUrl="http://api.test/documents/1/source" filename="june.xlsx" />);

    expect(screen.getByText("Spreadsheet")).toBeInTheDocument();
    expect(screen.getByText("Excel workbook")).toBeInTheDocument();
    expect(screen.getByText(/Parsed instantly via openpyxl/)).toBeInTheDocument();
    expect(screen.getByText("june.xlsx")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /Download original/ });
    expect(link).toHaveAttribute("href", "http://api.test/documents/1/source");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("omits the filename line when no filename is provided", () => {
    render(<SpreadsheetCard sourceUrl="http://api.test/documents/2/source" />);
    expect(screen.getByText("Excel workbook")).toBeInTheDocument();
    expect(screen.queryByText(/\.xlsx$/)).not.toBeInTheDocument();
  });
});

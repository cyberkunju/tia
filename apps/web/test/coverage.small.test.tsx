import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { api } from "../src/api";
import { fmtDate } from "../src/lib";
import { RoutingBadge } from "../src/ui";

/**
 * Top-up coverage for the last few branches the main suites leave open:
 *  - api.req's `content-type || ""` fallback when the header is absent
 *  - api.qaStream's `res.text().catch(() => "")` when the error body read fails
 *  - lib.fmtDate's catch arm (toLocaleString throwing)
 *  - ui.RoutingBadge's `?? "slate"` for an unknown routing value
 */

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api.req content-type fallback", () => {
  it("treats a missing content-type header as non-JSON and returns raw text", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null }, // no content-type → `|| ""`
      json: async () => ({ nope: true }),
      text: async () => "raw-body",
    });
    await expect(api.health() as unknown as Promise<string>).resolves.toBe("raw-body");
  });
});

describe("api.qaStream error-body read failure", () => {
  it("throws with an empty detail when reading the error body rejects", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      body: null,
      text: async () => {
        throw new Error("cannot read body");
      },
    });
    const gen = api.qaStream("q?");
    await expect(gen.next()).rejects.toThrow(/qa\/stream 500: $/);
  });
});

describe("lib.fmtDate catch arm", () => {
  it("returns the original string when toLocaleString throws", () => {
    const spy = vi
      .spyOn(Date.prototype, "toLocaleString")
      .mockImplementation(() => {
        throw new Error("locale blew up");
      });
    expect(fmtDate("2026-06-15T12:00:00Z")).toBe("2026-06-15T12:00:00Z");
    spy.mockRestore();
  });
});

describe("ui.RoutingBadge unknown routing", () => {
  it("falls back to the slate tone for a routing value not in the map", () => {
    const { container } = render(<RoutingBadge routing="mystery-routing" />);
    expect(container.querySelector(".badge-slate")).toBeInTheDocument();
    // humanized label of the unknown value
    expect(screen.getByText("Mystery-routing")).toBeInTheDocument();
  });
});

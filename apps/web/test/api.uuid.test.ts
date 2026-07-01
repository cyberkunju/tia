import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

/**
 * `uuid()` prefers crypto.randomUUID but falls back to a timestamp+random id
 * on platforms/contexts where it's unavailable. api.test.ts covers the normal
 * path (crypto.randomUUID present); this pins the `??` fallback branch.
 */

function fakeRes(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => fakeRes({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("uuid fallback when crypto.randomUUID is unavailable", () => {
  it("still produces an Idempotency-Key via the timestamp+random fallback", async () => {
    // crypto with no randomUUID → `?.()` short-circuits to undefined → fallback.
    vi.stubGlobal("crypto", {});
    await api.qa("hi");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const key = (init.headers as Record<string, string>)["Idempotency-Key"];
    // fallback shape: `${Date.now()}-${random hex}` (never a v4 uuid with dashes in fixed spots)
    expect(key).toMatch(/^\d+-[0-9a-f]+$/);
  });
});

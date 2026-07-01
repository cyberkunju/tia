import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bearer token is read once at module load from import.meta.env.VITE_API_TOKEN.
 * To cover the "token configured" branch of `req` we stub the env var and import
 * a fresh copy of the module (resetModules clears the cached, token-less one from
 * the sibling api.test.ts run).
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
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("req with VITE_API_TOKEN set", () => {
  it("attaches an Authorization: Bearer header to a plain GET", async () => {
    vi.stubEnv("VITE_API_TOKEN", "secret-abc");
    const { api } = await import("../src/api");
    await api.status();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-abc");
  });

  it("merges the bearer header with a request that already carries headers", async () => {
    vi.stubEnv("VITE_API_TOKEN", "secret-xyz");
    const { api } = await import("../src/api");
    await api.qa("hi");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer secret-xyz");
    // the jsonInit headers survive the merge
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Idempotency-Key"]).toBeTruthy();
  });

  it("does not attach an Authorization header when the token is empty", async () => {
    vi.stubEnv("VITE_API_TOKEN", "");
    const { api } = await import("../src/api");
    await api.status();
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });
});

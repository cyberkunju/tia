import { describe, expect, test } from "bun:test";
import { createSender, type FetchLike } from "../src/whatsapp/sender.ts";

/** A fake Graph fetch that records the last request and returns a scripted response. */
function fakeFetch(response: { ok: boolean; status: number; json: unknown }): {
  fetch: FetchLike;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: response.ok, status: response.status, json: async () => response.json };
  };
  return { fetch, calls };
}

const base = { graphBaseUrl: "https://graph.facebook.com/v23.0", phoneNumberId: "PN", token: "tok" };

describe("sender.sendText", () => {
  test("posts a text message and returns the message id", async () => {
    const { fetch, calls } = fakeFetch({ ok: true, status: 200, json: { messages: [{ id: "wamid.out" }] } });
    const sender = createSender({ ...base, fetch });
    const res = await sender.sendText("971500", "hello");
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("wamid.out");
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v23.0/PN/messages");
    expect(calls[0]?.body).toMatchObject({ type: "text", to: "971500", text: { body: "hello" } });
  });

  test("rejects empty body without calling the API", async () => {
    const { fetch, calls } = fakeFetch({ ok: true, status: 200, json: {} });
    const sender = createSender({ ...base, fetch });
    const res = await sender.sendText("971500", "");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("length_violation");
    expect(calls).toHaveLength(0);
  });

  test("classifies a closed 24h window from the error code", async () => {
    const { fetch } = fakeFetch({ ok: false, status: 400, json: { error: { code: 131047, message: "re-engagement" } } });
    const sender = createSender({ ...base, fetch });
    const res = await sender.sendText("971500", "hi");
    expect(res.ok).toBe(false);
    expect(res.windowClosed).toBe(true);
    expect(res.errorCode).toBe(131047);
  });

  test("missing credentials fail without a network call", async () => {
    const { fetch, calls } = fakeFetch({ ok: true, status: 200, json: {} });
    const sender = createSender({ ...base, token: "", fetch });
    const res = await sender.sendText("971500", "hi");
    expect(res.reason).toBe("missing_config");
    expect(calls).toHaveLength(0);
  });
});

describe("sender.sendInteractiveButtons", () => {
  test("posts up to 3 reply buttons and truncates long titles", async () => {
    const { fetch, calls } = fakeFetch({ ok: true, status: 200, json: { messages: [{ id: "wamid.b" }] } });
    const sender = createSender({ ...base, fetch });
    const res = await sender.sendInteractiveButtons("971500", {
      body: "Which Fatima Khan?",
      buttons: [
        { id: "emp:EMP10083", title: "Accountant · AED 6,200 (a very long label that exceeds the cap)" },
        { id: "emp:EMP10093", title: "Marketing Mgr · 16,500" },
        { id: "hitl:escalate", title: "Not sure" },
        { id: "ignored:4", title: "fourth dropped" },
      ],
    });
    expect(res.ok).toBe(true);
    const body = calls[0]?.body as {
      interactive: { action: { buttons: Array<{ reply: { id: string; title: string } }> } };
    };
    const buttons = body.interactive.action.buttons;
    expect(buttons).toHaveLength(3); // 4th dropped at the cap
    expect(buttons[0]?.reply.title.length).toBeLessThanOrEqual(20); // truncated
    expect(buttons[0]?.reply.id).toBe("emp:EMP10083");
  });

  test("rejects an empty button set without a network call", async () => {
    const { fetch, calls } = fakeFetch({ ok: true, status: 200, json: {} });
    const sender = createSender({ ...base, fetch });
    const res = await sender.sendInteractiveButtons("971500", { body: "x", buttons: [] });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("empty_buttons");
    expect(calls).toHaveLength(0);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { MediaService } from "../src/whatsapp/media.ts";
import type { Sender, SendResult, ButtonSpec } from "../src/whatsapp/sender.ts";
import type { IntakeResult, InvoiceRef, UpstreamClient } from "../src/upstream.ts";

const stagingDir = join(tmpdir(), `tia-wa-test-${crypto.randomUUID()}`);
afterAll(() => rmSync(stagingDir, { recursive: true, force: true }));

const config = loadConfig({
  WHATSAPP_VERIFY_TOKEN: "verify-tok",
  WHATSAPP_APP_SECRET: "app-secret",
  WHATSAPP_TOKEN: "tok",
  WHATSAPP_PHONE_NUMBER_ID: "PN",
  UPSTREAM_API_URL: "http://core.local",
  BRIDGE_PUBLIC_URL: "http://bridge.local",
  STAGING_DIR: stagingDir,
  NODE_ENV: "test",
});

const fakeMedia: MediaService = {
  async downloadMedia(id) {
    if (id === "DOC_XLSX") return { buffer: Buffer.from("PK fake xlsx"), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", byteSize: 12 };
    if (id === "IMG_JPG") return { buffer: Buffer.from("\xff\xd8 fake jpg"), mimeType: "image/jpeg", byteSize: 11 };
    return null;
  },
};

interface SentText { to: string; body: string; }

function capturingSender(): { sender: Sender; sent: SentText[]; docs: Array<{ to: string; caption?: string }>; reads: string[] } {
  const sent: SentText[] = [];
  const docs: Array<{ to: string; caption?: string }> = [];
  const reads: string[] = [];
  const sender: Sender = {
    async sendText(to, body): Promise<SendResult> { sent.push({ to, body }); return { ok: true, messageId: `t${sent.length}` }; },
    async sendInteractiveButtons(to, spec: ButtonSpec): Promise<SendResult> { sent.push({ to, body: spec.body }); return { ok: true }; },
    async uploadMedia(): Promise<string | null> { return "media.fake"; },
    async sendDocument(to, spec): Promise<SendResult> { docs.push({ to, caption: spec.caption }); return { ok: true, messageId: `d${docs.length}` }; },
    async markRead(messageId) { reads.push(messageId); },
  };
  return { sender, sent, docs, reads };
}

/** Fake upstream: records intake calls; returns a configurable status + invoice. */
function fakeUpstream(status: string, invoice: InvoiceRef | null): { upstream: UpstreamClient; intakes: any[] } {
  const intakes: any[] = [];
  let n = 0;
  const upstream: UpstreamClient = {
    async intakeWhatsapp(payload, idem): Promise<IntakeResult | null> {
      intakes.push({ payload, idem });
      n += 1;
      return { docId: `doc-${n}`, timesheetId: `ts-${n}`, status };
    },
    async invoiceForTimesheet(): Promise<InvoiceRef | null> { return invoice; },
    async invoicePdf() { return { bytes: new Uint8Array([1, 2, 3]), mime: "application/pdf" }; },
  };
  return { upstream, intakes };
}

async function fire(app: ReturnType<typeof buildApp>["app"], messages: unknown[]): Promise<number> {
  const res = await app.request("/internal/simulator/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  return res.status;
}

describe("bridge adapter → core /intake/whatsapp", () => {
  test("document: stages media, forwards attachment_url, sends back the invoice PDF", async () => {
    const { sender, docs, reads } = capturingSender();
    const { upstream, intakes } = fakeUpstream("invoice_generated", { id: "inv-1", status: "generated", amount: 10446.75, currency: "AED" });
    const built = buildApp({ config, media: fakeMedia, sender, upstream });

    expect(await fire(built.app, [{ from: "9715", id: "wamid.d1", type: "document", document: { id: "DOC_XLSX", mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "june.xlsx" } }])).toBe(200);
    await built.whenIdle();

    expect(intakes).toHaveLength(1);
    expect(intakes[0]!.payload.from_).toBe("9715");
    expect(intakes[0]!.payload.attachment_url).toContain("http://bridge.local/media/");
    expect(intakes[0]!.idem).toBe("wamid.d1");
    expect(docs).toHaveLength(1); // invoice PDF sent
    expect(docs[0]!.caption).toContain("Invoice ready");
    expect(reads).toContain("wamid.d1");
  });

  test("text: forwards message_text (no attachment)", async () => {
    const { sender } = capturingSender();
    const { upstream, intakes } = fakeUpstream("invoice_generated", { id: "inv-2", status: "generated", amount: 100, currency: "AED" });
    const built = buildApp({ config, media: fakeMedia, sender, upstream });
    await fire(built.app, [{ from: "9716", id: "wamid.t1", type: "text", text: { body: "EMP10001 worked 24 days" } }]);
    await built.whenIdle();
    expect(intakes[0]!.payload.message_text).toBe("EMP10001 worked 24 days");
    expect(intakes[0]!.payload.attachment_url).toBeNull();
  });

  test("awaiting_review → sends a review message, no document", async () => {
    const { sender, sent, docs } = capturingSender();
    const { upstream } = fakeUpstream("awaiting_review", null);
    const built = buildApp({ config, media: fakeMedia, sender, upstream });
    await fire(built.app, [{ from: "9717", id: "wamid.r1", type: "text", text: { body: "Fatima Khan 23 days" } }]);
    await built.whenIdle();
    expect(docs).toHaveLength(0);
    expect(sent.some((s) => s.body.toLowerCase().includes("human check"))).toBe(true);
  });

  test("media download failure → graceful prompt, no forward", async () => {
    const { sender, sent } = capturingSender();
    const { upstream, intakes } = fakeUpstream("invoice_generated", null);
    const built = buildApp({ config, media: fakeMedia, sender, upstream });
    await fire(built.app, [{ from: "9718", id: "wamid.b1", type: "document", document: { id: "UNKNOWN", mime_type: "application/pdf" } }]);
    await built.whenIdle();
    expect(intakes).toHaveLength(0);
    expect(sent.some((s) => s.body.toLowerCase().includes("couldn't download"))).toBe(true);
  });

  test("Meta retry of same message id is de-duplicated (forwarded once)", async () => {
    const { sender } = capturingSender();
    const { upstream, intakes } = fakeUpstream("invoice_generated", { id: "inv-3", status: "generated", amount: 1, currency: "AED" });
    const built = buildApp({ config, media: fakeMedia, sender, upstream });
    const payload = [{ from: "9719", id: "wamid.same", type: "text", text: { body: "hi" } }];
    await fire(built.app, payload); await built.whenIdle();
    await fire(built.app, payload); await built.whenIdle();
    expect(intakes).toHaveLength(1);
  });

  test("rejects unsigned POST with 403 and forwards nothing", async () => {
    const { sender } = capturingSender();
    const { upstream, intakes } = fakeUpstream("invoice_generated", null);
    const built = buildApp({ config, media: fakeMedia, sender, upstream });
    const res = await built.app.request("/webhook/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Hub-Signature-256": "sha256=dead" },
      body: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
    });
    expect(res.status).toBe(403);
    await built.whenIdle();
    expect(intakes).toHaveLength(0);
  });

  test("GET handshake echoes the challenge", async () => {
    const { sender } = capturingSender();
    const { upstream } = fakeUpstream("invoice_generated", null);
    const built = buildApp({ config, media: fakeMedia, sender, upstream });
    const ok = await built.app.request("/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-tok&hub.challenge=123");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("123");
  });
});

import { describe, expect, test } from "bun:test";
import { extractInboundMessages, parseInbound } from "../src/whatsapp/parse.ts";
import type { MetaWebhookEnvelope } from "../src/whatsapp/types.ts";

describe("parseInbound", () => {
  test("text → body from text.body", () => {
    const n = parseInbound({ type: "text", from: "971500", id: "m1", text: { body: "hello" } });
    expect(n.kind).toBe("text");
    expect(n.body).toBe("hello");
    expect(n.phone).toBe("971500");
    expect(n.messageId).toBe("m1");
  });

  test("document → captures media ref + filename + caption, sets hasDocument", () => {
    const n = parseInbound({
      type: "document",
      from: "971501",
      id: "m2",
      document: {
        id: "DOC1",
        mime_type: "application/pdf",
        filename: "june.pdf",
        caption: "my timesheet",
      },
    });
    expect(n.kind).toBe("document");
    expect(n.hasDocument).toBe(true);
    expect(n.documentRef).toEqual({ id: "DOC1", mimeType: "application/pdf", filename: "june.pdf" });
    expect(n.body).toBe("my timesheet");
  });

  test("image → captures media ref, sets hasImage", () => {
    const n = parseInbound({
      type: "image",
      from: "971502",
      id: "m3",
      image: { id: "IMG1", mime_type: "image/jpeg" },
    });
    expect(n.kind).toBe("image");
    expect(n.hasImage).toBe(true);
    expect(n.imageRef).toEqual({ id: "IMG1", mimeType: "image/jpeg", filename: undefined });
    expect(n.body).toBe("");
  });

  test("interactive → title, then id fallback; carries interactiveId", () => {
    const titled = parseInbound({
      type: "interactive",
      from: "x",
      interactive: { type: "list_reply", list_reply: { id: "client:CL005", title: "Majid Al Futtaim" } },
    });
    expect(titled.body).toBe("Majid Al Futtaim");
    expect(titled.interactiveId).toBe("client:CL005");

    const untitled = parseInbound({
      type: "interactive",
      from: "x",
      interactive: { type: "button_reply", button_reply: { id: "confirm:yes" } },
    });
    expect(untitled.body).toBe("confirm:yes");
  });

  test("unknown type → unsupported with empty body (audio falls here)", () => {
    expect(parseInbound({ type: "audio", from: "x", id: "a" }).kind).toBe("unsupported");
    expect(parseInbound({ type: "location", from: "x" }).kind).toBe("unsupported");
  });

  test("attaches phoneNumberId when provided", () => {
    const n = parseInbound({ type: "text", from: "x", text: { body: "hi" } }, "PNID123");
    expect(n.phoneNumberId).toBe("PNID123");
  });
});

describe("extractInboundMessages", () => {
  test("flattens messages and carries phone_number_id + sender name", () => {
    const env: MetaWebhookEnvelope = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "E",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PN1" },
                contacts: [{ profile: { name: "Aisha" } }],
                messages: [
                  { type: "text", from: "a", id: "1", text: { body: "one" } },
                  { type: "text", from: "b", id: "2", text: { body: "two" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const out = extractInboundMessages(env);
    expect(out).toHaveLength(2);
    expect(out[0]?.ctx.phoneNumberId).toBe("PN1");
    expect(out[0]?.ctx.senderName).toBe("Aisha");
  });

  test("status-only changes contribute nothing", () => {
    const env: MetaWebhookEnvelope = {
      entry: [
        {
          changes: [
            { field: "messages", value: { statuses: [{ id: "s", status: "delivered" }] } },
          ],
        },
      ],
    };
    expect(extractInboundMessages(env)).toHaveLength(0);
  });
});

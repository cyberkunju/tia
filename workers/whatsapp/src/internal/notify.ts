/**
 * Internal notify surface — the outbound path the core pipeline calls to reach the user in chat.
 *
 *   POST /internal/notify   (guarded by x-internal-secret)
 *   body: { to, kind: "text"|"document"|"buttons", text?, url?, filename?, caption?, buttons? }
 *
 * For documents, the PDF is fetched from the given URL (the core service's invoice endpoint),
 * uploaded to Meta as media, and sent as a WhatsApp document with a caption. This keeps the two
 * services decoupled: core never talks to Meta, it just hands us a URL.
 */
import type { Context, Hono as HonoType, Next } from "hono";
import { Hono } from "hono";
import type { ReplyButton, Sender } from "../whatsapp/sender.ts";

export interface NotifyRouterDeps {
  readonly sender: Sender;
  readonly getSecret: () => string;
  /** Fetch used to pull the document bytes from the core URL (default: global fetch). */
  readonly fetch?: typeof fetch;
}

interface NotifyBody {
  to?: string;
  kind?: "text" | "document" | "buttons";
  text?: string;
  url?: string;
  filename?: string;
  caption?: string;
  buttons?: ReplyButton[];
}

export function createNotifyRouter(deps: NotifyRouterDeps): { router: HonoType } {
  const fetchImpl = deps.fetch ?? fetch;
  const router = new Hono();

  router.use("/internal/notify", async (c: Context, next: Next) => {
    if (c.req.header("x-internal-secret") !== deps.getSecret()) return c.body(null, 401);
    await next();
  });

  router.post("/internal/notify", async (c: Context) => {
    let body: NotifyBody;
    try {
      body = (await c.req.json()) as NotifyBody;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const to = body.to;
    if (!to) return c.json({ error: "missing 'to'" }, 400);

    if (body.kind === "text") {
      const res = await deps.sender.sendText(to, body.text ?? "");
      return c.json({ ok: res.ok, result: res });
    }

    if (body.kind === "buttons") {
      const res = await deps.sender.sendInteractiveButtons(to, {
        body: body.text ?? "",
        buttons: (body.buttons ?? []).slice(0, 3),
      });
      return c.json({ ok: res.ok, result: res });
    }

    if (body.kind === "document") {
      if (!body.url) return c.json({ error: "missing 'url' for document" }, 400);
      let bytes: Uint8Array;
      let mime = "application/pdf";
      try {
        const r = await fetchImpl(body.url, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) return c.json({ ok: false, error: `fetch ${body.url} → ${r.status}` }, 502);
        mime = r.headers.get("content-type")?.split(";", 1)[0]?.trim() || mime;
        bytes = new Uint8Array(await r.arrayBuffer());
      } catch (error) {
        return c.json({ ok: false, error: `document fetch failed: ${String(error)}` }, 502);
      }
      const mediaId = await deps.sender.uploadMedia(bytes, mime, body.filename ?? "invoice.pdf");
      if (mediaId === null) return c.json({ ok: false, error: "media upload failed" }, 502);
      const res = await deps.sender.sendDocument(to, {
        mediaId,
        filename: body.filename,
        caption: body.caption,
      });
      return c.json({ ok: res.ok, result: res });
    }

    return c.json({ error: "unknown kind" }, 400);
  });

  return { router };
}

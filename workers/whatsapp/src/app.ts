/**
 * Application wiring - composes transport, dedup, and the intake adapter into one Hono app.
 *
 * The bridge is stateless: dedup is an in-memory ring (Meta retries arrive within minutes, and the
 * core's events table is the durable idempotency layer via the Idempotency-Key we forward). Each
 * inbound message is parsed, de-duplicated, and forwarded to the core under the right send-from
 * context so replies originate from the number the message arrived on.
 */
import { join, basename } from "node:path";
import { Hono } from "hono";
import { type AppConfig, getConfig } from "./config.ts";
import { createIntakeService, type IntakeService } from "./intake/service.ts";
import { createDiskBytesStore } from "./intake/storage.ts";
import { createUpstreamClient, type UpstreamClient } from "./upstream.ts";
import { withSendFrom } from "./whatsapp/context.ts";
import { createDedupStore, createFakeDurableDedupStore, type DedupStore } from "./whatsapp/dedup.ts";
import { createMediaServiceFromConfig, type MediaService } from "./whatsapp/media.ts";
import { parseInbound } from "./whatsapp/parse.ts";
import { createSenderFromConfig, type Sender } from "./whatsapp/sender.ts";
import { verifySignatureWithSecret } from "./whatsapp/signature.ts";
import { createWebhookRouter, type MessageProcessor } from "./whatsapp/webhook.ts";
import { createSimulatorRouter } from "./simulator.ts";
import { createNotifyRouter } from "./internal/notify.ts";

export interface BuiltApp {
  readonly app: Hono;
  readonly config: AppConfig;
  readonly dedup: DedupStore;
  readonly intake: IntakeService;
  readonly sender: Sender;
  readonly media: MediaService;
  readonly upstream: UpstreamClient;
  whenIdle(): Promise<void>;
}

export interface BuildAppOverrides {
  readonly config?: AppConfig;
  readonly media?: MediaService;
  readonly sender?: Sender;
  readonly upstream?: UpstreamClient;
  readonly dedup?: DedupStore;
  readonly onWarn?: (m: string) => void;
  readonly onProcessingError?: (e: unknown) => void;
}

const SAFE_MEDIA_NAME = /^[A-Za-z0-9._-]+$/;

export function buildApp(overrides: BuildAppOverrides = {}): BuiltApp {
  const config = overrides.config ?? getConfig();

  const media = overrides.media ?? createMediaServiceFromConfig(config);
  const sender =
    overrides.sender ??
    createSenderFromConfig(config, {
      // Surface send outcomes (incl. closed-window / allowlist errors) for live ops.
      onAudit: (e) =>
        console.log(`[whatsapp] send ${e.kind} → ${e.to ?? "?"}: ${e.reason}${e.errorCode ? ` (code ${e.errorCode})` : ""}`),
    });
  const storage = createDiskBytesStore(config.storage.stagingDir);
  const upstream =
    overrides.upstream ?? createUpstreamClient({ apiUrl: config.upstream.apiUrl });
  const dedup = overrides.dedup ?? createDedupStore({ durable: createFakeDurableDedupStore() });
  const intake = createIntakeService({
    media,
    sender,
    storage,
    upstream,
    publicUrl: config.server.publicUrl,
  });

  const processMessage: MessageProcessor = async (message, ctx) => {
    const normalized = parseInbound(message, ctx.phoneNumberId);
    const id = normalized.messageId;
    if ((await dedup.claim(id)) === "duplicate") return;
    try {
      const result = await withSendFrom(normalized.phoneNumberId ?? ctx.phoneNumberId, () =>
        intake.ingest(normalized, ctx),
      );
      console.log(
        `[whatsapp] inbound ${normalized.kind} from ${normalized.phone} → ${result.status}` +
          `${result.docId ? ` (${result.docId})` : ""}${result.reason ? ` [${result.reason}]` : ""}`,
      );
      if (id !== undefined) await dedup.markProcessed(id);
    } catch (error) {
      if (id !== undefined) await dedup.releaseClaim(id);
      throw error;
    }
  };

  const webhook = createWebhookRouter({
    getAppSecret: () => config.meta.appSecret,
    getVerifyToken: () => config.meta.verifyToken,
    verify: (raw, header) => verifySignatureWithSecret(raw, header, config.meta.appSecret),
    processMessage,
    onWarn: overrides.onWarn ?? ((m) => console.warn(`[whatsapp] ${m}`)),
    onProcessingError:
      overrides.onProcessingError ??
      ((e) => console.error("[whatsapp] message processing failed:", e)),
  });

  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, upstream: config.upstream.apiUrl }));
  app.route("/", webhook.router);

  // Serve staged inbound media so the core can fetch attachment_url. Read-only, name-validated.
  app.get("/media/:name", async (c) => {
    const name = basename(c.req.param("name"));
    if (!SAFE_MEDIA_NAME.test(name)) return c.body(null, 400);
    const file = Bun.file(join(config.storage.stagingDir, name));
    if (!(await file.exists())) return c.body(null, 404);
    return new Response(file);
  });

  // Optional outbound surface for a future core → bridge push (guarded by the internal secret).
  app.route("/", createNotifyRouter({ sender, getSecret: () => config.internal.secret }).router);

  if (!config.server.isProduction) {
    const simulator = createSimulatorRouter({
      getAppSecret: () => config.meta.appSecret,
      getPhoneNumberId: () => config.meta.phoneNumberId,
      isProduction: () => config.server.isProduction,
      postToWebhook: async (rawBody, signatureHeader) => {
        const res = await app.request("/webhook/whatsapp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(signatureHeader !== undefined ? { "X-Hub-Signature-256": signatureHeader } : {}),
          },
          body: rawBody,
        });
        return { status: res.status };
      },
    });
    app.route("/", simulator.router);
  }

  return { app, config, dedup, intake, sender, media, upstream, whenIdle: webhook.whenIdle };
}

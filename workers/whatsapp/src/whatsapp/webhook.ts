/**
 * Webhook router - the public Meta surface (`/webhook/whatsapp`).
 *
 * GET  = the verification handshake (echo hub.challenge when mode+token are valid).
 * POST = inbound delivery, in this exact order:
 *   1. Read the RAW unparsed body BEFORE anything else (signature is over these exact bytes).
 *   2. Gate on the X-Hub-Signature-256 HMAC. A failure → 403, nothing parsed, nothing mutated.
 *      When no app secret is configured, warn and proceed (dev) rather than rejecting.
 *   3. ACK 200 immediately, BEFORE any slow work - Meta needs the ACK within seconds, so the heavy
 *      per-message processing is scheduled on a microtask and the ACK never waits on it.
 *   4. Parse JSON only after the ACK; invalid JSON simply stops.
 *   5. Status-only payloads (sent/delivered/read) carry no messages and do nothing.
 *   6. Each message is processed independently - one throwing never blocks its siblings and never
 *      changes the (already-sent) 200.
 *
 * The per-message processor is injected (default no-op), so the transport is testable with no
 * engine, network, or database.
 */
import type { Context, Hono as HonoType } from "hono";
import { Hono } from "hono";
import { extractInboundMessages } from "./parse.ts";
import type { MessageContext, MetaInboundMessage, MetaWebhookEnvelope } from "./types.ts";

const MIN_CHALLENGE_LENGTH = 1;
const MAX_CHALLENGE_LENGTH = 4096;

export type MessageProcessor = (
  message: MetaInboundMessage,
  ctx: MessageContext,
) => Promise<void> | void;

export interface WebhookRouterDeps {
  getAppSecret: () => string | undefined;
  getVerifyToken: () => string | undefined;
  /** Verify a raw body against the signature header (HMAC under the app secret). */
  verify: (rawBody: string, header: string | undefined | null) => boolean;
  processMessage?: MessageProcessor;
  onAck?: () => void;
  onWarn?: (message: string) => void;
  onProcessingError?: (error: unknown, message: MetaInboundMessage) => void;
}

export interface WebhookRouter {
  readonly router: HonoType;
  handleVerification(c: Context): Response;
  handleInbound(c: Context): Promise<Response>;
  /** Resolves once all async-scheduled processing has settled (tests). */
  whenIdle(): Promise<void>;
}

export function createWebhookRouter(deps: WebhookRouterDeps): WebhookRouter {
  const processMessage: MessageProcessor = deps.processMessage ?? (() => {});
  const onAck = deps.onAck ?? (() => {});
  const onWarn = deps.onWarn ?? (() => {});
  const onProcessingError = deps.onProcessingError ?? (() => {});

  const inFlight = new Set<Promise<void>>();

  function handleVerification(c: Context): Response {
    const configuredToken = deps.getVerifyToken();
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");

    if (configuredToken === undefined || configuredToken.length === 0) return c.body(null, 403);
    if (mode !== "subscribe") return c.body(null, 403);
    if (token === undefined || token.length === 0) return c.body(null, 403);
    if (token !== configuredToken) return c.body(null, 403);
    if (
      challenge === undefined ||
      challenge.length < MIN_CHALLENGE_LENGTH ||
      challenge.length > MAX_CHALLENGE_LENGTH
    ) {
      return c.body(null, 400);
    }
    return c.text(challenge, 200);
  }

  async function handleInbound(c: Context): Promise<Response> {
    const rawBody = await c.req.text();
    const signature = c.req.header("X-Hub-Signature-256");
    const appSecret = deps.getAppSecret();

    if (appSecret === undefined || appSecret.length === 0) {
      onWarn("WHATSAPP_APP_SECRET is not configured; inbound signature verification is DISABLED.");
    } else if (!deps.verify(rawBody, signature)) {
      return c.body(null, 403);
    }

    onAck();
    scheduleProcessing(rawBody);
    return c.body(null, 200);
  }

  function scheduleProcessing(rawBody: string): void {
    const work = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        processEnvelope(rawBody).finally(() => resolve());
      });
    });
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  }

  async function processEnvelope(rawBody: string): Promise<void> {
    let envelope: MetaWebhookEnvelope;
    try {
      envelope = JSON.parse(rawBody) as MetaWebhookEnvelope;
    } catch {
      return; // invalid JSON; the 200 already went out
    }
    if (envelope === null || typeof envelope !== "object") return;

    const inbound = extractInboundMessages(envelope);
    if (inbound.length === 0) return; // status-only / message-less

    await Promise.all(
      inbound.map(async ({ message, ctx }) => {
        try {
          await processMessage(message, ctx);
        } catch (error) {
          onProcessingError(error, message);
        }
      }),
    );
  }

  async function whenIdle(): Promise<void> {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
  }

  const router = new Hono();
  router.get("/webhook/whatsapp", (c) => handleVerification(c));
  router.post("/webhook/whatsapp", (c) => handleInbound(c));

  return { router, handleVerification, handleInbound, whenIdle };
}

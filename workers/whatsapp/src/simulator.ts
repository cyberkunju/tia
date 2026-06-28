/**
 * Dev-only Meta webhook simulator.
 *
 * The real webhook only trusts traffic carrying a valid X-Hub-Signature-256 HMAC over the exact
 * raw body. That makes it awkward to exercise the end-to-end inbound path by hand. This endpoint
 * takes a small spec (messages / a full envelope), wraps it in a valid Meta envelope, computes the
 * correct signature with the app secret, and posts it to the real webhook - driving the genuine
 * signature → dedup → parse → intake path with no Meta involvement.
 *
 * It is INVISIBLE IN PRODUCTION: the production gate runs first and returns 404, so a dev tool can
 * never ship a way to inject signed traffic into a prod deployment.
 */
import type { Context, Hono as HonoType, Next } from "hono";
import { Hono } from "hono";
import { computeSignatureHex } from "./whatsapp/signature.ts";
import type {
  MetaChangeValue,
  MetaInboundMessage,
  MetaStatusCallback,
  MetaWebhookEnvelope,
} from "./whatsapp/types.ts";

export interface WebhookPostResult {
  readonly status: number;
}

/** Delivers a signed envelope to the real webhook. createApp wires it to the in-process router. */
export type WebhookPoster = (
  rawBody: string,
  signatureHeader: string | undefined,
) => Promise<WebhookPostResult>;

export interface SimulatorRequest {
  readonly envelope?: MetaWebhookEnvelope;
  readonly messages?: MetaInboundMessage[];
  readonly statuses?: MetaStatusCallback[];
  readonly field?: string;
  readonly phoneNumberId?: string;
  readonly displayPhoneNumber?: string;
  readonly senderName?: string;
  readonly entryId?: string;
}

export interface SimulatorRouterDeps {
  readonly postToWebhook: WebhookPoster;
  readonly getAppSecret: () => string | undefined;
  readonly getPhoneNumberId: () => string;
  readonly isProduction: () => boolean;
}

export interface SimulatorRouter {
  readonly router: HonoType;
}

export function buildEnvelope(
  req: SimulatorRequest,
  defaultPhoneNumberId: string,
): MetaWebhookEnvelope {
  if (req.envelope !== undefined) return req.envelope;

  const value: MetaChangeValue = {
    messaging_product: "whatsapp",
    metadata: {
      display_phone_number: req.displayPhoneNumber ?? "15550000000",
      phone_number_id: req.phoneNumberId ?? defaultPhoneNumberId,
    },
  };
  if (req.senderName !== undefined) {
    value.contacts = [{ profile: { name: req.senderName }, wa_id: req.messages?.[0]?.from }];
  }
  if (req.messages !== undefined) value.messages = req.messages;
  if (req.statuses !== undefined) value.statuses = req.statuses;

  const field = req.field ?? "messages";
  return {
    object: "whatsapp_business_account",
    entry: [{ id: req.entryId ?? "ENTRY_ID", changes: [{ field, value }] }],
  };
}

export function createSimulatorRouter(deps: SimulatorRouterDeps): SimulatorRouter {
  const router = new Hono();

  // Production gate FIRST - invisible in production regardless of any input.
  router.use("/internal/simulator/*", async (c: Context, next: Next) => {
    if (deps.isProduction()) return c.body(null, 404);
    await next();
  });

  router.post("/internal/simulator/whatsapp", async (c: Context) => {
    let body: SimulatorRequest;
    try {
      body = (await c.req.json()) as SimulatorRequest;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const envelope = buildEnvelope(body, deps.getPhoneNumberId());
    const rawBody = JSON.stringify(envelope);

    const secret = deps.getAppSecret();
    const signatureHeader =
      secret !== undefined && secret.length > 0
        ? `sha256=${computeSignatureHex(rawBody, secret)}`
        : undefined;

    const result = await deps.postToWebhook(rawBody, signatureHeader);
    return c.json({ delivered: true, webhookStatus: result.status, signed: signatureHeader !== undefined });
  });

  return { router };
}

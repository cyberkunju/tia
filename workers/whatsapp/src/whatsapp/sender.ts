/**
 * Sender — outbound replies via POST /{phone_number_id}/messages.
 *
 * TIA's reply surface is intentionally small: a free-form text acknowledgement/status, and a
 * read-receipt + typing indicator. Each call is bounded by an 8s timeout, validates the body, and
 * never throws — it returns a {@link SendResult} so the caller can audit and move on. The
 * `phone_number_id` is resolved per-call (multi-number) from the ambient send context, falling
 * back to the configured default.
 *
 * The 24-hour customer-service window matters: a free-form text fails with code 131047/131026/470
 * when the window is closed. We classify that distinctly so callers know an acknowledgement could
 * not be delivered (a template would be required to re-open the window — out of scope for v1, but
 * the classification is surfaced rather than hidden).
 */
import { graphBaseUrl, type AppConfig } from "../config.ts";
import { currentSendFrom } from "./context.ts";

export const SEND_TIMEOUT_MS = 8_000;
export const MAX_TEXT_BODY_CHARS = 4096;

/** Interactive reply-button caps (WhatsApp: ≤3 buttons, title ≤20 chars, body ≤1024). */
export const BUTTON_LIMITS = { maxButtons: 3, title: 20, body: 1024 } as const;

/** Cloud API error codes meaning the 24h window is closed. */
export const CLOSED_WINDOW_ERROR_CODES: ReadonlySet<number> = new Set([131047, 131026, 470]);

export function isWindowClosed(code: number | undefined | null): boolean {
  return typeof code === "number" && Number.isInteger(code) && CLOSED_WINDOW_ERROR_CODES.has(code);
}

export type SendFailureReason =
  | "length_violation"
  | "empty_buttons"
  | "missing_config"
  | "api_error"
  | "network_error"
  | "timeout";

export interface SendResult {
  readonly ok: boolean;
  readonly messageId?: string;
  readonly errorCode?: number;
  readonly errorMessage?: string;
  readonly windowClosed?: boolean;
  readonly reason?: SendFailureReason;
}

export interface SenderAuditEntry {
  readonly kind: "text" | "mark_read" | "buttons" | "media" | "document";
  readonly to?: string | undefined;
  readonly reason: string;
  readonly errorCode?: number | undefined;
}

/** One tappable quick-reply button. */
export interface ReplyButton {
  readonly id: string;
  readonly title: string;
}

/** An interactive reply-buttons message (up to 3 single-tap quick replies). */
export interface ButtonSpec {
  readonly body: string;
  readonly header?: string;
  readonly footer?: string;
  readonly buttons: readonly ReplyButton[];
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface SenderDeps {
  readonly graphBaseUrl: string;
  readonly phoneNumberId: string;
  readonly token: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly onAudit?: (entry: SenderAuditEntry) => void | Promise<void>;
  /** Resolve the phone-number-id for the current send; default uses the ambient context. */
  readonly resolveFrom?: () => string | undefined;
}

export interface Sender {
  sendText(to: string, body: string): Promise<SendResult>;
  /**
   * Send up to 3 tappable quick-reply buttons. Used by the HITL flow to resolve an ambiguous
   * timesheet over WhatsApp (e.g. "Which Fatima Khan? [Accountant] [Marketing Mgr]"); the tap
   * comes back as an `interactive` inbound carrying the button id the parser already extracts.
   */
  sendInteractiveButtons(to: string, spec: ButtonSpec): Promise<SendResult>;
  /** Upload bytes to Meta and return the media id (used to send a document/PDF). */
  uploadMedia(buffer: Uint8Array, mime: string, filename: string): Promise<string | null>;
  /** Send a previously-uploaded document (e.g. the invoice PDF) with an optional caption. */
  sendDocument(to: string, spec: { mediaId: string; filename?: string; caption?: string }): Promise<SendResult>;
  markRead(messageId: string, typing?: boolean): Promise<void>;
}

function truncate(value: string, max: number): string {
  if (typeof value !== "string") return "";
  return value.length <= max ? value : value.slice(0, max);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError" ? "timeout" : error.name;
  }
  return "unknown error";
}

function parseMessageId(json: unknown): string | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const messages = (json as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const first = messages[0];
  if (first === null || typeof first !== "object") return undefined;
  const id = (first as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function parseError(json: unknown, status: number): { code: number | undefined; message: string } {
  if (json !== null && typeof json === "object") {
    const error = (json as { error?: unknown }).error;
    if (error !== null && typeof error === "object") {
      const code = (error as { code?: unknown }).code;
      const message = (error as { message?: unknown }).message;
      return {
        code: typeof code === "number" ? code : undefined,
        message: typeof message === "string" && message.length > 0 ? message : `HTTP ${status}`,
      };
    }
  }
  return { code: undefined, message: `HTTP ${status}` };
}

export function createSender(deps: SenderDeps): Sender {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = deps.timeoutMs ?? SEND_TIMEOUT_MS;
  const onAudit = deps.onAudit ?? (() => {});
  const resolveFrom = deps.resolveFrom ?? currentSendFrom;
  const authHeader = `Bearer ${deps.token}`;

  function currentPhoneNumberId(): string {
    const resolved = resolveFrom();
    return resolved !== undefined && resolved.length > 0 ? resolved : deps.phoneNumberId;
  }

  function messagesUrl(): string {
    return `${deps.graphBaseUrl}/${encodeURIComponent(currentPhoneNumberId())}/messages`;
  }

  function configPresent(): boolean {
    return deps.token.length > 0 && currentPhoneNumberId().length > 0;
  }

  async function audit(entry: SenderAuditEntry): Promise<void> {
    try {
      await onAudit(entry);
    } catch {
      /* never break a send path */
    }
  }

  async function post(payload: Record<string, unknown>, to: string): Promise<SendResult> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(messagesUrl(), {
        method: "POST",
        headers: { Authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) {
        await audit({ kind: "text", to, reason: "request timed out after 8s" });
        return { ok: false, reason: "timeout", errorMessage: "request timed out after 8s" };
      }
      const description = describeError(error);
      await audit({ kind: "text", to, reason: `network error: ${description}` });
      return { ok: false, reason: "network_error", errorMessage: description };
    }

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }

    if (!res.ok) {
      const { code, message } = parseError(json, res.status);
      await audit({ kind: "text", to, reason: `cloud api error: ${message}`, errorCode: code });
      return {
        ok: false,
        reason: "api_error",
        errorCode: code,
        errorMessage: message,
        windowClosed: isWindowClosed(code),
      };
    }

    const messageId = parseMessageId(json);
    return messageId === undefined
      ? { ok: false, reason: "api_error", errorMessage: "no message id in response" }
      : { ok: true, messageId };
  }

  async function sendText(to: string, body: string): Promise<SendResult> {
    if (typeof body !== "string" || body.length === 0) {
      return { ok: false, reason: "length_violation", errorMessage: "text body is empty" };
    }
    if (body.length > MAX_TEXT_BODY_CHARS) {
      return {
        ok: false,
        reason: "length_violation",
        errorMessage: `text body exceeds ${MAX_TEXT_BODY_CHARS} characters`,
      };
    }
    if (!configPresent()) {
      const missing = deps.token.length === 0 ? "WHATSAPP_TOKEN" : "WHATSAPP_PHONE_NUMBER_ID";
      await audit({ kind: "text", to, reason: `missing credential: ${missing}` });
      return { ok: false, reason: "missing_config", errorMessage: `missing config: ${missing}` };
    }
    return post({ messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: false } }, to);
  }

  async function sendInteractiveButtons(to: string, spec: ButtonSpec): Promise<SendResult> {
    const buttons = (spec.buttons ?? []).slice(0, BUTTON_LIMITS.maxButtons);
    if (buttons.length === 0) {
      await audit({ kind: "buttons", to, reason: "no reply buttons" });
      return { ok: false, reason: "empty_buttons", errorMessage: "no reply buttons" };
    }
    if (!configPresent()) {
      const missing = deps.token.length === 0 ? "WHATSAPP_TOKEN" : "WHATSAPP_PHONE_NUMBER_ID";
      await audit({ kind: "buttons", to, reason: `missing credential: ${missing}` });
      return { ok: false, reason: "missing_config", errorMessage: `missing config: ${missing}` };
    }
    const interactive: Record<string, unknown> = {
      type: "button",
      body: { text: truncate(spec.body, BUTTON_LIMITS.body) },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: truncate(b.title, BUTTON_LIMITS.title) },
        })),
      },
    };
    if (spec.header !== undefined && spec.header.length > 0) {
      interactive.header = { type: "text", text: spec.header };
    }
    if (spec.footer !== undefined && spec.footer.length > 0) {
      interactive.footer = { text: spec.footer };
    }
    return post({ messaging_product: "whatsapp", to, type: "interactive", interactive }, to);
  }

  async function uploadMedia(
    buffer: Uint8Array,
    mime: string,
    filename: string,
  ): Promise<string | null> {
    if (!configPresent() || buffer.length === 0) return null;
    try {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", mime);
      form.append("file", new Blob([buffer], { type: mime }), filename);
      const res = await fetchImpl(`${deps.graphBaseUrl}/${encodeURIComponent(currentPhoneNumberId())}/media`, {
        method: "POST",
        headers: { Authorization: authHeader },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        await audit({ kind: "media", to: undefined, reason: `media upload status ${res.status}` });
        return null;
      }
      const json = (await res.json().catch(() => null)) as { id?: unknown } | null;
      return typeof json?.id === "string" && json.id.length > 0 ? json.id : null;
    } catch (error) {
      await audit({ kind: "media", reason: `media upload failed: ${describeError(error)}` });
      return null;
    }
  }

  async function sendDocument(
    to: string,
    spec: { mediaId: string; filename?: string; caption?: string },
  ): Promise<SendResult> {
    if (typeof spec.mediaId !== "string" || spec.mediaId.length === 0) {
      return { ok: false, reason: "length_violation", errorMessage: "missing media id" };
    }
    if (!configPresent()) {
      return { ok: false, reason: "missing_config", errorMessage: "missing config" };
    }
    const document: Record<string, unknown> = { id: spec.mediaId };
    if (spec.filename) document.filename = spec.filename;
    if (spec.caption) document.caption = spec.caption;
    return post({ messaging_product: "whatsapp", to, type: "document", document }, to);
  }

  async function markRead(messageId: string, typing?: boolean): Promise<void> {
    if (typeof messageId !== "string" || messageId.length === 0 || !configPresent()) return;
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    };
    if (typing === true) payload.typing_indicator = { type: "text" };
    try {
      const res = await fetchImpl(messagesUrl(), {
        method: "POST",
        headers: { Authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) await audit({ kind: "mark_read", reason: `mark read returned status ${res.status}` });
    } catch (error) {
      await audit({ kind: "mark_read", reason: `mark read failed: ${describeError(error)}` });
    }
  }

  return { sendText, sendInteractiveButtons, uploadMedia, sendDocument, markRead };
}

export function createSenderFromConfig(
  cfg: AppConfig,
  overrides: Partial<Pick<SenderDeps, "fetch" | "timeoutMs" | "onAudit" | "resolveFrom">> = {},
): Sender {
  return createSender({
    graphBaseUrl: graphBaseUrl(cfg),
    phoneNumberId: cfg.meta.phoneNumberId,
    token: cfg.meta.token,
    fetch: overrides.fetch,
    timeoutMs: overrides.timeoutMs,
    onAudit: overrides.onAudit,
    resolveFrom: overrides.resolveFrom,
  });
}

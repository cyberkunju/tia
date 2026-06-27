/**
 * Inbound parsing: flatten a Meta webhook envelope into its messages, and normalize each message
 * into the transport-level {@link NormalizedInbound} shape the intake pipeline consumes.
 *
 * The per-type rule (always falls back to an empty body rather than dropping a message):
 *  - text        → text.body
 *  - document    → document.caption (empty when absent); media ref captured for download
 *  - image       → image.caption; media ref captured
 *  - interactive → button_reply/list_reply title, falling back to its id
 *  - button      → button.text, falling back to button.payload
 *  - request_welcome → empty body; first-contact greeting
 *  - anything else → unsupported, empty body (so we can prompt for a supported form)
 *
 * Audio/voice notes are classified `unsupported` here: TIA ingests timesheets, not voice, so an
 * audio inbound gets a friendly "send the timesheet as a file/photo" prompt instead of silent loss.
 */
import type {
  InboundMediaRef,
  MessageContext,
  MetaInboundMessage,
  MetaWebhookEnvelope,
  NormalizedInbound,
} from "./types.ts";

export function extractInboundMessages(
  envelope: MetaWebhookEnvelope,
): Array<{ message: MetaInboundMessage; ctx: MessageContext }> {
  const out: Array<{ message: MetaInboundMessage; ctx: MessageContext }> = [];
  const entries = Array.isArray(envelope.entry) ? envelope.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      if (value === undefined || value === null) continue;
      const messages = Array.isArray(value.messages) ? value.messages : [];
      if (messages.length === 0) continue; // status-only / non-message change → nothing to ingest
      const senderName =
        Array.isArray(value.contacts) && value.contacts.length > 0
          ? value.contacts[0]?.profile?.name
          : undefined;
      const ctx: MessageContext = {
        field: change.field,
        phoneNumberId: value.metadata?.phone_number_id,
        senderName,
      };
      for (const message of messages) {
        if (message !== undefined && message !== null) out.push({ message, ctx });
      }
    }
  }
  return out;
}

function firstNonEmpty(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

export function parseInbound(m: MetaInboundMessage, phoneNumberId?: string): NormalizedInbound {
  const parsed = parseInboundCore(m);
  return phoneNumberId !== undefined && phoneNumberId.length > 0
    ? { ...parsed, phoneNumberId }
    : parsed;
}

function parseInboundCore(m: MetaInboundMessage): NormalizedInbound {
  const phone = m.from ?? "";
  const messageId = m.id;
  const base = {
    phone,
    messageId,
    hasDocument: false as boolean,
    hasImage: false as boolean,
    isWelcome: false as boolean,
  };

  switch (m.type) {
    case "text":
      return { ...base, body: firstNonEmpty(m.text?.body), kind: "text" };

    case "document": {
      const ref: InboundMediaRef = {
        id: m.document?.id,
        mimeType: m.document?.mime_type,
        filename: m.document?.filename,
      };
      return {
        ...base,
        body: firstNonEmpty(m.document?.caption),
        kind: "document",
        hasDocument: true,
        documentRef: ref,
      };
    }

    case "image": {
      const ref: InboundMediaRef = { id: m.image?.id, mimeType: m.image?.mime_type };
      return {
        ...base,
        body: firstNonEmpty(m.image?.caption),
        kind: "image",
        hasImage: true,
        imageRef: ref,
      };
    }

    case "interactive": {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      return {
        ...base,
        body: firstNonEmpty(reply?.title, reply?.id),
        kind: "interactive",
        interactiveId: reply?.id,
      };
    }

    case "button":
      return { ...base, body: firstNonEmpty(m.button?.text, m.button?.payload), kind: "button" };

    case "request_welcome":
      return { ...base, body: "", kind: "request_welcome", isWelcome: true };

    default:
      // Unsupported (incl. audio/location/contacts) → empty body, prompt for a supported form.
      return { ...base, body: "", kind: "unsupported" };
  }
}

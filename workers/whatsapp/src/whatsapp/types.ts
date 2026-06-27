/**
 * Meta WhatsApp Cloud API webhook payload types (the subset TIA reads) plus the normalized
 * inbound shape the intake pipeline consumes.
 *
 * Reference envelope shape:
 *   { object, entry: [ { id, changes: [ { field, value } ] } ] }
 * where `value` carries `metadata.phone_number_id`, `messages[]`, and/or `statuses[]`.
 */

/** A single inbound message object as delivered by Meta (subset). */
export interface MetaInboundMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string; sha256?: string };
  image?: { id?: string; mime_type?: string; caption?: string; sha256?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  interactive?: {
    type?: "button_reply" | "list_reply";
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  button?: { payload?: string; text?: string };
  [key: string]: unknown;
}

/** A delivery status callback (sent/delivered/read) — never turned into intake. */
export interface MetaStatusCallback {
  id?: string;
  status?: string;
  [key: string]: unknown;
}

export interface MetaChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: MetaInboundMessage[];
  statuses?: MetaStatusCallback[];
  [key: string]: unknown;
}

export interface MetaWebhookEnvelope {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: MetaChangeValue }>;
  }>;
}

/** Context handed alongside each inbound message (from the change metadata). */
export interface MessageContext {
  readonly field?: string;
  readonly phoneNumberId?: string;
  /** Sender display name from `contacts[].profile.name`, when present. */
  readonly senderName?: string;
}

/**
 * The inbound message kinds TIA understands. Timesheets arrive primarily as `document`
 * (PDF / Excel), `image` (handwritten photo, scan), or `text` (an email-style payout request
 * pasted into chat). `interactive`/`button` carry tapped quick-reply ids. Everything else is
 * `unsupported` and gets a friendly prompt.
 */
export type InboundKind =
  | "text"
  | "document"
  | "image"
  | "interactive"
  | "button"
  | "request_welcome"
  | "unsupported";

/** A reference to inbound media to be downloaded by the Media service. */
export interface InboundMediaRef {
  readonly id?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly filename?: string | undefined;
}

/** Normalized, transport-level view of one inbound message (pre media-download). */
export interface NormalizedInbound {
  /** Sender phone (`message.from`); empty string when absent. */
  readonly phone: string;
  /** Extracted text body; empty string rather than missing. */
  readonly body: string;
  readonly kind: InboundKind;
  readonly hasDocument: boolean;
  readonly hasImage: boolean;
  readonly messageId?: string | undefined;
  /** Which connected business number received this (replies go out FROM it). */
  readonly phoneNumberId?: string | undefined;
  /** Tapped list/button id, for deterministic interactive routing. */
  readonly interactiveId?: string | undefined;
  readonly isWelcome: boolean;
  readonly documentRef?: InboundMediaRef | undefined;
  readonly imageRef?: InboundMediaRef | undefined;
}

/**
 * Ingestion adapter — the per-message processor wired into the webhook.
 *
 * The bridge owns no database. For each inbound message it: marks it read, downloads any
 * attachment from Meta and stages it (served back at a public URL the core can fetch), forwards
 * the message to the core's `POST /intake/whatsapp`, and replies to the user — sending the
 * generated invoice PDF when the pipeline auto-approved, or a status message otherwise.
 *
 * Fail-safe: a media-download or upstream failure is surfaced and replied to, never thrown.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { MediaService } from "../whatsapp/media.ts";
import type { Sender } from "../whatsapp/sender.ts";
import type { MessageContext, NormalizedInbound } from "../whatsapp/types.ts";
import type { UpstreamClient } from "../upstream.ts";
import type { BytesStore } from "./storage.ts";

export type IngestStatus =
  | "forwarded"
  | "invoiced"
  | "review"
  | "answered"
  | "skipped"
  | "unsupported"
  | "welcome";

export interface IngestResult {
  readonly status: IngestStatus;
  readonly docId?: string;
  readonly reason?: string;
}

export interface IntakeServiceDeps {
  readonly media: MediaService;
  readonly sender: Sender;
  readonly storage: BytesStore;
  readonly upstream: UpstreamClient;
  /** Public base URL of this bridge, for building attachment_url the core downloads. */
  readonly publicUrl: string;
}

export interface IntakeService {
  ingest(inbound: NormalizedInbound, ctx: MessageContext): Promise<IngestResult>;
}

const WELCOME_TEXT =
  "👋 Welcome to TASC TIA. Send a timesheet as an Excel/PDF file, a photo of a handwritten " +
  "sheet, or just type the details (name, client, period, days). I'll extract it, check it, and " +
  "turn it into a billed invoice.";
const UNSUPPORTED_TEXT =
  "I can read timesheets sent as a *file* (Excel/PDF), a *photo*, or as *text*. Please resend in " +
  "one of those forms 🙏";
const FETCH_FAILED_TEXT = "I couldn't download that attachment from WhatsApp — please try sending it again.";
const UPSTREAM_FAILED_TEXT = "I couldn't reach the billing service just now — please try again shortly.";

function ref(docId: string): string {
  return `TIA-${docId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Statuses that mean the core auto-generated an invoice. */
const INVOICED = new Set(["invoice_generated", "approved", "auto", "dispatched"]);
const REVIEW = new Set(["awaiting_review", "escalate", "hitl"]);

export function createIntakeService(deps: IntakeServiceDeps): IntakeService {
  const { media, sender, storage, upstream, publicUrl } = deps;

  async function deliverOutcome(to: string, r: { docId: string; timesheetId: string; status: string }): Promise<IngestResult> {
    if (INVOICED.has(r.status)) {
      const inv = await upstream.invoiceForTimesheet(r.timesheetId);
      if (inv) {
        const pdf = await upstream.invoicePdf(inv.id);
        const caption =
          `✅ Invoice ready (${ref(r.docId)})\nTotal: ${inv.currency} ${inv.amount.toLocaleString()}`;
        if (pdf) {
          const mediaId = await sender.uploadMedia(pdf.bytes, pdf.mime, `${ref(r.docId)}.pdf`);
          if (mediaId) {
            await sender.sendDocument(to, { mediaId, filename: `${ref(r.docId)}.pdf`, caption });
            return { status: "invoiced", docId: r.docId };
          }
        }
        await sender.sendText(to, `${caption}\n(I'll send the PDF shortly.)`);
        return { status: "invoiced", docId: r.docId };
      }
    }
    if (REVIEW.has(r.status)) {
      await sender.sendText(
        to,
        `⚠️ Got your timesheet (${ref(r.docId)}). A couple of details need a human check — our team will confirm shortly.`,
      );
      return { status: "review", docId: r.docId };
    }
    await sender.sendText(to, `✅ Got it (${ref(r.docId)}). I'm processing your timesheet now.`);
    return { status: "forwarded", docId: r.docId };
  }

  async function ingest(inbound: NormalizedInbound, ctx: MessageContext): Promise<IngestResult> {
    const to = inbound.phone;
    if (inbound.messageId !== undefined) await sender.markRead(inbound.messageId, true);

    if (inbound.kind === "request_welcome") {
      await sender.sendText(to, WELCOME_TEXT);
      return { status: "welcome" };
    }

    const mediaRef = inbound.documentRef ?? inbound.imageRef;
    let attachmentUrl: string | null = null;
    let attachmentMime: string | null = null;
    let messageText: string | null = null;

    if (mediaRef?.id !== undefined && mediaRef.id.length > 0) {
      const dl = await media.downloadMedia(mediaRef.id);
      if (dl === null) {
        await sender.sendText(to, FETCH_FAILED_TEXT);
        return { status: "skipped", reason: "media_download_failed" };
      }
      const mime = mediaRef.mimeType ?? dl.mimeType;
      const path = await storage.write(sha256(dl.buffer), mime, dl.buffer);
      attachmentUrl = `${publicUrl}/media/${basename(path)}`;
      attachmentMime = mime;
      if (inbound.body.trim().length > 0) messageText = inbound.body.trim();
    } else if (
      (inbound.kind === "text" || inbound.kind === "button" || inbound.kind === "interactive") &&
      inbound.body.trim().length > 0
    ) {
      messageText = inbound.body.trim();
    } else {
      await sender.sendText(to, UNSUPPORTED_TEXT);
      return { status: "unsupported", reason: inbound.kind };
    }

    const result = await upstream.intakeWhatsapp(
      {
        from_: to,
        client_hint: ctx.senderName ?? null,
        attachment_url: attachmentUrl,
        attachment_mime: attachmentMime,
        message_text: messageText,
      },
      inbound.messageId,
    );
    if (result === null) {
      await sender.sendText(to, UPSTREAM_FAILED_TEXT);
      return { status: "skipped", reason: "upstream_failed" };
    }
    // "talk to the invoice" — the core answered a question rather than ingesting a sheet.
    if (result.mode === "answer") {
      const body = (result.answer ?? "").trim();
      await sender.sendText(to, body.length > 0 ? body : "I couldn't find an answer to that.");
      return { status: "answered" };
    }
    return deliverOutcome(to, result);
  }

  return { ingest };
}

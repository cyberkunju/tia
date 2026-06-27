/**
 * Client for the TIA core API (CONTRACTS.md). The bridge forwards each inbound WhatsApp message to
 * `POST /intake/whatsapp`, then (when an invoice was generated) fetches it to send back to the user.
 * The fetch port is injectable so the adapter is testable with no network.
 */
export type FetchLike = typeof fetch;

export interface IntakeResult {
  readonly docId: string;
  readonly timesheetId: string;
  readonly status: string;
}

export interface InvoiceRef {
  readonly id: string;
  readonly status: string;
  readonly amount: number;
  readonly currency: string;
}

export interface DownloadedPdf {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

export interface UpstreamClient {
  intakeWhatsapp(
    payload: {
      from_: string;
      client_hint?: string | null;
      attachment_url?: string | null;
      attachment_mime?: string | null;
      message_text?: string | null;
    },
    idempotencyKey: string | undefined,
  ): Promise<IntakeResult | null>;
  invoiceForTimesheet(timesheetId: string): Promise<InvoiceRef | null>;
  invoicePdf(invoiceId: string): Promise<DownloadedPdf | null>;
}

export interface UpstreamDeps {
  readonly apiUrl: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export function createUpstreamClient(deps: UpstreamDeps): UpstreamClient {
  const base = deps.apiUrl.replace(/\/+$/, "");
  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 65_000;

  async function intakeWhatsapp(
    payload: Parameters<UpstreamClient["intakeWhatsapp"]>[0],
    idempotencyKey: string | undefined,
  ): Promise<IntakeResult | null> {
    try {
      const res = await fetchImpl(`${base}/intake/whatsapp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { doc_id?: string; timesheet_id?: string; status?: string };
      if (!j.doc_id || !j.timesheet_id) return null;
      return { docId: j.doc_id, timesheetId: j.timesheet_id, status: j.status ?? "" };
    } catch {
      return null;
    }
  }

  async function invoiceForTimesheet(timesheetId: string): Promise<InvoiceRef | null> {
    try {
      const res = await fetchImpl(
        `${base}/invoices?timesheet_id=${encodeURIComponent(timesheetId)}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) return null;
      const list = (await res.json()) as Array<{ id: string; status: string; amount: number; currency: string }>;
      const inv = Array.isArray(list) ? list[0] : undefined;
      return inv ? { id: inv.id, status: inv.status, amount: inv.amount, currency: inv.currency } : null;
    } catch {
      return null;
    }
  }

  async function invoicePdf(invoiceId: string): Promise<DownloadedPdf | null> {
    try {
      const res = await fetchImpl(`${base}/invoices/${encodeURIComponent(invoiceId)}/pdf`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return null;
      const mime = res.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/pdf";
      return { bytes: new Uint8Array(await res.arrayBuffer()), mime };
    } catch {
      return null;
    }
  }

  return { intakeWhatsapp, invoiceForTimesheet, invoicePdf };
}

# TIA Contracts

Stable interfaces so the two builders (and the teammate owning **Modal/GLM-OCR + WhatsApp**)
can work in parallel against stubs. Change these only by editing this file first.

---

## 1. OCR serving — GLM-OCR on Modal (teammate owns)

**Base URL:** `https://versifine--glm-ocr-serve.modal.run` (scale-to-zero; cold start ~15–30s)

OpenAI-compatible vLLM endpoint. Two logical operations:

### 1a. KIE — image + schema → filled JSON
```
POST {base}/v1/chat/completions
{
  "model": "glm-ocr",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,<B64>"}},
      {"type": "text", "text": "<KIE prompt embedding the TimesheetExtraction JSON schema>"}
    ]
  }],
  "temperature": 0.0
}
```
Returns assistant message whose content is a JSON object matching `TimesheetExtraction`
(see §4). Worker is tolerant of code-fences / leading prose.

### 1b. Layout — image → blocks with bboxes
Same shape, prompt = `prompt_layout_all_en`. Returns
`[{ "bbox": [x1,y1,x2,y2], "category": "Text|Table|Picture|...", "text": "..." }, ...]`
in resized-image coords. Used by the reconciler to anchor KIE fields to a source bbox.

**Fallback chain (worker side):** GLM-OCR markdown → GLM-OCR KIE (schema-constrained JSON). GLM-OCR is the sole OCR; no Tesseract.

---

## 2. Ingestion — WhatsApp bridge (teammate owns the bridge; API owns the endpoint)

```
POST {api}/intake/whatsapp
Headers: Idempotency-Key: <uuid>
{
  "from": "+9715xxxxxxx",
  "client_hint": "Aldar" | null,
  "attachment_url": "https://.../file.jpg" | null,
  "attachment_mime": "image/jpeg" | "application/pdf" | null,
  "message_text": "free text body"
}
→ 202 { "doc_id": "<uuid>", "status": "queued" }
```
Idempotency-Key dedupes retries. The API downloads `attachment_url` into NVMe staging,
content-hashes it, and enqueues the pipeline.

**Status: implemented.** The bridge lives in `workers/whatsapp` (Bun + Hono, Meta Cloud API).
It verifies the Meta signature, de-duplicates retries, downloads inbound media and serves it at
its own `/media/<hash>` (so this endpoint can fetch `attachment_url`), forwards here, and replies
to the user with the generated invoice PDF (or a review notice). It owns no DB — the core is the
single source of truth.

---

## 3. Internal event bus (NATS JetStream)

Stream `TIA`, subjects:
```
doc.ingested        { doc_id, content_hash, channel, mime }
doc.triaged         { doc_id, doc_class, quality_score }
doc.extracted       { doc_id, hypotheses_id }
doc.resolved        { doc_id, timesheet_id }
doc.validated       { doc_id, timesheet_id, routing }   # auto | hitl | escalate
doc.review_resolved { doc_id, timesheet_id }
invoice.generated   { invoice_id }
invoice.dispatched  { invoice_id, idempotency_key }
```
Until NATS is wired, the Rust orchestrator calls stages in-process (same state machine).

---

## 4. Canonical schema — `TimesheetExtraction` (shared, source of truth)

```jsonc
{
  "client_code": "string|null",
  "client_hint": "string|null",
  "period": "YYYY-MM",
  "signed_by": "string|null",
  "rows": [{
    "employee_name": "string",
    "emp_id": "string|null",
    "days_worked": "number|null",
    "hours": "number|null",
    "ot_hours": "number|null",
    "leave_codes": ["AL","SICK",...],     // canonicalized enum
    "reimbursements": [{"reason":"string","amount_aed":"number"}],
    "notes": "string|null"
  }],
  "confidence_per_field": {"field_path": 0.0}   // raw model signal; NOT final confidence
}
```
Final confidence is computed by the matcher/validator, never trusted from the model.

Leave-code enum: `AL` (annual), `SICK`, `UNPAID`, `PUBLIC_HOLIDAY`, `ABSENT`, `PRESENT`.
Raw variants the canonicalizer maps: `A/L`, `Annual`, `annual leave`, `sick`, `S`, `P`, `A`, ...

---

## 5. Worker RPC (Rust API ↔ Python AI worker)

Python worker exposes a small HTTP surface (FastAPI under uv) until/unless folded in:
```
POST /extract   { doc_id, staging_path, mime, channel } → TimesheetExtraction + provenance
POST /match     { timesheet_id, rows } → [{ row_idx, candidates[], assignment, cost_matrix }]
POST /ocr/kie   { image_b64, schema } → TimesheetExtraction   # proxies Modal, adds fallback
POST /ocr/layout{ image_b64 } → blocks[]
```
All responses include `signals` used for calibrated confidence.

---

## 6. Idempotency & audit (cross-cutting)

- Every mutating API call requires `Idempotency-Key`. The key is unique in `events`.
- External side-effects (dispatch send, ERP post) check `events` for the key before firing.
- Audit middleware appends an `events` row **before** returning a mutating response.

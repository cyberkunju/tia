# TIA — Touchless Invoice Agent

Self-hosted, open-weight agent that ingests staffing **timesheets** in any of 7 shapes
(clean Excel → handwritten photo), resolves them against a payroll master, generates
client-billable **invoices** through a mock ERP, validates them deterministically,
dispatches per per-client rule, and exposes the whole flow to three personas
(Client / FinOps / Finance) with bbox-anchored provenance, calibrated confidence,
human-in-the-loop on exceptions, full audit, and a live eval dashboard with a CI gate.

Built for **HackArena 2.0 / IgniteRoom × TASC Outsourcing (UAE)**.
Strict **no-AI-wrapper** rule: every model in the inference path is open-weight and
self-hosted (GLM-OCR / dots.ocr on our GPU). The model is one node; the engineering
(evidence graph, Hungarian matcher, deterministic validators, eval+CI gate, audit log)
is the other twelve.

> **Headline differentiator:** reverse-billing AR generated from a timesheet against a
> *deliberately ambiguous* master (e.g. two `Fatima Khan` at the same client), where a
> Hungarian assignment — not a fuzzy name lookup — does the entity resolution.

## Architecture (target)

| Layer | Tech |
|---|---|
| Frontend | React + Vite + TS, Tailwind, shadcn/ui, TanStack Query/Router, Zustand, Uppy+tus, PDF.js, Framer Motion, SSE |
| Public backend | Rust · Axum · Tokio · Tower · Serde · SQLx · async-nats · tracing · OpenTelemetry |
| Workflow / events | NATS JetStream · Rust orchestrator · deterministic state machine · idempotency keys |
| Database | PostgreSQL 18 · JSONB · pg_trgm · append-only events |
| Hot storage | Local NVMe staging dir |
| Durable storage | SeaweedFS (S3 API + Filer) |
| Vector retrieval | Qdrant |
| AI / doc workers | Python 3.12 · uv · Pydantic v2 · OpenCV · openpyxl · pdfplumber · Tesseract · imagehash |
| OCR serving | vLLM · GLM-OCR (primary) · dots.ocr (layout ensemble) · Tesseract (offline fallback) · Modal GPU |
| Matching | pg_trgm retrieval · phonetic · rapidfuzz-style sim · Hungarian assignment (visible cost matrix) |
| Validation | Rust · decimal money math · deterministic rules · threshold approval · OOO delegate routing |
| Invoice | Rust · Typst · sandboxed render dir · PDF in SeaweedFS |
| Dispatch | Rust · SMTP/webhook adapters · idempotent side-effects |
| Chat | self-hosted small LLM · Qdrant grounded retrieval · DB-scoped tools · cited answers only |
| Observability | OpenTelemetry · Prometheus · Grafana · Loki · Tempo/Jaeger |

Build order is **demo-first**: the core flow runs on Postgres + local staging + direct
calls; NATS / SeaweedFS / Qdrant / full observability layer in additively.

## Monorepo layout

```
apps/web            React + Vite frontend (bun)
apps/api            Rust Axum public backend
services/           Rust: validation, invoice, dispatch, orchestrator
workers/ai          Python 3.12 (uv): extract, match, validate-helpers, OCR clients
db/                 PostgreSQL 18 schema + migrations
data/seed           TASC sample DB (xlsx)
data/synthetic      generators for the 7 test cases
data/gold           eval ground truth
infra/              otel / prometheus / grafana configs
docs/               brief + 8-slide deck
```

## Quickstart

See `CONTRACTS.md` for the API/queue/model contracts. Setup steps land in this section
as each layer is wired.

## Package manager policy

**Bun only** for JS/TS. **uv only** for Python. No npm/yarn/pnpm, no pip/poetry.

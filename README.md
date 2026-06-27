# TIA — Touchless Invoice Agent

[![ci](https://github.com/cyberkunju/tia/actions/workflows/ci.yml/badge.svg)](https://github.com/cyberkunju/tia/actions/workflows/ci.yml)

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
| AI / doc workers | Python 3.12 · uv · Pydantic v2 · OpenCV · openpyxl · pdfplumber · imagehash |
| OCR serving | vLLM · GLM-OCR on Modal (sole OCR; OpenAI-compatible) · markdown + KIE prompt modes |
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
apps/web              React + Vite + TS frontend (bun) — 3 personas, review/Hungarian/Why, eval, dispatch, finance
workers/ai            Python 3.12 (uv): extract (excel/email/pdf/vision) · resolve+Hungarian · validate ·
                      mock ERP · Typst invoice · orchestrator · eval harness · FastAPI surface · tia_ai/ai (LLM+guard)
workers/whatsapp      WhatsApp Cloud API bridge (Bun + Hono) — forwards inbound timesheets to the core,
                      sends the invoice PDF back; the implementation of the CONTRACTS §2 /intake/whatsapp bridge
data/seed             TASC sample DB (xlsx)
data/synthetic        generators for the sample test cases
data/gold             eval ground truth + last run
infra/                otel / prometheus / grafana configs
docs/                 brief + 8-slide deck
```

## Quickstart

```bash
# one-time
make install         # uv sync (python 3.12) + bun install (web + whatsapp bridge)
cp .env.example .env # add your GLM_OCR_API_KEY for the handwritten case
make seed            # 10 clients, 200 employees, 200 payroll rows
make synth           # generates the sample inputs + gold ground truth

# verify
make eval            # cases PASS, F1 + ECE printed
make test            # python pytest + bun test (bridge)

# run
make api             # core FastAPI on http://127.0.0.1:8000
make web             # Vite on http://127.0.0.1:5173
make whatsapp        # WhatsApp bridge on :8088 (needs Meta creds in workers/whatsapp/.env)
```

The eval workflow at `.github/workflows/eval.yml` enforces a CI gate: PRs fail if any of the
6 non-vision cases regress (vision case 4 is gated locally because Modal requires credentials).

## Deploy with Docker

Production stack — **Postgres 18 + FastAPI + nginx-served SPA**, fully containerized:

```bash
cp .env.docker.example .env     # set POSTGRES_PASSWORD, optional GLM_OCR_API_KEY
docker compose up -d --build    # builds api + web images, boots the 3 services
# open http://localhost:8080
```

What you get:

| Service | Image | Notes |
|---|---|---|
| `db`  | `postgres:18-alpine` | named volume `db-data` at `/var/lib/postgresql` (PG18 layout) |
| `api` | multi-stage `uv` build → `python:3.12-slim` | non-root, healthchecked, seeds master data + eval fixtures on boot, serves with `uvicorn` workers; Typst + fonts baked in |
| `web` | multi-stage `bun` build → `nginx:1.27-alpine` | serves the SPA and reverse-proxies `/api` → `api:8000` (single origin, no CORS) |

The web container is the only published port (`WEB_PORT`, default `8080`). The SPA calls the API
same-origin via `/api`, so nginx proxies it internally — including SSE at `/api/events/stream`.
The API blocks on Postgres readiness, then reseeds idempotently (toggle with `TIA_SEED_ON_START`
/ `TIA_SYNTH_ON_START`). Uploaded files and rendered invoice PDFs persist in the `staging` volume.

```bash
docker compose logs -f api      # tail the pipeline
docker compose down             # stop (keeps volumes)
docker compose down -v          # stop + wipe data
```

SQLite remains the zero-infra default for local `make` workflows; the container stack flips to
Postgres purely via `DATABASE_URL` (no code change).

### Continuous deployment

`deploy/` ships a self-contained auto-updater: a systemd **user** timer polls `origin` and, on a
new commit to the default branch, pulls and runs `docker compose up -d --build` — so a push to the
repo rolls out to the host within a minute. Install it with `deploy/install.sh` (see that script).

## Package manager policy

**Bun only** for JS/TS. **uv only** for Python. No npm/yarn/pnpm, no pip/poetry.

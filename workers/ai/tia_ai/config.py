"""Runtime configuration. Postgres 18 is the target; SQLite is the zero-infra default
so the pipeline runs before PG is provisioned. Flip by setting DATABASE_URL.
"""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def _load_dotenv() -> None:
    """Minimal .env loader (no extra dep). Checks repo root and worker dir."""
    for env_path in (REPO_ROOT / ".env", Path(__file__).resolve().parents[1] / ".env"):
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

DATA_DIR = REPO_ROOT / "data"
SEED_XLSX = DATA_DIR / "seed" / "TASC_Sample_Database_vF.xlsx"
STAGING_DIR = Path(os.getenv("TIA_STAGING_DIR", REPO_ROOT / "staging"))

# sqlite default; set e.g. postgresql+psycopg://tia:tia@localhost:5432/tia
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{REPO_ROOT / 'tia.db'}")

# GLM-OCR - OpenAI-compatible vision endpoint (handwriting/PDF).
# Default: edneam's self-hosted vLLM. Swap to ANY OpenAI-compatible endpoint
# via env vars - no code change. Proves the "no vendor lock" architecture.
GLM_OCR_BASE_URL = os.getenv("GLM_OCR_BASE_URL", "https://ocr.cyberkunju.com/v1")
GLM_OCR_API_KEY = os.getenv("GLM_OCR_API_KEY", "")
GLM_OCR_MODEL = os.getenv("GLM_OCR_MODEL", "glm-ocr:q8_0")
# How long to wait for GLM-OCR to *connect* before giving up and failing over to
# the Mistral fallback. Kept short so a down/unreachable GLM fails fast (the read
# timeout below still allows a healthy-but-slow GLM to finish a real transcription).
GLM_OCR_CONNECT_TIMEOUT = float(os.getenv("GLM_OCR_CONNECT_TIMEOUT", "6"))

# Mistral Document AI on Azure AI Foundry — instant OCR fallback. When GLM-OCR is
# unreachable/erroring, the markdown OCR path fails over to this automatically (no
# code change, no restart). Native /ocr endpoint: returns per-page markdown that our
# existing markdown timesheet parser consumes directly. Auth: `Authorization: Bearer`.
MISTRAL_OCR_ENDPOINT = os.getenv("MISTRAL_OCR_ENDPOINT", "")
MISTRAL_OCR_API_KEY = os.getenv("MISTRAL_OCR_API_KEY", "")
MISTRAL_OCR_MODEL = os.getenv("MISTRAL_OCR_MODEL", "mistral-document-ai-2512")

# Chat agent - OpenAI-compatible. Swap to a local model for demo by overriding
# OPENAI_BASE_URL (e.g. a Modal-served vLLM) + OPENAI_MODEL (e.g. "qwen2.5-7b").
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

# Azure OpenAI (preferred for chat when set) — gpt-5.4-nano on Azure AI.
# When AZURE_AI_ENDPOINT + AZURE_AI_KEY are present, the chat agent uses Azure and
# AZURE_CHAT_MODEL as the deployment; OPENAI_* is the fallback.
AZURE_AI_ENDPOINT = os.getenv("AZURE_AI_ENDPOINT", "")
AZURE_AI_KEY = os.getenv("AZURE_AI_KEY", "")
AZURE_AI_API_VERSION = os.getenv("AZURE_AI_API_VERSION", "2024-05-01-preview")
AZURE_CHAT_MODEL = os.getenv("AZURE_CHAT_MODEL", "gpt-5.4-nano")

# WhatsApp loop — the core pushes the approved invoice to the bridge's /internal/notify,
# and the bridge fetches the invoice PDF back from the core at TIA_SELF_URL.
# INTERNAL_SECRET must match the bridge's own INTERNAL_SECRET.
WHATSAPP_BRIDGE_URL = os.getenv("WHATSAPP_BRIDGE_URL", "http://localhost:8088")
TIA_SELF_URL = os.getenv("TIA_SELF_URL", "http://localhost:8000")
INTERNAL_SECRET = os.getenv("INTERNAL_SECRET", "tia-internal-dev")

# Auto-approval toggle. When TRUE (default) a clean, fully-resolved, rule-passing
# timesheet is approved + invoiced + dispatched with no human step (the "touchless"
# path). When FALSE, NOTHING auto-approves: every validated timesheet waits in the
# web review queue for an explicit human approve/reject before an invoice is made.
# The deploy sets this FALSE for the demo so the human-in-the-loop approval flow is
# always exercised; tests/CI run with the default TRUE to exercise the touchless path.
TIA_AUTO_APPROVE = os.getenv("TIA_AUTO_APPROVE", "true").lower() in ("1", "true", "yes")

# ─── Zoho Mail (tia@cyberkunju.com) - real-email ingestion + reply send ───
#
# IMAP: TIA polls the Zoho inbox for unseen messages and ingests each one
#       through the same `/intake/email` pipeline. Marks as seen on success.
# SMTP: When set, the cc_silent reply drafter additionally SENDS the .eml
#       through Zoho - closing the loop end-to-end.
#
# Set ZOHO_IMAP_USER + ZOHO_IMAP_PASSWORD (App Password if 2FA on) in .env
# to enable. Leave empty in dev to keep the poller idle.
ZOHO_IMAP_HOST = os.getenv("ZOHO_IMAP_HOST", "imap.zoho.com")
ZOHO_IMAP_PORT = int(os.getenv("ZOHO_IMAP_PORT", "993"))
ZOHO_IMAP_USER = os.getenv("ZOHO_IMAP_USER", "")
ZOHO_IMAP_PASSWORD = os.getenv("ZOHO_IMAP_PASSWORD", "")
ZOHO_IMAP_FOLDER = os.getenv("ZOHO_IMAP_FOLDER", "INBOX")
ZOHO_POLL_INTERVAL_SEC = int(os.getenv("ZOHO_POLL_INTERVAL_SEC", "30"))

ZOHO_SMTP_HOST = os.getenv("ZOHO_SMTP_HOST", "smtp.zoho.com")
ZOHO_SMTP_PORT = int(os.getenv("ZOHO_SMTP_PORT", "465"))
ZOHO_SMTP_USE_SSL = os.getenv("ZOHO_SMTP_USE_SSL", "1").lower() in ("1", "true", "yes")

# ── API security ──────────────────────────────────────────────────────────
# When TIA_API_TOKEN is set, the public API requires `Authorization: Bearer <token>`
# on everything EXCEPT health, the MCP transport, the intake pipeline (the bridge /
# poller call those and carry their own trust boundary), and the webhook surface.
# Unset (the default) leaves the API open so the public click-through demo keeps
# working — set it to lock the dashboard + mutation surface for a private deploy.
TIA_API_TOKEN = os.getenv("TIA_API_TOKEN", "").strip()

# Browser origins allowed to call the API cross-origin. The SPA is served
# same-origin via nginx so it never needs CORS; this only governs OTHER sites'
# in-browser JS. Was "*" (any site could script the API) — now an allow-list.
TIA_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "TIA_ALLOWED_ORIGINS",
        "https://tia.cyberkunju.com,http://localhost:5173,http://localhost:8080,http://localhost:8090",
    ).split(",")
    if o.strip()
]

# ── SAP Business One Service Layer (real outbound A/R Invoice) ──────────────
# Off by default: the pipeline generates the OData payload + WPS/consolidated
# artifacts as a mock. Set SAP_B1_ENABLED=1 plus the connection vars to actually
# POST the A/R Invoice to a live B1 Service Layer when an invoice is dispatched.
SAP_B1_ENABLED = os.getenv("SAP_B1_ENABLED", "0").lower() in ("1", "true", "yes")
SAP_B1_BASE_URL = os.getenv("SAP_B1_BASE_URL", "").rstrip("/")
SAP_B1_COMPANY_DB = os.getenv("SAP_B1_COMPANY_DB", "")
SAP_B1_USER = os.getenv("SAP_B1_USER", "")
SAP_B1_PASSWORD = os.getenv("SAP_B1_PASSWORD", "")
SAP_B1_VERIFY_TLS = os.getenv("SAP_B1_VERIFY_TLS", "1").lower() in ("1", "true", "yes")

STAGING_DIR.mkdir(parents=True, exist_ok=True)


def config_warnings() -> list[str]:
    """Non-fatal configuration sanity checks, surfaced at startup and on /status.

    Each string is an operational caveat the operator should know about — missing
    LLM/OCR backends, dev-default secrets, an open API, or an incomplete SAP config.
    """
    w: list[str] = []
    if not (AZURE_AI_ENDPOINT and AZURE_AI_KEY) and not OPENAI_API_KEY:
        w.append("no chat LLM configured (AZURE_AI_* or OPENAI_API_KEY) — chat + LLM extraction disabled")
    if not GLM_OCR_API_KEY and not (MISTRAL_OCR_ENDPOINT and MISTRAL_OCR_API_KEY):
        w.append("no OCR backend (GLM_OCR_* or MISTRAL_OCR_*) — image/scan timesheets will escalate")
    if INTERNAL_SECRET == "tia-internal-dev":
        w.append("INTERNAL_SECRET is the dev default — set a strong value (WhatsApp bridge trust boundary)")
    if DATABASE_URL.startswith("sqlite"):
        w.append("using SQLite (dev default) — set DATABASE_URL to Postgres for production")
    if not TIA_API_TOKEN:
        w.append("TIA_API_TOKEN unset — API is OPEN (ok for a public demo; set it to lock a private deploy)")
    if SAP_B1_ENABLED and not (SAP_B1_BASE_URL and SAP_B1_COMPANY_DB and SAP_B1_USER and SAP_B1_PASSWORD):
        w.append("SAP_B1_ENABLED but connection vars incomplete — invoices will NOT post to SAP")
    return w

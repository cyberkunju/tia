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

STAGING_DIR.mkdir(parents=True, exist_ok=True)

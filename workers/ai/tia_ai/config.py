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

# GLM-OCR — OpenAI-compatible vision endpoint (handwriting/PDF). See CONTRACTS.md §1.
# BASE_URL may be given with or without a trailing /v1; the client normalises it.
GLM_OCR_BASE_URL = os.getenv("GLM_OCR_BASE_URL", "https://versifine--glm-ocr-serve.modal.run")
GLM_OCR_API_KEY = os.getenv("GLM_OCR_API_KEY", "")
GLM_OCR_MODEL = os.getenv("GLM_OCR_MODEL", "glm-ocr")

# Chat agent — OpenAI-compatible. Swap to a local model for demo by overriding
# OPENAI_BASE_URL (e.g. a Modal-served vLLM) + OPENAI_MODEL (e.g. "qwen2.5-7b").
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

STAGING_DIR.mkdir(parents=True, exist_ok=True)

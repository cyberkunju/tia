"""OCR client: GLM-OCR (primary, via Modal) with a Tesseract offline fallback.

Teammate owns the Modal serving; this is the client + the brief-required fallback +
the JSON parsing into our canonical schema.
"""

from __future__ import annotations

import base64
import json
import re

import httpx

from ..config import GLM_OCR_BASE_URL
from ..schema import TimesheetExtraction

KIE_PROMPT = """You are extracting a staffing timesheet. Read the document image and
return ONLY a JSON object matching exactly this schema (no prose, no code fences):
{
  "client_code": string|null,
  "client_hint": string|null,
  "period": string|null,
  "signed_by": string|null,
  "rows": [
    {"employee_name": string, "emp_id": string|null, "days_worked": number|null,
     "hours": number|null, "ot_hours": number|null,
     "leave_codes": [string], "reimbursements": [{"reason": string, "amount_aed": number}],
     "notes": string|null}
  ]
}
Transcribe handwriting faithfully. Do not invent values; use null when unsure."""

LAYOUT_PROMPT = "prompt_layout_all_en"


def _b64_data_url(image_bytes: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(image_bytes).decode()}"


def _strip_json(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    m = re.search(r"\{.*\}", text, re.DOTALL)
    return m.group(0) if m else text


def glm_kie(
    image_bytes: bytes, mime: str = "image/png", timeout: float = 90.0
) -> TimesheetExtraction:
    payload = {
        "model": "glm-ocr",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": _b64_data_url(image_bytes, mime)}},
                    {"type": "text", "text": KIE_PROMPT},
                ],
            }
        ],
        "temperature": 0.0,
    }
    r = httpx.post(f"{GLM_OCR_BASE_URL}/v1/chat/completions", json=payload, timeout=timeout)
    r.raise_for_status()
    content = r.json()["choices"][0]["message"]["content"]
    data = json.loads(_strip_json(content))
    return TimesheetExtraction.model_validate(data)


def glm_layout(image_bytes: bytes, mime: str = "image/png", timeout: float = 90.0) -> list[dict]:
    """Return [{bbox,category,text}] for provenance anchoring."""
    payload = {
        "model": "glm-ocr",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": _b64_data_url(image_bytes, mime)}},
                    {"type": "text", "text": LAYOUT_PROMPT},
                ],
            }
        ],
        "temperature": 0.0,
    }
    r = httpx.post(f"{GLM_OCR_BASE_URL}/v1/chat/completions", json=payload, timeout=timeout)
    r.raise_for_status()
    content = r.json()["choices"][0]["message"]["content"]
    try:
        return json.loads(_strip_json(content))
    except (json.JSONDecodeError, ValueError):
        return []


def tesseract_text(image_bytes: bytes) -> str:
    """Offline fallback (brief-required). Returns raw OCR text."""
    import io

    import pytesseract
    from PIL import Image

    return pytesseract.image_to_string(Image.open(io.BytesIO(image_bytes)))

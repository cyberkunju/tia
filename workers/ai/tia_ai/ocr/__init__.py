"""OCR client: GLM-OCR on Modal (OpenAI-compatible vLLM endpoint).

GLM-OCR is the sole OCR. Two prompt modes:
  - markdown: faithful page-to-markdown (best for our handwritten/printed timesheets)
  - kie: image + JSON schema → filled JSON (fallback when markdown is too unstructured)

Teammate owns the Modal serving.
"""

from __future__ import annotations

import base64
import json
import re

import httpx

from ..config import GLM_OCR_API_KEY, GLM_OCR_BASE_URL, GLM_OCR_MODEL
from ..schema import TimesheetExtraction

# Proven on the live glm-ocr endpoint: the terse prompt transcribes faithfully,
# whereas verbose "preserve structure…" instructions made this model emit empty
# code fences. Keep it short.
MARKDOWN_PROMPT = "Extract all text as Markdown. Transcribe handwriting faithfully."

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

LAYOUT_PROMPT = """Identify each text block in this document and respond with ONLY a JSON array
(no prose, no code fences) of objects matching this schema:
[{"bbox": [x1, y1, x2, y2], "category": "Header|Text|Table|Picture", "text": "<exact transcription>"}]

Use pixel coordinates relative to the input image with origin at the top-left. Each block
should be a contiguous logical region (a single line of body text, a heading, a table cell
group, etc). Do not invent coordinates; if you cannot localize a region, omit it."""


def _headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if GLM_OCR_API_KEY:
        h["Authorization"] = f"Bearer {GLM_OCR_API_KEY}"
    return h


def _b64_data_url(image_bytes: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(image_bytes).decode()}"


def _completions_url() -> str:
    """Build the chat-completions URL whether or not BASE_URL already ends in /v1."""
    base = (GLM_OCR_BASE_URL or "").rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    return f"{base}/v1/chat/completions"


def _dedupe_looped(text: str) -> str:
    """Small OCR models loop — they transcribe the page once, then repeat it in
    code fences until they hit the token cap. Keep one clean copy: the text before
    the first fence, or (if it opens with a fence) the longest fenced block."""
    if not text:
        return ""
    head = text.strip().split("```", 1)[0].strip()
    if len(head) >= 20:
        return head
    blocks = [b.strip() for b in re.findall(r"```[a-zA-Z]*\n?(.*?)```", text, re.DOTALL)]
    blocks = [b for b in blocks if b]
    if blocks:
        return max(blocks, key=len)
    return text.replace("```", "").strip()


def _strip_json(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    m = re.search(r"\{.*\}", text, re.DOTALL)
    return m.group(0) if m else text


def _call(image_bytes: bytes, prompt: str, mime: str = "image/png", timeout: float = 180.0) -> str:
    payload = {
        "model": GLM_OCR_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": _b64_data_url(image_bytes, mime)}},
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "temperature": 0.0,
        "max_tokens": 2048,  # cap the loop; one transcription is well under this
    }
    r = httpx.post(_completions_url(), json=payload, headers=_headers(), timeout=timeout)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def glm_markdown(image_bytes: bytes, mime: str = "image/png", timeout: float = 180.0) -> str:
    """Primary path: page → markdown, de-looped to a single clean transcription."""
    return _dedupe_looped(_call(image_bytes, MARKDOWN_PROMPT, mime=mime, timeout=timeout))


def glm_kie(
    image_bytes: bytes, mime: str = "image/png", timeout: float = 180.0
) -> TimesheetExtraction:
    """Schema-constrained JSON path. Used only if markdown parsing yields no rows."""
    content = _call(image_bytes, KIE_PROMPT, mime=mime, timeout=timeout)
    data = json.loads(_strip_json(content))
    return TimesheetExtraction.model_validate(data)


def glm_layout(image_bytes: bytes, mime: str = "image/png", timeout: float = 180.0) -> list[dict]:
    """[{bbox,category,text}] for provenance anchoring.

    Tolerant of three shapes the model occasionally returns:
      - a JSON array (the schema we asked for)
      - a single object with bbox/text (a "whole-page" block)
      - `{"blocks": [...]}` wrapper
    """
    content = _call(image_bytes, LAYOUT_PROMPT, mime=mime, timeout=timeout)
    try:
        data = json.loads(_strip_json(content))
    except (json.JSONDecodeError, ValueError):
        return []
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        if "blocks" in data and isinstance(data["blocks"], list):
            return data["blocks"]
        if "bbox" in data:
            return [data]
    return []

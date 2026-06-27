"""Deterministic safety + prompt-injection guard, consulted BEFORE the model.

A hijacked or unlucky model must never be the thing that decides whether a message is safe, and
untrusted user text must never reach the model as instructions. Pure, no network. Four
mutually-exclusive categories (precedence self_harm → unsafe → injection → safe); each non-safe
category maps to a deterministic, helpful response. Plus the fence/sanitize helpers that wrap all
untrusted content as DATA, and blank-refusal detection so the assistant never dead-ends a user.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

SafetyCategory = str  # 'self_harm' | 'unsafe' | 'injection' | 'safe'

FENCE = "<<<USER_MESSAGE>>>"


@dataclass(frozen=True)
class GuardVerdict:
    category: SafetyCategory
    reason: str


_SELF_HARM = [
    re.compile(p, re.I) for p in [
        r"\bkill\s+my\s?self\b", r"\bkilling\s+my\s?self\b", r"\bend\s+(my|it)\s+(life|all)\b",
        r"\bsuicide\b", r"\bsuicidal\b", r"\bwant\s+to\s+die\b", r"\bwanna\s+die\b",
        r"\bno\s+reason\s+to\s+live\b", r"\b(harm|hurt|cut)\s+my\s?self\b", r"\bself[-\s]?harm\b",
    ]
]

_UNSAFE = [
    re.compile(p, re.I) for p in [
        r"\b(make|build|create|construct|assemble)\b.{0,40}\b(bomb|explosive|grenade|gun|firearm|weapon)\b",
        r"\bhow\s+to\b.{0,40}\b(bomb|explosive|detonat|poison\s+someone|nerve\s+agent|chemical\s+weapon)\b",
        r"\bhow\s+to\b.{0,30}\b(kill|murder|stab|strangle|assault)\b.{0,20}\b(someone|him|her|them|person|people)\b",
        r"\bhow\s+to\b.{0,40}\b(hack|steal|launder|counterfeit|smuggle|forge)\b",
        r"\b(get|find|access|steal|crack)\b.{0,30}\b(password|otp|pin|login|credentials)\b.{0,30}\b(of|for)\b.{0,20}\b(another|someone|other|his|her|their)\b",
    ]
]

_INJECTION = [
    re.compile(p, re.I) for p in [
        r"ignore\s+(all\s+|the\s+|any\s+)?(previous|prior|earlier|above)\s+(instructions?|prompts?|rules?|messages?)",
        r"disregard\s+(all\s+|the\s+|your\s+|any\s+)?(previous|prior|above|instructions?|rules?)",
        r"forget\s+(everything|all|the|your|those|these|any|previous|prior|above)",
        r"you\s+are\s+now\b", r"new\s+instructions?\s*:",
        r"(reveal|show|print|repeat|tell\s+me)\s+(your|the)\s+(instructions?|prompt|system\s+prompt|rules?)",
        r"act\s+as\s+(a|an|if)\b", r"pretend\s+(to\s+be|you('?re| are))\b",
        r"\bjailbreak\b", r"developer\s+mode", r"override\s+(your|the|all)\b",
    ]
]

_REFUSAL = [
    re.compile(p, re.I) for p in [
        r"\bi\s+don'?t\s+know\b", r"\bi\s+do\s+not\s+know\b", r"\bi\s+can'?t\s+help\b",
        r"\bi\s+cannot\s+help\b", r"\bi'?m\s+(just\s+)?a\s+bot\b",
        r"\bi\s+am\s+not\s+(able|programmed|designed|allowed)\b",
        r"\bthat'?s\s+not\s+something\s+i\s+can\s+do\b",
    ]
]

_OFFER = [
    re.compile(p, re.I) for p in [
        r"\bhelp\s+you\b", r"\bi\s+can\s+(suggest|help|point|tell|show)\b",
        r"\bwhat\s+would\s+you\s+like\b", r"\btell\s+me\s+(a\s+little\s+)?more\b",
        r"\bcould\s+you\b", r"\breach\s+out\b", r"\byou\s+matter\b",
    ]
]


def _any(text: str, bank: list[re.Pattern]) -> bool:
    return any(p.search(text) for p in bank)


def assess_safety(text: str) -> GuardVerdict:
    if not isinstance(text, str) or not text.strip():
        return GuardVerdict("safe", "empty message")
    if _any(text, _SELF_HARM):
        return GuardVerdict("self_harm", "self-harm / crisis markers")
    if _any(text, _UNSAFE):
        return GuardVerdict("unsafe", "safety-guardrail-triggering request")
    if _any(text, _INJECTION):
        return GuardVerdict("injection", "prompt-injection / override attempt")
    return GuardVerdict("safe", "no safety markers")


SELF_HARM_RESPONSE = (
    "I'm really sorry you're feeling like this, and I'm glad you reached out. You matter. Please "
    "contact your local emergency services or a trusted person nearby right now — you don't have "
    "to face this alone."
)
UNSAFE_RESPONSE = (
    "I can't help with that part. But I'm here for your timesheets and invoices — tell me what "
    "you're trying to do and I'll help safely."
)
INJECTION_RESPONSE = (
    "I'll keep helping the usual way. I can answer questions about your invoices and timesheets — "
    "what would you like to know?"
)


def safe_response_for(category: SafetyCategory) -> str:
    return {
        "self_harm": SELF_HARM_RESPONSE,
        "unsafe": UNSAFE_RESPONSE,
        "injection": INJECTION_RESPONSE,
    }.get(category, "")


def looks_like_blank_refusal(text: str) -> bool:
    if not isinstance(text, str) or not text.strip():
        return True
    if not _any(text, _REFUSAL):
        return False
    return not _any(text, _OFFER)


_CONTROL_RE = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]")
_FENCE_RE = re.compile(r"<<<\s*USER_MESSAGE\s*>>>", re.I)


def sanitize_untrusted(text: str, max_length: int = 4000) -> str:
    """Strip control chars, defang fence imitations, collapse whitespace, bound length."""
    s = _CONTROL_RE.sub(" ", text or "")
    s = _FENCE_RE.sub("[fenced]", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:max_length]


def fence_untrusted(text: str) -> str:
    return f"{FENCE}\n{sanitize_untrusted(text)}\n{FENCE}"

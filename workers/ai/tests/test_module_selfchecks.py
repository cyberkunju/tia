"""Run each module's offline `_demo()` self-check.

These self-checks assert real behavior (transition tables, cost-matrix
assignment, citation regex, VAT/SAP mapping shape, rule-engine bootstrap, etc.)
and only run under `__main__` in production. Executing them here turns them into
real regression tests and closes the demo-only coverage gaps deterministically.
No network, no external I/O beyond the local typst render used by render._demo.
"""

from __future__ import annotations

from tia_ai.canonicalize import _demo as canonicalize_demo
from tia_ai.extract.email_attachments import _demo as email_attach_demo
from tia_ai.extract.vision import _demo as vision_demo
from tia_ai.finance.leakage import _demo as leakage_demo
from tia_ai.finance.recovery import _demo as recovery_demo
from tia_ai.integrations.sap_b1.mapping import _demo as mapping_demo
from tia_ai.invoice.fsm import _demo as fsm_demo
from tia_ai.invoice.render import _demo as render_demo
from tia_ai.match.hungarian import _demo as hungarian_demo
from tia_ai.qa.agent import _demo as agent_demo
from tia_ai.qa.streaming import _demo as streaming_demo
from tia_ai.validate.rules_v2 import _demo as rules_v2_demo
from tia_ai.erp.smart_bot_sap import _demo as smart_bot_demo


def test_canonicalize_selfcheck():
    canonicalize_demo()


def test_fsm_selfcheck():
    fsm_demo()


def test_hungarian_selfcheck():
    hungarian_demo()


def test_agent_citation_selfcheck():
    agent_demo()


def test_streaming_selfcheck():
    streaming_demo()


def test_recovery_selfcheck():
    recovery_demo()


def test_leakage_selfcheck():
    leakage_demo()


def test_mapping_selfcheck():
    mapping_demo()


def test_rules_v2_selfcheck():
    rules_v2_demo()


def test_email_attachments_selfcheck():
    email_attach_demo()


def test_vision_selfcheck():
    vision_demo()


def test_smart_bot_sap_selfcheck():
    smart_bot_demo()


def test_render_selfcheck():
    render_demo()

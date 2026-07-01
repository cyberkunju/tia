"""Deterministically cover environment-dependent fallback branches so the 100%
coverage gate holds on ANY host (CI included), not just where a local .env or a
missing system font happens to exercise them.

- config._load_dotenv inner loop: only runs when a .env file exists (absent on CI).
- synthgen.case04_handwritten OSError fallback: only runs when the DejaVu TrueType
  font is missing (present on the CI runner, absent on some dev boxes).

Both are forced here via a temp .env and a monkeypatched font loader.
"""

from __future__ import annotations

import os

import tia_ai.config as cfg
import tia_ai.synthgen as sg


def test_load_dotenv_parses_env_file(tmp_path, monkeypatch):
    envfile = tmp_path / ".env"
    envfile.write_text(
        "# a comment\n"
        "\n"
        "TIA_PORTABLE_TEST_KEY=hello\n"
        'TIA_PORTABLE_QUOTED="quoted-value"\n'
        "no_equals_sign_line\n"
    )
    # Point the loader at our temp dir; ensure the keys are unset first so
    # os.environ.setdefault actually writes them.
    monkeypatch.setattr(cfg, "REPO_ROOT", tmp_path)
    monkeypatch.delenv("TIA_PORTABLE_TEST_KEY", raising=False)
    monkeypatch.delenv("TIA_PORTABLE_QUOTED", raising=False)

    cfg._load_dotenv()

    assert os.environ["TIA_PORTABLE_TEST_KEY"] == "hello"
    assert os.environ["TIA_PORTABLE_QUOTED"] == "quoted-value"


def test_load_dotenv_setdefault_does_not_override(tmp_path, monkeypatch):
    envfile = tmp_path / ".env"
    envfile.write_text("TIA_PORTABLE_EXISTING=fromfile\n")
    monkeypatch.setattr(cfg, "REPO_ROOT", tmp_path)
    monkeypatch.setenv("TIA_PORTABLE_EXISTING", "preset")
    cfg._load_dotenv()
    # setdefault must not clobber an already-set var
    assert os.environ["TIA_PORTABLE_EXISTING"] == "preset"


def test_case04_falls_back_when_truetype_font_missing(monkeypatch):
    from PIL import ImageFont

    real_truetype = ImageFont.truetype

    def _no_dejavu(font=None, *a, **k):
        # Simulate the specific system font being absent, but let PIL's
        # load_default() (which itself calls truetype with a bundled font)
        # still work — otherwise the fallback we're testing can't run.
        if isinstance(font, str) and "DejaVu" in font:
            raise OSError("no dejavu truetype font on this host")
        return real_truetype(font, *a, **k)

    monkeypatch.setattr(ImageFont, "truetype", _no_dejavu)
    # Must not raise — it falls back to ImageFont.load_default().
    sg.case04_handwritten()

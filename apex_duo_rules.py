"""
Single Source of Truth — Apex Duo Static Strategy Rules.

Delegates directly to `execution_engine/apex_duo_rules.py` so Backtest,
Forward/Paper (`app_server.py`), and the lighter Live Engine (`execution_engine`)
always execute the exact same rules with zero code duplication.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_TARGET = Path(__file__).resolve().parent / "execution_engine" / "apex_duo_rules.py"
_SPEC = importlib.util.spec_from_file_location("_exec_apex_duo_rules", str(_TARGET))
assert _SPEC is not None and _SPEC.loader is not None, f"Missing {_TARGET}"
_MOD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MOD)

for _name in dir(_MOD):
    if not _name.startswith("__"):
        globals()[_name] = getattr(_MOD, _name)

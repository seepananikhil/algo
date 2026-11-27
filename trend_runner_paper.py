#!/usr/bin/env python3
"""
Thin bridge delegating `trend_runner_paper` directly to the lighter
`execution_engine/strategy_engine.py` with `APEX_ROOT_DIR` set to the workspace root.

This guarantees Forward/Paper testing (`app_server.py`), CLI replays, and
backtests all run the exact same `TrendRunnerPaperEngine` implementation.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
_EXEC_DIR = _ROOT / "execution_engine"
os.environ.setdefault("APEX_ROOT_DIR", str(_ROOT))

if str(_EXEC_DIR) not in sys.path:
    sys.path.insert(0, str(_EXEC_DIR))

_SPEC = importlib.util.spec_from_file_location("_exec_strategy_engine", str(_EXEC_DIR / "strategy_engine.py"))
assert _SPEC is not None and _SPEC.loader is not None, f"Missing {_EXEC_DIR / 'strategy_engine.py'}"
_MOD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MOD)

for _name in dir(_MOD):
    if not _name.startswith("__"):
        globals()[_name] = getattr(_MOD, _name)

"""
Trend Runner Strategy Package
=============================
Multi-Timeframe Trend Following for NIFTY & SENSEX Index Options
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import trend_runner_paper

__all__ = ["trend_runner_paper"]

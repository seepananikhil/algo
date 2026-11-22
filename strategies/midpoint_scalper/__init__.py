"""
Midpoint Scalper Strategy Package
=================================
High-Frequency Level Breakout & Midpoint Mean-Reversion for NIFTY Options
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import midpoint_strategy
import backtest_midpoint_strategy

__all__ = ["midpoint_strategy", "backtest_midpoint_strategy"]

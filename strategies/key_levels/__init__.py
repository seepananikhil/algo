"""
Key Levels Breakout & Fade Strategy Package
===========================================
Institutional Support/Resistance & Multi-Year Key Levels for NIFTY & SENSEX
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import key_level_strategy
import key_level_live

__all__ = ["key_level_strategy", "key_level_live"]

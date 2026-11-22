"""
Phoenix Swinger 2.0 Strategy Package
====================================
High-Probability Deep Base Breakouts & Dynamic Swing Portfolio

Core Strategy Rules:
- Stock Universe: Market Cap >= Rs.2,000 Cr & High-Velocity ATR >= 3.2%
- Leg 1 Entry: Direct deep-base breakout with institutional volume surge
- Leg 2 Entry: 50% retracement cooldown to breakout pivot / 20 EMA
- Stop Loss: Initial -15% structural stop
- Break-Even Shield: Cost shield activated at +15% unrealized gain
- Trailing Lock: 25% peak trailing profit lock on runners
- Allocation: Rs.25,000 per slot (Paper Mode)

File Structure:
- Core Engine: root/swinger_engine.py
- Multi-Year Backtest: root/swinger_backtest.py
- Strategy Configuration: root/swinger_config.json
- Active Holdings: root/paper/swinger/portfolio.json (11 active positions)
- Forward Closed Trades: root/paper/swinger/trades.json (tracking live from Nov 21)
- 4Y Backtest Dataset: root/paper/swinger/backtest_trades.json (66 trades, CAGR +61.4%)
"""

import sys
from pathlib import Path

# Ensure root is in path for transparent proxying
ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from swinger_engine import (
    load_portfolio,
    save_portfolio,
    load_trades,
    save_trades,
    load_backtest_trades,
    load_daily_signals,
    load_watchlist,
    save_watchlist,
    load_config,
    save_config,
    update_positions_and_scan,
    fetch_chartink_signals,
    backtest_single_stock,
    get_stock_candles,
    get_stock_trade_context,
)

__all__ = [
    "load_portfolio",
    "save_portfolio",
    "load_trades",
    "save_trades",
    "load_backtest_trades",
    "load_daily_signals",
    "load_watchlist",
    "save_watchlist",
    "load_config",
    "save_config",
    "update_positions_and_scan",
    "fetch_chartink_signals",
    "backtest_single_stock",
    "get_stock_candles",
    "get_stock_trade_context",
]

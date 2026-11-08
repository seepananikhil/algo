#!/usr/bin/env python3
"""
Master Portfolio Runner (Paper & Live Dispatcher)
Orchestrates Engine 1 (VIX Master) and Engine 2 (Gap-and-Go Williams) in real-time.

Execution Principles:
- Modular: Strategy logic is encapsulated in independent engine objects.
- Capital Protection: Configurable priority routing (Strict 1-Lot vs Concurrent 2-Lots).
- Live Visibility: Real-time trailing SL tracking and dashboard integration.
"""

import os
import sys
import time
import json
import argparse
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent

IST = timezone(timedelta(hours=5, minutes=30))

class MasterPortfolioDispatcher:
    def __init__(self, mode="priority", symbol="NIFTY", paper_mode=True):
        self.mode = mode.lower()  # 'priority' or 'concurrent'
        self.symbol = symbol.upper()
        self.paper_mode = paper_mode
        self.active_engine = None
        self.current_position = None
        self.today_date = datetime.now(IST).strftime("%Y-%m-%d")
        
        # Engine state flags for the day
        self.gap_detected = False
        self.vix_master_traded_morning = False
        self.gap_engine_traded = False
        self.trades_today = []
        
        print("=" * 70)
        print(f"🚀 MASTER PORTFOLIO DISPATCHER INITIALIZED")
        print(f"   Symbol: {self.symbol} | Mode: {self.mode.upper()} | Paper: {self.paper_mode}")
        print("=" * 70)

    def on_market_open(self, open_price, prev_close_1515):
        """Called at 09:15 AM to inspect opening gap."""
        gap_pts = open_price - prev_close_1515
        gap_pct = (gap_pts / prev_close_1515) * 100.0
        print(f"[{datetime.now(IST).strftime('%H:%M:%S')}] 📊 Market Open: {open_price:.1f} | Prev Close: {prev_close_1515:.1f} | Gap: {gap_pts:+.1f} pts ({gap_pct:+.2f}%)")
        
        if abs(gap_pct) >= 0.5:
            self.gap_detected = True
            print("   👉 Large Gap Detected (>= 0.5%)! Priority routed to Engine 2 (Gap-and-Go).")
        else:
            self.gap_detected = False
            print("   👉 Normal Opening Range (< 0.5%). Priority routed to Engine 1 (VIX Master).")

    def on_one_minute_candle(self, candle):
        """Processes each 1-minute candle throughout the session."""
        ts_str = candle.get("time", "")
        # Routing logic
        # 1. Morning Window (09:15 - 11:00)
        # 2. Lunch Blackout (11:00 - 11:59)
        # 3. Afternoon Window (12:00 - 14:30)
        pass

    def record_trade(self, engine_name, side, entry_time, entry_price, sl, target):
        trade = {
            "engine": engine_name,
            "side": side,
            "entry_time": entry_time,
            "entry_price": entry_price,
            "sl": sl,
            "target": target,
            "status": "OPEN",
            "timestamp": datetime.now(IST).isoformat()
        }
        self.current_position = trade
        self.trades_today.append(trade)
        print(f"[{entry_time}] ⚡ TRADE EXECUTED by {engine_name}: {side} @ {entry_price:.1f} | SL: {sl:.1f} | Target: {target:.1f}")

    def status_summary(self):
        return {
            "mode": self.mode,
            "symbol": self.symbol,
            "gap_detected": self.gap_detected,
            "vix_master_traded": self.vix_master_traded_morning,
            "current_position": self.current_position,
            "trades_count": len(self.trades_today)
        }

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Master Portfolio Live/Paper Runner")
    parser.add_argument("--mode", choices=["priority", "concurrent"], default="priority", help="Execution mode")
    parser.add_argument("--symbol", choices=["NIFTY", "SENSEX"], default="NIFTY", help="Symbol to trade")
    parser.add_argument("--paper", action="store_true", default=True, help="Run in paper mode")
    args = parser.parse_args()

    dispatcher = MasterPortfolioDispatcher(mode=args.mode, symbol=args.symbol, paper_mode=args.paper)
    print("Dispatcher standby. Ready for market open.")

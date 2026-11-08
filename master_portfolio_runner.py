#!/usr/bin/env python3
"""
Master Portfolio Runner (Paper & Live Dispatcher)
Orchestrates the 4 modular strategy setups in real-time:

Setups:
  1. vix_master_morning   : VIX Master 09:30 - 11:00 ORB + VIX Bias
  2. vix_master_afternoon : VIX Master 12:00 - 14:30 Rolling Extreme Re-entry
  3. gap_and_go_morning   : Gap-and-Go 09:46 - 12:00 10% ORB Breakout (Gap >= 0.5%)
  4. williams_afternoon   : Williams Fractal 12:00 - 14:30 Prior Day Range Breakout

Configuration is loaded from `master_portfolio_config.json` with CLI override support.
"""

import os
import sys
sys.stdout.reconfigure(encoding='utf-8')
import time
import json
import argparse
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IST = timezone(timedelta(hours=5, minutes=30))
CONFIG_PATH = ROOT / "master_portfolio_config.json"

def load_portfolio_config():
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "symbol": "NIFTY",
        "mode": "priority",
        "max_trades_per_day": 2,
        "max_concurrent_positions": 1,
        "setups": {
            "vix_master_morning": True,
            "vix_master_afternoon": True,
            "williams_afternoon": True
        },
        "spot_ratchet_settings": {
            "initial_sl_pts": 28.0,
            "tier0a_trigger_pts": 40.0,
            "tier0a_lock_pts": -15.0,
            "tier0b_breakeven_trigger_pts": 55.0,
            "tier0b_breakeven_lock_pts": 5.0,
            "tier1_trigger_pts": 70.0,
            "tier1_lock_pts": 20.0,
            "tier2_trigger_pts": 130.0,
            "tier2_lock_pts": 60.0,
            "tier3_trigger_pts": 180.0,
            "tier3_lock_pts": 110.0,
            "tier4_trigger_pts": 230.0,
            "tier4_lock_pts": 165.0
        }
    }

class MasterPortfolioDispatcher:
    def __init__(self, config=None):
        self.cfg = config or load_portfolio_config()
        self.symbol = self.cfg.get("symbol", "NIFTY").upper()
        self.mode = self.cfg.get("mode", "priority").lower()
        self.setups = self.cfg.get("setups", {})
        self.ratchet = self.cfg.get("spot_ratchet_settings", {})
        
        self.current_position = None
        self.trades_today = []
        self.today_date = datetime.now(IST).strftime("%Y-%m-%d")
        
        # State tracking
        self.gap_pct = 0.0
        self.gap_detected = False
        self.morning_trade_taken = False
        self.afternoon_trade_taken = False

        print("=" * 75)
        print(f"🚀 MASTER PORTFOLIO DISPATCHER READY")
        print(f"   Symbol: {self.symbol} | Mode: {self.mode.upper()}")
        print(f"   Active Strategy Setups:")
        for name, active in self.setups.items():
            status = "🟢 ENABLED" if active else "⚪ DISABLED"
            print(f"     - {name:<26}: {status}")
        print(f"   Spot Ratchet Ladder: SL -{self.ratchet.get('initial_sl_pts', 28.0):.0f}pt | BE +{self.ratchet.get('tier0b_breakeven_trigger_pts', 55.0):.0f}->+{self.ratchet.get('tier0b_breakeven_lock_pts', 5.0):.0f}pt | R1 +{self.ratchet.get('tier1_trigger_pts', 70.0):.0f}->+{self.ratchet.get('tier1_lock_pts', 20.0):.0f}pt | R2 +{self.ratchet.get('tier2_trigger_pts', 130.0):.0f}->+{self.ratchet.get('tier2_lock_pts', 60.0):.0f}pt")
        print("=" * 75)

    def on_market_open(self, open_price, prev_close_1515):
        """Processes 09:15 AM market open and establishes opening baseline."""
        gap_pts = open_price - prev_close_1515
        self.gap_pct = (gap_pts / prev_close_1515) * 100.0
        print(f"[{datetime.now(IST).strftime('%H:%M:%S')}] 📊 09:15 Open: {open_price:.1f} | Prev Close: {prev_close_1515:.1f} | Gap: {gap_pts:+.1f} pts ({self.gap_pct:+.2f}%)")
        print("   👉 Morning session routed to Setup 1: VIX Master Morning ORB.")

    def can_trade_now(self, setup_name, current_time_str):
        """Enforces scheduling windows, setup enablement, and priority exclusivity."""
        if not self.setups.get(setup_name, False):
            return False

        if len(self.trades_today) >= self.cfg.get("max_trades_per_day", 2):
            return False

        # In Priority Mode:
        if self.mode == "priority":
            # If a position is already open, cannot enter another
            if self.current_position is not None:
                return False

            # If morning trade already taken, only afternoon setups are allowed
            if self.morning_trade_taken and current_time_str < "12:00":
                return False

        # Lunch Blackout Guard (11:00 - 11:59)
        if "11:00" <= current_time_str < "12:00":
            return False

        return True

    def record_entry(self, setup_name, side, price, sl, target, time_str, spot_ref=None):
        trade = {
            "setup": setup_name,
            "side": side,
            "entry_time": time_str,
            "entry_price": price,
            "entry_spot": spot_ref if spot_ref is not None else price,
            "sl": sl,
            "initial_sl": sl,
            "target": target,
            "peak_price": price,
            "max_fav_pts": 0.0,
            "last_ratchet": None,
            "status": "OPEN",
            "lots": 1
        }
        self.current_position = trade
        self.trades_today.append(trade)
        if time_str < "11:30":
            self.morning_trade_taken = True
        else:
            self.afternoon_trade_taken = True

        print(f"[{time_str}] ⚡ ENTRY by {setup_name}: {side} @ {price:.1f} | SL: {sl:.1f} | TGT: {target:.1f}")

    def update_ratchet(self, current_spot_high, current_spot_low, current_spot_close):
        """
        Applies exact VIX Master / Trend Runner Spot Points Ratchet Lock discipline.
        Locks fixed spot points at each milestone regardless of option price or volatility.
        """
        pos = self.current_position
        if not pos:
            return

        side = pos["side"]
        entry_spot = pos["entry_spot"]
        
        # Calculate maximum favorable spot excursion
        fav = (current_spot_high - entry_spot) if "LONG" in side or "CALL" in side else (entry_spot - current_spot_low)
        if fav > pos["max_fav_pts"]:
            pos["max_fav_pts"] = fav

        max_fav = pos["max_fav_pts"]
        
        # Spot Points Milestone Locks
        t0a_trig = self.ratchet.get("tier0a_trigger_pts", 40.0)
        t0a_lock = self.ratchet.get("tier0a_lock_pts", -15.0)
        t0b_trig = self.ratchet.get("tier0b_breakeven_trigger_pts", 55.0)
        t0b_lock = self.ratchet.get("tier0b_breakeven_lock_pts", 5.0)
        r1_trig = self.ratchet.get("tier1_trigger_pts", 70.0)
        r1_lock = self.ratchet.get("tier1_lock_pts", 20.0)
        r2_trig = self.ratchet.get("tier2_trigger_pts", 130.0)
        r2_lock = self.ratchet.get("tier2_lock_pts", 60.0)
        r3_trig = self.ratchet.get("tier3_trigger_pts", 180.0)
        r3_lock = self.ratchet.get("tier3_lock_pts", 110.0)
        r4_trig = self.ratchet.get("tier4_trigger_pts", 230.0)
        r4_lock = self.ratchet.get("tier4_lock_pts", 165.0)

        new_lock_pts = None
        tier_label = None

        if max_fav >= r4_trig:
            new_lock_pts = r4_lock
            tier_label = f"Tier 4 (+{r4_trig:.0f} pts)"
        elif max_fav >= r3_trig:
            new_lock_pts = r3_lock
            tier_label = f"Tier 3 (+{r3_trig:.0f} pts)"
        elif max_fav >= r2_trig:
            new_lock_pts = r2_lock
            tier_label = f"Tier 2 (+{r2_trig:.0f} pts)"
        elif max_fav >= r1_trig:
            new_lock_pts = r1_lock
            tier_label = f"Tier 1 (+{r1_trig:.0f} pts)"
        elif max_fav >= t0b_trig:
            new_lock_pts = t0b_lock
            tier_label = f"Tier 0B Breakeven (+{t0b_trig:.0f} pts)"
        elif max_fav >= t0a_trig:
            new_lock_pts = t0a_lock
            tier_label = f"Tier 0A Guard (+{t0a_trig:.0f} pts)"

        if new_lock_pts is not None and pos.get("last_ratchet") != tier_label:
            pos["last_ratchet"] = tier_label
            # Update stop loss
            is_call = "LONG" in side or "CALL" in side
            if pos["entry_spot"] == pos["entry_price"]: # Spot / Futures
                pos["sl"] = entry_spot + new_lock_pts if is_call else entry_spot - new_lock_pts
            else: # Option premium approximation (0.72 delta)
                pos["sl"] = pos["entry_price"] + (new_lock_pts * 0.72)
            print(f"   🛡️ [RATCHET {tier_label}]: Peak +{max_fav:.1f} pts! Stop moved to {pos['sl']:.1f} (Locked {new_lock_pts:+.1f} spot pts)")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Master Portfolio Dispatcher")
    parser.add_argument("--mode", choices=["priority", "concurrent"], help="Override mode")
    parser.add_argument("--symbol", choices=["NIFTY", "SENSEX"], help="Override symbol")
    parser.add_argument("--setups", help="Comma-separated setups to enable: vix_morn,vix_aft,gap_morn,williams or all")
    args = parser.parse_args()

    cfg = load_portfolio_config()
    if args.mode:
        cfg["mode"] = args.mode
    if args.symbol:
        cfg["symbol"] = args.symbol
    if args.setups:
        selected = [s.strip().lower() for s in args.setups.split(",")]
        cfg["setups"]["vix_master_morning"] = "all" in selected or "vix_morn" in selected
        cfg["setups"]["vix_master_afternoon"] = "all" in selected or "vix_aft" in selected
        cfg["setups"]["gap_and_go_morning"] = "all" in selected or "gap_morn" in selected
        cfg["setups"]["williams_afternoon"] = "all" in selected or "williams" in selected

    dispatcher = MasterPortfolioDispatcher(cfg)

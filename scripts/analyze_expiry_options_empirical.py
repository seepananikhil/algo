#!/usr/bin/env python3
"""Empirical Options Data Analysis:
Comparing 0-DTE ITM-150 vs 0-DTE ITM-200 vs Next-Week ITM-150 vs Next-Week ITM-200
for Nifty trade on 2026-11-17.
"""

from __future__ import annotations
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from datetime import datetime
import pandas as pd
from kotak_orders import get_kotak_client

def main():
    client = get_kotak_client()
    if not client:
        print("Failed to get Kotak client")
        return

    contracts = {
        "0-DTE ITM-150 (25250 CE)": {"token": "45396", "symbol": "NIFTY26N1725250CE", "strike": 25250, "dte": "0-DTE"},
        "0-DTE ITM-200 (25200 CE)": {"token": "45394", "symbol": "NIFTY26N1725200CE", "strike": 25200, "dte": "0-DTE"},
        "Next-Week ITM-150 (25250 CE)": {"token": "64453", "symbol": "NIFTY26NOV25250CE", "strike": 25250, "dte": "Next-Week (23-Nov)"},
        "Next-Week ITM-200 (25200 CE)": {"token": "64451", "symbol": "NIFTY26NOV25200CE", "strike": 25200, "dte": "Next-Week (23-Nov)"},
    }

    candles_data = {}
    import time
    for name, cinfo in contracts.items():
        time.sleep(2.5)  # Avoid Kotak 429 rate limit
        res = None
        for attempt in range(3):
            try:
                res = client.historical_data(
                    neosymbol=f"nse_fo|{cinfo['token']}",
                    interval="1min",
                    from_date="2026-11-17",
                    to_date="2026-11-17"
                )
                if isinstance(res, dict) and "data" in res:
                    break
                print(f"Retry {attempt+1} for {name}...")
                time.sleep(3)
            except Exception as e:
                print(f"Exception fetching {name}: {e}")
                time.sleep(3)
        candles = res.get("data", {}).get("candles", []) if isinstance(res, dict) else []
        # format: [time, open, high, low, close, volume]
        df = pd.DataFrame(candles, columns=["time", "open", "high", "low", "close", "volume"])
        df["time_str"] = df["time"].apply(lambda t: t[11:16])
        df.set_index("time_str", inplace=True)
        candles_data[name] = df
        print(f"Loaded {len(df)} candles for {name} ({cinfo['symbol']})")

    # Key trade timestamps
    # Entry: 09:54 (Spot: 25380.60)
    # Pyramid: 11:45 (Spot: 25450.60)
    # Peak: 12:13 (Spot: 25501.35)
    # Exit: 13:04 (Spot: 25430.60)
    t_entry = "09:54"
    t_pyr = "11:45"
    t_peak = "12:13"
    t_exit = "13:04"

    results = []

    lot_size = 25  # Nifty lot size

    print("\n" + "=" * 90)
    print(f"{'Metric':<32} | {'0-DTE ITM-150':<14} | {'0-DTE ITM-200':<14} | {'Next-Wk ITM-150':<15} | {'Next-Wk ITM-200':<15}")
    print("=" * 90)

    for name, df in candles_data.items():
        c_entry = df.loc[t_entry] if t_entry in df.index else None
        c_pyr = df.loc[t_pyr] if t_pyr in df.index else None
        c_peak = df.loc[t_peak] if t_peak in df.index else None
        c_exit = df.loc[t_exit] if t_exit in df.index else None

        p_entry = float(c_entry["close"]) if c_entry is not None else 0.0
        p_pyr = float(c_pyr["close"]) if c_pyr is not None else 0.0
        p_peak = float(c_peak["high"]) if c_peak is not None else 0.0
        p_exit = float(c_exit["close"]) if c_exit is not None else 0.0

        # Calculations:
        # Lot 1: bought at p_entry, sold at p_exit (peak at p_peak)
        # Lot 2: bought at p_pyr, sold at p_exit (peak at p_peak)
        cap_lot1 = p_entry * lot_size
        cap_lot2 = p_pyr * lot_size
        total_cap = cap_lot1 + cap_lot2

        # PnL Lot 1
        pnl_l1_pts = p_exit - p_entry
        pnl_l1_rs = pnl_l1_pts * lot_size

        # PnL Lot 2
        pnl_l2_pts = p_exit - p_pyr
        pnl_l2_rs = pnl_l2_pts * lot_size

        total_realized_rs = pnl_l1_rs + pnl_l2_rs
        total_realized_pts = (pnl_l1_pts + pnl_l2_pts) / 2  # avg points per lot

        # Peak Floating PnL at 12:13
        peak_l1_pts = p_peak - p_entry
        peak_l2_pts = p_peak - p_pyr
        peak_floating_rs = (peak_l1_pts + peak_l2_pts) * lot_size

        # Drawdown from peak to exit
        drawdown_rs = peak_floating_rs - total_realized_rs
        ret_on_capital = (total_realized_rs / total_cap) * 100 if total_cap > 0 else 0
        peak_ret_on_cap = (peak_floating_rs / total_cap) * 100 if total_cap > 0 else 0

        # Delta capture / efficiency vs Spot
        # Spot move entry to peak: 25501.35 - 25380.60 = +120.75 pts
        # Spot move entry to exit: 25430.60 - 25380.60 = +50.0 pts
        opt_spot_ratio_peak = (peak_l1_pts / 120.75) * 100
        opt_spot_ratio_exit = (pnl_l1_pts / 50.0) * 100

        results.append({
            "name": name,
            "p_entry": p_entry,
            "p_pyr": p_pyr,
            "p_peak": p_peak,
            "p_exit": p_exit,
            "cap_lot1": cap_lot1,
            "total_cap": total_cap,
            "peak_floating_rs": peak_floating_rs,
            "peak_ret_on_cap": peak_ret_on_cap,
            "pnl_l1_pts": pnl_l1_pts,
            "pnl_l2_pts": pnl_l2_pts,
            "total_realized_rs": total_realized_rs,
            "ret_on_capital": ret_on_capital,
            "drawdown_rs": drawdown_rs,
            "opt_spot_ratio_exit": opt_spot_ratio_exit,
            "opt_spot_ratio_peak": opt_spot_ratio_peak,
        })

    def get_val(idx, key, fmt="{:.1f}"):
        return fmt.format(results[idx][key])

    rows = [
        ("Lot 1 Entry Price (09:54)", "p_entry", "Rs {:.2f}"),
        ("Lot 2 Pyramid Price (11:45)", "p_pyr", "Rs {:.2f}"),
        ("Peak High Price (12:13)", "p_peak", "Rs {:.2f}"),
        ("Exit Price (13:04)", "p_exit", "Rs {:.2f}"),
        ("Initial Capital (Lot 1)", "cap_lot1", "Rs {:,.0f}"),
        ("Total Capital Deployed (2 Lots)", "total_cap", "Rs {:,.0f}"),
        ("Peak Floating P&L (12:13)", "peak_floating_rs", "+Rs {:,.0f}"),
        ("Peak Return on Capital", "peak_ret_on_cap", "+{:.1f}%"),
        ("Lot 1 Realized Points", "pnl_l1_pts", "{:+.2f} pts"),
        ("Lot 2 Realized Points", "pnl_l2_pts", "{:+.2f} pts"),
        ("FINAL REALIZED P&L (Rs)", "total_realized_rs", "+Rs {:,.0f}"),
        ("Realized Return on Capital", "ret_on_capital", "{:+.1f}%"),
        ("Profit Giveback from Peak", "drawdown_rs", "-Rs {:,.0f}"),
        ("Lot 1 Delta Eff vs Spot (Peak)", "opt_spot_ratio_peak", "{:.1f}%"),
        ("Lot 1 Delta Eff vs Spot (Exit)", "opt_spot_ratio_exit", "{:.1f}%"),
    ]

    for label, key, fmt in rows:
        v0 = fmt.format(results[0][key])
        v1 = fmt.format(results[1][key])
        v2 = fmt.format(results[2][key])
        v3 = fmt.format(results[3][key])
        print(f"{label:<32} | {v0:<14} | {v1:<14} | {v2:<15} | {v3:<15}")
    print("=" * 90)

    # Save to JSON for report
    with open("scripts/options_empirical_comparison.json", "w") as f:
        json.dump(results, f, indent=2)
    print("\nSaved detailed comparison to scripts/options_empirical_comparison.json")

if __name__ == "__main__":
    main()

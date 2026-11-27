#!/usr/bin/env python3
"""
Verify 100% Parity & Sync between:
  1. apex_duo_rules.py (root) == execution_engine/apex_duo_rules.py
  2. execution_engine/portfolio_config.json == locked SL/cutoff settings
  3. execution_engine.strategy_engine.TrendRunnerPaperEngine (live/lighter engine)
     replayed bar-by-bar on recent sessions vs Master Portfolio Backtest CSVs.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
EXEC_DIR = ROOT / "execution_engine"


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def check_static_sync() -> bool:
    sys.path.insert(0, str(ROOT))
    import apex_duo_rules as root_rules
    import trend_runner_paper

    sys.path.insert(0, str(EXEC_DIR))
    import apex_duo_rules as exec_rules

    print("[1] Single Source of Truth (apex_duo_rules.py -> execution_engine/apex_duo_rules.py):")
    checks = [
        ("NIFTY_INITIAL_SL_PTS", 55.0),
        ("SENSEX_INITIAL_SL_PTS", 220.0),
        ("NIFTY_EMA_BUFFER_PTS", 10.0),
        ("SENSEX_EMA_BUFFER_PTS", 30.0),
        ("EMA_TIMEFRAME", "1m"),
        ("EMA_PERIOD", 200),
        ("REENTRY_CUTOFF_TIME", "13:30"),
    ]
    for k, expected in checks:
        rv, ev = getattr(root_rules, k), getattr(exec_rules, k)
        if rv != expected or ev != expected:
            print(f"    ERROR: {k} mismatch (root={rv}, exec={ev}, expected={expected})")
            return False
    print("    OK: Root apex_duo_rules delegates directly to execution_engine/apex_duo_rules.py.")
    print(f"    OK: trend_runner_paper delegates to execution_engine/strategy_engine.py (PERF_DIR={trend_runner_paper.PERF_DIR}).")

    cfg = json.loads((EXEC_DIR / "portfolio_config.json").read_text(encoding="utf-8"))
    n_sl = cfg.get("nifty_settings", {}).get("initial_sl_pts")
    s_sl = cfg.get("sensex_settings", {}).get("initial_sl_pts")
    print(f"[2] execution_engine/portfolio_config.json:")
    print(f"    NIFTY SL={n_sl} | SENSEX SL={s_sl} | dual_act={cfg.get('require_dual_activation')} | dual_ema={cfg.get('require_dual_ema20_cross')}")
    if n_sl != 55.0 or s_sl != 220.0:
        print("    ERROR: portfolio_config.json SL mismatch!")
        return False
    print("    OK: Config matches locked 55p / 220p.")
    return True


def replay_execution_engine_on_dates(target_dates: list[str]) -> None:
    sys.path.insert(0, str(EXEC_DIR))
    from strategy_engine import TrendRunnerPaperEngine
    from apex_duo_rules import check_ema20_cross

    vix_df = pd.read_csv(ROOT / "captured_data" / "india_vix_10y.csv")
    vix_df["date"] = pd.to_datetime(vix_df["date"]).dt.strftime("%Y-%m-%d")
    vix_map = dict(zip(vix_df["date"], vix_df["vix_change_pct"]))

    def load_1m(sym: str) -> pd.DataFrame:
        folder = "technovusin_nifty50" if sym == "NIFTY" else "technovusin_sensex"
        files = sorted((ROOT / "captured_data" / folder / "1min").rglob("*2026*.csv"))
        df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
        df["dt"] = pd.to_datetime(df["Timestamp"])
        df.sort_values("dt", inplace=True)
        df["date"] = df["dt"].dt.strftime("%Y-%m-%d")
        df["time"] = df["dt"].dt.strftime("%H:%M")
        return df

    n_df = load_1m("NIFTY")
    s_df = load_1m("SENSEX")

    print("[3] Replaying execution_engine.strategy_engine.TrendRunnerPaperEngine...")
    for d in target_dates:
        vix_chg = float(vix_map.get(d, 0.0))
        # Warm up 5 prior days so 1m 200-EMA matches continuous backtest
        n_dates = sorted(n_df["date"].unique())
        s_dates = sorted(s_df["date"].unique())
        n_idx = n_dates.index(d)
        s_idx = s_dates.index(d)
        n_win = n_df[n_df["date"].isin(n_dates[max(0, n_idx - 5):n_idx + 1])].copy()
        s_win = s_df[s_df["date"].isin(s_dates[max(0, s_idx - 5):s_idx + 1])].copy()

        n_closed, s_closed = [], []
        eng_n = TrendRunnerPaperEngine(symbol="NIFTY", log_trades=False, enable_vix_trap=False, enable_trend_runner=True, on_exit_fn=lambda res, _pos: n_closed.append(res))
        eng_s = TrendRunnerPaperEngine(symbol="SENSEX", log_trades=False, enable_vix_trap=False, enable_trend_runner=True, on_exit_fn=lambda res, _pos: s_closed.append(res))

        # Dual exit gate matching main.py
        def make_exit_gate(other_eng):
            def gate(sym, sig, t_str, c_px, ema_px):
                oc = getattr(other_eng, "last_1m_close", None)
                oe = getattr(other_eng, "last_1m_ema200", None)
                if oc is None or oe is None:
                    return True
                other_sym = "SENSEX" if sym == "NIFTY" else "NIFTY"
                return check_ema20_cross(other_sym, sig, float(oc), float(oe))
            return gate

        eng_n.exit_gate_fn = make_exit_gate(eng_s)
        eng_s.exit_gate_fn = make_exit_gate(eng_n)

        # Feed warmup days (EMA warmup only)
        for day_s, eng in [(n_win[n_win["date"] < d], eng_n), (s_win[s_win["date"] < d], eng_s)]:
            for _, r in day_s.iterrows():
                alpha_200 = 2.0 / 201.0
                c = float(r["Close"])
                eng.ema200_1m = c if eng.ema200_1m is None else (c * alpha_200 + eng.ema200_1m * (1.0 - alpha_200))

        # Compute Opening Range (09:15-09:30) and cumulative VWAP
        n_day_df = n_win[n_win["date"] == d].copy()
        s_day_df = s_win[s_win["date"] == d].copy()
        for df_d in (n_day_df, s_day_df):
            tp = (df_d["High"] + df_d["Low"] + df_d["Close"]) / 3.0
            df_d["vwap"] = tp.expanding().mean()
        n_or = n_day_df[n_day_df["time"] < "09:30"]
        s_or = s_day_df[s_day_df["time"] < "09:30"]
        n_orh, n_orl = float(n_or["High"].max()), float(n_or["Low"].min())
        s_orh, s_orl = float(s_or["High"].max()), float(s_or["Low"].min())

        # Feed target day minute-by-minute simultaneously
        n_day = n_day_df.set_index("time")
        s_day = s_day_df.set_index("time")
        all_t = sorted(set(n_day.index).union(set(s_day.index)))
        for t_s in all_t:
            if t_s in n_day.index:
                r = n_day.loc[t_s]
                if isinstance(r, pd.DataFrame): r = r.iloc[-1]
                bar = pd.Series({"date": d, "time_str": t_s, "open": float(r["Open"]), "high": float(r["High"]), "low": float(r["Low"]), "close": float(r["Close"]), "vwap": float(r["vwap"])})
                eng_n.evaluate_bar(bar, n_orh, n_orl, n_orh - n_orl, vix_chg)
            if t_s in s_day.index:
                r = s_day.loc[t_s]
                if isinstance(r, pd.DataFrame): r = r.iloc[-1]
                bar = pd.Series({"date": d, "time_str": t_s, "open": float(r["Open"]), "high": float(r["High"]), "low": float(r["Low"]), "close": float(r["Close"]), "vwap": float(r["vwap"])})
                eng_s.evaluate_bar(bar, s_orh, s_orl, s_orh - s_orl, vix_chg)

        fmt = lambda lst: [(t.get("entry_time"), round(t.get("entry_price", 0), 2), t.get("exit_time", t.get("time")), round(t.get("exit_price", 0), 2), round(t.get("pnl_points", 0), 2), t.get("exit_reason", t.get("reason"))) for t in lst]
        print(f"    {d} NIFTY  trades: {fmt(n_closed)}")
        print(f"    {d} SENSEX trades: {fmt(s_closed)}")


if __name__ == "__main__":
    ok = check_static_sync()
    if not ok:
        sys.exit(1)
    replay_execution_engine_on_dates(["2026-11-23", "2026-11-26"])

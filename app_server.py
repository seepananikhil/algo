#!/usr/bin/env python3
"""Local dashboard + JSON API for the NIFTY strategy (read-only, plus the STOP_TRADING kill switch).

Run: python3 app_server.py  ->  http://127.0.0.1:8090
"""

from __future__ import annotations

import csv
import json
import math
import mimetypes
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd

from midpoint_strategy import MIDPOINT_BUFFER_POINTS, PAPER_LOTS, PAPER_STARTING_CAPITAL, TRADE_WINDOW_MINUTES, backtest_midpoint_strategy, day_setup, pending_entry
from fyers_orders import available_equity_funds, load_nifty_options
from key_level_strategy import aggregate_five_minute, backtest_key_levels, read_paper_events, settings_from_config as key_level_settings, summarize_key_level_trades
from option_paper import read_option_paper_trades

ROOT = Path(__file__).resolve().parent
TMP_DIR = ROOT / ".tmp"
TMP_DIR.mkdir(parents=True, exist_ok=True)
LIVE_DIR = ROOT / "captured_data" / "fyers" / "live"
TOKEN_FILE = ROOT / "captured_data" / "fyers" / "fyers_access_token.json"
CONFIG_FILE = ROOT / "fyers_config.json"
STOP_FILE = ROOT / "STOP_TRADING"
UI_FILE = ROOT / "ui" / "dashboard.html"
WEB_DIST = ROOT / "web" / "dist"
MASTER_CSV = ROOT / "captured_data" / "fyers" / "fyers_spot_1min_extended.csv"
ARCHIVE_CSV = ROOT / "captured_data" / "fyers" / "fyers_spot_1min_3y_archive.csv"
PAPER_TRADES_CSV = LIVE_DIR / "paper_trades.csv"
HERO_ZERO_DIR = ROOT / "captured_data" / "fyers" / "hero_zero"
KEY_LEVEL_DIR = ROOT / "captured_data" / "fyers" / "key_levels"
KEY_LEVEL_EVENT_FILE = KEY_LEVEL_DIR / "key_level_paper_events.csv"
OPTION_PAPER_EVENT_FILE = KEY_LEVEL_DIR / "key_level_option_paper_events.csv"
HOST, PORT = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8090"))
IST = timezone(timedelta(hours=5, minutes=30))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_token_cache = {"at": 0.0, "mtime": None, "value": None}
_master_cache = {"mtime": None, "df": None}
_option_master_cache = {"date": None, "df": None}
_option_master_lock = threading.Lock()
_sensex_option_master_cache = {"date": None, "df": None}
_sensex_option_master_lock = threading.Lock()
_backtest_cache = {"mtime": None, "value": None}
_key_level_backtest_cache = {"key": None, "value": None}
_cache_lock = threading.Lock()
_login_proc = {"proc": None}
_capture = {"auto_started": None, "stopped_by_user": None}
AUTO_START_WINDOW = ("09:00", "15:29")
SENSEX_COLLECTOR_START = (16, 5)
SENSEX_COLLECTOR_END_HOUR = 20
SENSEX_COLLECTOR_RETRY_SECONDS = 15 * 60
HERO_ZERO_START = (15, 5)
HERO_ZERO_END = (15, 31)

# Only these config keys are exposed/editable from the UI (never app_id/secret_key).
EDITABLE_SETTINGS = {
    "broker": (str, None, None),
    "lots": (int, 1, PAPER_LOTS),
    "daily_loss_limit": (int, 100, 100000),
    "strike_offset": (int, 0, 500),
    "option_target_pct": (int, 0, 200),
    "hero_zero_live_trading": (bool, None, None),
    "minimum_live_funds": (int, 10000, 10000000),
    "key_levels_live_trading": (bool, None, None),
    "key_levels_lots": (int, 1, PAPER_LOTS),
    "hero_zero_lots": (int, 1, PAPER_LOTS),
    "scalper_paper_trading": (bool, None, None),
    "scalper_live_trading": (bool, None, None),
    "scalper_lots": (int, 1, PAPER_LOTS),
    "scalper_sl_pts": (float, 3.0, 50.0),
    "scalper_target_pts": (float, 5.0, 100.0),
    "scalper_max_trades": (int, 1, 999),
    "scalper_stop_on_loss": (bool, None, None),
    "scalper_max_hold": (int, 3, 30),
    "hourly_trend_paper_trading": (bool, None, None),
    "hourly_trend_live_trading": (bool, None, None),
    "hourly_trend_lots": (int, 1, PAPER_LOTS),
}


def today() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d")


def current_nifty_options() -> pd.DataFrame:
    """Load the remote option master once per local trading day."""
    session_date = today()
    with _option_master_lock:
        if _option_master_cache["date"] != session_date or _option_master_cache["df"] is None:
            _option_master_cache["df"] = load_nifty_options()
            _option_master_cache["date"] = session_date
        return _option_master_cache["df"]


def current_sensex_options() -> pd.DataFrame:
    """Load or build the Sensex option master once per local trading day."""
    session_date = today()
    with _sensex_option_master_lock:
        if _sensex_option_master_cache["date"] == session_date and _sensex_option_master_cache["df"] is not None:
            return _sensex_option_master_cache["df"]

        cache_file = TMP_DIR / f"sensex_options_{session_date}.pkl"
        if cache_file.exists():
            try:
                df = pd.read_pickle(cache_file)
                _sensex_option_master_cache["df"] = df
                _sensex_option_master_cache["date"] = session_date
                return df
            except Exception:
                pass

        df = None
        # Try Kotak Neo scrip search first
        try:
            from kotak_orders import get_kotak_client, kotak_token_status
            if kotak_token_status().get("valid"):
                client = get_kotak_client()
                if client:
                    ce_scrip = client.search_scrip(exchange_segment="bse_fo", symbol="SENSEX", option_type="CE") or []
                    pe_scrip = client.search_scrip(exchange_segment="bse_fo", symbol="SENSEX", option_type="PE") or []
                    rows = []
                    for item in ce_scrip + pe_scrip:
                        if item.get("pSymbolName") == "SENSEX" and item.get("lExpiryDate"):
                            exp_date = datetime.fromtimestamp(item["lExpiryDate"], tz=IST).date()
                            stk = float(item.get("dStrikePrice;", 0) / 100)
                            rows.append({
                                "symbol": str(item.get("pTrdSymbol", "")),
                                "lot_size": int(item.get("lLotSize", 20)),
                                "strike": stk,
                                "opt_type": str(item.get("pOptionType", "")).upper(),
                                "expiry": exp_date,
                                "token": str(item.get("pSymbol", "")),
                            })
                    if rows:
                        df = pd.DataFrame(rows).drop_duplicates(subset=["expiry", "strike", "opt_type"])
        except Exception:
            pass

        # Fallback to Fyers BSE_FO.csv
        if df is None or df.empty:
            try:
                fo_url = "https://public.fyers.in/sym_details/BSE_FO.csv"
                master_raw = pd.read_csv(fo_url, header=None, dtype=str)
                rows = master_raw[(master_raw[13] == "SENSEX") & master_raw[16].isin(("CE", "PE"))]
                built = []
                for row in rows.itertuples(index=False, name=None):
                    exp_sec = pd.to_numeric(row[8], errors="coerce")
                    if pd.isna(exp_sec):
                        continue
                    exp_dt = pd.to_datetime(exp_sec, unit="s", utc=True).dt.tz_convert("Asia/Kolkata").date()
                    built.append({
                        "symbol": str(row[9]),
                        "lot_size": int(float(row[3])) if row[3] else 20,
                        "strike": float(row[15]),
                        "opt_type": str(row[16]).upper(),
                        "expiry": exp_dt,
                        "token": str(row[0]),
                    })
                if built:
                    df = pd.DataFrame(built).drop_duplicates(subset=["expiry", "strike", "opt_type"])
            except Exception:
                pass

        if df is None:
            df = pd.DataFrame(columns=["symbol", "lot_size", "strike", "opt_type", "expiry", "token"])

        try:
            df.to_pickle(cache_file)
        except Exception:
            pass

        _sensex_option_master_cache["df"] = df
        _sensex_option_master_cache["date"] = session_date
        return df


def is_market_weekday(now: datetime | None = None) -> bool:
    return (now or datetime.now(IST)).weekday() < 5


def read_csv_rows(path: Path) -> list:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def fyers_token_status() -> dict:
    mtime = TOKEN_FILE.stat().st_mtime if TOKEN_FILE.exists() else None
    if time.time() - _token_cache["at"] < 30 and _token_cache["value"] and _token_cache["mtime"] == mtime:
        return _token_cache["value"]
    value = {"broker": "FYERS", "valid": False, "generated_at_utc": None}
    if TOKEN_FILE.exists():
        try:
            tok = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
            value["generated_at_utc"] = tok.get("generated_at_utc")
            from fyers_apiv3 import fyersModel

            r = fyersModel.FyersModel(
                client_id=tok["app_id"],
                token=tok["access_token"],
                is_async=False,
                log_path=str(TMP_DIR),
            ).get_profile()
            value["valid"] = r.get("s") == "ok"
        except Exception:
            pass
    _token_cache.update(at=time.time(), mtime=mtime, value=value)
    return value


def token_status() -> dict:
    from broker import get_active_broker
    active = get_active_broker()
    if active == "KOTAK_NEO":
        from kotak_orders import kotak_token_status
        ks = kotak_token_status()
        return {
            "broker": "KOTAK_NEO",
            "valid": ks.get("valid", False),
            "ucc": ks.get("ucc"),
            "greeting_name": ks.get("greeting_name"),
            "generated_at_utc": ks.get("logged_in_at"),
            "reason": ks.get("reason"),
        }
    return fyers_token_status()


def _process_pids_by_pattern(pattern: str) -> list[int]:
    """Return PIDs matching a command pattern, cross-platform."""
    if os.name == "nt":
        escaped = pattern.replace("'", "''")
        python_name = Path(sys.executable).name.replace("'", "''")
        ps = (
            "Get-CimInstance Win32_Process | "
            "Where-Object { $_.Name -eq '%s' -and $_.CommandLine -match [regex]::Escape('%s') } | "
            "Select-Object -ExpandProperty ProcessId"
        ) % (python_name, escaped)
        result = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, check=False)
        pids = []
        for line in result.stdout.splitlines():
            text = line.strip()
            if text and text.isdigit():
                pids.append(int(text))
        return pids

    result = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True, check=False)
    pids = []
    for line in result.stdout.splitlines():
        text = line.strip()
        if text and text.isdigit():
            pids.append(int(text))
    return pids


def capture_running() -> bool:
    return bool(_process_pids_by_pattern("kotak_capture"))


def start_capture() -> dict:
    if not is_market_weekday():
        return {"capture_running": capture_running(), "started": False, "market_closed": True}
    if capture_running():
        return {"capture_running": True, "started": False}
    LIVE_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LIVE_DIR / "capture.log"
    if log_path.exists() and datetime.fromtimestamp(log_path.stat().st_mtime, IST).strftime("%Y-%m-%d") != today():
        log_path.replace(LIVE_DIR / "capture.prev.log")
    log = log_path.open("a", encoding="utf-8")
    kwargs = {
        "cwd": ROOT,
        "stdout": log,
        "stderr": subprocess.STDOUT,
        "start_new_session": True,
    }
    if os.name != "nt":
        kwargs["preexec_fn"] = lambda: signal.signal(signal.SIGINT, signal.SIG_DFL)

    script = "kotak_capture.py"
    subprocess.Popen([sys.executable, "-u", str(ROOT / script)], **kwargs)
    _capture["stopped_by_user"] = None
    return {"capture_running": True, "started": True}


def stop_capture() -> dict:
    pids = _process_pids_by_pattern("kotak_capture")
    for pid in pids:
        try:
            os.kill(pid, signal.SIGINT)
        except (ProcessLookupError, OSError):
            pass

    def force_later() -> None:
        time.sleep(15)
        for pid in pids:
            try:
                os.kill(pid, signal.SIGTERM)
            except (ProcessLookupError, OSError):
                pass

    threading.Thread(target=force_later, daemon=True).start()
    _capture["stopped_by_user"] = today()
    return {"stopping": len(pids)}


def auto_start_loop() -> None:
    """Start on weekdays in the configured window and stop any capture carried into weekends."""
    while True:
        try:
            now = datetime.now(IST)
            day = now.strftime("%Y-%m-%d")
            if not is_market_weekday(now):
                if capture_running() and _capture.get("weekend_stop_requested") != day:
                    stop_capture()
                    _capture["weekend_stop_requested"] = day
                    print(f"[{now:%H:%M:%S}] stopped capture for weekend")
                time.sleep(30)
                continue
            in_window = AUTO_START_WINDOW[0] <= now.strftime("%H:%M") <= AUTO_START_WINDOW[1]
            if in_window and _capture["stopped_by_user"] != day and _capture["auto_started"] != day:
                if not capture_running():
                    start_capture()
                    print(f"[{now:%H:%M:%S}] auto-started capture")
                _capture["auto_started"] = day
        except Exception as exc:
            print(f"auto-start error: {exc}")
        time.sleep(30)


def sensex_expiry_collector_loop() -> None:
    """Fetch SENSEX expiry options on Thursdays after close while the app server is running."""
    last_attempt_date = None
    last_attempt_at = 0.0
    script = ROOT / "fyers_fetch_sensex_expiry.py"
    output_dir = ROOT / "captured_data" / "fyers" / "sensex_expiry"
    log_path = output_dir / "collector.log"
    while True:
        now = datetime.now(IST)
        try:
            session = now.date()
            due = (
                now.weekday() == 3
                and (now.hour, now.minute) >= SENSEX_COLLECTOR_START
                and now.hour < SENSEX_COLLECTOR_END_HOUR
            )
            csv_path = output_dir / f"sensex_expiry_{session.isoformat()}.csv"
            json_path = output_dir / f"sensex_expiry_{session.isoformat()}.json"
            retry_due = last_attempt_date != session or time.time() - last_attempt_at >= SENSEX_COLLECTOR_RETRY_SECONDS
            if due and retry_due and not (csv_path.exists() and json_path.exists()):
                output_dir.mkdir(parents=True, exist_ok=True)
                last_attempt_date, last_attempt_at = session, time.time()
                with log_path.open("a", encoding="utf-8") as log:
                    log.write(f"\n[{now:%Y-%m-%d %H:%M:%S} IST] Starting SENSEX expiry fetch.\n")
                    result = subprocess.run(
                        [sys.executable, "-u", str(script), "--date", session.isoformat(), "--count", "15", "--force"],
                        cwd=ROOT,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        timeout=15 * 60,
                        check=False,
                    )
                    log.write(f"[{datetime.now(IST):%Y-%m-%d %H:%M:%S} IST] Collector exit code: {result.returncode}.\n")
        except Exception as exc:
            output_dir.mkdir(parents=True, exist_ok=True)
            with log_path.open("a", encoding="utf-8") as log:
                log.write(f"[{datetime.now(IST):%Y-%m-%d %H:%M:%S} IST] Scheduler failed: {exc}\n")
            print(f"SENSEX expiry scheduler failed: {exc}")
        time.sleep(30)


def hero_zero_capture_loop() -> None:
    """Launch the Hero-Zero expiry option capture (SENSEX via Kotak Neo) before the 15:20 snapshot."""
    script = ROOT / "kotak_hero_zero_capture.py"
    output_dir = ROOT / "captured_data" / "fyers" / "hero_zero"
    log_path = output_dir / "collector.log"
    last_attempt_date = None
    last_attempt_at = 0.0
    while True:
        now = datetime.now(IST)
        session = now.date().isoformat()
        due = now.weekday() < 5 and (now.hour, now.minute) >= HERO_ZERO_START and (now.hour, now.minute) < HERO_ZERO_END
        status_path = output_dir / f"hero_zero_status_{session}.json"
        try:
            process = bool(_process_pids_by_pattern("kotak_hero_zero_capture.py"))
            retry_due = last_attempt_date != session or time.time() - last_attempt_at >= 120
            if due and not status_path.exists() and not process and retry_due:
                output_dir.mkdir(parents=True, exist_ok=True)
                last_attempt_date, last_attempt_at = session, time.time()
                log = log_path.open("a", encoding="utf-8")
                log.write(f"\n[{now:%Y-%m-%d %H:%M:%S} IST] Starting HeroZero expiry capture (Kotak/SENSEX).\n")
                log.flush()
                subprocess.Popen(
                    [sys.executable, "-u", str(script)],
                    cwd=ROOT,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                log.close()
                print(f"[{now:%H:%M:%S}] started HeroZero expiry capture (Kotak/SENSEX)")
        except Exception as exc:
            output_dir.mkdir(parents=True, exist_ok=True)
            with log_path.open("a", encoding="utf-8") as log:
                log.write(f"[{now:%Y-%m-%d %H:%M:%S} IST] Scheduler failed: {exc}\n")
            print(f"HeroZero scheduler failed: {exc}")
        time.sleep(30)


def scalper_status() -> dict:
    cfg = read_config()
    today_str = today()
    live_paper_file = LIVE_DIR / "scalper_live_paper.csv"
    today_trades = []
    if live_paper_file.exists():
        for r in read_csv_rows(live_paper_file):
            if r.get("date") == today_str:
                today_trades.append(r)
    return {
        "enabled": bool(cfg.get("scalper_paper_trading", True) or cfg.get("scalper_live_trading", False)),
        "mode": "LIVE" if cfg.get("scalper_live_trading") else "PAPER",
        "sl_pts": float(cfg.get("scalper_sl_pts", 9.0)),
        "target_pts": float(cfg.get("scalper_target_pts", 25.0)),
        "max_trades": int(cfg.get("scalper_max_trades", 1)),
        "trades_today_count": len(today_trades),
        "today_trades": today_trades,
    }


def scalper_forward_loop() -> None:
    """Continuously monitor today's live 1-min candles for Micro-Compression Momentum Scalper setups."""
    live_paper_file = LIVE_DIR / "scalper_live_paper.csv"
    last_candle_checked = None

    while True:
        try:
            cfg = read_config()
            paper_on = cfg.get("scalper_paper_trading", True)
            live_on = cfg.get("scalper_live_trading", False)
            if not paper_on and not live_on:
                time.sleep(5)
                continue

            sl_pts = float(cfg.get("scalper_sl_pts", 9.0))
            tgt_pts = float(cfg.get("scalper_target_pts", 25.0))
            max_trades = int(cfg.get("scalper_max_trades", 1))
            stop_on_loss = bool(cfg.get("scalper_stop_on_loss", True))
            max_hold = int(cfg.get("scalper_max_hold", 10))

            today_str = today()
            live_file = LIVE_DIR / f"nifty_1min_{today_str}.csv"
            if not live_file.exists():
                time.sleep(5)
                continue

            df = pd.read_csv(live_file)
            if df.empty or len(df) < 15:
                time.sleep(5)
                continue

            last_ts = str(df["timestamp"].iloc[-1])
            if last_ts == last_candle_checked:
                time.sleep(3)
                continue

            from compression_scalp_strategy import backtest_compression_scalp
            today_trades_df = backtest_compression_scalp(
                df,
                sl_points=sl_pts,
                target_points=tgt_pts,
                max_hold_bars=max_hold,
                max_trades_per_day=max_trades,
                stop_on_loss_day=stop_on_loss,
            )

            # Read existing live paper trades
            existing_trades = []
            if live_paper_file.exists():
                existing_trades = read_csv_rows(live_paper_file)

            existing_keys = {(r.get("date"), r.get("entry_time")) for r in existing_trades}

            # Check for any newly closed trades today
            if not today_trades_df.empty:
                new_trades = []
                lots = max(1, int(cfg.get("scalper_lots", 1)))
                qty = lots * 65
                base_opt_price = 105.0

                for _, trade_row in today_trades_df.iterrows():
                    key = (str(trade_row["date"]), str(trade_row["entry_time"]))
                    if key not in existing_keys:
                        side = "CALL" if str(trade_row["side"]) == "LONG" else "PUT"
                        entry_spot = float(trade_row["entry_price"])
                        exit_spot = float(trade_row["exit_price"])
                        pnl_pts = float(trade_row["pnl_points"])
                        strike = int(round(entry_spot / 50.0) * 50)
                        opt_name = f"NIFTY {strike} {'CE' if side == 'CALL' else 'PE'}"

                        # Option pricing: ATM delta ~ 0.50
                        opt_pts = pnl_pts * 0.50
                        buy_px = base_opt_price
                        sell_px = round(max(1.0, buy_px + opt_pts), 2)
                        buy_val = round(buy_px * qty, 2)
                        sell_val = round(sell_px * qty, 2)
                        pnl_rs = round((sell_px - buy_px) * qty, 2)
                        charges = est_charges(buy_val, sell_val)
                        net_rs = round(pnl_rs - charges, 2)

                        sl_spot = round(entry_spot - sl_pts if side == "CALL" else entry_spot + sl_pts, 2)
                        tgt_spot = round(entry_spot + tgt_pts if side == "CALL" else entry_spot - tgt_pts, 2)

                        new_trades.append({
                            "date": str(trade_row["date"]),
                            "entry_time": str(trade_row["entry_time"]),
                            "side": side,
                            "entry_price": entry_spot,
                            "option": opt_name,
                            "qty": qty,
                            "buy_price": buy_px,
                            "buy_value_rs": buy_val,
                            "exit_time": str(trade_row["exit_time"]),
                            "exit_price": exit_spot,
                            "sell_price": sell_px,
                            "sell_value_rs": sell_val,
                            "pnl_rs": pnl_rs,
                            "pnl_points": pnl_pts,
                            "charges_rs": charges,
                            "net_rs": net_rs,
                            "exit_reason": str(trade_row["exit_reason"]),
                            "bars_held": int(trade_row["bars_held"]),
                            "sl": sl_spot,
                            "target": tgt_spot,
                        })
                if new_trades:
                    new_df = pd.DataFrame(new_trades)
                    if live_paper_file.exists():
                        new_df.to_csv(live_paper_file, mode="a", header=False, index=False)
                    else:
                        new_df.to_csv(live_paper_file, index=False)
                    print(f"[{datetime.now(IST):%H:%M:%S}] [Micro Scalper LIVE PAPER] Logged {len(new_trades)} trade(s): {new_trades}")

            last_candle_checked = last_ts
        except Exception:
            pass
        time.sleep(3)


def trend_runner_forward_loop() -> None:
    """Continuously monitor today's live 1-min stream for Trend Catcher (VIX Runner) setups."""
    today_str = today()
    live_file = LIVE_DIR / f"nifty_1min_{today_str}.csv"
    engine = None
    last_processed_5m = ""

    while True:
        try:
            cfg = read_config()
            if not cfg.get("trend_runner_paper_trading", True):
                time.sleep(5)
                continue

            current_today = today()
            if current_today != today_str:
                today_str = current_today
                live_file = LIVE_DIR / f"nifty_1min_{today_str}.csv"
                engine = None
                last_processed_5m = ""

            if not live_file.exists():
                time.sleep(5)
                continue

            df1 = pd.read_csv(live_file)
            if df1.empty or len(df1) < 15:
                time.sleep(5)
                continue

            from trend_runner_paper import TrendRunnerPaperEngine, compute_indicators, get_vix_change_pct
            if engine is None:
                lots_cfg = int(cfg.get("trend_runner_lots", 3))
                engine = TrendRunnerPaperEngine(
                    sl_points=28.0,
                    sl_mode="fixed",
                    lots=lots_cfg,
                    sizing_mode="fixed",
                    reentry=True,
                )
                engine.current_day_str = today_str

            df5, or_high, or_low, or_range = compute_indicators(df1)
            if df5.empty:
                time.sleep(5)
                continue

            latest_bar = df5.iloc[-1]
            curr_5m_time = str(latest_bar.get("time_str", ""))

            if curr_5m_time != last_processed_5m:
                vix_chg = get_vix_change_pct(today_str)
                res = engine.evaluate_bar(latest_bar, or_high, or_low, or_range, vix_chg)
                last_processed_5m = curr_5m_time
                if res:
                    print(f"[{datetime.now(IST):%H:%M:%S}] [Trend Catcher LIVE PAPER] Position Event: {res}")

        except Exception:
            pass
        time.sleep(5)



def history_mtime() -> tuple:
    return tuple(p.stat().st_mtime if p.exists() else None for p in (ARCHIVE_CSV, MASTER_CSV))


def master() -> pd.DataFrame:
    """3-year archive plus the daily-updated master 1-min history (stored in UTC), as naive IST like the live files."""
    paths = [p for p in (ARCHIVE_CSV, MASTER_CSV) if p.exists()]
    if not paths:
        return pd.DataFrame()
    mtime = history_mtime()
    with _cache_lock:
        if _master_cache["mtime"] != mtime:
            df = pd.concat([pd.read_csv(p) for p in paths], ignore_index=True)
            ts = pd.to_datetime(df["timestamp"], errors="coerce")
            df["timestamp"] = ts.dt.tz_localize("UTC").dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
            df = df.dropna(subset=["timestamp", "open", "high", "low", "close"])
            # Master is listed last, so its rows win where the two files overlap.
            df = df.drop_duplicates("timestamp", keep="last").sort_values("timestamp").reset_index(drop=True)
            _master_cache.update(mtime=mtime, df=df)
        return _master_cache["df"]


def candles(date: str, symbol: str = "NIFTY") -> pd.DataFrame:
    sym = str(symbol or "NIFTY").strip().upper()
    if sym == "SENSEX":
        path = LIVE_DIR / f"sensex_1min_{date}.csv"
        if path.exists():
            try:
                df = pd.read_csv(path)
                if not df.empty and "timestamp" in df.columns:
                    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
                    df = df.dropna(subset=["timestamp"])
                    return df
            except Exception:
                pass
        return pd.DataFrame()

    m = master()
    master_day = pd.DataFrame()
    if not m.empty:
        master_day = m[m["timestamp"].dt.strftime("%Y-%m-%d") == date].reset_index(drop=True)

    path = LIVE_DIR / f"nifty_1min_{date}.csv"
    if path.exists():
        try:
            df = pd.read_csv(path)
            if not df.empty and "timestamp" in df.columns:
                df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
                df = df.dropna(subset=["timestamp"])
                if master_day.empty:
                    return df
                # Combine master archive with live file to ensure full 09:15-15:30 session coverage
                combined = pd.concat([master_day, df], ignore_index=True)
                combined = combined.drop_duplicates("timestamp", keep="last").sort_values("timestamp").reset_index(drop=True)
                return combined
        except Exception:
            pass

    if master_day.empty:
        n5_path = ROOT / "captured_data" / "fyers" / "nifty_5min.csv"
        if n5_path.exists():
            try:
                n5 = pd.read_csv(n5_path)
                n5["timestamp"] = pd.to_datetime(n5["timestamp"])
                day_n5 = n5[n5["timestamp"].dt.strftime("%Y-%m-%d") == date].reset_index(drop=True)
                if not day_n5.empty:
                    return day_n5
            except Exception:
                pass

    return master_day


def available_days() -> list:
    days = {p.stem.replace("nifty_1min_", "") for p in LIVE_DIR.glob("nifty_1min_*.csv")}
    m = master()
    if not m.empty:
        days |= set(m["timestamp"].dt.strftime("%Y-%m-%d").unique())
    return sorted(days, reverse=True)


def backtest_report() -> dict:
    """Current-rule backtest over the master history (cached until the CSV changes)."""
    m = master()
    if m.empty:
        return {"summary": {}, "trades": [], "monthly": [], "exit_reasons": []}
    mtime = history_mtime()
    with _cache_lock:
        if _backtest_cache["mtime"] == mtime:
            return _backtest_cache["value"]
    t = backtest_midpoint_strategy(m)
    trades, equity, peak = [], 0.0, 0.0
    for r in t.itertuples():
        equity += r.pnl_points
        peak = max(peak, equity)
        trades.append({
            "date": pd.Timestamp(r.entry_time).strftime("%Y-%m-%d"),
            "side": "CALL" if r.side == "LONG" else "PUT",
            "entry": pd.Timestamp(r.entry_time).strftime("%H:%M"),
            "entry_price": round(r.entry, 2),
            "sl": round(r.stop, 2),
            "target": round(r.target, 2),
            "exit": pd.Timestamp(r.exit_time).strftime("%H:%M"),
            "exit_price": round(r.exit_price, 2),
            "reason": r.reason,
            "pnl_points": round(r.pnl_points, 2),
            "equity": round(equity, 2),
            "drawdown": round(equity - peak, 2),
        })
    n = len(trades)
    wins = sum(1 for x in trades if x["pnl_points"] > 0)
    monthly, reasons = {}, {}
    for x in trades:
        monthly[x["date"][:7]] = round(monthly.get(x["date"][:7], 0.0) + x["pnl_points"], 2)
        reasons[x["reason"]] = reasons.get(x["reason"], 0) + 1
    days = m["timestamp"].dt.strftime("%Y-%m-%d")
    daily = {d: {"date": d, "points": 0.0, "trades": 0} for d in days.unique()}
    for x in trades:
        daily[x["date"]]["points"] = round(daily[x["date"]]["points"] + x["pnl_points"], 2)
        daily[x["date"]]["trades"] += 1
    value = {
        "summary": {
            "from": days.iloc[0],
            "to": days.iloc[-1],
            "days": int(days.nunique()),
            "trades": n,
            "wins": wins,
            "losses": sum(1 for x in trades if x["pnl_points"] < 0),
            "win_rate_pct": round(100.0 * wins / n, 2) if n else 0.0,
            "total_points": round(sum(x["pnl_points"] for x in trades), 2),
            "avg_points": round(sum(x["pnl_points"] for x in trades) / n, 2) if n else 0.0,
            "max_drawdown": min((x["drawdown"] for x in trades), default=0.0),
            "best": max((x["pnl_points"] for x in trades), default=0.0),
            "worst": min((x["pnl_points"] for x in trades), default=0.0),
            "lot_size": 65,
        },
        "trades": trades,
        "monthly": [{"month": k, "points": v} for k, v in sorted(monthly.items())],
        "daily": sorted(daily.values(), key=lambda d: d["date"]),
        "exit_reasons": [{"reason": k, "count": v} for k, v in sorted(reasons.items(), key=lambda kv: -kv[1])],
    }
    with _cache_lock:
        _backtest_cache.update(mtime=mtime, value=value)
    return value


def read_config() -> dict:
    return json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}


def public_settings() -> dict:
    cfg = read_config()
    out = {k: cfg.get(k) for k in EDITABLE_SETTINGS}
    out["broker"] = cfg.get("broker", "FYERS")
    out["lots"] = int(cfg.get("lots", PAPER_LOTS))
    out["daily_loss_limit"] = cfg.get("daily_loss_limit") if cfg.get("daily_loss_limit") is not None else 1000
    out["strike_offset"] = cfg.get("strike_offset") if cfg.get("strike_offset") is not None else 100
    out["option_target_pct"] = cfg.get("option_target_pct") if cfg.get("option_target_pct") is not None else 10
    out["minimum_live_funds"] = int(cfg.get("minimum_live_funds") or 25000)
    out["midpoint_live_trading"] = bool(cfg.get("midpoint_live_trading", cfg.get("live_trading", False)))
    out["hero_zero_live_trading"] = bool(cfg.get("hero_zero_live_trading", False))
    out["key_levels_live_trading"] = bool(cfg.get("key_levels_live_trading", False))
    out["key_levels_lots"] = int(cfg.get("key_levels_lots", 1))
    out["hero_zero_lots"] = int(cfg.get("hero_zero_lots", 1))
    out["scalper_paper_trading"] = bool(cfg.get("scalper_paper_trading", True))
    out["scalper_live_trading"] = bool(cfg.get("scalper_live_trading", False))
    out["scalper_lots"] = int(cfg.get("scalper_lots", 1))
    out["scalper_sl_pts"] = float(cfg.get("scalper_sl_pts", 9.0))
    out["scalper_target_pts"] = float(cfg.get("scalper_target_pts", 25.0))
    out["scalper_max_trades"] = int(cfg.get("scalper_max_trades", 1))
    out["scalper_stop_on_loss"] = bool(cfg.get("scalper_stop_on_loss", True))
    out["hourly_trend_paper_trading"] = bool(cfg.get("hourly_trend_paper_trading", True))
    out["hourly_trend_live_trading"] = bool(cfg.get("hourly_trend_live_trading", False))
    out["hourly_trend_lots"] = int(cfg.get("hourly_trend_lots", 1))
    out.update(key_level_settings(cfg))
    out["live_trading"] = out["midpoint_live_trading"]
    out["capture_running"] = capture_running()

    # Kotak Neo non-sensitive metadata for UI
    k_cfg = cfg.get("kotak_neo", {})
    out["kotak_mobile_number"] = k_cfg.get("mobile_number", "")
    out["kotak_ucc"] = k_cfg.get("ucc", "")
    out["kotak_consumer_key_set"] = bool(k_cfg.get("consumer_key"))
    out["kotak_mpin_set"] = bool(k_cfg.get("mpin"))
    out["kotak_totp_secret_set"] = bool(k_cfg.get("totp_secret"))
    return out


def broker_funds() -> dict:
    from broker import get_funds
    return get_funds()


class ManualTradeError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def manual_fyers_client():
    if not TOKEN_FILE.exists():
        raise ManualTradeError("Fyers token is missing; log in first.", 401)
    from fyers_apiv3 import fyersModel

    tok = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
    return fyersModel.FyersModel(
        client_id=tok["app_id"],
        token=tok["access_token"],
        is_async=False,
        log_path=str(TMP_DIR),
    )


def _manual_number(value, default: float = 0.0) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def _manual_contract(expiry_text: str, strike_value, option_type: str, index_symbol: str = "NIFTY") -> dict:
    try:
        expiry = datetime.strptime(expiry_text, "%Y-%m-%d").date()
        strike = float(strike_value)
    except (TypeError, ValueError):
        raise ManualTradeError("Choose a valid expiry and strike.") from None
    option_type = str(option_type).upper()
    if not math.isfinite(strike) or option_type not in ("CE", "PE"):
        raise ManualTradeError("Choose a valid CE or PE contract.")

    idx = str(index_symbol or "NIFTY").upper()
    options = current_sensex_options() if idx == "SENSEX" else current_nifty_options()
    matches = options[
        (options["expiry"] == expiry)
        & (options["strike"] == strike)
        & (options["opt_type"] == option_type)
    ]
    if matches.empty:
        raise ManualTradeError(f"That {idx} option contract is not available in the current symbol master.")
    row = matches.iloc[0]
    return {
        "symbol": str(row["symbol"]),
        "lot_size": int(row.get("lot_size", 20 if idx == "SENSEX" else 65)),
        "expiry": expiry.isoformat(),
        "strike": strike,
        "option_type": option_type,
        "token": str(row.get("token", "")),
        "index_symbol": idx,
    }


def manual_option_choices(query: dict | None = None) -> dict:
    idx_sym = "NIFTY"
    if query:
        idx_sym = str((query.get("symbol") or query.get("index") or ["NIFTY"])[0]).upper()

    if idx_sym == "SENSEX":
        spot = 0.0
        st = status()
        if st.get("sensex_last_tick") and st["sensex_last_tick"].get("ltp"):
            spot = float(st["sensex_last_tick"]["ltp"])
        if spot <= 0:
            spot = 74000.0

        options = current_sensex_options()
        current_date = datetime.now(IST).date()
        expiries = sorted(expiry for expiry in options["expiry"].unique() if expiry >= current_date)[:4]
        if not expiries:
            raise ManualTradeError("No future SENSEX option expiries are available.", 503)
        atm = round(spot / 100) * 100
        choices = []
        for expiry in expiries:
            rows = options[(options["expiry"] == expiry) & (options["strike"].between(atm - 3000, atm + 3000))]
            choices.append({
                "expiry": expiry.isoformat(),
                "lot_size": int(rows.iloc[0]["lot_size"]) if not rows.empty else 20,
                "strikes": sorted(int(strike) for strike in rows["strike"].unique()),
            })
        return {"symbol": "SENSEX", "spot": spot, "atm": atm, "max_lots": max(1, int(PAPER_LOTS)), "expiries": choices}

    spot = 0.0
    try:
        client = manual_fyers_client()
        quote = client.quotes(data={"symbols": "NSE:NIFTY50-INDEX"})
        quote_rows = quote.get("d") or []
        if quote.get("s") == "ok" and quote_rows:
            spot = _manual_number((quote_rows[0].get("v") or {}).get("lp"))
    except Exception:
        pass

    if spot <= 0:
        st = status()
        if st.get("last_tick") and st["last_tick"].get("ltp"):
            spot = float(st["last_tick"]["ltp"])
        else:
            spot = 22700.0

    options = current_nifty_options()
    current_date = datetime.now(IST).date()
    expiries = sorted(expiry for expiry in options["expiry"].unique() if expiry >= current_date)[:4]
    if not expiries:
        raise ManualTradeError("No future NIFTY option expiries are available.", 503)
    atm = round(spot / 50) * 50
    choices = []
    for expiry in expiries:
        rows = options[(options["expiry"] == expiry) & (options["strike"].between(atm - 2000, atm + 2000))]
        choices.append({
            "expiry": expiry.isoformat(),
            "lot_size": int(rows.iloc[0]["lot_size"]) if not rows.empty else 65,
            "strikes": sorted(int(strike) for strike in rows["strike"].unique()),
        })
    return {"symbol": "NIFTY", "spot": spot, "atm": atm, "max_lots": max(1, int(PAPER_LOTS)), "expiries": choices}


def manual_option_quote(query: dict) -> dict:
    symbol = str((query.get("symbol") or [""])[0])
    idx = str((query.get("index_symbol") or query.get("symbol_index") or [""])[0]).upper()
    if not idx:
        idx = "SENSEX" if "SENSEX" in symbol else "NIFTY"

    if symbol:
        options = current_sensex_options() if idx == "SENSEX" else current_nifty_options()
        clean = symbol.replace("NSE:", "").replace("BSE:", "")
        matches = options[(options["symbol"] == clean) | (options["symbol"] == symbol)]
        lot_sz = int(matches.iloc[0]["lot_size"]) if not matches.empty else (20 if idx == "SENSEX" else 65)
        tok = str(matches.iloc[0]["token"]) if not matches.empty and "token" in matches.columns else ""
        contract = {"symbol": symbol, "lot_size": lot_sz, "token": tok, "index_symbol": idx}
    else:
        expiry = str((query.get("expiry") or [""])[0])
        strike = (query.get("strike") or [""])[0]
        option_type = str((query.get("option_type") or [""])[0])
        contract = _manual_contract(expiry, strike, option_type, index_symbol=idx)

    from broker import get_active_broker
    broker = get_active_broker()
    price = 0.0

    # Kotak Neo quote lookup
    if (broker == "KOTAK_NEO" or contract["index_symbol"] == "SENSEX") and contract.get("token"):
        from kotak_orders import get_kotak_client
        c = get_kotak_client()
        if c:
            try:
                ex_seg = "bse_fo" if contract["index_symbol"] == "SENSEX" else "nse_fo"
                q_resp = c.quotes(instrument_tokens=[{"instrument_token": str(contract["token"]), "exchange_segment": ex_seg}])
                if isinstance(q_resp, list) and q_resp:
                    price = float(q_resp[0].get("ltp") or 0.0)
            except Exception:
                pass

    if price <= 0:
        # Fallback to Fyers quote
        try:
            f_sym = contract["symbol"]
            if contract["index_symbol"] == "SENSEX":
                if not f_sym.startswith("BSE:"):
                    f_sym = f"BSE:{f_sym}"
            else:
                if not f_sym.startswith("NSE:"):
                    f_sym = f"NSE:{f_sym}"
            response = manual_fyers_client().quotes(data={"symbols": f_sym})
            rows = response.get("d") or []
            if response.get("s") == "ok" and rows:
                price = _manual_number((rows[0].get("v") or {}).get("lp"))
        except Exception:
            pass

    if price <= 0:
        raise ManualTradeError(f"Unable to fetch valid option quote for {contract['symbol']}.", 502)
    return {"symbol": contract["symbol"], "lot_size": contract["lot_size"], "last_price": price}


def manual_trading_snapshot() -> dict:
    client = manual_fyers_client()
    positions_response = client.positions()
    orders_response = client.orderbook()
    if positions_response.get("s") != "ok":
        raise ManualTradeError("Fyers positions request failed.", 502)
    if orders_response.get("s") != "ok":
        raise ManualTradeError("Fyers order-book request failed.", 502)

    open_positions = []
    for row in positions_response.get("netPositions") or []:
        symbol = str(row.get("symbol", ""))
        if not (symbol.startswith("NSE:NIFTY") and symbol.endswith(("CE", "PE"))):
            continue
        net_qty = int(_manual_number(row.get("netQty")))
        if net_qty == 0:
            continue
        open_positions.append({
            "symbol": symbol,
            "net_qty": net_qty,
            "average_price": _manual_number(row.get("netAvg")),
            "pnl": _manual_number(row.get("pl")),
            "realized_pnl": _manual_number(row.get("realized_profit")),
            "unrealized_pnl": _manual_number(row.get("unrealized_profit")),
        })

    if open_positions:
        options = current_nifty_options()
        lot_sizes = options.set_index("symbol")["lot_size"].to_dict()
        for position in open_positions:
            position["lot_size"] = int(lot_sizes.get(position["symbol"], 0))

    orders = []
    for row in (orders_response.get("orderBook") or [])[-50:]:
        symbol = str(row.get("symbol", ""))
        if not (symbol.startswith("NSE:NIFTY") and symbol.endswith(("CE", "PE"))):
            continue
        orders.append({
            "id": str(row.get("id", "")),
            "symbol": symbol,
            "qty": int(_manual_number(row.get("qty"))),
            "side": int(_manual_number(row.get("side"))),
            "type": int(_manual_number(row.get("type"))),
            "status": int(_manual_number(row.get("status"))),
            "limit_price": _manual_number(row.get("limitPrice")),
            "traded_price": _manual_number(row.get("tradedPrice")),
            "filled_qty": int(_manual_number(row.get("filledQty"))),
            "time": str(row.get("orderDateTime", "")),
        })

    overall = positions_response.get("overall") or {}
    now = datetime.now(IST)
    return {
        "updated_at": now.isoformat(timespec="seconds"),
        "order_window_open": is_market_weekday(now) and datetime.strptime("09:15", "%H:%M").time() <= now.time() <= datetime.strptime("15:30", "%H:%M").time(),
        "kill_switch": STOP_FILE.exists(),
        "account_pnl": {
            "realized": _manual_number(overall.get("pl_realized")),
            "unrealized": _manual_number(overall.get("pl_unrealized")),
            "total": _manual_number(overall.get("pl_total")),
        },
        "positions": open_positions,
        "orders": orders,
    }


def submit_manual_order(body: dict) -> dict:
    if body.get("confirm") not in ("PLACE LIVE ORDER", "CONFIRM", "YES"):
        raise ManualTradeError("Please confirm your order submission.")

    action = str(body.get("action", "")).upper()
    order_kind = str(body.get("order_type", "")).upper()
    if action not in ("BUY", "SELL") or order_kind not in ("MARKET", "LIMIT"):
        raise ManualTradeError("Choose Buy or Sell and Market or Limit.")
    try:
        lots = int(body.get("lots"))
    except (TypeError, ValueError):
        raise ManualTradeError("Lots must be a whole number.") from None
    if lots < 1 or lots > int(PAPER_LOTS):
        raise ManualTradeError(f"Lots must be between 1 and {int(PAPER_LOTS)}.")

    if STOP_FILE.exists() and action == "BUY":
        raise ManualTradeError("Kill switch is on; new manual buys are blocked.", 409)

    from broker import get_active_broker
    broker = get_active_broker()

    index_sym = str(body.get("index_symbol", "NIFTY")).upper()
    if action == "BUY":
        contract = _manual_contract(body.get("expiry", ""), body.get("strike"), body.get("option_type", ""), index_symbol=index_sym)
        quantity = lots * contract["lot_size"]
    else:
        symbol = str(body.get("symbol", ""))
        default_lot = 20 if "SENSEX" in symbol.upper() else 65
        contract = {"symbol": symbol, "lot_size": int(body.get("lot_size", default_lot)), "index_symbol": "SENSEX" if "SENSEX" in symbol.upper() else "NIFTY"}
        quantity = int(body.get("qty", lots * contract["lot_size"]))

    if broker == "KOTAK_NEO":
        from kotak_orders import place_kotak_order
        raw_symbol = contract["symbol"].replace("NSE:", "").replace("BSE:", "").strip()
        side_val = 1 if action == "BUY" else -1
        product = str(body.get("product", "MIS"))
        ex_seg = "bse_fo" if ("SENSEX" in raw_symbol.upper() or contract.get("index_symbol") == "SENSEX") else "nse_fo"
        try:
            order_id, fill_price = place_kotak_order(symbol=raw_symbol, qty=quantity, side=side_val, product=product, exchange_segment=ex_seg)
            return {
                "ok": True,
                "order_id": order_id,
                "symbol": raw_symbol,
                "qty": quantity,
                "action": action,
                "order_type": order_kind,
                "fill_price": fill_price,
                "broker": "KOTAK_NEO",
            }
        except Exception as exc:
            raise ManualTradeError(f"Kotak Neo order failed: {exc}", 502)
    else:
        quantity = lots * contract["lot_size"]
        limit_price = 0.0
        if order_kind == "LIMIT":
            limit_price = _manual_number(body.get("limit_price"), -1)
            if limit_price <= 0 or abs(limit_price * 20 - round(limit_price * 20)) > 1e-6:
                raise ManualTradeError("Enter a positive limit price in ₹0.05 increments.")

        client = manual_fyers_client()
        response = client.place_order(data={
            "symbol": contract["symbol"],
            "qty": quantity,
            "type": 2 if order_kind == "MARKET" else 1,
            "side": 1 if action == "BUY" else -1,
            "productType": "INTRADAY",
            "limitPrice": limit_price,
            "stopPrice": 0,
            "validity": "DAY",
            "disclosedQty": 0,
            "offlineOrder": False,
        })
        if response.get("s") != "ok":
            raise ManualTradeError(f"Fyers rejected the order: {response.get('message', 'unknown error')}", 502)
        return {"ok": True, "order_id": str(response.get("id", "")), "symbol": contract["symbol"], "qty": quantity, "action": action, "order_type": order_kind, "broker": "FYERS"}


def exit_position(body: dict) -> dict:
    from broker import get_active_broker
    broker = get_active_broker()
    symbol = str(body.get("symbol", "")).strip()
    qty = int(body.get("qty", 0))
    if not symbol or qty <= 0:
        raise ManualTradeError("Invalid position symbol or quantity to exit.")

    if broker == "KOTAK_NEO":
        from kotak_orders import get_kotak_client, kotak_token_status
        client = get_kotak_client()
        if not client or not kotak_token_status().get("valid"):
            raise ManualTradeError("Kotak Neo session is expired or missing. Please re-authenticate.")

        clean_sym = symbol.replace("NSE:", "").replace("BSE:", "").strip()
        matched_pos = None
        try:
            pos_resp = client.positions()
            if isinstance(pos_resp, dict) and pos_resp.get("stat") == "ok":
                for r in pos_resp.get("data") or []:
                    trd_sym = str(r.get("trdSym", "")).strip()
                    if trd_sym == clean_sym or trd_sym == symbol:
                        matched_pos = r
                        break
        except Exception:
            pass

        if matched_pos:
            b_qty = int(matched_pos.get("flBuyQty", 0)) + int(matched_pos.get("cfBuyQty", 0))
            s_qty = int(matched_pos.get("flSellQty", 0)) + int(matched_pos.get("cfSellQty", 0))
            net_qty = b_qty - s_qty
            if net_qty == 0:
                raise ManualTradeError(f"Position {clean_sym} is already closed in Kotak Neo.")
            # If long (net_qty > 0), to exit we must SELL ('S')
            # If short (net_qty < 0), to exit we must BUY ('B')
            tt = "S" if net_qty > 0 else "B"
            prod = str(matched_pos.get("prod") or matched_pos.get("prodCode") or body.get("product") or "MIS")
            ex_seg = str(matched_pos.get("exSeg") or body.get("exchange") or ("bse_fo" if "SENSEX" in clean_sym else "nse_fo"))
            exit_qty = min(qty, abs(net_qty))
        else:
            prod = str(body.get("product") or "MIS")
            ex_seg = str(body.get("exchange") or ("bse_fo" if "SENSEX" in clean_sym else "nse_fo"))
            side_in = str(body.get("side", "")).upper()
            tt = "B" if side_in == "BUY" else "S"
            exit_qty = qty

        resp = client.place_order(
            exchange_segment=ex_seg,
            product=prod,
            price="0",
            order_type="MKT",
            quantity=str(exit_qty),
            validity="DAY",
            trading_symbol=clean_sym,
            transaction_type=tt,
            amo="NO",
        )
        if not isinstance(resp, dict) or resp.get("stat") == "Not_Ok" or resp.get("error"):
            err = resp.get("errMsg") or resp.get("message") or resp.get("error") if isinstance(resp, dict) else str(resp)
            raise ManualTradeError(f"Kotak exit failed: {err}")

        order_id = str(resp.get("nOrdNo") or resp.get("order_id") or resp.get("result", ""))
        if not order_id:
            raise ManualTradeError("Kotak Neo did not return an order ID for the exit order.")

        # Check order confirmation / rejection asynchronously with short polling (max ~2 seconds)
        for _ in range(5):
            time.sleep(0.4)
            try:
                hist = client.order_history(order_id=order_id)
                if isinstance(hist, dict):
                    inner = hist.get("data") or hist.get("result") or []
                    if isinstance(inner, dict):
                        inner = inner.get("data") or []
                    if isinstance(inner, list) and inner:
                        ord_info = inner[0] if isinstance(inner[0], dict) else {}
                        ord_st = str(ord_info.get("ordSt", "")).lower()
                        if ord_st in ("rejected", "rej", "cancelled", "can"):
                            rej_rsn = ord_info.get("rejRsn") or ord_info.get("ordUsrMsg") or "Order rejected by broker/RMS"
                            raise ManualTradeError(f"Kotak exit rejected: {rej_rsn}")
                        if ord_st in ("complete", "trd", "traded", "filled", "open"):
                            return {"ok": True, "symbol": clean_sym, "qty": exit_qty, "order_id": order_id, "status": ord_st}
            except ManualTradeError:
                raise
            except Exception:
                pass

        return {"ok": True, "symbol": clean_sym, "qty": exit_qty, "order_id": order_id}
    else:
        client = manual_fyers_client()
        side_in = str(body.get("side", "")).upper()
        fyers_side = 1 if side_in == "BUY" else -1
        fyers_sym = symbol if symbol.startswith("NSE:") else f"NSE:{symbol}"
        prod_type = str(body.get("product") or "INTRADAY")
        resp = client.place_order(data={
            "symbol": fyers_sym,
            "qty": qty,
            "type": 2,
            "side": fyers_side,
            "productType": prod_type,
            "limitPrice": 0,
            "stopPrice": 0,
            "validity": "DAY",
            "disclosedQty": 0,
            "offlineOrder": False,
        })
        if resp.get("s") != "ok":
            raise ManualTradeError(f"Fyers exit failed: {resp.get('message')}")
        return {"ok": True, "symbol": fyers_sym, "qty": qty, "order_id": resp.get("id")}


def exit_all_positions() -> dict:
    from broker import get_positions
    pos_data = get_positions()
    open_pos = pos_data.get("open_positions", [])
    if not open_pos:
        return {"ok": True, "message": "No open positions to exit.", "closed_count": 0, "failed_count": 0}

    results = []
    errors = []
    for p in open_pos:
        sym = p.get("symbol", "")
        qty = abs(p.get("net_qty", 0))
        prod = p.get("product", "MIS")
        ex = p.get("exchange", "nse_fo")
        side = "BUY" if (p.get("net_qty", 0) < 0) else "SELL"
        try:
            res = exit_position({"symbol": sym, "qty": qty, "product": prod, "exchange": ex, "side": side})
            results.append({"symbol": sym, "qty": qty, "status": "success", "order_id": res.get("order_id")})
        except Exception as exc:
            errors.append({"symbol": sym, "error": str(exc)})

    if errors and not results:
        raise ManualTradeError(f"Exit all failed: {errors[0]['error']}")

    return {
        "ok": True,
        "closed_count": len(results),
        "failed_count": len(errors),
        "details": results,
        "errors": errors,
    }


def update_settings(body: dict) -> tuple:
    cfg = read_config()
    for key, value in body.items():
        if key in ("live_trading", "midpoint_live_trading"):
            if not isinstance(value, bool):
                return {"error": f"{key} must be true/false"}, 400
            if value and body.get("confirm") != "LIVE":
                return {"error": "type LIVE to confirm Midpoint real-money trading"}, 400
            cfg["midpoint_live_trading"] = value
            cfg["live_trading"] = value
        elif key in ("hero_zero_live_trading", "key_levels_live_trading", "scalper_live_trading", "hourly_trend_live_trading"):
            label = "HeroZero" if key == "hero_zero_live_trading" else "Key Levels" if key == "key_levels_live_trading" else "Micro Scalper" if key == "scalper_live_trading" else "Hourly Trend"
            if not isinstance(value, bool):
                return {"error": f"{key} must be true/false"}, 400
            if value and body.get("confirm") != "LIVE":
                return {"error": f"type LIVE to confirm {label} real-money trading"}, 400
            cfg[key] = value
        elif key == "broker":
            b = str(value).strip().upper()
            if b not in ("FYERS", "KOTAK_NEO"):
                return {"error": "broker must be FYERS or KOTAK_NEO"}, 400
            cfg["broker"] = b
        elif key.startswith("kotak_"):
            field = key.replace("kotak_", "")
            if "kotak_neo" not in cfg or not isinstance(cfg["kotak_neo"], dict):
                cfg["kotak_neo"] = {}
            if value is not None and str(value).strip() != "":
                cfg["kotak_neo"][field] = str(value).strip()
        elif key in EDITABLE_SETTINGS:
            kind, lo, hi = EDITABLE_SETTINGS[key]
            if kind is bool:
                if not isinstance(value, bool):
                    return {"error": f"{key} must be true/false"}, 400
            elif kind is int:
                if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
                    return {"error": f"{key} must be an integer between {lo} and {hi}"}, 400
            elif kind is float:
                try:
                    fval = float(value)
                    if not lo <= fval <= hi:
                        return {"error": f"{key} must be between {lo} and {hi}"}, 400
                    value = fval
                except (ValueError, TypeError):
                    return {"error": f"{key} must be a valid number"}, 400
            cfg[key] = value
        elif key != "confirm":
            return {"error": f"unknown setting: {key}"}, 400
    tmp = CONFIG_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(CONFIG_FILE)
    out = public_settings()
    out["restart_required"] = out["capture_running"] or bool(_process_pids_by_pattern("kotak_hero_zero_capture.py"))
    return out, 200


def port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex((host, port)) != 0


def start_login() -> dict:
    """Start the 8080 callback listener (fyers_daily_login auto) and return the Fyers login URL."""
    from fyers_daily_login import build_session, load_config

    cfg = load_config(CONFIG_FILE)
    redirect = urlparse(cfg["redirect_uri"])
    host, port = redirect.hostname or "127.0.0.1", redirect.port or 80
    proc = _login_proc["proc"]
    listener = "already running"
    if (proc is None or proc.poll() is not None) and port_free(host, port):
        _login_proc["proc"] = subprocess.Popen(
            [sys.executable, str(ROOT / "fyers_daily_login.py"), "auto", "--timeout", "600"],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "BROWSER": "true"},  # UI opens the URL, not the script
        )
        listener = "started"
    return {"login_url": build_session(cfg).generate_authcode(), "listener": listener}


def forming_candle(date: str, last_closed: str, symbol: str = "NIFTY") -> dict:
    """Current minute's candle built from the 1-second file."""
    sym = str(symbol or "NIFTY").strip().upper()
    prefix = "sensex" if sym == "SENSEX" else "nifty"
    path = LIVE_DIR / f"{prefix}_1s_{date}.csv"
    if not path.exists():
        return {}
    lines = path.read_text(encoding="utf-8").strip().splitlines()[-90:]
    rows = [ln.split(",") for ln in lines if ln and not ln.startswith("timestamp")]
    if not rows:
        return {}
    minute = rows[-1][0][11:16]
    if last_closed and minute <= last_closed:
        return {}
    prices = [float(r[1]) for r in rows if r[0][11:16] == minute]
    return {"time": minute, "open": prices[0], "high": max(prices), "low": min(prices), "close": prices[-1]}


def forming_five_minute_candle(date: str, minute_candles: pd.DataFrame) -> tuple[dict | None, float | None]:
    """Aggregate closed one-minute bars and the current feed minute into the live five-minute bar."""
    if date != today():
        return None, None
    last_closed = minute_candles.iloc[-1]["timestamp"].strftime("%H:%M") if not minute_candles.empty else ""
    live_minute = forming_candle(date, last_closed)
    if not live_minute:
        return None, None

    minute_time = pd.Timestamp(f"{date} {live_minute['time']}:00")
    bucket_start = minute_time.floor("5min")
    bucket_end = bucket_start + pd.Timedelta(minutes=5)
    completed = minute_candles[
        (minute_candles["timestamp"] >= bucket_start)
        & (minute_candles["timestamp"] < bucket_end)
    ]
    highs = completed["high"].astype(float).tolist() + [float(live_minute["high"])]
    lows = completed["low"].astype(float).tolist() + [float(live_minute["low"])]
    opening = float(completed.iloc[0]["open"]) if not completed.empty else float(live_minute["open"])
    current_price = float(live_minute["close"])
    return {
        "time": bucket_start.strftime("%H:%M"),
        "open": opening,
        "high": max(highs),
        "low": min(lows),
        "close": current_price,
    }, current_price


def current_rule_trades(df: pd.DataFrame, symbol: str = "NIFTY") -> list:
    if df.empty:
        return []
    sym = symbol.upper()
    t = backtest_midpoint_strategy(df)
    if t.empty:
        return []
    trades = []
    for r in t.itertuples():
        entry_p = round(r.entry, 2)
        sl_p = round(r.stop, 2)
        tgt_p = round(r.target, 2)
        pnl = round(r.pnl_points, 2)
        if sym == "SENSEX":
            if r.side == "LONG":
                sl_p = round(max(r.entry - 60.0, r.stop), 2)
                tgt_p = round(r.entry + 150.0, 2)
            else:
                sl_p = round(min(r.entry + 60.0, r.stop), 2)
                tgt_p = round(r.entry - 150.0, 2)
        trades.append({
            "side": "CALL" if r.side == "LONG" else "PUT",
            "entry": pd.Timestamp(r.entry_time).strftime("%H:%M"),
            "entry_price": entry_p,
            "sl": sl_p,
            "target": tgt_p,
            "exit": pd.Timestamp(r.exit_time).strftime("%H:%M"),
            "exit_price": round(r.exit_price, 2),
            "reason": r.reason,
            "pnl_points": pnl,
        })
    return trades


def active_key_level_zone(df: pd.DataFrame, replay_trades: list | None = None, settings: dict | None = None) -> dict | None:
    cfg = settings or key_level_settings(read_config())
    step = int(cfg.get("key_level_step", 500))
    buffer = int(cfg.get("key_level_break_buffer", 10))
    if replay_trades:
        return {"level": float(replay_trades[0]["level"]), "buffer": buffer}
    if df.empty:
        return None
    session_low = float(df["low"].min())
    session_high = float(df["high"].max())
    last_close = float(df["close"].iloc[-1])
    low_level = int(math.floor(session_low / step)) * step
    high_level = int(math.ceil(session_high / step)) * step
    candidates = list(range(low_level, high_level + step, step))
    if not candidates:
        return None
    level = min(
        candidates,
        key=lambda lvl: (max(session_low - lvl, 0.0, lvl - session_high), abs(last_close - lvl)),
    )
    return {"level": float(level), "buffer": buffer}


def setup_info(df: pd.DataFrame) -> dict:
    if df.empty:
        return {}
    s = day_setup(df, list(df.index))
    out = {"so_far_high": float(df["high"].max()), "so_far_low": float(df["low"].min())}
    session_low = float(df["low"].min())
    session_high = float(df["high"].max())
    first_open = float(df["open"].iloc[0])
    level_start = int(math.floor((session_low - 10) / 500)) * 500
    level_end = int(math.ceil((session_high + 10) / 500)) * 500
    level_prices = list(range(level_start, level_end + 500, 500))
    level_distances = {
        level: max(session_low - level, 0.0, level - session_high)
        for level in level_prices
    }
    out["key_levels"] = [
        {"price": level, "distance": round(level_distances[level], 2), "nearby": True}
        for level in level_prices
    ]
    out["key_level_zone"] = active_key_level_zone(df)
    nearby_levels = [level for level in level_prices if level_distances[level] <= 10]
    breaks = []
    for idx in range(min(len(df), 3)):
        row = df.iloc[idx]
        previous_close = float(df["close"].iloc[idx - 1]) if idx else first_open
        close = float(row["close"])
        for level in nearby_levels:
            side = "CALL" if previous_close <= level < close else "PUT" if previous_close >= level > close else None
            if side:
                next_close = float(df["close"].iloc[idx + 1]) if idx + 1 < len(df) else None
                confirmed = next_close is not None and (next_close >= level if side == "CALL" else next_close <= level)
                breaks.append({
                    "time": row["timestamp"].strftime("%H:%M"),
                    "price": level,
                    "side": side,
                    "confirmed": confirmed,
                    "distance": round(level_distances[level], 2),
                })
    out["key_breaks"] = breaks
    if s:
        out.update({
            "range_high": s["ref_high"],
            "range_low": s["ref_low"],
            "mid": s["mid"],
            "buffer": MIDPOINT_BUFFER_POINTS,
            "range_fixed_at": df.loc[s["range_fixed_idx"], "timestamp"].strftime("%H:%M"),
        })
    w = pending_entry(df)
    if w:
        out["armed"] = {
            "side": "CALL" if w["side"] == "LONG" else "PUT",
            "candle": w["candle_time"].strftime("%H:%M"),
            "level": w["level"],
            "stop": w["stop"],
        }
    return out


def status() -> dict:
    cfg = read_config()
    live_orders = read_csv_rows(LIVE_DIR / f"live_orders_{today()}.csv")
    auto_live_started = any(row.get("mode") == "LIVE" for row in live_orders)
    secs = LIVE_DIR / f"nifty_1s_{today()}.csv"
    mins = LIVE_DIR / f"nifty_1min_{today()}.csv"
    s_time, s_ltp = None, None
    if secs.exists():
        lines = secs.read_text(encoding="utf-8").strip().splitlines()
        if len(lines) > 1:
            ts, ltp, _ = lines[-1].split(",")
            s_time, s_ltp = ts[11:], float(ltp)
    m_time, m_ltp = None, None
    if mins.exists():
        lines = mins.read_text(encoding="utf-8").strip().splitlines()
        if len(lines) > 1:
            parts = lines[-1].split(",")
            m_time, m_ltp = parts[0][11:16], float(parts[4])

    # Check latest quotes cache from Kotak/Fyers for change and prev_close
    quotes_file = LIVE_DIR / f"quotes_{today()}.json"
    q_data = {}
    if quotes_file.exists():
        try:
            q_data = json.loads(quotes_file.read_text(encoding="utf-8"))
        except Exception:
            pass
    nifty_q = q_data.get("nifty", {})
    sensex_q = q_data.get("sensex", {})

    last_tick = {
        "time": nifty_q.get("time", s_time or m_time),
        "ltp": nifty_q.get("ltp", s_ltp or m_ltp),
        "change": nifty_q.get("change"),
        "per_change": nifty_q.get("per_change"),
        "prev_close": nifty_q.get("prev_close"),
    } if (nifty_q.get("ltp") or s_ltp or m_ltp) else None

    # Sensex tick
    s_secs = LIVE_DIR / f"sensex_1s_{today()}.csv"
    s_mins = LIVE_DIR / f"sensex_1min_{today()}.csv"
    sx_time, sx_ltp = None, None
    if s_secs.exists():
        lines = s_secs.read_text(encoding="utf-8").strip().splitlines()
        if len(lines) > 1:
            ts, ltp, _ = lines[-1].split(",")
            sx_time, sx_ltp = ts[11:], float(ltp)
    if not sx_ltp and s_mins.exists():
        lines = s_mins.read_text(encoding="utf-8").strip().splitlines()
        if len(lines) > 1:
            parts = lines[-1].split(",")
            sx_time, sx_ltp = parts[0][11:16], float(parts[4])
    sensex_last_tick = {
        "time": sensex_q.get("time", sx_time),
        "ltp": sensex_q.get("ltp", sx_ltp),
        "change": sensex_q.get("change"),
        "per_change": sensex_q.get("per_change"),
        "prev_close": sensex_q.get("prev_close"),
    } if (sensex_q.get("ltp") or sx_ltp) else None

    from broker import get_active_broker, get_all_broker_status
    active_broker = get_active_broker()
    return {
        "now": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        "market_open_day": is_market_weekday(),
        "token": token_status(),
        "broker": active_broker,
        "broker_status": get_all_broker_status(),
        "capture_running": capture_running(),
        "mode": "LIVE" if cfg.get("midpoint_live_trading", cfg.get("live_trading")) or cfg.get("hero_zero_live_trading") or cfg.get("key_levels_live_trading") or cfg.get("scalper_live_trading") or auto_live_started else "PAPER",
        "lots": int(cfg.get("lots", PAPER_LOTS)) if cfg.get("midpoint_live_trading", cfg.get("live_trading")) or auto_live_started else PAPER_LOTS,
        "daily_loss_limit": cfg.get("daily_loss_limit"),
        "kill_switch": STOP_FILE.exists(),
        "last_tick": last_tick,
        "sensex_last_tick": sensex_last_tick,
        "scalper": scalper_status(),
    }


def option_trades(date: str | None = None) -> list:
    """One row per option trade (BUY paired with the next SELL), optionally for one date."""
    out = []
    paths = [LIVE_DIR / f"live_orders_{date}.csv"] if date else sorted(LIVE_DIR.glob("live_orders_*.csv"))
    for path in paths:
        if not path.exists():
            continue
        date = path.stem.replace("live_orders_", "")
        open_buy = None
        for r in read_csv_rows(path):
            if r["action"] == "BUY":
                open_buy = r
                continue
            if r["action"] != "SELL" or not open_buy:
                continue
            qty = int(open_buy["qty"])
            buy_px, sell_px = float(open_buy["fill_price"] or 0), float(r["fill_price"] or 0)
            idx_in, idx_out = float(open_buy["index_price"] or 0), float(r["index_price"] or 0)
            side = "CALL" if open_buy["symbol"].endswith("CE") else "PUT"
            out.append({
                "date": date,
                "side": side,
                "option": f"{open_buy['symbol'][-7:-2]} {open_buy['symbol'][-2:]}",
                "qty": qty,
                "entry": open_buy["time"][:5],
                "nifty_in": idx_in,
                "buy_price": buy_px,
                "buy_value_rs": round(buy_px * qty, 2),
                "exit": r["time"][:5],
                "nifty_out": idx_out,
                "sell_price": sell_px,
                "sell_value_rs": round(sell_px * qty, 2),
                "pnl_rs": round((sell_px - buy_px) * qty, 2),
                "nifty_points": round(idx_out - idx_in if side == "CALL" else idx_in - idx_out, 2),
                "exit_reason": r["reason"],
                "mode": r["mode"],
            })
            open_buy = None
    return out


def option_paper_fill(trade: dict, strategy: str) -> dict:
    side = trade["side"]
    spot_points = trade["exit_spot"] - trade["spot_entry"] if side == "CALL" else trade["spot_entry"] - trade["exit_spot"]
    if strategy == "key_levels":
        mode = "KEYLEVEL HISTORICAL PAPER REPLAY" if trade.get("source") == "historical_option_replay" else "KEYLEVEL PAPER"
        label = "Key Levels"
    else:
        mode = "MIDPOINT PAPER SIMULATION"
        label = "Midpoint"
    return {
        "date": trade["date"],
        "side": side,
        "option": trade["symbol"],
        "qty": trade["qty"],
        "entry": trade["entry_time"][:5],
        "nifty_in": trade["spot_entry"],
        "buy_price": trade["option_entry"],
        "buy_value_rs": round(trade["capital_used"], 2),
        "exit": trade["exit_time"][:5],
        "nifty_out": trade["exit_spot"],
        "sell_price": trade["exit_option"],
        "sell_value_rs": round(trade["exit_option"] * trade["qty"], 2),
        "pnl_rs": trade["pnl_rs"],
        "nifty_points": round(spot_points, 2),
        "exit_reason": trade["reason"],
        "mode": mode,
        "spot_at_entry": trade["spot_entry"],
        "level": trade["level"] if strategy == "key_levels" else None,
        "trigger_label": f"{label} · {trade.get('source') or 'paper'}",
    }


def read_ledger_paper_trades(date: str | None = None) -> list:
    out = []
    if not PAPER_TRADES_CSV.exists():
        return out
    for r in read_csv_rows(PAPER_TRADES_CSV):
        r_date = r.get("date", "")
        if date and r_date != date:
            continue
        try:
            entry_spot = float(r.get("entry_price") or 0)
            exit_spot = float(r.get("exit_price") or 0)
            points = float(r.get("points") or 0)
            lots = int(float(r.get("lots") or 2))
            rupees = float(r.get("rupees") or 0)
            side = r.get("side", "CALL").upper()
            qty = lots * 65
            atm_strike = int(round(entry_spot / 50.0) * 50)
            opt_symbol = f"{atm_strike} {'CE' if side == 'CALL' else 'PE'}"
            est_buy_px = 130.0
            pts_gain = (rupees / qty) if qty > 0 else 0.0
            est_sell_px = round(est_buy_px + pts_gain, 2)
            out.append({
                "date": r_date,
                "side": side,
                "option": opt_symbol,
                "qty": qty,
                "entry": str(r.get("entry_time", ""))[:5],
                "nifty_in": entry_spot,
                "buy_price": est_buy_px,
                "buy_value_rs": round(est_buy_px * qty, 2),
                "exit": str(r.get("exit_time", ""))[:5],
                "nifty_out": exit_spot,
                "sell_price": est_sell_px,
                "sell_value_rs": round(est_sell_px * qty, 2),
                "pnl_rs": rupees,
                "nifty_points": points,
                "exit_reason": r.get("exit_reason", ""),
                "mode": "PAPER",
            })
        except Exception:
            continue
    return out


def midpoint_option_trades(date: str | None = None) -> list:
    """Use actual Midpoint fills where available; otherwise include closed quote simulations and paper ledger."""
    actual = option_trades(date)
    actual_keys = {(trade["date"], trade["side"], trade["entry"]) for trade in actual}
    paper = [
        trade for trade in read_option_paper_trades(OPTION_PAPER_EVENT_FILE)
        if trade["strategy"] == "midpoint" and trade["status"] == "closed"
        and (date is None or trade["date"] == date)
    ]
    fallback = [
        option_paper_fill(trade, "midpoint") for trade in paper
        if (trade["date"], trade["side"], trade["entry_time"][:5]) not in actual_keys
    ]
    seen_keys = actual_keys.union({(t["date"], t["side"], t["entry"]) for t in fallback})
    ledger_trades = [
        t for t in read_ledger_paper_trades(date)
        if (t["date"], t["side"], t["entry"]) not in seen_keys
    ]
    return actual + fallback + ledger_trades


def key_level_option_trades(date: str | None = None) -> list:
    """Closed Key Levels paper/replay entries in the shared option-fill shape."""
    out = []
    for trade in read_option_paper_trades(OPTION_PAPER_EVENT_FILE):
        if trade["strategy"] != "key_levels" or trade["status"] != "closed" or (date and trade["date"] != date):
            continue
        out.append(option_paper_fill(trade, "key_levels"))
    return out


def key_level_option_paper_rows(date: str | None = None) -> list:
    trades = [trade for trade in read_option_paper_trades(OPTION_PAPER_EVENT_FILE) if trade["strategy"] == "key_levels"]
    if date:
        trades = [trade for trade in trades if trade["date"] == date]
    return _option_paper_book(trades)["trades"]


def paper_trades_for_day(date: str) -> tuple[list, str | None]:
    rows = read_csv_rows(PAPER_TRADES_CSV)
    first_date = min((row.get("date", "") for row in rows if row.get("date")), default=None)
    return [row for row in rows if row.get("date") == date], first_date


def est_charges(buy_value: float, sell_value: float) -> float:
    """Approximate option-buy round-trip costs. Zero brokerage for Kotak Neo, Rs 40 for Fyers."""
    cfg = read_config()
    is_zero_brokerage = cfg.get("active_broker") == "KOTAK_NEO" or cfg.get("broker") == "KOTAK_NEO"
    brokerage = 0.0 if is_zero_brokerage else 40.0
    stt = 0.001 * sell_value
    txn = 0.0003503 * (buy_value + sell_value)
    sebi = 0.000001 * (buy_value + sell_value)
    stamp = 0.00003 * buy_value
    gst = 0.18 * (brokerage + txn + sebi)
    return round(brokerage + stt + txn + sebi + stamp + gst, 2)


def compression_scalp_live_paper_trades(date: str | None = None) -> list:
    """Live-market paper option trades for Micro-Compression Scalper."""
    out = []
    live_paper_file = LIVE_DIR / "scalper_live_paper.csv"
    if not live_paper_file.exists():
        return out

    cfg = read_config()
    lots = max(1, int(cfg.get("scalper_lots", 1)))
    lot_size = 65
    qty = lots * lot_size

    for row in read_csv_rows(live_paper_file):
        r_date = row.get("date", "")
        if date and r_date != date:
            continue
        try:
            side = "CALL" if row.get("side") in ("LONG", "CALL") else "PUT"
            entry_spot = float(row.get("entry_price") or row.get("nifty_in") or 0.0)
            exit_spot = float(row.get("exit_price") or row.get("nifty_out") or 0.0)
            pnl_pts = float(row.get("pnl_points") or row.get("nifty_points") or 0.0)
            strike = int(round(entry_spot / 50.0) * 50)
            opt_name = row.get("option") or f"NIFTY {strike} {'CE' if side == 'CALL' else 'PE'}"
            buy_px = float(row.get("buy_price") or 105.0)
            sell_px = float(row.get("sell_price") or (buy_px + pnl_pts * 0.5))
            buy_val = round(buy_px * qty, 2)
            sell_val = round(sell_px * qty, 2)
            pnl_rs = round(float(row.get("pnl_rs") or (sell_val - buy_val)), 2)
            charges = float(row.get("charges_rs") or est_charges(buy_val, sell_val))
            net_rs = float(row.get("net_rs") or (pnl_rs - charges))

            sl_pts = float(cfg.get("scalper_sl_pts", 9.0))
            tgt_pts = float(cfg.get("scalper_target_pts", 25.0))
            sl_spot = float(row.get("sl") or round(entry_spot - sl_pts if side == "CALL" else entry_spot + sl_pts, 2))
            tgt_spot = float(row.get("target") or round(entry_spot + tgt_pts if side == "CALL" else entry_spot - tgt_pts, 2))

            out.append({
                "date": r_date,
                "side": side,
                "option": opt_name,
                "qty": qty,
                "entry": str(row.get("entry_time") or row.get("entry", ""))[:5],
                "nifty_in": entry_spot,
                "buy_price": buy_px,
                "buy_value_rs": buy_val,
                "exit": str(row.get("exit_time") or row.get("exit", ""))[:5],
                "nifty_out": exit_spot,
                "sell_price": sell_px,
                "sell_value_rs": sell_val,
                "pnl_rs": pnl_rs,
                "nifty_points": pnl_pts,
                "exit_reason": row.get("exit_reason", ""),
                "mode": "MICRO SCALPER PAPER",
                "spot_at_entry": entry_spot,
                "trigger_label": "Micro Scalp · paper",
                "sl": sl_spot,
                "target": tgt_spot,
                "charges_rs": charges,
                "net_rs": net_rs,
            })
        except Exception:
            continue
    return out


def compression_scalp_report() -> dict:
    """Live-market paper report (empty until live market session executes)."""
    return build_paper_report(compression_scalp_live_paper_trades())


def trend_runner_live_paper_trades(date: str | None = None) -> list:
    """Live/forward paper trades for Trend Expansion (VIX Runner)."""
    csv_path = ROOT / "performance" / "trend_runner_paper_trades.csv"
    if not csv_path.exists():
        return []
    qty = 25
    out = []
    for row in read_csv_rows(csv_path):
        r_date = str(row.get("date", ""))
        if date and r_date != date:
            continue
        try:
            side = "CALL" if row.get("side") in ("LONG", "CALL") else "PUT"
            entry_spot = float(row.get("entry_price") or 0.0)
            exit_spot = float(row.get("exit_price") or 0.0)
            pnl_pts = float(row.get("pnl_points") or 0.0)
            strike = int(round(entry_spot / 50.0) * 50)
            opt_name = row.get("option") or f"NIFTY {strike} {'CE' if side == 'CALL' else 'PE'}"
            buy_px = 120.0  # Estimated ATM entry premium
            sell_px = max(1.0, buy_px + pnl_pts * 0.55)  # 0.55 delta
            buy_val = round(buy_px * qty, 2)
            sell_val = round(sell_px * qty, 2)
            pnl_rs = float(row.get("pnl_rupees") or round((sell_val - buy_val), 2))
            charges = est_charges(buy_val, sell_val)
            net_rs = round(pnl_rs - charges, 2)
            init_sl = float(row.get("initial_sl") or (entry_spot - 28.0 if side == "CALL" else entry_spot + 28.0))
            tgt_spot = round(entry_spot + 200.0 if side == "CALL" else entry_spot - 200.0, 2)

            out.append({
                "date": r_date,
                "side": side,
                "option": opt_name,
                "qty": qty,
                "entry": str(row.get("entry_time") or "")[:5],
                "nifty_in": entry_spot,
                "buy_price": buy_px,
                "buy_value_rs": buy_val,
                "exit": str(row.get("exit_time") or "")[:5],
                "nifty_out": exit_spot,
                "sell_price": sell_px,
                "sell_value_rs": sell_val,
                "pnl_rs": pnl_rs,
                "nifty_points": pnl_pts,
                "exit_reason": row.get("exit_reason", ""),
                "mode": "TREND CATCHER PAPER",
                "spot_at_entry": entry_spot,
                "trigger_label": "Trend Catcher · Paper",
                "sl": init_sl,
                "target": tgt_spot,
                "charges_rs": charges,
                "net_rs": net_rs,
            })
        except Exception:
            continue
    return out


def trend_runner_paper_report() -> dict:
    return build_paper_report(trend_runner_live_paper_trades())


def compression_scalp_spot_trades_for_day(date: str) -> list:
    """Historical spot trades for backtest chart display on date."""
    csv_path = ROOT / "performance" / "compression_scalp_trades.csv"
    if not csv_path.exists():
        return []
    cfg = read_config()
    sl_pts = float(cfg.get("scalper_sl_pts", 9.0))
    tgt_pts = float(cfg.get("scalper_target_pts", 25.0))
    out = []
    for r in read_csv_rows(csv_path):
        if r.get("date") == date:
            side = "CALL" if r.get("side") == "LONG" else "PUT"
            entry_spot = float(r.get("entry_price") or 0.0)
            exit_spot = float(r.get("exit_price") or 0.0)
            sl_spot = round(entry_spot - sl_pts if side == "CALL" else entry_spot + sl_pts, 2)
            tgt_spot = round(entry_spot + tgt_pts if side == "CALL" else entry_spot - tgt_pts, 2)
            out.append({
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": str(r.get("exit_reason", "")),
                "pnl_points": float(r.get("pnl_points") or 0.0),
            })
    return out


def compression_scalp_backtest_report() -> dict:
    """Historical backtest performance over master archive for Sniper / Micro Scalper."""
    csv_path = ROOT / "performance" / "compression_scalp_trades.csv"
    if not csv_path.exists():
        return {"summary": {}, "trades": [], "monthly": [], "daily": [], "exit_reasons": []}

    cfg = read_config()
    sl_pts = float(cfg.get("scalper_sl_pts", 9.0))
    tgt_pts = float(cfg.get("scalper_target_pts", 25.0))
    lot_size = 65

    raw_trades = read_csv_rows(csv_path)
    trades, equity, peak = [], 0.0, 0.0
    daily_map = {}
    monthly_map = {}
    reasons_map = {}

    for r in raw_trades:
        try:
            r_date = str(r.get("date", ""))
            side = "CALL" if r.get("side") == "LONG" else "PUT"
            entry_spot = round(float(r.get("entry_price") or 0.0), 2)
            exit_spot = round(float(r.get("exit_price") or 0.0), 2)
            pnl_pts = round(float(r.get("pnl_points") or 0.0), 2)
            equity += pnl_pts
            peak = max(peak, equity)
            reason = str(r.get("exit_reason", ""))

            sl_spot = round(entry_spot - sl_pts if side == "CALL" else entry_spot + sl_pts, 2)
            tgt_spot = round(entry_spot + tgt_pts if side == "CALL" else entry_spot - tgt_pts, 2)

            trades.append({
                "date": r_date,
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": reason,
                "pnl_points": pnl_pts,
                "equity": round(equity, 2),
                "drawdown": round(equity - peak, 2),
            })

            d = daily_map.setdefault(r_date, {"date": r_date, "points": 0.0, "trades": 0})
            d["points"] = round(d["points"] + pnl_pts, 2)
            d["trades"] += 1

            m = r_date[:7]
            monthly_map[m] = round(monthly_map.get(m, 0.0) + pnl_pts, 2)

            reasons_map[reason] = reasons_map.get(reason, 0) + 1
        except Exception:
            continue

    n = len(trades)
    wins = sum(1 for x in trades if x["pnl_points"] > 0)
    sorted_daily = sorted(daily_map.values(), key=lambda x: x["date"])
    sorted_monthly = [{"month": m, "points": pts} for m, pts in sorted(monthly_map.items())]
    sorted_reasons = [{"reason": reason, "count": count} for reason, count in sorted(reasons_map.items(), key=lambda item: -item[1])]

    return {
        "summary": {
            "from": sorted_daily[0]["date"] if sorted_daily else "",
            "to": sorted_daily[-1]["date"] if sorted_daily else "",
            "days": len(sorted_daily),
            "trades": n,
            "wins": wins,
            "losses": sum(1 for x in trades if x["pnl_points"] < 0),
            "win_rate_pct": round(100.0 * wins / n, 2) if n else 0.0,
            "total_points": round(equity, 2),
            "avg_points": round(equity / n, 2) if n else 0.0,
            "max_drawdown": min((x["drawdown"] for x in trades), default=0.0),
            "best": max((x["pnl_points"] for x in trades), default=0.0),
            "worst": min((x["pnl_points"] for x in trades), default=0.0),
            "lot_size": lot_size,
        },
        "trades": trades,
        "daily": sorted_daily,
        "monthly": sorted_monthly,
        "exit_reasons": sorted_reasons,
    }


def mtf_orb_5y_backtest_report() -> dict:
    """Official 5-Year Backtest report for NIFTY Multi-Timeframe ORB & 1-Hour Trend (2021-2026)."""
    csv_path = ROOT / "performance" / "mtf_orb_5y_trades.csv"
    if not csv_path.exists():
        return {"summary": {}, "trades": [], "monthly": [], "daily": [], "exit_reasons": []}

    lot_size = 25
    raw_trades = read_csv_rows(csv_path)
    trades, equity, peak = [], 0.0, 0.0
    daily_map = {}
    monthly_map = {}
    reasons_map = {}

    for r in raw_trades:
        try:
            r_date = str(r.get("date", ""))
            side = str(r.get("side", ""))
            entry_spot = round(float(r.get("entry_spot") or 0.0), 2)
            exit_spot = round(float(r.get("exit_spot") or 0.0), 2)
            sl_spot = round(float(r.get("sl_spot") or 0.0), 2)
            tgt_spot = round(float(r.get("target_spot") or 0.0), 2)
            pnl_pts = round(float(r.get("pnl_points") or 0.0), 2)
            reason = str(r.get("reason", ""))

            equity += pnl_pts
            peak = max(peak, equity)

            trades.append({
                "date": r_date,
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": reason,
                "pnl_points": pnl_pts,
                "equity": round(equity, 2),
                "drawdown": round(equity - peak, 2),
            })

            d = daily_map.setdefault(r_date, {"date": r_date, "points": 0.0, "trades": 0})
            d["points"] = round(d["points"] + pnl_pts, 2)
            d["trades"] += 1

            m = r_date[:7]
            monthly_map[m] = round(monthly_map.get(m, 0.0) + pnl_pts, 2)

            reasons_map[reason] = reasons_map.get(reason, 0) + 1
        except Exception:
            continue

    n = len(trades)
    wins = sum(1 for x in trades if x["pnl_points"] > 0)
    sorted_daily = sorted(daily_map.values(), key=lambda x: x["date"])
    sorted_monthly = [{"month": m, "points": pts} for m, pts in sorted(monthly_map.items())]
    sorted_reasons = [{"reason": reason, "count": count} for reason, count in sorted(reasons_map.items(), key=lambda item: -item[1])]

    return {
        "summary": {
            "from": sorted_daily[0]["date"] if sorted_daily else "",
            "to": sorted_daily[-1]["date"] if sorted_daily else "",
            "days": len(sorted_daily),
            "trades": n,
            "wins": wins,
            "losses": sum(1 for x in trades if x["pnl_points"] < 0),
            "win_rate_pct": round(100.0 * wins / n, 2) if n else 0.0,
            "total_points": round(equity, 2),
            "avg_points": round(equity / n, 2) if n else 0.0,
            "max_drawdown": min((x["drawdown"] for x in trades), default=0.0),
            "best": max((x["pnl_points"] for x in trades), default=0.0),
            "worst": min((x["pnl_points"] for x in trades), default=0.0),
            "lot_size": lot_size,
        },
        "trades": trades,
        "daily": sorted_daily,
        "monthly": sorted_monthly,
        "exit_reasons": sorted_reasons,
    }


def sr_breakout_spot_trades_for_day(date: str) -> list:
    """Historical spot trades for S/R Breakout Strategy on date."""
    csv_path = ROOT / "performance" / "sr_breakout_trades.csv"
    if not csv_path.exists():
        return []
    out = []
    for r in read_csv_rows(csv_path):
        if r.get("date") == date:
            side = str(r.get("side", "CALL"))
            entry_spot = float(r.get("entry_price") or 0.0)
            exit_spot = float(r.get("exit_price") or 0.0)
            sl_spot = float(r.get("sl") or (entry_spot - 22.0 if side == "CALL" else entry_spot + 22.0))
            tgt_spot = float(r.get("target") or (entry_spot + 55.0 if side == "CALL" else entry_spot - 55.0))
            out.append({
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": str(r.get("exit_reason", "")),
                "pnl_points": float(r.get("pnl_points") or 0.0),
            })
    return out


def vix_trend_runner_spot_trades_for_day(date: str) -> list:
    """Historical spot trades for Nifty Trend Expansion Runner on date."""
    out = []
    for r in trend_runner_live_paper_trades(date):
        side = r.get("side", "CALL")
        entry_spot = float(r.get("nifty_in") or 0.0)
        exit_spot = float(r.get("nifty_out") or 0.0)
        sl_spot = float(r.get("sl") or (entry_spot - 28.0 if side == "CALL" else entry_spot + 28.0))
        tgt_spot = float(r.get("target") or (entry_spot + 200.0 if side == "CALL" else entry_spot - 200.0))
        out.append({
            "side": side,
            "entry": str(r.get("entry", ""))[:5],
            "entry_price": entry_spot,
            "sl": sl_spot,
            "target": tgt_spot,
            "exit": str(r.get("exit", ""))[:5],
            "exit_price": exit_spot,
            "reason": str(r.get("exit_reason", "")),
            "pnl_points": float(r.get("nifty_points") or 0.0),
        })
    if out:
        return out
    csv_path = ROOT / "performance" / "vix_trend_runner_trades.csv"
    if not csv_path.exists():
        return []
    out = []
    for r in read_csv_rows(csv_path):
        if r.get("date") == date:
            side = str(r.get("side", "CALL"))
            entry_spot = float(r.get("entry_price") or 0.0)
            exit_spot = float(r.get("exit_price") or 0.0)
            sl_spot = float(r.get("sl") or (entry_spot - 28.0 if side == "CALL" else entry_spot + 28.0))
            tgt_spot = float(r.get("target") or (entry_spot + 200.0 if side == "CALL" else entry_spot - 200.0))
            out.append({
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": str(r.get("exit_reason", "")),
                "pnl_points": float(r.get("pnl_points") or 0.0),
            })
    return out


def vix_trend_runner_backtest_report() -> dict:
    """Historical backtest performance over 738 days for Nifty Trend Expansion Runner (with India VIX confluence)."""
    csv_path = ROOT / "performance" / "vix_trend_runner_trades.csv"
    if not csv_path.exists():
        return {"summary": {}, "trades": [], "monthly": [], "daily": [], "exit_reasons": []}

    lot_size = 25  # Nifty lot size is 25

    raw_trades = read_csv_rows(csv_path)
    trades, equity, peak = [], 0.0, 0.0
    daily_map = {}
    monthly_map = {}
    reasons_map = {}

    for r in raw_trades:
        try:
            r_date = str(r.get("date", ""))
            side = str(r.get("side", "CALL"))
            entry_spot = round(float(r.get("entry_price") or 0.0), 2)
            exit_spot = round(float(r.get("exit_price") or 0.0), 2)
            pnl_pts = round(float(r.get("pnl_points") or 0.0), 2)
            equity += pnl_pts
            peak = max(peak, equity)
            reason = str(r.get("exit_reason", ""))

            sl_spot = round(float(r.get("sl") or (entry_spot - 28.0 if side == "CALL" else entry_spot + 28.0)), 2)
            tgt_spot = round(float(r.get("target") or (entry_spot + 200.0 if side == "CALL" else entry_spot - 200.0)), 2)

            trades.append({
                "date": r_date,
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": reason,
                "pnl_points": pnl_pts,
                "equity": round(equity, 2),
                "drawdown": round(equity - peak, 2),
            })

            d = daily_map.setdefault(r_date, {"date": r_date, "points": 0.0, "trades": 0})
            d["points"] = round(d["points"] + pnl_pts, 2)
            d["trades"] += 1

            m = r_date[:7]
            monthly_map[m] = round(monthly_map.get(m, 0.0) + pnl_pts, 2)

            reasons_map[reason] = reasons_map.get(reason, 0) + 1
        except Exception:
            continue

    n = len(trades)
    wins = sum(1 for x in trades if x["pnl_points"] > 0)
    sorted_daily = sorted(daily_map.values(), key=lambda x: x["date"])
    sorted_monthly = [{"month": m, "points": pts} for m, pts in sorted(monthly_map.items())]
    sorted_reasons = [{"reason": reason, "count": count} for reason, count in sorted(reasons_map.items(), key=lambda item: -item[1])]

    return {
        "summary": {
            "from": sorted_daily[0]["date"] if sorted_daily else "",
            "to": sorted_daily[-1]["date"] if sorted_daily else "",
            "days": len(sorted_daily),
            "trades": n,
            "wins": wins,
            "losses": sum(1 for x in trades if x["pnl_points"] < 0),
            "win_rate": round(100.0 * wins / n, 2) if n else 0.0,
            "win_rate_pct": round(100.0 * wins / n, 2) if n else 0.0,
            "total_points": round(equity, 2),
            "avg_points": round(equity / n, 2) if n else 0.0,
            "max_drawdown": min((x["drawdown"] for x in trades), default=0.0),
            "best": max((x["pnl_points"] for x in trades), default=0.0),
            "worst": min((x["pnl_points"] for x in trades), default=0.0),
            "lot_size": lot_size,
        },
        "trades": trades,
        "daily": sorted_daily,
        "monthly": sorted_monthly,
        "exit_reasons": sorted_reasons,
    }


def trend_runner_5y_backtest_report() -> dict:
    """Official 5-Year Backtest report for NIFTY Trend Runner (2021-2026, 1240 trading days)."""
    csv_path = ROOT / "performance" / "trend_runner_5y_trades.csv"
    if not csv_path.exists():
        return {"summary": {}, "trades": [], "monthly": [], "daily": [], "exit_reasons": []}

    lot_size = 25
    raw_trades = read_csv_rows(csv_path)
    trades, equity, peak = [], 0.0, 0.0
    daily_map = {}
    monthly_map = {}
    reasons_map = {}

    for r in raw_trades:
        try:
            r_date = str(r.get("date", ""))
            side = str(r.get("side", "CALL"))
            entry_spot = round(float(r.get("entry_price") or 0.0), 2)
            exit_spot = round(float(r.get("exit_price") or 0.0), 2)
            pnl_pts = round(float(r.get("pnl_points") or 0.0), 2)
            equity += pnl_pts
            peak = max(peak, equity)
            reason = str(r.get("exit_reason", ""))

            sl_spot = round(float(r.get("sl") or (entry_spot - 30.0 if side == "CALL" else entry_spot + 30.0)), 2)
            tgt_spot = round(float(r.get("target") or (entry_spot + 250.0 if side == "CALL" else entry_spot - 250.0)), 2)

            trades.append({
                "date": r_date,
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": reason,
                "pnl_points": pnl_pts,
                "equity": round(equity, 2),
                "drawdown": round(equity - peak, 2),
            })

            d = daily_map.setdefault(r_date, {"date": r_date, "points": 0.0, "trades": 0})
            d["points"] = round(d["points"] + pnl_pts, 2)
            d["trades"] += 1

            m = r_date[:7]
            monthly_map[m] = round(monthly_map.get(m, 0.0) + pnl_pts, 2)

            reasons_map[reason] = reasons_map.get(reason, 0) + 1
        except Exception:
            continue

    n = len(trades)
    wins = sum(1 for x in trades if x["pnl_points"] > 0)
    sorted_daily = sorted(daily_map.values(), key=lambda x: x["date"])
    sorted_monthly = [{"month": m, "points": pts} for m, pts in sorted(monthly_map.items())]
    sorted_reasons = [{"reason": reason, "count": count} for reason, count in sorted(reasons_map.items(), key=lambda item: -item[1])]

    return {
        "summary": {
            "from": sorted_daily[0]["date"] if sorted_daily else "",
            "to": sorted_daily[-1]["date"] if sorted_daily else "",
            "days": len(sorted_daily),
            "trades": n,
            "wins": wins,
            "losses": sum(1 for x in trades if x["pnl_points"] < 0),
            "win_rate": round(100.0 * wins / n, 2) if n else 0.0,
            "win_rate_pct": round(100.0 * wins / n, 2) if n else 0.0,
            "total_points": round(equity, 2),
            "avg_points": round(equity / n, 2) if n else 0.0,
            "max_drawdown": min((x["drawdown"] for x in trades), default=0.0),
            "best": max((x["pnl_points"] for x in trades), default=0.0),
            "worst": min((x["pnl_points"] for x in trades), default=0.0),
            "lot_size": lot_size,
        },
        "trades": trades,
        "daily": sorted_daily,
        "monthly": sorted_monthly,
        "exit_reasons": sorted_reasons,
    }


def sr_breakout_backtest_report() -> dict:
    """Historical backtest performance for Support & Resistance Breakout Run Strategy."""
    csv_path = ROOT / "performance" / "sr_breakout_trades.csv"
    if not csv_path.exists():
        return {"summary": {}, "trades": [], "monthly": [], "daily": [], "exit_reasons": []}

    lot_size = 25
    raw_trades = read_csv_rows(csv_path)
    trades, equity, peak = [], 0.0, 0.0
    daily_map = {}
    monthly_map = {}
    reasons_map = {}

    for r in raw_trades:
        try:
            r_date = str(r.get("date", ""))
            side = str(r.get("side", "CALL"))
            entry_spot = round(float(r.get("entry_price") or 0.0), 2)
            exit_spot = round(float(r.get("exit_price") or 0.0), 2)
            pnl_pts = round(float(r.get("pnl_points") or 0.0), 2)
            equity += pnl_pts
            peak = max(peak, equity)
            reason = str(r.get("exit_reason", ""))

            sl_spot = round(float(r.get("sl") or (entry_spot - 20.0 if side == "CALL" else entry_spot + 20.0)), 2)
            tgt_spot = round(float(r.get("target") or (entry_spot + 50.0 if side == "CALL" else entry_spot - 50.0)), 2)

            trades.append({
                "date": r_date,
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": reason,
                "pnl_points": pnl_pts,
                "equity": round(equity, 2),
                "drawdown": round(equity - peak, 2),
            })

            d = daily_map.setdefault(r_date, {"date": r_date, "points": 0.0, "trades": 0})
            d["points"] = round(d["points"] + pnl_pts, 2)
            d["trades"] += 1

            m = r_date[:7]
            monthly_map[m] = round(monthly_map.get(m, 0.0) + pnl_pts, 2)
            reasons_map[reason] = reasons_map.get(reason, 0) + 1
        except Exception:
            continue

    n = len(trades)
    wins = sum(1 for x in trades if x["pnl_points"] > 0)
    sorted_daily = sorted(daily_map.values(), key=lambda x: x["date"])
    sorted_monthly = [{"month": m, "points": pts} for m, pts in sorted(monthly_map.items())]
    sorted_reasons = [{"reason": reason, "count": count} for reason, count in sorted(reasons_map.items(), key=lambda item: -item[1])]

    return {
        "summary": {
            "from": sorted_daily[0]["date"] if sorted_daily else "",
            "to": sorted_daily[-1]["date"] if sorted_daily else "",
            "days": len(sorted_daily),
            "trades": n,
            "wins": wins,
            "losses": sum(1 for x in trades if x["pnl_points"] < 0),
            "win_rate_pct": round(100.0 * wins / n, 2) if n else 0.0,
            "total_points": round(equity, 2),
            "avg_points": round(equity / n, 2) if n else 0.0,
            "max_drawdown": min((x["drawdown"] for x in trades), default=0.0),
            "best": max((x["pnl_points"] for x in trades), default=0.0),
            "worst": min((x["pnl_points"] for x in trades), default=0.0),
            "lot_size": lot_size,
        },
        "trades": trades,
        "daily": sorted_daily,
        "monthly": sorted_monthly,
        "exit_reasons": sorted_reasons,
    }


def hourly_trend_option_trades(date: str | None = None) -> list:

    """Paper option trades for Institutional 1-Hour Trend Strategy."""
    out = []
    trades_path = Path(__file__).resolve().parent / "performance" / "hourly_trend_trades.csv"
    if not trades_path.exists():
        return out
    
    cfg = read_config()
    lots = max(1, int(cfg.get("hourly_trend_lots", 1)))
    lot_size = 65
    qty = lots * lot_size
    base_opt_price = 110.0
    for row in read_csv_rows(trades_path):
        r_date = row.get("date", "")
        if date and r_date != date:
            continue
        try:
            side = "CALL" if row.get("side") == "LONG" else "PUT"
            entry_spot = float(row.get("entry_price") or 0.0)
            exit_spot = float(row.get("exit_price") or 0.0)
            pnl_pts = float(row.get("pnl_points") or 0.0)
            strike = int(round(entry_spot / 50.0) * 50)
            opt_name = f"NIFTY {strike} {'CE' if side == 'CALL' else 'PE'}"
            
            # ATM Option Delta ~ 0.50
            opt_pts = pnl_pts * 0.50
            buy_px = base_opt_price
            sell_px = round(max(1.0, buy_px + opt_pts), 2)
            buy_val = round(buy_px * qty, 2)
            sell_val = round(sell_px * qty, 2)
            pnl_rs = round((sell_px - buy_px) * qty, 2)
            
            out.append({
                "date": r_date,
                "side": side,
                "option": opt_name,
                "qty": qty,
                "entry": str(row.get("entry_time", ""))[:5],
                "nifty_in": entry_spot,
                "buy_price": buy_px,
                "buy_value_rs": buy_val,
                "exit": str(row.get("exit_time", ""))[:5],
                "nifty_out": exit_spot,
                "sell_price": sell_px,
                "sell_value_rs": sell_val,
                "pnl_rs": pnl_rs,
                "nifty_points": pnl_pts,
                "exit_reason": row.get("exit_reason", ""),
                "mode": "HOURLY TREND PAPER",
                "spot_at_entry": entry_spot,
                "trigger_label": "Hourly Trend · paper",
            })
        except Exception:
            continue
    return out


def hourly_trend_report() -> dict:
    return build_paper_report(hourly_trend_option_trades())


def paper_report() -> dict:
    """Paper/live option trades with estimated charges, net equity curve and drawdown."""
    return build_paper_report(midpoint_option_trades())


def hero_zero_option_trades() -> list:
    """Closed HeroZero simulated entries, one lot per in-band option, exited at 15:30."""
    out = []
    for path in sorted(HERO_ZERO_DIR.glob("hero_zero_trades_*.csv")):
        for row in read_csv_rows(path):
            if row.get("status") != "closed":
                continue
            entry_price, exit_price = float(row["entry_price"]), float(row["exit_price"])
            qty = int(row["lot_size"])
            spot_at_entry = float(row["spot_ltp"]) if row.get("spot_ltp") else None
            distance = float(row["distance_from_spot"]) if row.get("distance_from_spot") else None
            side = "CALL" if row["option_type"] == "CE" else "PUT"
            out.append({
                "date": row["date"],
                "side": side,
                "option": f"{row['underlying']} {float(row['strike']):g} {row['option_type']}",
                "qty": qty,
                "spot_at_entry": spot_at_entry,
                "distance_from_spot": distance,
                "entry": row["entry_time"][11:16],
                "nifty_in": 0.0,
                "buy_price": entry_price,
                "buy_value_rs": round(entry_price * qty, 2),
                "exit": row["exit_time"][11:16],
                "nifty_out": 0.0,
                "sell_price": exit_price,
                "sell_value_rs": round(exit_price * qty, 2),
                "pnl_rs": round((exit_price - entry_price) * qty, 2),
                "nifty_points": 0.0,
                "exit_reason": row["exit_reason"],
                "mode": (
                    "HEROZERO LIVE" if row.get("source") == "hero_zero_live"
                    else "HEROZERO REPLAY · SPOT UNVERIFIED" if "spot_stale" in row.get("source", "")
                    else "HEROZERO 1M REPLAY" if "historical_1m_replay" in row.get("source", "")
                    else "HEROZERO PAPER"
                ),
            })
    return out


def hero_zero_report() -> dict:
    return build_paper_report(hero_zero_option_trades())


def _key_level_book(trades: list[dict]) -> dict:
    daily: dict = {}
    for trade in trades:
        day = daily.setdefault(trade["date"], {"date": trade["date"], "trades": 0, "open_trades": 0, "net_points": 0.0})
        if trade["status"] == "closed":
            day["trades"] += 1
            day["net_points"] += float(trade["pnl_points"])
        else:
            day["open_trades"] += 1
    return {
        "summary": summarize_key_level_trades(trades),
        "trades": trades,
        "daily": [{**row, "net_points": round(row["net_points"], 2)} for row in sorted(daily.values(), key=lambda item: item["date"])],
    }


def _option_paper_book(trades: list[dict]) -> dict:
    closed = [trade for trade in trades if trade["status"] == "closed"]
    net_pnl = []
    for trade in closed:
        buy_value = float(trade["option_entry"]) * int(trade["qty"])
        sell_value = float(trade["exit_option"]) * int(trade["qty"])
        charges = est_charges(buy_value, sell_value)
        net = round(float(trade["pnl_rs"]) - charges, 2)
        trade["charges_rs"] = charges
        trade["net_pnl_rs"] = net
        trade["net_return_pct"] = round(net / float(trade["capital_used"]) * 100, 2) if trade["capital_used"] else 0.0
        net_pnl.append(net)
    wins = sum(value > 0 for value in net_pnl)
    equity = peak = max_drawdown = 0.0
    for value in net_pnl:
        equity += value
        peak = max(peak, equity)
        max_drawdown = min(max_drawdown, equity - peak)
    return {
        "summary": {
            "trades": len(closed),
            "open_trades": len(trades) - len(closed),
            "wins": wins,
            "losses": len(closed) - wins,
            "win_rate_pct": round(wins * 100 / len(closed), 2) if closed else 0.0,
            "gross_pnl_rs": round(sum(float(trade["pnl_rs"]) for trade in closed), 2),
            "estimated_charges_rs": round(sum(float(trade["charges_rs"]) for trade in closed), 2),
            "net_pnl_rs": round(sum(net_pnl), 2),
            "avg_return_pct": round(sum(float(trade["net_return_pct"]) for trade in closed) / len(closed), 2) if closed else 0.0,
            "max_drawdown_rs": round(max_drawdown, 2),
        },
        "trades": trades,
    }


def key_level_report() -> dict:
    settings = key_level_settings(read_config())
    paper_trades = read_paper_events(KEY_LEVEL_EVENT_FILE)
    option_trades = [
        trade for trade in read_option_paper_trades(OPTION_PAPER_EVENT_FILE)
        if trade["strategy"] == "key_levels"
    ]
    today_date = today()
    today_candles = candles(today_date)
    today_replay_trades = backtest_key_levels(today_candles, settings) if not today_candles.empty else []
    today_paper_trades = [trade for trade in paper_trades if trade["date"] == today_date]
    cache_key = (history_mtime(), tuple(sorted(settings.items())))
    with _cache_lock:
        replay = _key_level_backtest_cache["value"] if _key_level_backtest_cache["key"] == cache_key else None
    if replay is None:
        history = master()
        replay_trades = backtest_key_levels(history, settings) if not history.empty else []
        replay = _key_level_book([{**trade, "source": "historical_replay"} for trade in replay_trades])
        with _cache_lock:
            _key_level_backtest_cache.update(key=cache_key, value=replay)
    return {
        "settings": settings,
        "today": today_date,
        "capture_running": capture_running(),
        "paper": _key_level_book(paper_trades),
        "today_replay": _key_level_book([{**trade, "source": "today_replay"} for trade in today_replay_trades]),
        "today_paper": _key_level_book(today_paper_trades),
        "option_paper": _option_paper_book(option_trades),
        "today_option_paper": _option_paper_book([trade for trade in option_trades if trade["date"] == today_date]),
        "backtest": replay,
    }


def build_paper_report(source_trades: list) -> dict:
    trades, equity, peak = [], 0.0, 0.0
    for t in source_trades:
        charges = est_charges(t["buy_value_rs"], t["sell_value_rs"])
        net = round(t["pnl_rs"] - charges, 2)
        equity += net
        peak = max(peak, equity)
        trades.append({**t, "charges_rs": charges, "net_rs": net, "equity": round(equity, 2), "drawdown": round(equity - peak, 2)})
    daily: dict = {}
    for x in trades:
        d = daily.setdefault(x["date"], {"date": x["date"], "trades": 0, "gross_rs": 0.0, "net_rs": 0.0, "points": 0.0})
        d["trades"] += 1
        d["gross_rs"] = round(d["gross_rs"] + x["pnl_rs"], 2)
        d["net_rs"] = round(d["net_rs"] + x["net_rs"], 2)
        d["points"] = round(d["points"] + x["nifty_points"], 2)
    n = len(trades)
    wins = [x["net_rs"] for x in trades if x["net_rs"] > 0]
    losses = [x["net_rs"] for x in trades if x["net_rs"] <= 0]
    return {
        "summary": {
            "trades": n,
            "days": len(daily),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate_pct": round(100.0 * len(wins) / n, 2) if n else 0.0,
            "gross_rs": round(sum(x["pnl_rs"] for x in trades), 2),
            "charges_rs": round(sum(x["charges_rs"] for x in trades), 2),
            "net_rs": round(equity, 2),
            "points": round(sum(x["nifty_points"] for x in trades), 2),
            "avg_win_rs": round(sum(wins) / len(wins), 2) if wins else 0.0,
            "avg_loss_rs": round(sum(losses) / len(losses), 2) if losses else 0.0,
            "max_drawdown_rs": min((x["drawdown"] for x in trades), default=0.0),
            "winning_days": sum(1 for d in daily.values() if d["net_rs"] > 0),
        },
        "trades": trades,
        "daily": sorted(daily.values(), key=lambda d: d["date"]),
    }


def capital_projection(source_trades: list) -> dict:
    ordered = sorted(source_trades, key=lambda trade: (trade["date"], trade["entry"], trade["exit"]))
    active = []
    curve = [{"timestamp": "", "label": "Start", "equity": PAPER_STARTING_CAPITAL, "drawdown": 0.0}]
    equity = float(PAPER_STARTING_CAPITAL)
    equity_peak = equity
    reserved_capital = 0.0
    peak_deployed = 0.0
    skipped_trades = 0
    daily = {}
    accepted_trades = []

    def realize_through(timestamp: str) -> None:
        nonlocal equity, equity_peak, reserved_capital
        active.sort(key=lambda position: position["exit_at"])
        while active and active[0]["exit_at"] <= timestamp:
            position = active.pop(0)
            equity += position["net_rs"]
            reserved_capital -= position["reserved"]
            equity_peak = max(equity_peak, equity)
            curve.append({
                "timestamp": position["exit_at"],
                "label": position["exit_at"],
                "equity": round(equity, 2),
                "drawdown": round(equity - equity_peak, 2),
            })

    for trade in ordered:
        entry_at = f"{trade['date']} {trade['entry']}"
        exit_at = f"{trade['date']} {trade['exit']}"
        realize_through(entry_at)
        reserved = round(trade["buy_value_rs"] + trade["charges_rs"], 2)
        if reserved > equity - reserved_capital + 1e-8:
            skipped_trades += 1
            continue
        active.append({"exit_at": exit_at, "reserved": reserved, "net_rs": trade["net_rs"]})
        reserved_capital += reserved
        peak_deployed = max(peak_deployed, reserved_capital)
        accepted_trades.append(trade)
        day = daily.setdefault(trade["date"], {"date": trade["date"], "trades": 0, "net_rs": 0.0})
        day["trades"] += 1
        day["net_rs"] += trade["net_rs"]

    while active:
        active.sort(key=lambda position: position["exit_at"])
        realize_through(active[0]["exit_at"])

    max_drawdown = min((point["drawdown"] for point in curve), default=0.0)
    return {
        "curve": curve,
        "trades": accepted_trades,
        "daily": [
            {"date": day["date"], "trades": day["trades"], "net_rs": round(day["net_rs"], 2)}
            for day in sorted(daily.values(), key=lambda item: item["date"])
        ],
        "summary": {
            "starting_capital": PAPER_STARTING_CAPITAL,
            "ending_capital": round(equity, 2),
            "net_rs": round(equity - PAPER_STARTING_CAPITAL, 2),
            "return_pct": round((equity - PAPER_STARTING_CAPITAL) / PAPER_STARTING_CAPITAL * 100, 2),
            "max_drawdown_rs": round(max_drawdown, 2),
            "peak_deployed_rs": round(peak_deployed, 2),
            "skipped_trades": skipped_trades,
        },
    }


def capital_report() -> dict:
    cfg = read_config()
    trades = []
    if cfg.get("midpoint_paper_trading", True):
        trades.extend(paper_report()["trades"])
    if cfg.get("hero_zero_paper_trading", True):
        trades.extend(hero_zero_report()["trades"])
    if cfg.get("key_levels_paper_trading", True):
        trades.extend(build_paper_report(key_level_option_trades())["trades"])
    if cfg.get("scalper_paper_trading", True):
        trades.extend(compression_scalp_report()["trades"])
    if cfg.get("trend_runner_paper_trading", True):
        trades.extend(trend_runner_paper_report()["trades"])
    if cfg.get("hourly_trend_paper_trading", False):
        trades.extend(hourly_trend_report()["trades"])
    return capital_projection(trades)


def tail(path: Path, lines: int) -> list:
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]


def today_log(path: Path, lines: int) -> list:
    """Capture log lines from today's run(s) only; each run starts with 'Waiting for market open'."""
    if not path.exists():
        return []
    day = today()
    runs: list = [[]]
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("Waiting for market open"):
            runs.append([])
        runs[-1].append(line)
    date_re = re.compile(r"\b(20\d\d-\d\d-\d\d)\b")
    keep = []
    for run in runs:
        dates = {d for line in run for d in date_re.findall(line)}
        if day in dates or (not dates and run is runs[-1]):
            keep.extend(run)
    return keep[-lines:]


class Handler(BaseHTTPRequestHandler):
    def _json(self, data, code: int = 200) -> None:
        body = json.dumps(data, default=str).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionError, BrokenPipeError):
            pass

    def _is_local_client(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1")

    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        q = parse_qs(url.query)
        date = q.get("date", [today()])[0]
        if not DATE_RE.match(date):
            return self._json({"error": "date must be YYYY-MM-DD"}, 400)

        if not url.path.startswith("/api/"):
            self._static(url.path)
        elif url.path == "/api/status":
            self._json(status())
        elif url.path == "/api/day":
            symbol = q.get("symbol", ["NIFTY"])[0].upper()
            strategy_param = q.get("strategy", ["midpoint"])[0]
            df = candles(date, symbol=symbol)
            cutoff = ""
            full_session = q.get("full", ["1"])[0] != "0"
            if not df.empty and not full_session:
                end = df["timestamp"].iloc[0] + pd.Timedelta(minutes=TRADE_WINDOW_MINUTES)
                df = df[df["timestamp"] <= end].reset_index(drop=True)
                cutoff = end.strftime("%H:%M")
            rows = [] if df.empty else [
                {"time": r.timestamp.strftime("%H:%M"), "open": r.open, "high": r.high, "low": r.low, "close": r.close}
                for r in df.itertuples()
            ]
            forming = forming_candle(date, rows[-1]["time"] if rows else "", symbol=symbol)
            if cutoff and forming.get("time", "") > cutoff:
                forming = {}
            paper_trades, first_paper_date = paper_trades_for_day(date)
            live_scalp_fills = compression_scalp_live_paper_trades(date)
            live_trend_fills = trend_runner_live_paper_trades(date)
            key_level_fills = key_level_option_trades(date)
            midpoint_fills = midpoint_option_trades(date)

            if strategy_param in ("trend_runner", "trend", "vix_runner", "vix_trend", "trend_expansion"):
                selected_option_trades = live_trend_fills
                selected_paper_trades = []
            elif strategy_param in ("compression_scalp", "sniper", "scalp", "micro_scalp"):
                selected_option_trades = live_scalp_fills
                selected_paper_trades = []
            elif strategy_param in ("midpoint",):
                selected_option_trades = midpoint_fills
                selected_paper_trades = paper_trades
            elif strategy_param in ("key_levels", "key_level"):
                selected_option_trades = key_level_fills
                selected_paper_trades = []
            elif strategy_param in ("hero_zero",):
                selected_option_trades = hero_zero_option_trades(date)
                selected_paper_trades = []
            else:
                # "all", "combined", or unspecified
                selected_option_trades = midpoint_fills + key_level_fills + live_scalp_fills + live_trend_fills
                selected_paper_trades = paper_trades

            option_fills = build_paper_report(selected_option_trades)["trades"]
            
            if strategy_param in ("compression_scalp", "sniper", "scalp"):
                rule_trades = compression_scalp_spot_trades_for_day(date)
            elif strategy_param in ("trend_runner", "vix_trend", "trend_expansion"):
                rule_trades = vix_trend_runner_spot_trades_for_day(date)
            elif strategy_param in ("sr_breakout", "swing_sr", "breakout"):
                rule_trades = sr_breakout_spot_trades_for_day(date)
            else:
                rule_trades = current_rule_trades(df, symbol=symbol)

            quotes_file = LIVE_DIR / f"quotes_{date}.json"
            prev_close = None
            if quotes_file.exists():
                try:
                    q_data = json.loads(quotes_file.read_text(encoding="utf-8"))
                    prev_close = q_data.get(symbol.lower(), {}).get("prev_close")
                except Exception:
                    pass

            self._json({
                "symbol": symbol,
                "date": date,
                "cutoff": cutoff,
                "prev_close": prev_close,
                "candles": rows,
                "forming": forming,
                "setup": setup_info(df),
                "trades": rule_trades,
                "signals": read_csv_rows(LIVE_DIR / f"signals_{symbol.lower()}_{date}.csv") if (LIVE_DIR / f"signals_{symbol.lower()}_{date}.csv").exists() else (read_csv_rows(LIVE_DIR / f"signals_{date}.csv") if symbol == "NIFTY" else []),
                "paper_trades": selected_paper_trades if symbol == "NIFTY" else [],
                "option_trades": option_fills if symbol == "NIFTY" else [],
                "first_paper_date": first_paper_date,
                "execution_mode": "LIVE" if read_config().get("midpoint_live_trading", read_config().get("live_trading")) else "PAPER",
            })
        elif url.path == "/api/key-level-day":
            minute_candles = candles(date)
            forming, current_price = forming_five_minute_candle(date, minute_candles)
            bars = aggregate_five_minute(minute_candles)
            settings = key_level_settings(read_config())
            replay_trades = backtest_key_levels(minute_candles, settings)
            rows = [] if bars.empty else [
                {"time": row.timestamp.strftime("%H:%M"), "open": row.open, "high": row.high, "low": row.low, "close": row.close}
                for row in bars.itertuples()
            ]
            chart_trades = [
                {
                    "side": trade["side"],
                    "entry": trade["entry_time"],
                    "entry_price": trade["entry_price"],
                    "sl": trade["stop"],
                    "target": trade["target"],
                    "exit": trade["exit_time"],
                    "exit_price": trade["exit_price"],
                    "reason": trade["exit_reason"],
                    "pnl_points": trade["pnl_points"],
                }
                for trade in replay_trades
            ]
            self._json({
                "date": date,
                "timeframe_minutes": 5,
                "candles": rows,
                "forming": forming,
                "current_price": current_price,
                "trades": chart_trades,
                "key_level_zone": active_key_level_zone(minute_candles, replay_trades, settings),
            })
        elif url.path == "/api/signals":
            self._json(read_csv_rows(LIVE_DIR / f"signals_{date}.csv"))
        elif url.path == "/api/orders":
            self._json(read_csv_rows(LIVE_DIR / f"live_orders_{date}.csv"))
        elif url.path == "/api/trades":
            self._json(midpoint_option_trades())
        elif url.path == "/api/key-level-option-trades":
            self._json(build_paper_report(key_level_option_trades(date))["trades"])
        elif url.path == "/api/key-level-option-paper":
            self._json(key_level_option_paper_rows(date))
        elif url.path == "/api/paper-report":
            strategy = q.get("strategy", [""])[0]
            if strategy in ("trend_runner", "trend", "vix_runner"):
                self._json(trend_runner_paper_report())
            elif strategy == "hero_zero":
                self._json(hero_zero_report())
            elif strategy in ("compression_scalp", "scalp", "micro_scalp", "sniper"):
                self._json(compression_scalp_report())
            elif strategy in ("hourly_trend", "hourly"):
                self._json(hourly_trend_report())
            elif strategy in ("", "midpoint"):
                self._json(paper_report())
            else:
                self._json({"error": "unknown strategy"}, 404)
        elif url.path == "/api/capital-report":
            self._json(capital_report())
        elif url.path == "/api/paper-trades":
            strategy = q.get("strategy", [""])[0]
            if strategy in ("trend_runner", "trend", "vix_runner"):
                self._json(trend_runner_live_paper_trades())
            else:
                self._json(read_csv_rows(LIVE_DIR / "paper_trades.csv"))
        elif url.path == "/api/log":
            n = min(int(q.get("lines", ["200"])[0]), 2000)
            self._json(today_log(LIVE_DIR / "capture.log", n))
        elif url.path == "/api/days":
            self._json(available_days())
        elif url.path == "/api/backtest":
            strategy = q.get("strategy", [""])[0]
            if strategy in ("trend_runner_5y", "5y_trend", "trend_5y"):
                self._json(trend_runner_5y_backtest_report())
            elif strategy in ("trend_runner", "vix_trend", "trend_expansion"):
                self._json(vix_trend_runner_backtest_report())
            elif strategy == "key_levels":
                self._json(key_level_report())
            elif strategy in ("compression_scalp", "scalp", "micro_scalp", "sniper"):
                self._json(compression_scalp_backtest_report())
            elif strategy in ("mtf_orb", "mtf", "5y", "5year"):
                self._json(mtf_orb_5y_backtest_report())
            elif strategy in ("hourly_trend", "hourly"):
                self._json(hourly_trend_report())
            elif strategy in ("sr_breakout", "swing_sr", "breakout"):
                self._json(sr_breakout_backtest_report())
            elif strategy not in ("", "midpoint"):
                return self._json({"error": "unknown strategy"}, 404)
            else:
                self._json(backtest_report())

        elif url.path == "/api/settings":
            self._json(public_settings())
        elif url.path == "/api/funds":
            funds = broker_funds()
            self._json(funds, 200 if funds["ok"] else 502)
        elif url.path == "/api/positions":
            from broker import get_positions
            self._json(get_positions())
        elif url.path in ("/api/manual-options", "/api/manual-trading", "/api/manual-quote"):
            if not self._is_local_client():
                return self._json({"error": "manual trading endpoints are local-only"}, 403)
            try:
                if url.path == "/api/manual-options":
                    data = manual_option_choices(q)
                elif url.path == "/api/manual-quote":
                    data = manual_option_quote(q)
                else:
                    data = manual_trading_snapshot()
                self._json(data)
            except ManualTradeError as exc:
                self._json({"error": str(exc)}, exc.status_code)
            except Exception:
                self._json({"error": "Unable to load manual trading data from Fyers."}, 502)
        elif url.path in ("/api/scalper/status", "/api/scalper-status"):
            self._json(scalper_status())
        elif url.path == "/api/kotak/status":
            from kotak_orders import kotak_token_status
            self._json(kotak_token_status())
        elif url.path == "/api/brokers":
            from broker import get_all_broker_status
            self._json(get_all_broker_status())
        else:
            self._json({"error": "not found"}, 404)

    def _static(self, path: str) -> None:
        # Built React app (web/dist) with SPA fallback; old dashboard if not built yet.
        if not (WEB_DIST / "index.html").exists():
            body, ctype = UI_FILE.read_bytes(), "text/html; charset=utf-8"
        else:
            root = WEB_DIST.resolve()
            target = (root / path.lstrip("/")).resolve()
            if root not in target.parents or not target.is_file():
                target = root / "index.html"
            body = target.read_bytes()
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            if "html" in ctype or "javascript" in ctype:
                self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
                self.send_header("Pragma", "no-cache")
                self.send_header("Expires", "0")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionError, BrokenPipeError):
            pass

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 10_000:
            return {}
        try:
            data = json.loads(self.rfile.read(n))
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def do_POST(self):  # noqa: N802
        url = urlparse(self.path)
        # Custom header forces a CORS preflight (which we never approve), so other sites can't post here.
        if self.headers.get("X-Dashboard") != "1":
            return self._json({"error": "forbidden"}, 403)
        if url.path == "/api/manual-order":
            if not self._is_local_client():
                return self._json({"error": "manual orders are local-only"}, 403)
            try:
                self._json(submit_manual_order(self._body()))
            except ManualTradeError as exc:
                self._json({"error": str(exc)}, exc.status_code)
            except Exception as exc:
                self._json({"error": f"Order request failed: {exc}"}, 502)
        elif url.path == "/api/exit-position":
            if not self._is_local_client():
                return self._json({"error": "manual orders are local-only"}, 403)
            try:
                self._json(exit_position(self._body()))
            except ManualTradeError as exc:
                self._json({"error": str(exc)}, exc.status_code)
            except Exception as exc:
                self._json({"error": f"Position exit failed: {exc}"}, 502)
        elif url.path == "/api/exit-all":
            if not self._is_local_client():
                return self._json({"error": "manual orders are local-only"}, 403)
            try:
                self._json(exit_all_positions())
            except ManualTradeError as exc:
                self._json({"error": str(exc)}, exc.status_code)
            except Exception as exc:
                self._json({"error": f"Exit all failed: {exc}"}, 502)
        elif url.path == "/api/kill-switch/on":
            STOP_FILE.write_text(f"stopped from dashboard at {datetime.now(IST):%H:%M:%S}\n", encoding="utf-8")
            self._json({"kill_switch": True})
        elif url.path == "/api/kill-switch/off":
            STOP_FILE.unlink(missing_ok=True)
            self._json({"kill_switch": False})
        elif url.path == "/api/capture/start":
            self._json(start_capture())
        elif url.path == "/api/capture/stop":
            self._json(stop_capture())
        elif url.path == "/api/settings":
            data, code = update_settings(self._body())
            self._json(data, code)
        elif url.path == "/api/login/start":
            try:
                self._json(start_login())
            except Exception as exc:
                self._json({"error": f"login start failed: {exc}"}, 500)
        elif url.path == "/api/kotak/login":
            from kotak_orders import kotak_login
            body = self._body()
            res = kotak_login(totp_code=body.get("totp"), mpin=body.get("mpin"))
            self._json(res, 200 if res.get("ok") else 400)
        else:
            self._json({"error": "not found"}, 404)

    def log_message(self, *_args):
        return


if __name__ == "__main__":
    threading.Thread(target=hero_zero_capture_loop, daemon=True, name="hero-zero-capture").start()
    threading.Thread(target=sensex_expiry_collector_loop, daemon=True, name="sensex-expiry-collector").start()
    threading.Thread(target=auto_start_loop, daemon=True).start()
    threading.Thread(target=scalper_forward_loop, daemon=True, name="micro-scalper-forward").start()
    threading.Thread(target=trend_runner_forward_loop, daemon=True, name="trend-runner-forward").start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Dashboard: http://{HOST}:{PORT}/  (Ctrl+C to stop)")
    while True:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            break
        except Exception as exc:
            print(f"Server exception: {exc}, continuing in 2s...")
            time.sleep(2)

#!/usr/bin/env python3
"""Local dashboard + JSON API for the NIFTY strategy (read-only, plus the STOP_TRADING kill switch).

Run: python3 app_server.py  ->  http://127.0.0.1:8090
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import hmac
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

def load_nifty_options():
    cache = ROOT / 'captured_data' / 'fyers' / 'nifty_options_cache.pkl'
    today_date = datetime.now(timezone(timedelta(hours=5, minutes=30))).date()
    if cache.exists():
        try:
            mtime = datetime.fromtimestamp(cache.stat().st_mtime, tz=timezone(timedelta(hours=5, minutes=30))).date()
            if mtime == today_date:
                return pd.read_pickle(cache)
        except Exception:
            pass
    SYMBOL_MASTER_URL = 'https://public.fyers.in/sym_details/NSE_FO.csv'
    try:
        cols = {8: 'expiry_epoch', 9: 'symbol', 3: 'lot_size', 13: 'underlying', 15: 'strike', 16: 'opt_type'}
        raw = pd.read_csv(SYMBOL_MASTER_URL, header=None, usecols=list(cols))
        df = raw.rename(columns=cols)
        df = df[(df['underlying'] == 'NIFTY') & (df['opt_type'].isin(['CE', 'PE']))].copy()
        df['expiry'] = pd.to_datetime(df['expiry_epoch'], unit='s', utc=True).dt.tz_convert('Asia/Kolkata').dt.date
        cache.parent.mkdir(parents=True, exist_ok=True)
        df.to_pickle(cache)
        return df
    except Exception:
        return pd.DataFrame(columns=['symbol', 'strike', 'opt_type', 'expiry', 'lot_size'])

from key_level_strategy import aggregate_five_minute, backtest_key_levels, read_paper_events, settings_from_config as key_level_settings, summarize_key_level_trades
from option_paper import read_option_paper_trades


def available_equity_funds(response: dict | None) -> float:
    if not isinstance(response, dict):
        return 0.0
    fund_limit = response.get("fund_limit", [])
    if isinstance(fund_limit, list):
        for item in fund_limit:
            if item.get("title") == "Available Balance":
                return float(item.get("equityAmount", 0.0))
    return float(response.get("available_balance", 0.0))


ROOT = Path(__file__).resolve().parent
TMP_DIR = ROOT / ".tmp"
TMP_DIR.mkdir(parents=True, exist_ok=True)
LIVE_DIR = ROOT / "captured_data" / "fyers" / "live"
CONFIG_FILE = ROOT / "fyers_config.json"
TOKEN_FILE = ROOT / "captured_data" / "kotak" / "kotak_token.json"
KOTAK_DIR = ROOT / "captured_data" / "kotak"
SCALP_TARGETS_FILE = KOTAK_DIR / "scalp_targets.json"
STOP_FILE = ROOT / "STOP_TRADING"
UI_FILE = ROOT / "ui" / "dashboard.html"
WEB_DIST = ROOT / "web" / "dist"
MASTER_CSV = ROOT / "historical_data" / "nifty50" / "daily" / "NIFTY50_daily.csv"
ARCHIVE_CSV = ROOT / "historical_data" / "sensex" / "daily" / "SENSEX_daily.csv"
PAPER_TRADES_CSV = LIVE_DIR / "paper_trades.csv"
HERO_ZERO_DIR = ROOT / "paper" / "hero_zero"
KEY_LEVEL_DIR = ROOT / "paper" / "key_levels"
KEY_LEVEL_EVENT_FILE = KEY_LEVEL_DIR / "key_level_paper_events.csv"
OPTION_PAPER_EVENT_FILE = KEY_LEVEL_DIR / "key_level_option_paper_events.csv"
HOST, PORT = os.environ.get("HOST", "0.0.0.0"), int(os.environ.get("PORT", "8090"))
IST = timezone(timedelta(hours=5, minutes=30))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

def is_kill_switch_active() -> bool:
    """Return True if kill switch is active today. Auto-resets stale halts from previous days."""
    if not STOP_FILE.exists():
        return False
    try:
        mtime = datetime.fromtimestamp(STOP_FILE.stat().st_mtime, tz=IST)
        today = datetime.now(IST).date()
        if mtime.date() < today:
            STOP_FILE.unlink(missing_ok=True)
            print(f"[{datetime.now(IST):%Y-%m-%d %H:%M:%S}] Auto-cleared stale STOP_TRADING file from {mtime.date()} for new trading day {today}")
            return False
    except Exception:
        pass
    return True
_token_cache = {"at": 0.0, "mtime": None, "value": None}
_master_cache = {"mtime": None, "df": None}
_option_master_cache = {"date": None, "df": None}
_option_master_lock = threading.Lock()
_sensex_option_master_cache = {"date": None, "df": None}
_sensex_option_master_lock = threading.Lock()
_backtest_cache = {"mtime": None, "value": None}
_key_level_backtest_cache = {"key": None, "value": None}
_cache_lock = threading.Lock()
_sync_state = {
    "status": "idle",
    "message": "Ready",
    "started_at": None,
    "completed_at": None,
    "last_sync_date": None,
}
_sync_lock = threading.Lock()

def trigger_backtest_sync(reason: str = "manual") -> dict:
    with _sync_lock:
        if _sync_state["status"] == "running":
            return {"ok": True, "running": True, "message": "Backtest sync already in progress..."}
        _sync_state["status"] = "running"
        _sync_state["message"] = f"Updating historical data & running backtests ({reason})..."
        _sync_state["started_at"] = datetime.now(IST).isoformat()

    def _worker():
        try:
            import subprocess, sys, shutil
            print(f"[{datetime.now(IST)}] Starting backtest sync ({reason})...")
            # If update_historical_data.py exists, run it
            script = ROOT / "update_historical_data.py"
            if script.exists():
                res = subprocess.run([sys.executable, str(script)], capture_output=True, text=True)
                if res.returncode == 0:
                    nifty_10y = ROOT / "performance" / "nifty_10y_backtest_trades.csv"
                    vix_file = ROOT / "performance" / "vix_trend_runner_trades.csv"
                    if nifty_10y.exists():
                        shutil.copy2(nifty_10y, vix_file)
                    with _cache_lock:
                        _backtest_cache.update(mtime=None, value=None)
                    with _sync_lock:
                        _sync_state["status"] = "completed"
                        _sync_state["message"] = "Backtests updated successfully with latest data."
                        _sync_state["completed_at"] = datetime.now(IST).isoformat()
                        _sync_state["last_sync_date"] = datetime.now(IST).strftime("%Y-%m-%d")
                    print(f"[{datetime.now(IST)}] Backtest sync completed successfully.")
                    return
                else:
                    err = res.stderr[-300:] if res.stderr else "Update script failed"
                    with _sync_lock:
                        _sync_state["status"] = "failed"
                        _sync_state["message"] = f"Backtest update failed: {err}"
                        _sync_state["completed_at"] = datetime.now(IST).isoformat()
                    return
        except Exception as exc:
            with _sync_lock:
                _sync_state["status"] = "failed"
                _sync_state["message"] = f"Backtest exception: {exc}"
                _sync_state["completed_at"] = datetime.now(IST).isoformat()
            print(f"[{datetime.now(IST)}] Backtest sync error: {exc}")

    threading.Thread(target=_worker, daemon=True).start()
    return {"ok": True, "running": True, "message": _sync_state["message"]}

def daily_backtest_sync_loop() -> None:
    """Trigger daily backtest sync after market close (16:35 IST on weekdays)."""
    while True:
        try:
            now = datetime.now(IST)
            if now.weekday() < 5 and now.hour == 16 and now.minute == 35:
                today_str = now.strftime("%Y-%m-%d")
                if _sync_state.get("last_sync_date") != today_str:
                    trigger_backtest_sync(reason="daily_schedule_1635")
        except Exception as e:
            pass
        time.sleep(30)

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
    "sizing_mode": (str, None, None),
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
    "trend_runner_paper_trading": (bool, None, None),
    "trend_runner_live_trading": (bool, None, None),
    "trend_runner_lots": (int, 1, PAPER_LOTS),
    "sensex_runner_paper_trading": (bool, None, None),
    "sensex_runner_live_trading": (bool, None, None),
    "sensex_runner_lots": (int, 1, PAPER_LOTS),
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
    if time.time() - _token_cache["at"] < 120 and _token_cache["value"] and _token_cache["mtime"] == mtime:
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


def _process_pids_by_pattern(pattern: str) -> list[int]:
    """Return PIDs matching a command pattern, cross-platform."""
    try:
        import psutil
        pids = []
        for p in psutil.process_iter(["pid", "cmdline"]):
            try:
                cmd = " ".join(p.info["cmdline"] or [])
                if pattern in cmd:
                    pids.append(p.info["pid"])
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return pids
    except Exception:
        pass

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
    output_dir = ROOT / "options_data" / "sensex"
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
        cfg = read_config()
        if not (cfg.get("hero_zero_paper_trading", False) or cfg.get("hero_zero_live_trading", False)):
            time.sleep(30)
            continue
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
        "enabled": bool(cfg.get("scalper_paper_trading", False) or cfg.get("scalper_live_trading", False)),
        "mode": "LIVE" if cfg.get("scalper_live_trading") else "PAPER",
        "sl_pts": float(cfg.get("scalper_sl_pts", 18.0)),
        "target_pts": float(cfg.get("scalper_target_pts", 35.0)),
        "max_trades": int(cfg.get("scalper_max_trades", 2)),
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
            paper_on = cfg.get("scalper_paper_trading", False)
            if not paper_on:
                time.sleep(5)
                continue

            sl_pts = float(cfg.get("scalper_sl_pts", 18.0))
            tgt_pts = float(cfg.get("scalper_target_pts", 35.0))
            max_trades = int(cfg.get("scalper_max_trades", 2))
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


import collections

ENGINE_TELEMETRY_LOGS = collections.deque(maxlen=300)
ENGINE_LIVE_STATE = {
    "nifty": {
        "status": "INITIALIZING",
        "last_updated": "",
        "bar_time": "",
        "spot": 0.0,
        "or_high": 0.0,
        "or_low": 0.0,
        "or_range": 0.0,
        "in_position": False,
        "active_position": None,
        "trades_today": 0,
        "vix_chg": 0.0,
    },
    "sensex": {
        "status": "INITIALIZING",
        "last_updated": "",
        "bar_time": "",
        "spot": 0.0,
        "or_high": 0.0,
        "or_low": 0.0,
        "or_range": 0.0,
        "in_position": False,
        "active_position": None,
        "trades_today": 0,
        "vix_chg": 0.0,
    }
}

def log_engine_telemetry(symbol: str, engine: str, level: str, message: str) -> None:
    now_str = datetime.now(IST).strftime("%H:%M:%S")
    entry = {
        "time": now_str,
        "symbol": symbol.upper(),
        "engine": engine,
        "level": level,
        "message": message,
    }
    ENGINE_TELEMETRY_LOGS.append(entry)

def log_live_order_event(action: str, symbol: str, qty: int, order_id: str, fill_price: float = 0.0, reason: str = "", mode: str = "LIVE", trade_pnl_rs: float = 0.0) -> None:
    try:
        now = datetime.now(IST)
        d_str = now.strftime("%Y-%m-%d")
        t_str = now.strftime("%H:%M:%S")
        LIVE_DIR.mkdir(parents=True, exist_ok=True)
        fpath = LIVE_DIR / f"live_orders_{d_str}.csv"
        new = not fpath.exists()
        with fpath.open("a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["time", "action", "symbol", "qty", "order_id", "fill_price", "index_price", "reason", "trade_pnl_rs", "day_pnl_rs", "mode"])
            w.writerow([t_str, action, symbol, qty, order_id, fill_price, "", reason, trade_pnl_rs, "", mode])
        log_engine_telemetry("ORDER", "LIVE BROKER", "ORDER", f"[{mode}] {action} {qty}x {symbol} @ {fill_price:.2f} (Order #{order_id})")
    except Exception as exc:
        print(f"Error logging live order event: {exc}")

def trend_runner_forward_loop() -> None:
    """Continuously monitor today's live 1-min stream for Trend Catcher (VIX Runner) setups."""
    today_str = today()
    live_file = LIVE_DIR / f"nifty_1min_{today_str}.csv"
    engine = None
    last_processed_5m = ""
    last_processed_1m = ""

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
                last_processed_1m = ""

            if not live_file.exists():
                time.sleep(5)
                continue

            df1 = pd.read_csv(live_file)
            if df1.empty or len(df1) < 15:
                time.sleep(5)
                continue

            from trend_runner_paper import TrendRunnerPaperEngine, compute_indicators, get_vix_change_pct
            if engine is None:
                lots_cfg = int(cfg.get("trend_runner_lots", 1))
                sizing_cfg = str(cfg.get("sizing_mode", "fixed")).lower()
                engine = TrendRunnerPaperEngine(
                    sl_points=28.0,
                    sl_mode="fixed",
                    lots=lots_cfg,
                    sizing_mode=sizing_cfg,
                    reentry=True,
                    notify_telegram=True,
                )
                engine.current_day_str = today_str
                log_engine_telemetry("NIFTY", "Apex Duo", "SYSTEM", "Nifty Forward Engine active and listening.")

            df5, or_high, or_low, or_range = compute_indicators(df1)
            if df5.empty:
                time.sleep(5)
                continue

            latest_1m = df1.iloc[-1]
            t1m = str(latest_1m.get("timestamp", ""))[-8:-3]
            c1m = float(latest_1m.get("close", 0.0))
            now_hms = datetime.now(IST).strftime("%H:%M:%S")

            ENGINE_LIVE_STATE["nifty"].update({
                "status": "IN_POSITION" if engine.active_position else ("ACTIVE_EVALUATING" if t1m >= "09:30" else "BUILDING_OR"),
                "last_updated": now_hms,
                "bar_time": t1m,
                "spot": c1m,
                "or_high": round(or_high, 2),
                "or_low": round(or_low, 2),
                "or_range": round(or_range, 2),
                "in_position": engine.active_position is not None,
                "active_position": engine.active_position,
                "trades_today": engine.trades_today,
            })

            if t1m != last_processed_1m:
                last_processed_1m = t1m
                dist_h = or_high - c1m
                dist_l = c1m - or_low
                status_desc = f"Inside OR ({dist_h:.1f} pt to High, {dist_l:.1f} pt to Low) - Standby" if (or_low <= c1m <= or_high) else ("Above OR High" if c1m > or_high else "Below OR Low")
                log_engine_telemetry("NIFTY", "Apex Duo", "INFO", f"1m Bar [{t1m}] Spot {c1m:.2f} | OR [{or_low:.2f} - {or_high:.2f}] | {status_desc}")

            latest_bar = df5.iloc[-1]
            curr_5m_time = str(latest_bar.get("time_str", ""))

            if curr_5m_time != last_processed_5m:
                vix_chg = get_vix_change_pct(today_str)
                ENGINE_LIVE_STATE["nifty"]["vix_chg"] = round(vix_chg, 2)
                res = engine.evaluate_bar(latest_bar, or_high, or_low, or_range, vix_chg)
                last_processed_5m = curr_5m_time
                if res:
                    print(f"[{datetime.now(IST):%H:%M:%S}] [Trend Catcher LIVE PAPER] Position Event: {res}")
                    log_engine_telemetry("NIFTY", "Trend Runner", "SIGNAL", f"Position Event: {res.get('stage')} | {res.get('side')} @ {res.get('entry_px')} | SL {res.get('sl')}")

        except Exception:
            pass
        time.sleep(5)


def sensex_runner_forward_loop() -> None:
    """Continuously monitor today's live Sensex 1-min stream for Sensex Trend Runner setups."""
    today_str = today()
    live_file = LIVE_DIR / f"sensex_1min_{today_str}.csv"
    engine = None
    last_processed_5m = ""
    last_processed_1m = ""

    while True:
        try:
            cfg = read_config()
            if not cfg.get("sensex_runner_paper_trading", True):
                time.sleep(5)
                continue

            current_today = today()
            if current_today != today_str:
                today_str = current_today
                live_file = LIVE_DIR / f"sensex_1min_{today_str}.csv"
                engine = None
                last_processed_5m = ""
                last_processed_1m = ""

            if not live_file.exists():
                time.sleep(5)
                continue

            df1 = pd.read_csv(live_file)
            if df1.empty or len(df1) < 15:
                time.sleep(5)
                continue

            from trend_runner_paper import TrendRunnerPaperEngine, compute_indicators, get_vix_change_pct
            if engine is None:
                lots_cfg = int(cfg.get("sensex_runner_lots", 1))
                sizing_cfg = str(cfg.get("sizing_mode", "fixed")).lower()
                engine = TrendRunnerPaperEngine(
                    symbol="SENSEX",
                    sl_points=120.0,
                    sl_mode="fixed",
                    lots=lots_cfg,
                    sizing_mode=sizing_cfg,
                    reentry=True,
                    notify_telegram=True,
                )
                engine.current_day_str = today_str
                log_engine_telemetry("SENSEX", "Apex Duo", "SYSTEM", "Sensex Forward Engine active and listening.")

            df5, or_high, or_low, or_range = compute_indicators(df1)
            if df5.empty:
                time.sleep(5)
                continue

            latest_1m = df1.iloc[-1]
            t1m = str(latest_1m.get("timestamp", ""))[-8:-3]
            c1m = float(latest_1m.get("close", 0.0))
            now_hms = datetime.now(IST).strftime("%H:%M:%S")

            ENGINE_LIVE_STATE["sensex"].update({
                "status": "IN_POSITION" if engine.active_position else ("ACTIVE_EVALUATING" if t1m >= "09:30" else "BUILDING_OR"),
                "last_updated": now_hms,
                "bar_time": t1m,
                "spot": c1m,
                "or_high": round(or_high, 2),
                "or_low": round(or_low, 2),
                "or_range": round(or_range, 2),
                "in_position": engine.active_position is not None,
                "active_position": engine.active_position,
                "trades_today": engine.trades_today,
            })

            if t1m != last_processed_1m:
                last_processed_1m = t1m
                dist_h = or_high - c1m
                dist_l = c1m - or_low
                status_desc = f"Inside OR ({dist_h:.1f} pt to High, {dist_l:.1f} pt to Low) - Standby" if (or_low <= c1m <= or_high) else ("Above OR High" if c1m > or_high else "Below OR Low")
                log_engine_telemetry("SENSEX", "Apex Duo", "INFO", f"1m Bar [{t1m}] Spot {c1m:.2f} | OR [{or_low:.2f} - {or_high:.2f}] | {status_desc}")

            latest_bar = df5.iloc[-1]
            curr_5m_time = str(latest_bar.get("time_str", ""))

            if curr_5m_time != last_processed_5m:
                vix_chg = get_vix_change_pct(today_str)
                ENGINE_LIVE_STATE["sensex"]["vix_chg"] = round(vix_chg, 2)
                res = engine.evaluate_bar(latest_bar, or_high, or_low, or_range, vix_chg)
                last_processed_5m = curr_5m_time
                if res:
                    print(f"[{datetime.now(IST):%H:%M:%S}] [Sensex Trend Runner LIVE PAPER] Position Event: {res}")
                    log_engine_telemetry("SENSEX", "Trend Runner", "SIGNAL", f"Position Event: {res.get('stage')} | {res.get('side')} @ {res.get('entry_px')} | SL {res.get('sl')}")

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
            dfs = []
            for pth in paths:
                try:
                    d = pd.read_csv(pth)
                    if "date" in d.columns and "timestamp" not in d.columns:
                        d = d.rename(columns={"date": "timestamp"})
                    dfs.append(d)
                except Exception:
                    pass
            if not dfs:
                return pd.DataFrame()
            df = pd.concat(dfs, ignore_index=True)
            if "timestamp" not in df.columns:
                return pd.DataFrame()
            ts = pd.to_datetime(df["timestamp"], errors="coerce")
            df["timestamp"] = ts.dt.tz_localize("UTC").dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
            df = df.dropna(subset=["timestamp", "open", "high", "low", "close"])
            # Master is listed last, so its rows win where the two files overlap.
            df = df.drop_duplicates("timestamp", keep="last").sort_values("timestamp").reset_index(drop=True)
            _master_cache.update(mtime=mtime, df=df)
        return _master_cache["df"]


def load_technovusin_day(date_str: str, symbol: str = "NIFTY") -> pd.DataFrame:
    """Load 1-minute candles for a specific day from technovusin repository."""
    year = date_str[:4]
    month = date_str[:7]
    sym = str(symbol or "NIFTY").strip().upper()
    repo_name = "technovusin_sensex" if sym == "SENSEX" else "technovusin_nifty50"
    prefix = "SENSEX" if sym == "SENSEX" else "NIFTY50"
    base = ROOT / "captured_data" / repo_name / "1min" / year
    if not base.exists():
        return pd.DataFrame()

    yearly_file = base / f"{prefix}_1min_{year}.csv"
    if yearly_file.exists():
        try:
            df = pd.read_csv(yearly_file)
        except Exception:
            return pd.DataFrame()
    else:
        monthly_file = base / f"{prefix}_1min_{month}.csv"
        if monthly_file.exists():
            try:
                df = pd.read_csv(monthly_file)
            except Exception:
                return pd.DataFrame()
        else:
            return pd.DataFrame()

    ts_col = "Timestamp" if "Timestamp" in df.columns else "timestamp"
    df[ts_col] = pd.to_datetime(df[ts_col], errors="coerce")
    sub = df[df[ts_col].dt.strftime("%Y-%m-%d") == date_str].copy()
    if sub.empty:
        return pd.DataFrame()

    sub.rename(columns={
        ts_col: "timestamp",
        "Open": "open",
        "High": "high",
        "Low": "low",
        "Close": "close",
        "Volume": "volume",
        "open": "open",
        "high": "high",
        "low": "low",
        "close": "close",
        "volume": "volume",
    }, inplace=True)
    if "volume" not in sub.columns:
        sub["volume"] = 1.0
    return sub.sort_values("timestamp").reset_index(drop=True)


def candles(date: str, symbol: str = "NIFTY") -> pd.DataFrame:
    sym = str(symbol or "NIFTY").strip().upper()
    is_sx = (sym == "SENSEX")
    prefix = "SENSEX" if is_sx else "NIFTY50"
    subdir = "sensex" if is_sx else "nifty50"
    live_prefix = "sensex" if is_sx else "nifty"

    candidates = []

    # 1. Technovusin archive (10-Year 1-min dataset, complete 375 bars/day)
    tech_df = load_technovusin_day(date, symbol=sym)
    if not tech_df.empty:
        candidates.append((len(tech_df), tech_df))

    # 2. Historical data daily CSVs (automated daily sync)
    year, month = date[:4], date[5:7]
    hist_path = ROOT / "historical_data" / subdir / "1min" / year / month / f"{prefix}_1min_{date}.csv"
    if hist_path.exists():
        try:
            hdf = pd.read_csv(hist_path)
            ts_c = "Timestamp" if "Timestamp" in hdf.columns else "timestamp"
            hdf["timestamp"] = pd.to_datetime(hdf[ts_c], errors="coerce")
            hdf = hdf.dropna(subset=["timestamp"])
            hdf.rename(columns={"Open": "open", "High": "high", "Low": "low", "Close": "close", "Volume": "volume"}, inplace=True)
            candidates.append((len(hdf), hdf))
        except Exception:
            pass

    # 3. Live capture file (today's active trading or live forward tests)
    path = LIVE_DIR / f"{live_prefix}_1min_{date}.csv"
    if path.exists():
        try:
            ldf = pd.read_csv(path)
            if not ldf.empty and "timestamp" in ldf.columns:
                ldf["timestamp"] = pd.to_datetime(ldf["timestamp"], errors="coerce")
                ldf = ldf.dropna(subset=["timestamp"])
                candidates.append((len(ldf), ldf))
        except Exception:
            pass

    # If any 1-minute candidates found, return the one with the MOST bars (prevents partial 91-bar files from masking full 375-bar days)
    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0][1]

    # 4. Fallback Yahoo 2m / 5m for Sensex
    if is_sx:
        for yf in ["sensex_yahoo_2m.csv", "sensex_yahoo_5m.csv"]:
            yp = ROOT / "captured_data" / yf
            if yp.exists():
                try:
                    ydf = pd.read_csv(yp)
                    ydf["timestamp"] = pd.to_datetime(ydf["timestamp"], errors="coerce")
                    ysub = ydf[ydf["timestamp"].dt.strftime("%Y-%m-%d") == date].reset_index(drop=True)
                    if not ysub.empty:
                        return ysub
                except Exception:
                    pass

    # 5. Fallback legacy Fyers master archive / 5min for Nifty
    if not is_sx:
        m = master()
        if not m.empty:
            master_day = m[m["timestamp"].dt.strftime("%Y-%m-%d") == date].reset_index(drop=True)
            if not master_day.empty:
                return master_day

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

    return pd.DataFrame()


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
        return {"summary": {}, "trades": [], "monthly": [], "daily": [], "exit_reasons": []}
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
    out["broker"] = cfg.get("broker", "KOTAK_NEO")
    out["lots"] = int(cfg.get("lots", PAPER_LOTS))
    out["sizing_mode"] = str(cfg.get("sizing_mode", "fixed")).lower()
    out["daily_loss_limit"] = cfg.get("daily_loss_limit") if cfg.get("daily_loss_limit") is not None else 1000
    out["strike_offset"] = cfg.get("strike_offset") if cfg.get("strike_offset") is not None else 100
    out["option_target_pct"] = cfg.get("option_target_pct") if cfg.get("option_target_pct") is not None else 10
    out["minimum_live_funds"] = int(cfg.get("minimum_live_funds") or 25000)
    out["midpoint_live_trading"] = bool(cfg.get("midpoint_live_trading", cfg.get("live_trading", False)))
    out["hero_zero_live_trading"] = bool(cfg.get("hero_zero_live_trading", False))
    out["key_levels_live_trading"] = bool(cfg.get("key_levels_live_trading", False))
    out["key_levels_lots"] = int(cfg.get("key_levels_lots", 1))
    out["hero_zero_lots"] = int(cfg.get("hero_zero_lots", 1))
    out["scalper_paper_trading"] = bool(cfg.get("scalper_paper_trading", False))
    out["scalper_live_trading"] = bool(cfg.get("scalper_live_trading", False))
    out["scalper_lots"] = int(cfg.get("scalper_lots", 1))
    out["scalper_sl_pts"] = float(cfg.get("scalper_sl_pts", 18.0))
    out["scalper_target_pts"] = float(cfg.get("scalper_target_pts", 35.0))
    out["scalper_max_trades"] = int(cfg.get("scalper_max_trades", 2))
    out["scalper_stop_on_loss"] = bool(cfg.get("scalper_stop_on_loss", True))
    out["hourly_trend_paper_trading"] = bool(cfg.get("hourly_trend_paper_trading", False))
    out["hourly_trend_live_trading"] = bool(cfg.get("hourly_trend_live_trading", False))
    out["hourly_trend_lots"] = int(cfg.get("hourly_trend_lots", 1))
    out["trend_runner_paper_trading"] = bool(cfg.get("trend_runner_paper_trading", True))
    out["trend_runner_live_trading"] = bool(cfg.get("trend_runner_live_trading", False))
    out["trend_runner_lots"] = int(cfg.get("trend_runner_lots", 1))
    out["sensex_runner_paper_trading"] = bool(cfg.get("sensex_runner_paper_trading", True))
    out["sensex_runner_live_trading"] = bool(cfg.get("sensex_runner_live_trading", False))
    out["sensex_runner_lots"] = int(cfg.get("sensex_runner_lots", 1))
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
        "kill_switch": is_kill_switch_active(),
        "account_pnl": {
            "realized": _manual_number(overall.get("pl_realized")),
            "unrealized": _manual_number(overall.get("pl_unrealized")),
            "total": _manual_number(overall.get("pl_total")),
        },
        "positions": open_positions,
        "orders": orders,
    }



def load_scalp_targets() -> dict:
    if not SCALP_TARGETS_FILE.exists():
        return {}
    try:
        return json.loads(SCALP_TARGETS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_scalp_targets(targets: dict) -> None:
    SCALP_TARGETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    try:
        SCALP_TARGETS_FILE.write_text(json.dumps(targets, indent=2), encoding="utf-8")
    except Exception as exc:
        print(f"Error saving scalp targets: {exc}")


def set_scalp_target(symbol: str, tp_pts: float, tl_pts: float, entry_price: float = 0.0, qty: int = 0) -> dict:
    targets = load_scalp_targets()
    clean_sym = clean_option_symbol(symbol)
    raw_sym = symbol.replace("NSE:", "").replace("BSE:", "").strip()

    if tp_pts <= 0 and tl_pts <= 0:
        for k in (raw_sym, clean_sym, symbol):
            targets.pop(k, None)
        save_scalp_targets(targets)
        return {"ok": True, "symbol": raw_sym, "removed": True}

    tgt_px = round(entry_price + tp_pts, 2) if (entry_price > 0 and tp_pts > 0) else 0.0
    sl_px = round(max(0.05, entry_price - tl_pts), 2) if (entry_price > 0 and tl_pts > 0) else 0.0

    info = {
        "symbol": raw_sym,
        "clean_symbol": clean_sym,
        "tp_pts": float(tp_pts),
        "tl_pts": float(tl_pts),
        "entry_price": float(entry_price),
        "target_price": tgt_px,
        "stop_price": sl_px,
        "qty": int(qty),
        "updated_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
    }
    targets[raw_sym] = info
    targets[clean_sym] = info
    save_scalp_targets(targets)
    return {"ok": True, "symbol": raw_sym, "target": info}


def clear_scalp_target(symbol: str) -> None:
    targets = load_scalp_targets()
    clean_sym = clean_option_symbol(symbol)
    raw_sym = symbol.replace("NSE:", "").replace("BSE:", "").strip()
    changed = False
    for k in (raw_sym, clean_sym, symbol):
        if k in targets:
            targets.pop(k, None)
            changed = True
    if changed:
        save_scalp_targets(targets)


def update_tp_tl(body: dict) -> dict:
    symbol = str(body.get("symbol", "")).strip()
    if not symbol:
        raise ValueError("Missing symbol")
    try:
        tp_pts = max(0.0, float(body.get("tp_pts", 0.0)))
    except (ValueError, TypeError):
        tp_pts = 0.0
    try:
        tl_pts = max(0.0, float(body.get("tl_pts", body.get("ts_pts", body.get("sl_pts", 0.0)))))
    except (ValueError, TypeError):
        tl_pts = 0.0
    entry_price = float(body.get("entry_price") or 0.0)
    qty = int(body.get("qty") or 0)

    clean_sym = clean_option_symbol(symbol)
    raw_sym = symbol.replace("NSE:", "").replace("BSE:", "").strip()

    # Save to local targets tracker
    res = set_scalp_target(symbol, tp_pts=tp_pts, tl_pts=tl_pts, entry_price=entry_price, qty=qty)

    # If in LIVE mode with Kotak Neo, place or update existing Stop Loss order in Kotak Neo!
    cfg = read_config()
    is_live = bool(cfg.get("mode") == "LIVE" or cfg.get("scalper_live_trading"))
    kotak_msg = ""
    if is_live and tl_pts > 0:
        try:
            from kotak_orders import get_kotak_client, modify_kotak_order, place_kotak_sl_order, cancel_kotak_order
            client = get_kotak_client()
            if client:
                from broker import get_positions
                pos_data = get_positions()
                matched_pos = None
                for pos in pos_data.get("open_positions", []):
                    p_sym = str(pos.get("symbol", "")).strip()
                    if p_sym == raw_sym or p_sym == clean_sym or raw_sym in p_sym or clean_sym in p_sym:
                        matched_pos = pos
                        raw_sym = p_sym
                        break

                if matched_pos:
                    pos_qty = abs(int(matched_pos.get("net_qty", qty or 1)))
                    pos_entry = float(matched_pos.get("buy_avg", entry_price or 0.0))
                    prod = str(matched_pos.get("product") or "NRML")
                    ex_seg = str(matched_pos.get("exchange") or ("bse_fo" if "SENSEX" in raw_sym else "nse_fo"))

                    sl_trg = round(max(0.05, pos_entry - tl_pts), 1)
                    sl_limit = round(max(0.05, sl_trg - 2.0), 1)

                    # Look for existing open pending SELL order in Kotak order book
                    ord_rep = client.order_report()
                    existing_sl_order = None
                    if isinstance(ord_rep, dict) and ord_rep.get("data"):
                        for o in ord_rep["data"]:
                            o_sym = str(o.get("trdSym", ""))
                            o_st = str(o.get("ordSt", "")).lower()
                            o_side = str(o.get("trnsTp", "")).upper()
                            if (o_sym == raw_sym or raw_sym in o_sym) and o_side == "S" and o_st in ("open", "trigger pending", "pending", "trig_pend"):
                                existing_sl_order = o
                                break

                    if existing_sl_order:
                        ord_id = str(existing_sl_order.get("nOrdNo"))
                        modify_kotak_order(order_id=ord_id, price=sl_limit, trigger_price=sl_trg, qty=pos_qty, order_type="SL")
                        kotak_msg = f" (Updated Kotak SL order #{ord_id} @ ₹{sl_trg})"
                        set_scalp_target(raw_sym, tp_pts=tp_pts, tl_pts=tl_pts, entry_price=pos_entry, qty=pos_qty)
                    else:
                        ord_id, _ = place_kotak_sl_order(
                            symbol=raw_sym,
                            qty=pos_qty,
                            side=-1,
                            trigger_price=sl_trg,
                            price=sl_limit,
                            product=prod,
                            exchange_segment=ex_seg,
                        )
                        kotak_msg = f" (Placed Kotak SL order #{ord_id} @ ₹{sl_trg})"
                        set_scalp_target(raw_sym, tp_pts=tp_pts, tl_pts=tl_pts, entry_price=pos_entry, qty=pos_qty)
        except Exception as exc:
            print(f"Error updating Kotak SL order: {exc}")
            kotak_msg = f" (Kotak SL: {exc})"

    return {"ok": True, "message": f"Updated TP (+{tp_pts} pts) and TL (-{tl_pts} pts) for {symbol}{kotak_msg}", **res}


def scalp_tp_tl_sentinel_loop() -> None:
    """Continuously monitor active Kotak Neo & paper positions with TP/TL targets and exit automatically when reached."""
    while True:
        try:
            targets = load_scalp_targets()
            if targets:
                cfg = read_config()
                is_live = bool(cfg.get("mode") == "LIVE" or cfg.get("scalper_live_trading"))
                if is_live:
                    from broker import get_positions
                    pos_data = get_positions()
                    if pos_data.get("ok"):
                        open_positions = pos_data.get("open_positions", [])
                        active_syms = set()
                        for pos in open_positions:
                            sym = str(pos.get("symbol", "")).strip()
                            clean_sym = clean_option_symbol(sym)
                            active_syms.add(sym)
                            active_syms.add(clean_sym)

                            t_info = targets.get(sym) or targets.get(clean_sym)
                            if not t_info:
                                continue

                            tp_pts = float(t_info.get("tp_pts", 0.0))
                            tl_pts = float(t_info.get("tl_pts", 0.0))
                            if tp_pts <= 0 and tl_pts <= 0:
                                continue

                            cur_ltp = float(pos.get("ltp") or 0.0)
                            buy_avg = float(pos.get("buy_avg") or t_info.get("entry_price") or 0.0)
                            if buy_avg <= 0 or cur_ltp <= 0:
                                continue
                            qty = abs(int(pos.get("net_qty", 65)))
                            pts = round(cur_ltp - buy_avg, 2)

                            if tp_pts > 0 and pts >= tp_pts:
                                print(f"[{datetime.now(IST):%H:%M:%S}] [TP HIT] {clean_sym}: +{pts:.1f} pts >= +{tp_pts} pts (LTP: ₹{cur_ltp:.1f}, Buy: ₹{buy_avg:.1f}). Auto-exiting...")
                                try:
                                    exit_position({"symbol": sym, "qty": qty})
                                except Exception as exc:
                                    print(f"Error auto-exiting on TP: {exc}")
                                clear_scalp_target(sym)
                                clear_scalp_target(clean_sym)
                            elif tl_pts > 0 and pts <= -tl_pts:
                                print(f"[{datetime.now(IST):%H:%M:%S}] [TL HIT] {clean_sym}: {pts:.1f} pts <= -{tl_pts} pts (LTP: ₹{cur_ltp:.1f}, Buy: ₹{buy_avg:.1f}). Auto-exiting...")
                                try:
                                    exit_position({"symbol": sym, "qty": qty})
                                except Exception as exc:
                                    print(f"Error auto-exiting on TL: {exc}")
                                clear_scalp_target(sym)
                                clear_scalp_target(clean_sym)

                        for k in list(targets.keys()):
                            if k not in active_syms:
                                clear_scalp_target(k)
        except Exception:
            pass
        time.sleep(1)


def submit_scalp_order(body: dict) -> dict:
    """Execute scalper orders strictly as LIVE market trades via broker (Kotak Neo - Zero Brokerage). Never paper."""
    symbol = str(body.get("symbol", "NIFTY")).upper()
    action = str(body.get("action", "BUY")).upper()
    option_type = str(body.get("option_type", "CE")).upper()
    lots = max(1, int(body.get("lots", 1)))

    # Action EXIT or SELL -> Always execute real market exit directly on broker!
    if action in ("EXIT", "CLOSE", "SELL"):
        return exit_position(body)

    # Check Risk Guardian and Kill Switch before placing buy orders
    from risk_guardian import is_risk_locked
    locked, lock_info = is_risk_locked()
    if locked:
        lim = lock_info.get("limit", 2000)
        pnl_val = lock_info.get("pnl", 0)
        raise ManualTradeError(
            f"Risk Guardian Active: Max daily loss limit of Rs. {lim:,.0f} breached today (P&L: Rs. {pnl_val:+,.2f}). Trading locked and new positions will be auto-closed.",
            409,
        )
    if is_kill_switch_active():
        raise ManualTradeError("Emergency kill switch is active; new scalp orders are blocked.", 409)

    req_tp = body.get("tp") if body.get("tp") is not None else body.get("tgt_pts")
    req_ts = body.get("ts") if body.get("ts") is not None else body.get("sl_pts")
    try:
        sl_pts = float(req_ts) if req_ts is not None else 0.0
    except (ValueError, TypeError):
        sl_pts = 0.0
    try:
        tgt_pts = float(req_tp) if req_tp is not None else 0.0
    except (ValueError, TypeError):
        tgt_pts = 0.0

    st = status()
    if "SENSEX" in symbol:
        lot_size = 20
        spot_step = 100
        spot = float((st.get("sensex_last_tick") or {}).get("ltp") or 75000.0)
    else:
        lot_size = 65
        spot_step = 50
        spot = float((st.get("last_tick") or {}).get("ltp") or 23250.0)

    req_strike = body.get("strike")
    atm_strike = int(req_strike) if req_strike else int(round(spot / spot_step) * spot_step)

    # Resolve nearest expiry if not explicitly passed
    req_expiry = body.get("expiry")
    if not req_expiry:
        try:
            options = current_sensex_options() if "SENSEX" in symbol else current_nifty_options()
            current_date = datetime.now(IST).date()
            upcoming = sorted([d for d in options["expiry"].unique() if d >= current_date])
            if upcoming:
                req_expiry = upcoming[0].isoformat()
        except Exception as exc:
            print(f"Error resolving nearest expiry: {exc}")

    # Action BUY -> ALWAYS strictly LIVE order on broker (Kotak Neo - Zero Brokerage)
    body["confirm"] = "CONFIRM"
    body["order_type"] = "MARKET"
    body["lots"] = lots
    body["index_symbol"] = symbol
    body["strike"] = atm_strike
    body["expiry"] = req_expiry
    if sl_pts > 0:
        body["sl_pts"] = sl_pts
    if tgt_pts > 0:
        body["target_pts"] = tgt_pts

    res = submit_manual_order(body)
    if not isinstance(res, dict) or not res.get("ok"):
        raise ManualTradeError(f"Broker live order failed: {res}")

    raw_sym = str(res.get("symbol", "")).strip()
    fill_px = float(res.get("fill_price") or 0.0)
    if sl_pts > 0 or tgt_pts > 0:
        try:
            update_tp_tl({
                "symbol": raw_sym,
                "tp_pts": tgt_pts,
                "tl_pts": sl_pts,
                "entry_price": fill_px,
                "qty": res.get("qty", lots * lot_size),
            })
        except Exception as exc:
            print(f"Warning: could not set initial Kotak SL/TP: {exc}")

    return res

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

    if action == "BUY":
        from risk_guardian import is_risk_locked
        locked, lock_info = is_risk_locked()
        if locked:
            lim = lock_info.get("limit", 2000)
            pnl_val = lock_info.get("pnl", 0)
            raise ManualTradeError(
                f"Risk Guardian Active: Max daily loss limit of Rs. {lim:,.0f} breached today (P&L: Rs. {pnl_val:+,.2f}). Trading locked and new positions will be auto-closed.",
                409,
            )
        if is_kill_switch_active():
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
        product = str(body.get("product", "NRML"))
        ex_seg = "bse_fo" if ("SENSEX" in raw_symbol.upper() or contract.get("index_symbol") == "SENSEX") else "nse_fo"
        try:
            order_id, fill_price = place_kotak_order(symbol=raw_symbol, qty=quantity, side=side_val, product=product, exchange_segment=ex_seg)
            log_live_order_event(action, raw_symbol, quantity, order_id, fill_price, "MANUAL_ORDER", "LIVE")
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
            if isinstance(pos_resp, dict) and str(pos_resp.get("stat", "")).lower() == "ok":
                for r in pos_resp.get("data") or []:
                    trd_sym = str(r.get("trdSym", "")).strip()
                    r_clean = clean_option_symbol(trd_sym)
                    if (
                        trd_sym == clean_sym
                        or trd_sym == symbol
                        or r_clean == clean_sym
                        or clean_sym in trd_sym
                        or (clean_sym in ("NIFTY", "SENSEX") and clean_sym in trd_sym)
                    ):
                        b_q = int(r.get("flBuyQty", 0)) + int(r.get("cfBuyQty", 0))
                        s_q = int(r.get("flSellQty", 0)) + int(r.get("cfSellQty", 0))
                        if b_q != s_q:
                            matched_pos = r
                            clean_sym = trd_sym
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

        # Cancel any pending SL orders for this symbol so they don't trigger later
        try:
            ord_rep = client.order_report()
            if isinstance(ord_rep, dict) and ord_rep.get("data"):
                for o in ord_rep["data"]:
                    o_sym = str(o.get("trdSym", ""))
                    o_st = str(o.get("ordSt", "")).lower()
                    if (o_sym == clean_sym or clean_sym in o_sym) and o_st in ("open", "trigger pending", "pending", "trig_pend"):
                        client.cancel_order(order_id=str(o.get("nOrdNo")))
        except Exception as exc:
            print(f"Error cancelling pending SL orders on exit: {exc}")

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
                            clear_scalp_target(clean_sym)
                            clear_scalp_target(symbol)
                            log_live_order_event("SELL" if tt == "S" else "BUY", clean_sym, exit_qty, order_id, 0.0, "POSITION_EXIT", "LIVE")
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
    vix_q = q_data.get("vix", {})
    vix_last_tick = {
        "time": vix_q.get("time"),
        "ltp": vix_q.get("ltp"),
        "change": vix_q.get("change"),
        "per_change": vix_q.get("per_change"),
        "prev_close": vix_q.get("prev_close"),
    } if vix_q.get("ltp") else None

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
        "daily_loss_limit": cfg.get("daily_loss_limit", 2000),
        "kill_switch": is_kill_switch_active(),
        "risk_guardian": (lambda: (__import__("risk_guardian").check_and_enforce_guardian()))(),
        "last_tick": last_tick,
        "sensex_last_tick": sensex_last_tick,
        "vix_last_tick": vix_last_tick,
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
    st = status()

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
            sym_name = "SENSEX" if "SENSEX" in str(opt_name).upper() else "NIFTY"
            lot_size = 20 if sym_name == "SENSEX" else 65
            try:
                qty = int(float(row.get("qty") or (lots * lot_size)))
            except (ValueError, TypeError):
                qty = lots * lot_size

            buy_px = float(row.get("buy_price") or (105.0 if sym_name == "NIFTY" else 295.0))
            buy_val = round(buy_px * qty, 2)
            exit_tm = str(row.get("exit_time") or "").strip()
            is_open = not bool(exit_tm and exit_tm.lower() not in ("", "open", "none", "nan"))

            if is_open and entry_spot > 0:
                cur_spot = (st.get("sensex_last_tick") or {}).get("ltp") if sym_name == "SENSEX" else (st.get("last_tick") or {}).get("ltp")
                if cur_spot and float(cur_spot) > 0:
                    pts_diff = (float(cur_spot) - entry_spot) if side == "CALL" else (entry_spot - float(cur_spot))
                    est_opt_px = max(1.0, buy_px + pts_diff * 0.5)
                    sell_px = round(est_opt_px, 2)
                    sell_val = round(sell_px * qty, 2)
                    pnl_rs = round((sell_px - buy_px) * qty, 2)
                    pnl_pts = round(pts_diff, 2)
                    charges = 0.0
                    net_rs = pnl_rs
                else:
                    sell_px = buy_px
                    sell_val = buy_val
                    pnl_rs = 0.0
                    charges = 0.0
                    net_rs = 0.0
            else:
                sell_px = float(row.get("sell_price") or (buy_px + pnl_pts * 0.5))
                sell_val = round(sell_px * qty, 2)
                pnl_rs = round(float(row.get("pnl_rs") or (sell_val - buy_val)), 2)
                charges = float(row.get("charges_rs") or est_charges(buy_val, sell_val))
                net_rs = float(row.get("net_rs") or (pnl_rs - charges))

            sl_pts = float(cfg.get("scalper_sl_pts", 18.0))
            tgt_pts = float(cfg.get("scalper_target_pts", 35.0))

            sl_val = row.get("sl")
            try:
                sl_f = float(sl_val) if sl_val not in (None, "", "nan", "null") else None
                sl_spot = sl_f if (sl_f is not None and not math.isnan(sl_f) and not math.isinf(sl_f)) else (round(entry_spot - sl_pts if side == "CALL" else entry_spot + sl_pts, 2) if entry_spot > 0 else None)
            except (ValueError, TypeError):
                sl_spot = round(entry_spot - sl_pts if side == "CALL" else entry_spot + sl_pts, 2) if entry_spot > 0 else None

            tgt_val = row.get("target")
            try:
                tgt_f = float(tgt_val) if tgt_val not in (None, "", "nan", "null") else None
                tgt_spot = tgt_f if (tgt_f is not None and not math.isnan(tgt_f) and not math.isinf(tgt_f)) else (round(entry_spot + tgt_pts if side == "CALL" else entry_spot - tgt_pts, 2) if entry_spot > 0 else None)
            except (ValueError, TypeError):
                tgt_spot = round(entry_spot + tgt_pts if side == "CALL" else entry_spot - tgt_pts, 2) if entry_spot > 0 else None

            out.append({
                "date": r_date,
                "side": side,
                "option": opt_name,
                "qty": qty,
                "entry": str(row.get("entry_time") or row.get("entry", ""))[:5],
                "nifty_in": entry_spot,
                "buy_price": buy_px,
                "buy_value_rs": buy_val,
                "exit": "" if is_open else str(row.get("exit_time") or row.get("exit", ""))[:5],
                "nifty_out": exit_spot,
                "sell_price": sell_px,
                "sell_value_rs": sell_val,
                "pnl_rs": pnl_rs,
                "option_pnl_rs": pnl_rs,
                "nifty_points": pnl_pts,
                "exit_reason": "open" if is_open else row.get("exit_reason", "closed"),
                "mode": "MICRO SCALPER PAPER",
                "spot_at_entry": entry_spot,
                "trigger_label": "Micro Scalp · paper",
                "sl": sl_spot,
                "target": tgt_spot,
                "charges_rs": charges,
                "net_rs": net_rs,
                "strategy": f"scalp_{sym_name.lower()}",
                "symbol": sym_name,
                "is_open": is_open,
            })
        except Exception as exc:
            print(f"Error processing paper trade row: {exc}")
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
            opt_name = str(row.get("option") or "")
            opt_symbol = str(row.get("option_symbol") or "").strip()
            if opt_symbol:
                opt_name = opt_symbol

            m = re.search(r"NIFTY\s+(\d+)\s+(CE|PE)", opt_name, re.IGNORECASE)
            if m:
                strike = int(m.group(1))
                opt_type = m.group(2).upper()
            else:
                opt_type = "CE" if side == "CALL" else "PE"
                strike = int(round((entry_spot - 150 if side == "CALL" else entry_spot + 150) / 50.0) * 50)
                if not opt_symbol:
                    opt_name = f"NIFTY {strike} {opt_type} (ITM-150)"

            opt_entry_px = float(row.get("option_entry_price") or 0.0)
            opt_exit_px = float(row.get("option_exit_price") or 0.0)

            is_open = str(row.get("exit_reason", "")).lower() == "open" or not row.get("exit_time")
            if is_open:
                buy_px = round(opt_entry_px, 2) if opt_entry_px > 0 else round(entry_spot, 2)
                sell_px = 0.0
                buy_val = round(buy_px * qty, 2)
                sell_val = 0.0
                pnl_rs = 0.0
                charges = 0.0
                net_rs = 0.0
            elif opt_entry_px > 0 and opt_exit_px > 0:
                buy_px = round(opt_entry_px, 2)
                sell_px = round(opt_exit_px, 2)
                buy_val = round(buy_px * qty, 2)
                sell_val = round(sell_px * qty, 2)
                pnl_rs = float(row.get("pnl_rupees") or round((sell_px - buy_px) * qty, 2))
                charges = est_charges(buy_val, sell_val)
                net_rs = round(pnl_rs - charges, 2)
            else:
                continue
            init_sl = float(row.get("initial_sl") or (entry_spot - 28.0 if side == "CALL" else entry_spot + 28.0))
            tgt_spot = round(entry_spot + 200.0 if side == "CALL" else entry_spot - 200.0, 2)

            futures_pnl = round(pnl_pts * qty, 2)
            opt_pnl = float(row.get("option_pnl_rupees") or pnl_rs)
            diff = round(futures_pnl - opt_pnl, 2)

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
                "futures_pnl_rs": futures_pnl,
                "option_pnl_rs": opt_pnl,
                "diff_rs": diff,
                "nifty_points": pnl_pts,
                "exit_reason": row.get("exit_reason", ""),
                "mode": "TREND CATCHER PAPER",
                "spot_at_entry": entry_spot,
                "trigger_label": "Trend Catcher · Paper",
                "sl": init_sl,
                "target": tgt_spot,
                "charges_rs": charges,
                "net_rs": net_rs,
                "strategy": "trend_runner_nifty",
                "symbol": "NIFTY",
                "is_open": is_open,
            })
        except Exception:
            continue
    return out


def trend_runner_paper_report() -> dict:
    return build_paper_report(trend_runner_live_paper_trades())


def sensex_runner_live_paper_trades(date: str | None = None) -> list:
    """Read logged Sensex Trend Runner paper trades and format as OptionTrade dicts."""
    csv_paths = [
        ROOT / "captured_data" / "fyers" / "live" / "trend_runner_sensex_live_paper.csv",
        ROOT / "performance" / "trend_runner_sensex_paper_trades.csv",
    ]
    raw_rows = []
    seen = set()
    for cp in csv_paths:
        if cp.exists():
            for r in read_csv_rows(cp):
                k = (r.get("date"), r.get("entry_time"), r.get("side"))
                if k not in seen:
                    seen.add(k)
                    raw_rows.append(r)

    out = []
    for row in raw_rows:
        try:
            r_date = str(row.get("date") or "")
            if date and r_date != date:
                continue

            side_raw = str(row.get("side") or "").upper()
            side = "CALL" if side_raw in ("LONG", "CALL", "CE") else "PUT"
            entry_spot = round(float(row.get("entry_price") or 0.0), 2)
            exit_spot = round(float(row.get("exit_price") or 0.0), 2)
            pnl_pts = round(float(row.get("pnl_points") or 0.0), 2)
            qty = int(row.get("qty") or (int(row.get("total_lots") or 1) * 20))

            opt_name = str(row.get("option") or "")
            opt_symbol = str(row.get("option_symbol") or "")
            m = re.search(r"SENSEX\s+(\d+)\s+(CE|PE)", opt_name, re.IGNORECASE)
            if m:
                strike = int(m.group(1))
                opt_type = m.group(2).upper()
            else:
                opt_type = "CE" if side == "CALL" else "PE"
                strike = int(round(entry_spot / 100.0) * 100)
                if not opt_name:
                    opt_name = f"SENSEX {strike} {opt_type} (ATM)"

            opt_entry_px = float(row.get("option_entry_price") or 0.0)
            opt_exit_px = float(row.get("option_exit_price") or 0.0)

            is_open = str(row.get("exit_reason", "")).lower() == "open" or not row.get("exit_time")
            if is_open:
                buy_px = round(opt_entry_px, 2) if opt_entry_px > 0 else round(entry_spot, 2)
                sell_px = 0.0
                buy_val = round(buy_px * qty, 2)
                sell_val = 0.0
                pnl_rs = 0.0
                charges = 0.0
                net_rs = 0.0
            elif opt_entry_px > 0 and opt_exit_px > 0:
                buy_px = round(opt_entry_px, 2)
                sell_px = round(opt_exit_px, 2)
                buy_val = round(buy_px * qty, 2)
                sell_val = round(sell_px * qty, 2)
                pnl_rs = float(row.get("pnl_rupees") or round((sell_val - buy_val), 2))
                charges = est_charges(buy_val, sell_val)
                net_rs = round(pnl_rs - charges, 2)
            else:
                continue
            init_sl = float(row.get("initial_sl") or (entry_spot - 120.0 if side == "CALL" else entry_spot + 120.0))
            tgt_spot = round(entry_spot + 700.0 if side == "CALL" else entry_spot - 700.0, 2)

            futures_pnl = round(pnl_pts * qty, 2)
            opt_pnl = float(row.get("option_pnl_rupees") or pnl_rs)
            diff = round(futures_pnl - opt_pnl, 2)

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
                "futures_pnl_rs": futures_pnl,
                "option_pnl_rs": opt_pnl,
                "diff_rs": diff,
                "nifty_points": pnl_pts,
                "exit_reason": row.get("exit_reason", ""),
                "mode": "SENSEX RUNNER PAPER",
                "spot_at_entry": entry_spot,
                "trigger_label": "Sensex Runner · Paper",
                "sl": init_sl,
                "target": tgt_spot,
                "charges_rs": charges,
                "net_rs": net_rs,
                "strategy": "trend_runner_sensex",
                "symbol": "SENSEX",
                "is_open": is_open,
            })
        except Exception:
            continue
    return out


def sensex_runner_paper_report() -> dict:
    return build_paper_report(sensex_runner_live_paper_trades())


def sensex_runner_backtest_report() -> dict:
    """Backtest performance for Sensex Trend Runner."""
    csv_path = ROOT / "performance" / "sensex_backtest_trades.csv"
    return vix_trend_runner_backtest_report(csv_path, lot_size=10, option_delta=0.60)


def sensex_key_levels_backtest_report() -> dict:
    """Backtest performance for Sensex Key Levels S&R + Reverse Retry."""
    csv_path = ROOT / "performance" / "sensex_key_levels_trades.csv"
    return vix_trend_runner_backtest_report(csv_path, lot_size=10, option_delta=0.50)


def sensex_key_levels_live_paper_trades(date: str | None = None) -> list:
    """Read logged Sensex Key Levels paper trades and format as OptionTrade dicts."""
    csv_paths = [
        ROOT / "captured_data" / "fyers" / "live" / "sensex_key_levels_live_paper.csv",
        ROOT / "performance" / "sensex_key_levels_paper_trades.csv",
    ]
    raw_rows = []
    seen = set()
    for cp in csv_paths:
        if cp.exists():
            for r in read_csv_rows(cp):
                k = (r.get("date"), r.get("entry_time"), r.get("side"), r.get("level"))
                if k not in seen:
                    seen.add(k)
                    raw_rows.append(r)

    out = []
    qty = 10
    for row in raw_rows:
        try:
            r_date = str(row.get("date") or "")
            if date and r_date != date:
                continue

            side_raw = str(row.get("side") or "").upper()
            side = "CALL" if side_raw in ("LONG", "CALL", "CE") else "PUT"
            entry_spot = round(float(row.get("entry_price") or 0.0), 2)
            exit_spot = round(float(row.get("exit_price") or 0.0), 2)
            pnl_pts = round(float(row.get("pnl_points") or 0.0), 2)
            lvl = float(row.get("level") or 0.0)
            ttype = str(row.get("type") or "")

            strike = int(round(lvl / 100.0) * 100) if lvl > 0 else int(round(entry_spot / 100.0) * 100)
            opt_type = "CE" if side == "CALL" else "PE"
            opt_name = str(row.get("option") or f"SENSEX {strike} {opt_type}")

            opt_entry_px = float(row.get("option_entry_price") or 350.0)
            opt_exit_px = float(row.get("option_exit_price") or 0.0)
            if opt_exit_px <= 0:
                delta = 0.55
                opt_pts = round(pnl_pts * delta, 2)
                opt_exit_px = max(5.0, opt_entry_px + opt_pts)

            buy_px = round(opt_entry_px, 2)
            sell_px = round(opt_exit_px, 2)
            buy_val = round(buy_px * qty, 2)
            sell_val = round(sell_px * qty, 2)

            pnl_rs = float(row.get("pnl_rupees") or round((sell_val - buy_val), 2))
            charges = est_charges(buy_val, sell_val)
            net_rs = round(pnl_rs - charges, 2)
            init_sl = float(row.get("sl") or 0.0)
            tgt_spot = float(row.get("target") or 0.0)

            futures_pnl = round(pnl_pts * qty, 2)
            opt_pnl = pnl_rs
            diff = round(futures_pnl - opt_pnl, 2)

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
                "futures_pnl_rs": futures_pnl,
                "option_pnl_rs": opt_pnl,
                "diff_rs": diff,
                "nifty_points": pnl_pts,
                "exit_reason": row.get("exit_reason", ""),
                "mode": "SENSEX KEY LEVELS PAPER",
                "spot_at_entry": entry_spot,
                "trigger_label": f"Key Level {int(lvl)} · {ttype}",
                "sl": init_sl,
                "target": tgt_spot,
                "charges_rs": charges,
                "net_rs": net_rs,
                "strategy": "sensex_key_levels",
                "symbol": "SENSEX",
                "is_open": (str(row.get("exit_reason", "")).lower() == "open" or not row.get("exit_time")),
            })
        except Exception:
            continue
    return out


def sensex_key_levels_paper_report() -> dict:
    return build_paper_report(sensex_key_levels_live_paper_trades())


def nifty_key_levels_backtest_report() -> dict:
    """Backtest performance for Nifty Key Levels S&R + Reverse Retry."""
    csv_path = ROOT / "performance" / "nifty_key_levels_trades.csv"
    return vix_trend_runner_backtest_report(csv_path, lot_size=25, option_delta=0.50)


def nifty_key_levels_live_paper_trades(date: str | None = None) -> list:
    """Read logged Nifty Key Levels paper trades and format as OptionTrade dicts."""
    csv_paths = [
        ROOT / "captured_data" / "fyers" / "live" / "nifty_key_levels_live_paper.csv",
        ROOT / "performance" / "nifty_key_levels_paper_trades.csv",
    ]
    raw_rows = []
    seen = set()
    for cp in csv_paths:
        if cp.exists():
            for r in read_csv_rows(cp):
                k = (r.get("date"), r.get("entry_time"), r.get("side"), r.get("level"))
                if k not in seen:
                    seen.add(k)
                    raw_rows.append(r)

    out = []
    qty = 25
    for row in raw_rows:
        try:
            r_date = str(row.get("date") or "")
            if date and r_date != date:
                continue

            side_raw = str(row.get("side") or "").upper()
            side = "CALL" if side_raw in ("LONG", "CALL", "CE") else "PUT"
            entry_spot = round(float(row.get("entry_price") or 0.0), 2)
            exit_spot = round(float(row.get("exit_price") or 0.0), 2)
            pnl_pts = round(float(row.get("pnl_points") or 0.0), 2)
            lvl = float(row.get("level") or 0.0)
            ttype = str(row.get("type") or "")

            strike = int(round(lvl / 50.0) * 50) if lvl > 0 else int(round(entry_spot / 50.0) * 50)
            opt_type = "CE" if side == "CALL" else "PE"
            opt_name = str(row.get("option") or f"NIFTY {strike} {opt_type}")

            opt_entry_px = float(row.get("option_entry_price") or 120.0)
            opt_exit_px = float(row.get("option_exit_price") or 0.0)
            if opt_exit_px <= 0:
                delta = 0.50
                opt_pts = round(pnl_pts * delta, 2)
                opt_exit_px = max(2.0, opt_entry_px + opt_pts)

            buy_px = round(opt_entry_px, 2)
            sell_px = round(opt_exit_px, 2)
            buy_val = round(buy_px * qty, 2)
            sell_val = round(sell_px * qty, 2)

            pnl_rs = float(row.get("pnl_rupees") or round((sell_val - buy_val), 2))
            charges = est_charges(buy_val, sell_val)
            net_rs = round(pnl_rs - charges, 2)
            init_sl = float(row.get("sl") or 0.0)
            tgt_spot = float(row.get("target") or 0.0)

            futures_pnl = round(pnl_pts * qty, 2)
            opt_pnl = pnl_rs
            diff = round(futures_pnl - opt_pnl, 2)

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
                "futures_pnl_rs": futures_pnl,
                "option_pnl_rs": opt_pnl,
                "diff_rs": diff,
                "nifty_points": pnl_pts,
                "exit_reason": row.get("exit_reason", ""),
                "mode": "NIFTY KEY LEVELS PAPER",
                "spot_at_entry": entry_spot,
                "trigger_label": f"Key Level {int(lvl)} · {ttype}",
                "sl": init_sl,
                "target": tgt_spot,
                "charges_rs": charges,
                "net_rs": net_rs,
                "strategy": "nifty_key_levels",
                "symbol": "NIFTY",
                "is_open": (str(row.get("exit_reason", "")).lower() == "open" or not row.get("exit_time")),
            })
        except Exception:
            continue
    return out


def nifty_key_levels_paper_report() -> dict:
    return build_paper_report(nifty_key_levels_live_paper_trades())


def nifty_key_levels_spot_trades_for_day(date: str) -> list:
    """Historical spot trades for Nifty Key Levels on date."""
    for fname in ["nifty_key_levels_trades.csv", "nifty_key_levels_paper_trades.csv"]:
        csv_path = ROOT / "performance" / fname
        if not csv_path.exists():
            continue
        out = []
        for r in read_csv_rows(csv_path):
            if r.get("date") == date:
                side = str(r.get("side", "CALL"))
                entry_spot = float(r.get("entry_price") or 0.0)
                exit_spot = float(r.get("exit_price") or 0.0)
                sl_spot = float(r.get("sl") or 0.0)
                tgt_spot = float(r.get("target") or 0.0)
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
                    "setup": str(r.get("setup") or r.get("type", "")),
                    "level": float(r.get("level") or 0.0),
                })
        if out:
            return out
    return []


def compression_scalp_spot_trades_for_day(date: str) -> list:
    """Historical spot trades for backtest chart display on date."""
    csv_path = ROOT / "performance" / "compression_scalp_trades.csv"
    if not csv_path.exists():
        return []
    cfg = read_config()
    sl_pts = float(cfg.get("scalper_sl_pts", 18.0))
    tgt_pts = float(cfg.get("scalper_target_pts", 35.0))
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
    sl_pts = float(cfg.get("scalper_sl_pts", 18.0))
    tgt_pts = float(cfg.get("scalper_target_pts", 35.0))
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
            "option_delta": option_delta,
        },
        "trades": trades,
        "daily": sorted_daily,
        "monthly": sorted_monthly,
        "exit_reasons": sorted_reasons,
    }


def nifty_10y_backtest_report() -> dict:
    """Historical 10-Year backtest performance (2017-2026) for Nifty Trend Expansion Runner."""
    return vix_trend_runner_backtest_report(ROOT / "performance" / "nifty_10y_backtest_trades.csv")


def nifty_btst_backtest_report() -> dict:
    """Historical 10-Year backtest performance (2017-2026) for Nifty Overnight BTST Gap Strategy."""
    return vix_trend_runner_backtest_report(ROOT / "performance" / "nifty_btst_trades.csv", lot_size=25)


def sensex_btst_backtest_report() -> dict:
    """Historical Multi-Year backtest performance (2023-2026) for Sensex Overnight BTST Gap Strategy."""
    return vix_trend_runner_backtest_report(ROOT / "performance" / "sensex_btst_trades.csv", lot_size=10)


def vix_divergence_backtest_report() -> dict:
    """Historical 10-Year backtest performance (2017-2026) for VIX Trap Divergence (1-Lot Baseline)."""
    return vix_trend_runner_backtest_report(
        ROOT / "performance" / "vix_divergence_backtest_trades.csv",
        lot_size=25,
        option_delta=0.60,
        use_weighted=False
    )


def nifty_vix_master_backtest_report() -> dict:
    """Historical 10-Year backtest performance (2017-2026) for Unified VIX Master Strategy (Nifty)."""
    return vix_trend_runner_backtest_report(
        ROOT / "performance" / "nifty_vix_master_trades.csv",
        lot_size=25,
        option_delta=0.60,
        use_weighted=True
    )


def sensex_vix_master_backtest_report() -> dict:
    """Historical 4-Year backtest performance (2023-2026) for Unified VIX Master Strategy (Sensex)."""
    return vix_trend_runner_backtest_report(
        ROOT / "performance" / "sensex_vix_master_trades.csv",
        lot_size=10,
        option_delta=0.60,
        use_weighted=True
    )


def master_portfolio_backtest_report(symbol: str = "nifty") -> dict:
    """Historical backtest performance for Unified Master Portfolio Suite (VIX Master + Gap-and-Go Williams)."""
    csv_path = ROOT / "performance" / f"master_portfolio_{symbol.lower()}_trades.csv"
    if not csv_path.exists():
        csv_path = ROOT / "performance" / "master_portfolio_nifty_trades.csv"
    return vix_trend_runner_backtest_report(
        csv_path,
        lot_size=10 if symbol.lower() == "sensex" else 25,
        option_delta=0.60,
        use_weighted=False
    )


def gap_and_go_backtest_report(symbol: str = "nifty") -> dict:
    """Historical backtest performance for Gap-and-Go -> Williams Chain."""
    is_sx = symbol.lower() == "sensex"
    csv_path = ROOT / "performance" / ("gap_and_go_sensex_trades.csv" if is_sx else "gap_and_go_williams_official_trades.csv")
    if not csv_path.exists():
        csv_path = ROOT / "performance" / "gap_and_go_williams_official_trades.csv"
    if not csv_path.exists():
        return {"summary": {}, "trades": [], "monthly": [], "daily": [], "exit_reasons": []}

    raw_trades = read_csv_rows(csv_path)
    trades, equity, peak = [], 0.0, 0.0
    daily_map = {}
    monthly_map = {}
    reasons_map = {}
    lot_size = 10 if is_sx else 25
    option_delta = 0.72

    for r in raw_trades:
        try:
            r_date = str(r.get("date", ""))
            side = "CALL" if str(r.get("type", "")).upper() == "CE" else "PUT"
            entry_spot = round(float(r.get("entry_spot") or r.get("entry_price") or 0.0), 2)
            exit_spot = round(float(r.get("exit_spot") or r.get("exit_price") or 0.0), 2)
            pnl_pts = round(float(r.get("spot_pts") or r.get("pnl_points") or 0.0), 2)
            opt_pts = round(float(r.get("net_pts_base") or r.get("net_pts") or (pnl_pts * option_delta)), 2)
            
            equity += pnl_pts
            peak = max(peak, equity)
            reason = str(r.get("exit_reason", ""))
            
            sl_spot = round(entry_spot - 28.0 if side == "CALL" else entry_spot + 28.0, 2)
            tgt_spot = round(entry_spot + 200.0 if side == "CALL" else entry_spot - 200.0, 2)
            
            opt_rs = round(opt_pts * lot_size, 2)
            fut_rs = round(pnl_pts * lot_size, 2)

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
                "base_points": pnl_pts,
                "pnl_rupees": opt_rs,
                "futures_rupees": fut_rs,
                "lots": 1,
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
            "option_delta": option_delta,
        },
        "trades": trades,
        "daily": sorted_daily,
        "monthly": sorted_monthly,
        "exit_reasons": sorted_reasons,
    }


def vix_master_spot_trades_for_day(date: str, symbol: str = "NIFTY") -> list:
    """Historical spot trades for Unified VIX Master Strategy on date."""
    fname = "sensex_vix_master_trades.csv" if symbol.upper() == "SENSEX" else "nifty_vix_master_trades.csv"
    csv_path = ROOT / "performance" / fname
    if not csv_path.exists():
        return []
    out = []
    for r in read_csv_rows(csv_path):
        if r.get("date") == date:
            side = str(r.get("side", "CALL"))
            entry_spot = float(r.get("entry_price") or 0.0)
            exit_spot = float(r.get("exit_price") or 0.0)
            sl_spot = float(r.get("initial_sl") or 0.0)
            tgt_spot = float(r.get("target") or 0.0)
            pts = float(r.get("weighted_pnl_points") or r.get("pnl_points") or 0.0)
            out.append({
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": str(r.get("exit_reason", "")),
                "pnl_points": pts,
                "base_points": float(r.get("pnl_points") or 0.0),
                "lots": int(r.get("total_lots") or 1),
                "stage": str(r.get("stage", "")),
                "origin": str(r.get("origin", ""))
            })
    return out

def master_portfolio_spot_trades_for_day(date: str, symbol: str = "NIFTY") -> list:
    """Spot trades for Master Portfolio Suite on date with engine & trigger attribution."""
    is_sx = symbol.upper() == "SENSEX"
    fname = "master_portfolio_sensex_trades.csv" if is_sx else "master_portfolio_nifty_trades.csv"
    csv_path = ROOT / "performance" / fname
    if not csv_path.exists():
        fname = "master_portfolio_nifty_trades.csv"
        csv_path = ROOT / "performance" / fname
    if not csv_path.exists():
        return []
    out = []
    for r in read_csv_rows(csv_path):
        if r.get("date") == date:
            side = str(r.get("side", "CALL"))
            if side not in ("CALL", "PUT"):
                side = "CALL" if str(r.get("side", "")).upper() == "LONG" or "CE" in str(r.get("option", "")).upper() else "PUT"
            entry_spot = float(r.get("entry_price") or r.get("entry_spot") or 0.0)
            exit_spot = float(r.get("exit_price") or r.get("exit_spot") or 0.0)
            sl_spot = float(r.get("final_sl") or r.get("initial_sl") or (entry_spot - 28.0 if side == "CALL" else entry_spot + 28.0))
            tgt_spot = float(r.get("target") or (entry_spot + 200.0 if side == "CALL" else entry_spot - 200.0))
            pts = float(r.get("pnl_points") or r.get("spot_pts") or 0.0)
            engine = str(r.get("engine") or r.get("origin") or "MASTER")
            stage = str(r.get("stage") or "")
            label = str(r.get("strategy_label") or "")
            if not label or label.lower() == "nan":
                if "GAP" in engine.upper() or "GAP" in stage.upper():
                    label = "Gap-and-Go" if "GAP_AND_GO" in stage.upper() else "Williams Fractal"
                else:
                    label = "VIX Master"
            
            trig_label = str(r.get("trigger_label") or f"[{label}] BUY {side}")
            trig_reason = str(r.get("trigger_reason") or label)
            out.append({
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": str(r.get("exit_reason", "")),
                "pnl_points": pts,
                "base_points": pts,
                "lots": int(r.get("total_lots") or 1),
                "stage": stage,
                "engine": engine,
                "strategy_label": label,
                "trigger_label": trig_label,
                "trigger_reason": trig_reason
            })
    return out


def gap_and_go_spot_trades_for_day(date: str, symbol: str = "NIFTY") -> list:
    """Spot trades for Gap-and-Go -> Williams strategy on date."""
    is_sx = symbol.upper() == "SENSEX"
    fname = "gap_and_go_sensex_trades.csv" if is_sx else "gap_and_go_williams_official_trades.csv"
    csv_path = ROOT / "performance" / fname
    if not csv_path.exists():
        csv_path = ROOT / "performance" / "gap_and_go_williams_official_trades.csv"
    if not csv_path.exists():
        return []
    out = []
    for r in read_csv_rows(csv_path):
        if r.get("date") == date:
            side = "CALL" if str(r.get("type", "")).upper() == "CE" else "PUT"
            entry_spot = float(r.get("entry_spot") or r.get("entry_price") or 0.0)
            exit_spot = float(r.get("exit_spot") or r.get("exit_price") or 0.0)
            sl_spot = round(entry_spot - 28.0 if side == "CALL" else entry_spot + 28.0, 2)
            tgt_spot = round(entry_spot + 200.0 if side == "CALL" else entry_spot - 200.0, 2)
            pts = float(r.get("spot_pts") or r.get("pnl_points") or 0.0)
            stage = str(r.get("stage", ""))
            label = "Gap-and-Go" if "GAP" in stage.upper() else "Williams Fractal"
            out.append({
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": str(r.get("exit_reason", "")),
                "pnl_points": pts,
                "base_points": pts,
                "lots": 1,
                "stage": stage,
                "engine": "GAP_WILLIAMS",
                "strategy_label": label,
                "trigger_label": f"[{label}] {side} Trigger"
            })
    return out




def sensex_vix_divergence_backtest_report() -> dict:
    """Historical 4-Year backtest performance (2023-2026) for Sensex VIX Trap Divergence (1-Lot Baseline)."""
    return vix_trend_runner_backtest_report(
        ROOT / "performance" / "sensex_vix_divergence_trades.csv",
        lot_size=10,
        option_delta=0.60,
        use_weighted=False
    )


def aggressive_midpoint_scalp_report(key_level_only: bool = False) -> dict:
    """Historical backtest performance for Aggressive Morning Midpoint & Key Level Scalp."""
    filename = "aggressive_key_level_trades.csv" if key_level_only else "aggressive_midpoint_scalp_trades.csv"
    csv_path = ROOT / "performance" / filename
    if not csv_path.exists():
        return {"summary": {}, "trades": [], "monthly": [], "daily": [], "exit_reasons": []}

    raw_trades = read_csv_rows(csv_path)
    trades, equity, peak = [], 0.0, 0.0
    daily_map = {}
    monthly_map = {}
    reasons_map = {}
    lot_size = 65

    for r in raw_trades:
        try:
            r_date = str(r.get("date", ""))
            side = str(r.get("side", "CALL"))
            entry_spot = round(float(r.get("entry") or 0.0), 2)
            exit_spot = round(float(r.get("exit_price") or 0.0), 2)
            sl_spot = round(float(r.get("stop") or 0.0), 2)
            tgt_spot = round(float(r.get("target") or 0.0), 2)
            pnl_pts = round(float(r.get("pnl_points") or 0.0), 2)
            equity += pnl_pts
            peak = max(peak, equity)
            reason = str(r.get("reason", ""))

            trade_item = {
                "date": r_date,
                "side": side,
                "setup": str(r.get("setup", "")),
                "entry": str(r.get("entry_time", "")),
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", "")),
                "exit_price": exit_spot,
                "reason": reason,
                "pnl_points": pnl_pts,
                "equity": round(equity, 2),
                "drawdown": round(equity - peak, 2),
                "bars_held": int(r.get("bars_held", 0)),
            }
            trades.append(trade_item)

            if r_date not in daily_map:
                daily_map[r_date] = {"date": r_date, "points": 0.0, "trades": 0}
            daily_map[r_date]["points"] = round(daily_map[r_date]["points"] + pnl_pts, 2)
            daily_map[r_date]["trades"] += 1

            m_key = r_date[:7]
            monthly_map[m_key] = round(monthly_map.get(m_key, 0.0) + pnl_pts, 2)
            reasons_map[reason] = reasons_map.get(reason, 0) + 1
        except Exception:
            continue

    n = len(trades)
    wins = sum(1 for x in trades if x["pnl_points"] > 0)
    sorted_daily = sorted(daily_map.values(), key=lambda d: d["date"])
    sorted_monthly = [{"month": m, "points": pts} for m, pts in sorted(monthly_map.items())]
    sorted_reasons = [{"reason": reason, "count": count} for reason, count in sorted(reasons_map.items(), key=lambda item: -item[1])]

    return {
        "summary": {
            "strategy": "Aggressive Morning Midpoint & Key Level Scalp",
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
            "option_delta": option_delta,
        },
        "trades": trades,
        "daily": sorted_daily,
        "monthly": sorted_monthly,
        "exit_reasons": sorted_reasons,
    }


def c1_pdc_retest_report() -> dict:
    """Historical backtest performance for C1 Color + PDC Break & Retest."""
    csv_path = ROOT / "performance" / "c1_pdc_retest_trades.csv"
    if not csv_path.exists():
        return {"summary": {}, "trades": [], "monthly": [], "daily": [], "exit_reasons": []}

    raw_trades = read_csv_rows(csv_path)
    trades, equity, peak = [], 0.0, 0.0
    daily_map = {}
    monthly_map = {}
    reasons_map = {}
    lot_size = 65

    for r in raw_trades:
        try:
            r_date = str(r.get("date", ""))
            side = str(r.get("side", "CALL"))
            entry_spot = round(float(r.get("entry") or 0.0), 2)
            exit_spot = round(float(r.get("exit_price") or 0.0), 2)
            sl_spot = round(float(r.get("stop") or 0.0), 2)
            tgt_spot = round(float(r.get("target") or 0.0), 2)
            pnl_pts = round(float(r.get("pnl_points") or 0.0), 2)
            equity += pnl_pts
            peak = max(peak, equity)
            reason = str(r.get("reason", ""))
            c1_col = str(r.get("c1_color", ""))
            pdc_val = str(r.get("pdc", ""))

            trade_item = {
                "date": r_date,
                "side": side,
                "setup": f"C1_{c1_col}_PDC_RETEST",
                "entry": str(r.get("entry_time", "")),
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", "")),
                "exit_price": exit_spot,
                "reason": reason,
                "pnl_points": pnl_pts,
                "equity": round(equity, 2),
                "drawdown": round(equity - peak, 2),
                "bars_held": int(r.get("bars_held", 0)),
            }
            trades.append(trade_item)

            if r_date not in daily_map:
                daily_map[r_date] = {"date": r_date, "points": 0.0, "trades": 0}
            daily_map[r_date]["points"] = round(daily_map[r_date]["points"] + pnl_pts, 2)
            daily_map[r_date]["trades"] += 1

            m_key = r_date[:7]
            monthly_map[m_key] = round(monthly_map.get(m_key, 0.0) + pnl_pts, 2)
            reasons_map[reason] = reasons_map.get(reason, 0) + 1
        except Exception:
            continue

    n = len(trades)
    wins = sum(1 for x in trades if x["pnl_points"] > 0)
    sorted_daily = sorted(daily_map.values(), key=lambda d: d["date"])
    sorted_monthly = [{"month": m, "points": pts} for m, pts in sorted(monthly_map.items())]
    sorted_reasons = [{"reason": reason, "count": count} for reason, count in sorted(reasons_map.items(), key=lambda item: -item[1])]

    return {
        "summary": {
            "strategy": "C1 Color + PDC Break & Retest",
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
            "option_delta": option_delta,
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
            "option_delta": option_delta,
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
    for fname in ["trend_runner_paper_trades.csv", "nifty_10y_backtest_trades.csv", "vix_trend_runner_trades.csv"]:
        csv_path = ROOT / "performance" / fname
        if not csv_path.exists():
            continue
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
        if out:
            return out
    return []


def sensex_vix_divergence_spot_trades_for_day(date: str) -> list:
    """Historical spot trades for Sensex VIX Trap Divergence on date."""
    csv_path = ROOT / "performance" / "sensex_vix_divergence_trades.csv"
    if not csv_path.exists():
        return []
    out = []
    for r in read_csv_rows(csv_path):
        if r.get("date") == date:
            side = str(r.get("side", "CALL"))
            entry_spot = float(r.get("entry_price") or 0.0)
            exit_spot = float(r.get("exit_price") or 0.0)
            sl_spot = float(r.get("initial_sl") or (entry_spot - 100.0 if side == "CALL" else entry_spot + 100.0))
            tgt_spot = float(r.get("target") or (entry_spot + 300.0 if side == "CALL" else entry_spot - 300.0))
            pts = float(r.get("weighted_pnl_points") or r.get("pnl_points") or 0.0)
            out.append({
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": str(r.get("exit_reason", "")),
                "pnl_points": pts,
                "base_points": float(r.get("pnl_points") or 0.0),
                "lots": int(r.get("total_lots") or 1)
            })
    return out


def vix_divergence_spot_trades_for_day(date: str) -> list:
    """Historical spot trades for VIX Trap Divergence on date."""
    csv_path = ROOT / "performance" / "vix_divergence_backtest_trades.csv"
    if not csv_path.exists():
        return []
    out = []
    for r in read_csv_rows(csv_path):
        if r.get("date") == date:
            side = str(r.get("side", "CALL"))
            entry_spot = float(r.get("entry_price") or 0.0)
            exit_spot = float(r.get("exit_price") or 0.0)
            sl_spot = float(r.get("initial_sl") or (entry_spot - 30.0 if side == "CALL" else entry_spot + 30.0))
            tgt_spot = float(r.get("target") or (entry_spot + 150.0 if side == "CALL" else entry_spot - 150.0))
            pts = float(r.get("weighted_pnl_points") or r.get("pnl_points") or 0.0)
            out.append({
                "side": side,
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": entry_spot,
                "sl": sl_spot,
                "target": tgt_spot,
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": exit_spot,
                "reason": str(r.get("exit_reason", "")),
                "pnl_points": pts,
                "base_points": float(r.get("pnl_points") or 0.0),
                "lots": int(r.get("total_lots") or 1)
            })
    return out


def sensex_trend_runner_spot_trades_for_day(date: str) -> list:
    """Historical spot trades for Sensex Trend Runner on date."""
    for fname in ["sensex_backtest_trades.csv", "trend_runner_sensex_paper_trades.csv"]:
        csv_path = ROOT / "performance" / fname
        if not csv_path.exists():
            continue
        out = []
        for r in read_csv_rows(csv_path):
            if r.get("date") == date:
                side = str(r.get("side", "CALL"))
                entry_spot = float(r.get("entry_price") or 0.0)
                exit_spot = float(r.get("exit_price") or 0.0)
                sl_spot = float(r.get("initial_sl") or r.get("sl") or (entry_spot - 80.0 if side == "CALL" else entry_spot + 80.0))
                tgt_spot = float(r.get("target") or (entry_spot + 600.0 if side == "CALL" else entry_spot - 600.0))
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
        if out:
            return out
    return []


_VIX_DAILY_CACHE = None

def get_vix_daily_map() -> dict:
    global _VIX_DAILY_CACHE
    if _VIX_DAILY_CACHE is None:
        vix_path = ROOT / "captured_data" / "india_vix_10y.csv"
        m = {}
        if vix_path.exists():
            import csv
            with open(vix_path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                prev_c = None
                for r in reader:
                    d = r.get("date", "")
                    try:
                        c = float(r.get("close") or 0.0)
                        pct_val = r.get("vix_change_pct")
                        pct = float(pct_val) if pct_val and pct_val != "" else 0.0
                        pts = round(c - prev_c, 2) if prev_c is not None else 0.0
                        m[d] = {
                            "close": c,
                            "change_pct": round(pct, 2),
                            "change_pts": pts,
                            "prev_close": prev_c
                        }
                        prev_c = c
                    except Exception:
                        pass
        _VIX_DAILY_CACHE = m
    return _VIX_DAILY_CACHE


def get_vix_for_date(date: str) -> dict | None:
    """Return VIX close, change_pct, change_pts, prev_close for a given day."""
    if not date:
        return None
    # 1. Live quotes file if available
    quotes_file = LIVE_DIR / f"quotes_{date}.json"
    if quotes_file.exists():
        try:
            q_data = json.loads(quotes_file.read_text(encoding="utf-8"))
            vix_quote = q_data.get("vix")
            if vix_quote and vix_quote.get("ltp"):
                return {
                    "close": float(vix_quote.get("ltp") or 0.0),
                    "change_pct": float(vix_quote.get("per_change") or 0.0),
                    "change_pts": float(vix_quote.get("change") or 0.0),
                    "prev_close": float(vix_quote.get("prev_close") or 0.0),
                }
        except Exception:
            pass

    # 2. Historical VIX 10y map
    v_map = get_vix_daily_map()
    if date in v_map:
        return v_map[date]
    return None


def sensex_key_levels_spot_trades_for_day(date: str) -> list:
    """Historical spot trades for Sensex Key Levels on date."""
    for fname in ["sensex_key_levels_trades.csv", "sensex_key_levels_paper_trades.csv"]:
        csv_path = ROOT / "performance" / fname
        if not csv_path.exists():
            continue
        out = []
        for r in read_csv_rows(csv_path):
            if r.get("date") == date:
                side = str(r.get("side", "CALL"))
                entry_spot = float(r.get("entry_price") or 0.0)
                exit_spot = float(r.get("exit_price") or 0.0)
                sl_spot = float(r.get("sl") or 0.0)
                tgt_spot = float(r.get("target") or 0.0)
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
                    "setup": str(r.get("setup") or r.get("type", "")),
                    "level": float(r.get("level") or 0.0),
                })
        if out:
            return out
    return []

def _legacy_vix_trades_unused(date: str) -> list:
    csv_path = ROOT / "performance" / "vix_trend_runner_trades.csv"
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


def vix_trend_runner_backtest_report(csv_path: Path | None = None, lot_size: int = 25, option_delta: float = 0.60, use_weighted: bool = False) -> dict:
    """Historical backtest performance for Nifty/Sensex Trend Expansion Runner (with India VIX confluence)."""
    if csv_path is None:
        csv_path = ROOT / "performance" / "vix_trend_runner_trades.csv"
    if not csv_path.exists():
        return {"summary": {}, "trades": [], "monthly": [], "daily": [], "exit_reasons": []}

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
            w_pts = round(float(r.get("weighted_pnl_points") or pnl_pts), 2)
            pts_to_use = w_pts if use_weighted else pnl_pts
            equity += pts_to_use
            peak = max(peak, equity)
            reason = str(r.get("exit_reason", ""))

            sl_spot = round(float(r.get("sl") or r.get("initial_sl") or (entry_spot - 28.0 if side == "CALL" else entry_spot + 28.0)), 2)
            tgt_spot = round(float(r.get("target") or (entry_spot + 200.0 if side == "CALL" else entry_spot - 200.0)), 2)

            opt_rs = round(float(r.get("pnl_rupees") or (pts_to_use * lot_size * option_delta)), 2)
            fut_rs = round(float(r.get("futures_pnl_rupees") or (pts_to_use * lot_size)), 2)

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
                "pnl_points": pts_to_use,
                "base_points": pnl_pts,
                "pnl_rupees": opt_rs,
                "futures_rupees": fut_rs,
                "lots": int(r.get("total_lots") or 1),
                "engine": str(r.get("engine") or r.get("origin") or ""),
                "strategy_label": str(r.get("strategy_label") or ""),
                "trigger_label": str(r.get("trigger_label") or ""),
                "trigger_reason": str(r.get("trigger_reason") or ""),
                "stage": str(r.get("stage") or ""),
                "equity": round(equity, 2),
                "drawdown": round(equity - peak, 2),
            })

            d = daily_map.setdefault(r_date, {"date": r_date, "points": 0.0, "trades": 0})
            d["points"] = round(d["points"] + pts_to_use, 2)
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
            "total_points": round(sum(float(x.get("pnl_points") or 0.0) for x in raw_trades), 2),
            "base_points": round(sum(float(x.get("pnl_points") or 0.0) for x in raw_trades), 2),
            "base_rupees": round(sum(float(x.get("pnl_points") or 0.0) for x in raw_trades) * lot_size * (option_delta if option_delta else 1.0), 2),
            "dynamic_points": round(sum(float(x.get("weighted_pnl_points") or x.get("pnl_points") or 0.0) for x in raw_trades), 2),
            "dynamic_rupees": round(sum(float(x.get("weighted_pnl_points") or x.get("pnl_points") or 0.0) for x in raw_trades) * lot_size * (option_delta if option_delta else 1.0), 2),
            "futures_rupees": round(sum(float(x.get("weighted_pnl_points") or x.get("pnl_points") or 0.0) for x in raw_trades) * lot_size, 2),
            "avg_points": round(equity / n, 2) if n else 0.0,
            "max_drawdown": min((x["drawdown"] for x in trades), default=0.0),
            "best": max((x["pnl_points"] for x in trades), default=0.0),
            "worst": min((x["pnl_points"] for x in trades), default=0.0),
            "lot_size": lot_size,
            "option_delta": option_delta,
        },
        "trades": trades,
        "daily": sorted_daily,
        "monthly": sorted_monthly,
        "exit_reasons": sorted_reasons,
    }




def combined_strategy_backtest_report(
    nifty_csv: Path,
    sensex_csv: Path,
    nifty_lot: int = 25,
    sensex_lot: int = 10,
    option_delta: float = 0.60,
    use_weighted: bool = False
) -> dict:
    """Historical combined portfolio performance merging Nifty and Sensex trade logs."""
    raw_nifty = read_csv_rows(nifty_csv) if nifty_csv.exists() else []
    raw_sensex = read_csv_rows(sensex_csv) if sensex_csv.exists() else []

    parsed_trades = []
    for r in raw_nifty:
        try:
            pnl_pts = round(float(r.get("pnl_points") or 0.0), 2)
            w_pts = round(float(r.get("weighted_pnl_points") or pnl_pts), 2)
            pts = w_pts if use_weighted else pnl_pts
            opt_rs = round(pts * nifty_lot * option_delta, 2)
            fut_rs = round(pts * nifty_lot, 2)
            parsed_trades.append({
                "date": str(r.get("date", "")),
                "symbol": "NIFTY",
                "side": str(r.get("side", "CALL")),
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": round(float(r.get("entry_price") or 0.0), 2),
                "sl": round(float(r.get("sl") or r.get("initial_sl") or 0.0), 2),
                "target": round(float(r.get("target") or 0.0), 2),
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": round(float(r.get("exit_price") or 0.0), 2),
                "reason": str(r.get("exit_reason", "")),
                "pnl_points": pts,
                "base_points": pnl_pts,
                "pnl_rupees": opt_rs,
                "futures_rupees": fut_rs,
                "lots": int(r.get("total_lots") or 1),
                "lot_size": nifty_lot,
            })
        except Exception:
            continue

    for r in raw_sensex:
        try:
            pnl_pts = round(float(r.get("pnl_points") or 0.0), 2)
            w_pts = round(float(r.get("weighted_pnl_points") or pnl_pts), 2)
            pts = w_pts if use_weighted else pnl_pts
            opt_rs = round(pts * sensex_lot * option_delta, 2)
            fut_rs = round(pts * sensex_lot, 2)
            parsed_trades.append({
                "date": str(r.get("date", "")),
                "symbol": "SENSEX",
                "side": str(r.get("side", "CALL")),
                "entry": str(r.get("entry_time", ""))[:5],
                "entry_price": round(float(r.get("entry_price") or 0.0), 2),
                "sl": round(float(r.get("sl") or r.get("initial_sl") or 0.0), 2),
                "target": round(float(r.get("target") or 0.0), 2),
                "exit": str(r.get("exit_time", ""))[:5],
                "exit_price": round(float(r.get("exit_price") or 0.0), 2),
                "reason": str(r.get("exit_reason", "")),
                "pnl_points": pts,
                "base_points": pnl_pts,
                "pnl_rupees": opt_rs,
                "futures_rupees": fut_rs,
                "lots": int(r.get("total_lots") or 1),
                "lot_size": sensex_lot,
            })
        except Exception:
            continue

    parsed_trades.sort(key=lambda x: (x["date"], x["entry"]))

    trades, equity, peak = [], 0.0, 0.0
    daily_map = {}
    monthly_map = {}
    reasons_map = {}

    for t in parsed_trades:
        rs = t["pnl_rupees"]
        norm_pts = round(rs / (25.0 * option_delta), 2)
        equity += norm_pts
        peak = max(peak, equity)
        r_date = t["date"]

        t_copy = dict(t)
        t_copy["equity"] = round(equity, 2)
        t_copy["drawdown"] = round(equity - peak, 2)
        trades.append(t_copy)

        d = daily_map.setdefault(r_date, {"date": r_date, "points": 0.0, "trades": 0, "rupees": 0.0})
        d["points"] = round(d["points"] + norm_pts, 2)
        d["rupees"] = round(d["rupees"] + rs, 2)
        d["trades"] += 1

        m = r_date[:7]
        monthly_map[m] = round(monthly_map.get(m, 0.0) + norm_pts, 2)
        reasons_map[t["reason"]] = reasons_map.get(t["reason"], 0) + 1

    n = len(trades)
    wins = sum(1 for x in trades if x["pnl_rupees"] > 0)
    sorted_daily = sorted(daily_map.values(), key=lambda x: x["date"])
    sorted_monthly = [{"month": m, "points": pts} for m, pts in sorted(monthly_map.items())]
    sorted_reasons = [{"reason": reason, "count": count} for reason, count in sorted(reasons_map.items(), key=lambda item: -item[1])]

    total_dyn_rs = round(sum(x["pnl_rupees"] for x in trades), 2)
    total_fut_rs = round(sum(x["futures_rupees"] for x in trades), 2)
    total_base_rs = round(sum(float(x.get("base_points", x.get("pnl_points", 0.0))) * x.get("lot_size", 25) * option_delta for x in trades), 2)
    base_norm_pts = round(total_base_rs / (25.0 * option_delta), 2)

    return {
        "summary": {
            "from": sorted_daily[0]["date"] if sorted_daily else "",
            "to": sorted_daily[-1]["date"] if sorted_daily else "",
            "days": len(sorted_daily),
            "trades": n,
            "wins": wins,
            "losses": sum(1 for x in trades if x["pnl_rupees"] < 0),
            "win_rate": round(100.0 * wins / n, 2) if n else 0.0,
            "win_rate_pct": round(100.0 * wins / n, 2) if n else 0.0,
            "total_points": base_norm_pts,
            "base_points": base_norm_pts,
            "base_rupees": total_base_rs,
            "dynamic_points": round(equity, 2),
            "dynamic_rupees": total_dyn_rs,
            "futures_rupees": total_fut_rs,
            "avg_points": round(equity / n, 2) if n else 0.0,
            "max_drawdown": min((x["drawdown"] for x in trades), default=0.0),
            "best": max((x["pnl_points"] for x in trades), default=0.0),
            "worst": min((x["pnl_points"] for x in trades), default=0.0),
            "lot_size": 25,
            "option_delta": option_delta,
        },
        "trades": trades,
        "daily": sorted_daily,
        "monthly": sorted_monthly,
        "exit_reasons": sorted_reasons,
    }

def dynamic_box_backtest_report() -> dict:
    """Historical backtest performance for Dynamic Volatility Box Breakout."""
    csv_path = ROOT / "performance" / "dynamic_box_trades.csv"
    if not csv_path.exists():
        return {"summary": {}, "trades": [], "monthly": [], "daily": [], "exit_reasons": []}

    lot_size = 25
    option_delta = 0.60
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
            sl_spot = round(float(r.get("sl") or 0.0), 2)
            tgt_spot = round(float(r.get("target") or 0.0), 2)
            b_high = round(float(r.get("box_high") or 0.0), 2)
            b_low = round(float(r.get("box_low") or 0.0), 2)
            b_med = round(float(r.get("box_median") or 0.0), 2)

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
                "box_high": b_high,
                "box_low": b_low,
                "box_median": b_med
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
            "option_delta": option_delta,
        },
        "trades": trades,
        "daily": sorted_daily,
        "monthly": sorted_monthly,
        "exit_reasons": sorted_reasons,
    }


def dynamic_box_spot_trades_for_day(date: str) -> list:
    """Historical spot trades for Dynamic Box Breakout on date."""
    csv_path = ROOT / "performance" / "dynamic_box_trades.csv"
    if not csv_path.exists():
        return []
    out = []
    for r in read_csv_rows(csv_path):
        if r.get("date") == date:
            side = str(r.get("side", "CALL"))
            entry_spot = float(r.get("entry_price") or 0.0)
            exit_spot = float(r.get("exit_price") or 0.0)
            sl_spot = float(r.get("sl") or 0.0)
            tgt_spot = float(r.get("target") or 0.0)
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


def dynamic_box_boxes_for_day(date: str) -> list:
    """Historical compression boxes for Dynamic Box Breakout on date."""
    json_path = ROOT / "performance" / "dynamic_box_boxes.json"
    if not json_path.exists():
        return []
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get(date, [])
    except Exception:
        return []



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
            "option_delta": option_delta,
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
    if cfg.get("midpoint_paper_trading", False):
        trades.extend(paper_report()["trades"])
    if cfg.get("hero_zero_paper_trading", False):
        trades.extend(hero_zero_report()["trades"])
    if cfg.get("key_levels_paper_trading", False):
        trades.extend(build_paper_report(key_level_option_trades())["trades"])
    if cfg.get("scalper_paper_trading", False):
        trades.extend(compression_scalp_report()["trades"])
    if cfg.get("trend_runner_paper_trading", True):
        trades.extend(trend_runner_paper_report()["trades"])
    if cfg.get("sensex_runner_paper_trading", True):
        trades.extend(sensex_runner_paper_report()["trades"])
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



def clean_option_symbol(sym: str) -> str:
    """Format technical broker symbol (e.g. NIFTY26N0323300CE) into clean human-readable name."""
    m = re.search(r'(NIFTY|SENSEX)\d{2}[A-Z0-9]{3}(\d+)(CE|PE)', sym)
    if m:
        return f"{m.group(1)} {m.group(2)} {m.group(3)}"
    return sym


def kotak_orders() -> list:
    """Return today's real executed orders directly from Kotak Neo."""
    try:
        from kotak_orders import get_kotak_client
        client = get_kotak_client()
        if not client:
            return []
        res = client.order_report()
        if not isinstance(res, dict) or str(res.get("stat", "")).lower() != "ok":
            return []
        orders = []
        for o in res.get("data") or []:
            sym = str(o.get("trdSym", ""))
            side = "BUY" if o.get("trnsTp") == "B" else "SELL"
            st = str(o.get("ordSt", "")).lower()
            px = float(o.get("avgPrc") or o.get("prc") or 0.0)
            qty = int(o.get("qty") or 0)
            dt_tm = str(o.get("ordDtTm") or "")
            t_str = dt_tm.split()[1][:5] if len(dt_tm.split()) > 1 else dt_tm[:5]
            orders.append({
                "order_id": str(o.get("nOrdNo", "")),
                "symbol": clean_option_symbol(sym),
                "raw_symbol": sym,
                "side": side,
                "status": st,
                "price": px,
                "qty": qty,
                "time": t_str,
                "order_type": str(o.get("ordTp", "MKT")),
                "exchange": str(o.get("exSeg", "nse_fo")),
                "product": str(o.get("prod", "MIS")),
            })
        return orders
    except Exception as exc:
        print(f"Error fetching Kotak orders: {exc}")
        return []


def get_spot_at_time(idx_sym: str, hhmm: str) -> float:
    try:
        t_str = today()
        prefix = "sensex" if "SENSEX" in idx_sym.upper() else "nifty"
        p = LIVE_DIR / f"{prefix}_1min_{t_str}.csv"
        if p.exists():
            rows = read_csv_rows(p)
            for r in rows:
                t_val = str(r.get("time") or r.get("timestamp") or "")
                if hhmm in t_val:
                    return float(r.get("close") or r.get("open") or 0.0)
            if rows:
                return float(rows[-1].get("close") or 0.0)
    except Exception:
        pass
    st = status()
    if "SENSEX" in idx_sym.upper():
        return float((st.get("sensex_last_tick") or {}).get("ltp") or 75000.0)
    return float((st.get("last_tick") or {}).get("ltp") or 23300.0)


def kotak_live_trades() -> list:
    """Return active and closed Kotak Neo positions formatted as OptionTrade dicts with stable, FIFO-paired timestamps."""
    try:
        from broker import get_positions
        from kotak_orders import get_kotak_client
        pos_data = get_positions()

        # Fetch and parse completed orders
        completed_orders = []
        try:
            client = get_kotak_client()
            if client:
                res = client.order_report()
                if isinstance(res, dict) and str(res.get("stat", "")).lower() == "ok":
                    for o in res.get("data") or []:
                        if str(o.get("ordSt", "")).lower() in ("complete", "trd", "traded", "filled"):
                            completed_orders.append(o)
        except Exception as exc:
            print(f"Error fetching Kotak Neo order_report: {exc}")

        def parse_ord_time(o: dict):
            dt_str = str(o.get("ordDtTm", "")).strip()
            try:
                return datetime.strptime(dt_str, "%d-%b-%Y %H:%M:%S")
            except Exception:
                return datetime.min

        completed_orders.sort(key=parse_ord_time)

        # Group completed orders by trading symbol
        by_symbol = {}
        for o in completed_orders:
            sym = str(o.get("trdSym", ""))
            if sym not in by_symbol:
                by_symbol[sym] = []
            by_symbol[sym].append(o)

        today_str = today()
        targets = load_scalp_targets()
        trades = []

        # Map live open positions by symbol for quick lookup of current MTM
        open_pos_map = {}
        if pos_data.get("ok"):
            for pos in pos_data.get("open_positions", []):
                s = str(pos.get("symbol", "")).strip()
                open_pos_map[s] = pos
                open_pos_map[clean_option_symbol(s)] = pos
                open_pos_map[s.replace(" ", "")] = pos

        # Reconstruct distinct round-trip trades using FIFO matching
        for sym, ords in by_symbol.items():
            readable_name = clean_option_symbol(sym)
            idx_sym = "SENSEX" if "SENSEX" in sym.upper() else "NIFTY"
            side = "CALL" if "CE" in sym.upper() else "PUT"
            buys = []
            for o in ords:
                tt = str(o.get("trnsTp", "")).upper()
                qty = int(o.get("qty", 0))
                prc = float(o.get("avgPrc", 0.0))
                dt_parts = str(o.get("ordDtTm", "")).split()
                dt = dt_parts[1][:5] if len(dt_parts) > 1 else "09:30"
                if tt == "B":
                    buys.append({"qty": qty, "price": prc, "time": dt, "order_id": o.get("nOrdNo")})
                elif tt == "S":
                    sell_qty = qty
                    sell_prc = prc
                    sell_dt = dt
                    while sell_qty > 0 and buys:
                        b = buys[0]
                        matched_qty = min(sell_qty, b["qty"])
                        pnl = round((sell_prc - b["price"]) * matched_qty, 2)
                        pts = round(sell_prc - b["price"], 2)
                        spot_in = get_spot_at_time(sym, b["time"])
                        spot_out = get_spot_at_time(sym, sell_dt)
                        trades.append({
                            "date": today_str,
                            "side": side,
                            "option": readable_name,
                            "raw_symbol": sym,
                            "symbol": idx_sym,
                            "qty": matched_qty,
                            "entry": b["time"],
                            "exit": sell_dt,
                            "buy_price": b["price"],
                            "sell_price": sell_prc,
                            "buy_value_rs": round(b["price"] * matched_qty, 2),
                            "sell_value_rs": round(sell_prc * matched_qty, 2),
                            "spot_at_entry": spot_in,
                            "nifty_in": spot_in,
                            "nifty_out": spot_out,
                            "nifty_points": pts,
                            "pnl_points": pts,
                            "pnl_rs": pnl,
                            "option_pnl_rs": pnl,
                            "net_rs": pnl,
                            "charges_rs": 0.0,
                            "exit_reason": "closed",
                            "strategy": "kotak_live",
                            "mode": "LIVE KOTAK",
                            "trigger_label": "Kotak Neo Real Trade",
                            "is_open": False,
                        })
                        b["qty"] -= matched_qty
                        sell_qty -= matched_qty
                        if b["qty"] <= 0:
                            buys.pop(0)

            # Remaining unclosed buys are active open positions!
            for b in buys:
                if b["qty"] > 0:
                    pos_info = open_pos_map.get(sym) or open_pos_map.get(readable_name) or open_pos_map.get(sym.replace(" ", "")) or {}
                    cur_ltp = float(pos_info.get("ltp") or 0.0)
                    if cur_ltp <= 0:
                        cur_ltp = float(pos_info.get("buy_avg") or b["price"])
                    unrealized = float(pos_info.get("unrealized_pnl") if pos_info.get("unrealized_pnl") is not None else round((cur_ltp - b["price"]) * b["qty"], 2))
                    pts = round(cur_ltp - b["price"], 2)

                    t_info = targets.get(sym) or targets.get(readable_name) or {}
                    tp_pts = float(t_info.get("tp_pts") or 0.0)
                    tl_pts = float(t_info.get("tl_pts") or 0.0)
                    sl_val = round(b["price"] - tl_pts, 2) if (tl_pts > 0 and b["price"] > 0) else None
                    tgt_val = round(b["price"] + tp_pts, 2) if (tp_pts > 0 and b["price"] > 0) else None
                    spot_in = get_spot_at_time(sym, b["time"])

                    trades.append({
                        "date": today_str,
                        "side": side,
                        "option": readable_name,
                        "raw_symbol": sym,
                        "symbol": idx_sym,
                        "qty": b["qty"],
                        "entry": b["time"],
                        "exit": "",
                        "buy_price": b["price"],
                        "sell_price": cur_ltp,
                        "buy_value_rs": round(b["price"] * b["qty"], 2),
                        "sell_value_rs": round(cur_ltp * b["qty"], 2),
                        "spot_at_entry": spot_in,
                        "nifty_in": spot_in,
                        "nifty_out": spot_in,
                        "nifty_points": pts,
                        "pnl_points": pts,
                        "pnl_rs": unrealized,
                        "option_pnl_rs": unrealized,
                        "net_rs": unrealized,
                        "charges_rs": 0.0,
                        "sl": sl_val,
                        "target": tgt_val,
                        "tp_pts": tp_pts,
                        "tl_pts": tl_pts,
                        "exit_reason": "open",
                        "strategy": "kotak_live",
                        "mode": "LIVE KOTAK",
                        "trigger_label": "Kotak Neo Real Position",
                        "is_open": True,
                    })

        # If orders were empty but positions exist, fallback to raw positions
        if not trades and pos_data.get("ok"):
            for pos in pos_data.get("open_positions", []):
                sym = str(pos.get("symbol", ""))
                readable_name = clean_option_symbol(sym)
                side = str(pos.get("side", "CALL"))
                qty = int(pos.get("net_qty", 65))
                buy_px = float(pos.get("buy_avg", 0.0))
                cur_ltp = float(pos.get("ltp", buy_px))
                spot_in = get_spot_at_time(sym, "09:30")
                unrealized = float(pos.get("unrealized_pnl", (cur_ltp - buy_px) * qty))
                trades.append({
                    "date": today_str,
                    "side": side,
                    "option": readable_name,
                    "raw_symbol": sym,
                    "symbol": "SENSEX" if "SENSEX" in sym.upper() else "NIFTY",
                    "qty": qty,
                    "entry": "09:30",
                    "exit": "",
                    "buy_price": buy_px,
                    "sell_price": cur_ltp,
                    "spot_at_entry": spot_in,
                    "nifty_in": spot_in,
                    "nifty_out": spot_in,
                    "pnl_rs": unrealized,
                    "option_pnl_rs": unrealized,
                    "nifty_points": round(cur_ltp - buy_px, 2),
                    "exit_reason": "open",
                    "mode": "LIVE KOTAK",
                    "strategy": "kotak_live",
                    "is_open": True,
                })

        # Stable sort by entry time
        trades.sort(key=lambda x: str(x.get("entry", "09:15")))
        return trades
    except Exception as exc:
        print(f"Error in kotak_live_trades: {exc}")
        return []


DEFAULT_APP_PIN = "642539"
AUTH_SECRET = "algoneo_auth_secret_token_key_2026"

def get_master_pin() -> str:
    try:
        cfg = read_config()
        return str(cfg.get("app_pin") or cfg.get("kotak_mpin") or DEFAULT_APP_PIN).strip()
    except Exception:
        return DEFAULT_APP_PIN

def generate_session_token(pin: str) -> str:
    return hmac.new(AUTH_SECRET.encode(), pin.encode(), hashlib.sha256).hexdigest()

def verify_session_token(token: str) -> bool:
    if not token:
        return False
    expected = generate_session_token(get_master_pin())
    return hmac.compare_digest(token, expected)


def sanitize_json(obj):
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    elif isinstance(obj, dict):
        return {k: sanitize_json(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [sanitize_json(v) for v in obj]
    return obj


class Handler(BaseHTTPRequestHandler):
    def _json(self, data, code: int = 200) -> None:
        body = json.dumps(sanitize_json(data), default=str).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionError, BrokenPipeError):
            pass

    def _is_authenticated(self) -> bool:
        # Check Authorization header: Bearer <token>
        auth_hdr = self.headers.get("Authorization", "")
        if auth_hdr.startswith("Bearer "):
            tok = auth_hdr.split("Bearer ", 1)[1].strip()
            if verify_session_token(tok):
                return True

        # Check Cookie: algo_auth=<token>
        cookie_hdr = self.headers.get("Cookie", "")
        if "algo_auth=" in cookie_hdr:
            for part in cookie_hdr.split(";"):
                part = part.strip()
                if part.startswith("algo_auth="):
                    tok = part.split("algo_auth=", 1)[1].strip()
                    if verify_session_token(tok):
                        return True

        # Check direct PIN header
        if self.headers.get("X-App-Pin") == get_master_pin():
            return True

        return False

    def _is_local_client(self) -> bool:
        return self._is_authenticated() or (self.client_address[0] in ("127.0.0.1", "::1"))

    def do_HEAD(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        q = parse_qs(url.query)
        date = q.get("date", [today()])[0]
        if not DATE_RE.match(date):
            return self._json({"error": "date must be YYYY-MM-DD"}, 400)

        if not url.path.startswith("/api/"):
            self._static(url.path)
            return

        if url.path == "/api/auth/status":
            return self._json({"authenticated": self._is_authenticated()})

        if not self._is_authenticated():
            return self._json({"error": "unauthorized", "auth_required": True}, 401)

        if url.path == "/api/status":
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

            if strategy_param in ("trend_runner", "trend_runner_10y", "10y", "trend", "vix_runner", "vix_trend", "trend_expansion"):
                selected_option_trades = live_trend_fills
                selected_paper_trades = []
            elif strategy_param in ("sensex_runner", "sensex", "sensex_trend"):
                selected_option_trades = sensex_runner_live_paper_trades(date)
                selected_paper_trades = []
            elif strategy_param in ("sensex_key_levels", "sensex_levels", "key_levels_sensex"):
                selected_option_trades = sensex_key_levels_live_paper_trades(date)
                selected_paper_trades = []
            elif strategy_param in ("nifty_key_levels", "nifty_levels", "key_levels_nifty"):
                selected_option_trades = nifty_key_levels_live_paper_trades(date)
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
            elif strategy_param in ("sensex_runner", "sensex", "sensex_trend"):
                rule_trades = sensex_trend_runner_spot_trades_for_day(date)
            elif strategy_param in ("sensex_key_levels", "sensex_levels", "key_levels_sensex"):
                rule_trades = sensex_key_levels_spot_trades_for_day(date)
            elif strategy_param in ("nifty_key_levels", "nifty_levels", "key_levels_nifty"):
                rule_trades = nifty_key_levels_spot_trades_for_day(date)
            elif strategy_param in ("master_portfolio", "master_portfolio_nifty", "master_portfolio_sensex", "master_portfolio_all", "portfolio", "unified_master"):
                rule_trades = master_portfolio_spot_trades_for_day(date, symbol)
            elif strategy_param in ("gap_and_go", "gap_and_go_williams", "gap_williams", "williams", "gap_and_go_nifty", "gap_and_go_sensex", "gap_and_go_all"):
                rule_trades = gap_and_go_spot_trades_for_day(date, symbol)
            elif strategy_param in ("vix_master_nifty", "nifty_vix_master", "vix_master"):
                rule_trades = vix_master_spot_trades_for_day(date, "NIFTY")
            elif strategy_param in ("vix_master_sensex", "sensex_vix_master"):
                rule_trades = vix_master_spot_trades_for_day(date, "SENSEX")
            elif strategy_param in ("sensex_vix_divergence", "sensex_vix", "sensex_trap"):
                rule_trades = sensex_vix_divergence_spot_trades_for_day(date)
            elif strategy_param in ("vix_divergence", "vix_trap", "vix_reversal", "vix"):
                rule_trades = vix_divergence_spot_trades_for_day(date)
            elif strategy_param in ("trend_runner", "trend_runner_10y", "10y", "vix_trend", "trend_expansion"):
                rule_trades = vix_trend_runner_spot_trades_for_day(date)
            elif strategy_param in ("dynamic_box", "box_breakout", "volatility_box"):
                rule_trades = dynamic_box_spot_trades_for_day(date)
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
                "vix": get_vix_for_date(date),
                "candles": rows,
                "forming": forming,
                "setup": setup_info(df),
                "trades": rule_trades,
                "boxes": dynamic_box_boxes_for_day(date) if strategy_param in ("dynamic_box", "box_breakout", "volatility_box") else [],
                "signals": read_csv_rows(LIVE_DIR / f"signals_{symbol.lower()}_{date}.csv") if (LIVE_DIR / f"signals_{symbol.lower()}_{date}.csv").exists() else (read_csv_rows(LIVE_DIR / f"signals_{date}.csv") if symbol == "NIFTY" else []),
                "paper_trades": selected_paper_trades,
                "option_trades": option_fills,
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
        elif url.path == "/api/hold-and-raise":
            try:
                import hold_and_raise_strategy
                tf = q.get("tf", ["5m"])[0]
                pyramid = q.get("pyramid", ["1"])[0] == "1"
                min_df = candles(date, symbol="NIFTY")
                res = hold_and_raise_strategy.analyze_hold_and_raise(min_df, timeframe=tf, target_date=date, enable_pyramiding=pyramid)
                self._json(res)
            except Exception as e:
                self._json({"error": str(e), "candles": [], "boxes": [], "trades": [], "metrics": {}})
        elif url.path == "/api/signals":
            signals_list = read_csv_rows(LIVE_DIR / f"signals_{date}.csv")
            for sig_file in ("trend_runner_live_signals.csv", "trend_runner_sensex_live_signals.csv"):
                tr_sig_path = LIVE_DIR / sig_file
                if tr_sig_path.exists():
                    for sr in read_csv_rows(tr_sig_path):
                        if sr.get("date") == date or not date:
                            signals_list.append({
                                "event": "ENTRY",
                                "side": "CALL" if sr.get("side") in ("LONG", "CALL", "CE") else "PUT",
                                "entry_time": sr.get("entry_time"),
                                "price": sr.get("entry_price"),
                                "sl": sr.get("initial_sl") or sr.get("sl_pts"),
                                "target": sr.get("target") if sr.get("target") != "UNCAPPED" else "",
                                "candle_time": sr.get("entry_time"),
                                "detected_at": sr.get("entry_time"),
                                "option": sr.get("option", ""),
                                "vix_chg": sr.get("vix_chg", ""),
                                "date": sr.get("date", ""),
                            })
            # Also include Sensex Key Levels live paper signals
            sk_paper_path = ROOT / "performance" / "sensex_key_levels_paper_trades.csv"
            if sk_paper_path.exists():
                for sr in read_csv_rows(sk_paper_path):
                    if sr.get("date") == date or not date:
                        signals_list.append({
                            "event": "ENTRY",
                            "strategy": "sensex_key_levels",
                            "side": sr.get("side", ""),
                            "entry_time": sr.get("entry_time"),
                            "price": sr.get("entry_price"),
                            "sl": sr.get("sl"),
                            "target": sr.get("target"),
                            "candle_time": sr.get("entry_time"),
                            "detected_at": sr.get("entry_time"),
                            "option": sr.get("option", ""),
                            "pnl_points": sr.get("pnl_points"),
                            "exit_reason": sr.get("exit_reason"),
                            "date": sr.get("date", ""),
                        })
            self._json(signals_list)
        elif url.path == "/api/orders":
            from broker import get_active_broker
            if get_active_broker() == "KOTAK_NEO":
                self._json(kotak_orders())
            else:
                self._json(read_csv_rows(LIVE_DIR / f"live_orders_{date}.csv"))
        elif url.path == "/api/trades":
            trade_mode = q.get("mode", [""])[0].strip().upper()
            all_trades = []
            kotak_trades = []
            try:
                kotak_trades = list(kotak_live_trades())
                all_trades.extend(kotak_trades)
            except Exception as exc:
                print(f"Error reading Kotak live trades: {exc}")

            from broker import get_active_broker
            is_kotak_active = (get_active_broker() == "KOTAK_NEO")

            paper_trades = []
            paper_trades.extend(trend_runner_live_paper_trades(date))
            paper_trades.extend(sensex_runner_live_paper_trades(date))
            paper_trades.extend(sensex_key_levels_live_paper_trades(date))
            paper_trades.extend(nifty_key_levels_live_paper_trades(date))
            paper_trades.extend(list(midpoint_option_trades(date)))

            if trade_mode == "LIVE":
                self._json(kotak_trades)
            elif trade_mode == "PAPER":
                self._json(paper_trades)
            else:
                all_trades.extend(paper_trades)
                self._json(all_trades)
        elif url.path == "/api/key-level-option-trades":
            self._json(build_paper_report(key_level_option_trades(date))["trades"])
        elif url.path == "/api/key-level-option-paper":
            self._json(key_level_option_paper_rows(date))
        elif url.path == "/api/paper-report":
            strategy = q.get("strategy", ["trend_runner"])[0].strip().lower()
            if not strategy or strategy in ("trend_runner", "trend", "vix_runner"):
                self._json(trend_runner_paper_report())
            elif strategy in ("sensex_runner", "sensex", "sensex_trend"):
                self._json(sensex_runner_paper_report())
            elif strategy in ("sensex_key_levels", "key_levels_sensex", "sensex_levels"):
                self._json(sensex_key_levels_paper_report())
            elif strategy in ("nifty_key_levels", "key_levels_nifty", "nifty_levels"):
                self._json(nifty_key_levels_paper_report())
            elif strategy == "hero_zero":
                self._json(hero_zero_report())
            elif strategy in ("compression_scalp", "scalp", "micro_scalp", "sniper"):
                self._json(compression_scalp_report())
            elif strategy in ("hourly_trend", "hourly"):
                self._json(hourly_trend_report())
            elif strategy == "midpoint":
                self._json(paper_report())
            else:
                self._json({"error": "unknown strategy"}, 404)
        elif url.path == "/api/capital-report":
            self._json(capital_report())
        elif url.path == "/api/paper-trades":
            strategy = q.get("strategy", ["trend_runner"])[0].strip().lower()
            if not strategy or strategy in ("trend_runner", "trend", "vix_runner"):
                self._json(trend_runner_live_paper_trades())
            elif strategy in ("sensex_runner", "sensex", "sensex_trend"):
                self._json(sensex_runner_live_paper_trades())
            elif strategy in ("sensex_key_levels", "key_levels_sensex", "sensex_levels"):
                self._json(sensex_key_levels_live_paper_trades())
            elif strategy in ("nifty_key_levels", "key_levels_nifty", "nifty_levels"):
                self._json(nifty_key_levels_live_paper_trades())
            elif strategy == "midpoint":
                self._json(read_csv_rows(LIVE_DIR / "paper_trades.csv"))
            else:
                self._json(trend_runner_live_paper_trades())
        elif url.path in ("/api/strategy-telemetry", "/api/engine-logs"):
            self._json({
                "ok": True,
                "now": datetime.now(IST).strftime("%H:%M:%S"),
                "state": ENGINE_LIVE_STATE,
                "logs": list(reversed(ENGINE_TELEMETRY_LOGS))
            })
        elif url.path == "/api/log":
            n = min(int(q.get("lines", ["200"])[0]), 2000)
            self._json(today_log(LIVE_DIR / "capture.log", n))
        elif url.path == "/api/days":
            self._json(available_days())
        elif url.path in ("/api/backtest/sync", "/api/backtest/update"):
            return self._json(trigger_backtest_sync(reason="manual"))
        elif url.path == "/api/backtest/sync/status":
            return self._json(_sync_state)
        elif url.path == "/api/backtest":
            strategy = q.get("strategy", ["trend_runner_10y"])[0].lower()
            if strategy in ("", "trend_runner_10y", "10y", "10year", "trend_10y", "trend_runner", "vix_trend", "trend_expansion"):
                self._json(nifty_10y_backtest_report())
            elif strategy in ("dynamic_box", "box_breakout", "volatility_box", "dynamic_volatility_box"):
                self._json(dynamic_box_backtest_report())
            elif strategy in ("nifty_btst", "btst_nifty", "overnight_nifty", "nifty_gap"):
                self._json(nifty_btst_backtest_report())
            elif strategy in ("sensex_btst", "btst_sensex", "overnight_sensex", "sensex_gap"):
                self._json(sensex_btst_backtest_report())
            elif strategy in ("sensex_runner", "sensex", "sensex_trend"):
                self._json(sensex_runner_backtest_report())
            elif strategy in ("sensex_key_levels", "sensex_levels", "key_levels_sensex"):
                self._json(sensex_key_levels_backtest_report())
            elif strategy in ("nifty_key_levels", "nifty_levels", "key_levels_nifty"):
                self._json(nifty_key_levels_backtest_report())
            elif strategy == "key_levels":
                self._json(key_level_report())
            elif strategy in ("compression_scalp", "scalp", "micro_scalp", "sniper"):
                self._json(compression_scalp_backtest_report())
            elif strategy in ("mtf_orb", "mtf", "5y", "5year"):
                self._json(mtf_orb_5y_backtest_report())
            elif strategy in ("hourly_trend", "hourly"):
                self._json(hourly_trend_report())
            elif strategy in ("c1_pdc_retest", "pdc_retest", "c1_retest"):
                self._json(c1_pdc_retest_report())
            elif strategy in ("midpoint_aggressive", "aggressive_scalp", "midpoint_scalp", "aggressive"):
                self._json(aggressive_midpoint_scalp_report(key_level_only=False))
            elif strategy in ("key_levels_aggressive", "aggressive_key_levels"):
                self._json(aggressive_midpoint_scalp_report(key_level_only=True))
            elif strategy in ("sr_breakout", "swing_sr", "breakout"):
                self._json(sr_breakout_backtest_report())
            elif strategy in ("vix_master_all", "vix_master_combined"):
                self._json(combined_strategy_backtest_report(
                    ROOT / "performance" / "nifty_vix_master_trades.csv",
                    ROOT / "performance" / "sensex_vix_master_trades.csv",
                    nifty_lot=25, sensex_lot=10, option_delta=0.60, use_weighted=True
                ))
            elif strategy in ("trend_runner_all", "trend_runner_combined"):
                self._json(combined_strategy_backtest_report(
                    ROOT / "performance" / "vix_trend_runner_trades.csv",
                    ROOT / "performance" / "sensex_backtest_trades.csv",
                    nifty_lot=25, sensex_lot=10, option_delta=0.60, use_weighted=True
                ))
            elif strategy in ("vix_trap_all", "vix_divergence_all", "vix_trap_combined"):
                self._json(combined_strategy_backtest_report(
                    ROOT / "performance" / "vix_divergence_backtest_trades.csv",
                    ROOT / "performance" / "sensex_vix_divergence_trades.csv",
                    nifty_lot=25, sensex_lot=10, option_delta=0.60, use_weighted=False
                ))
            elif strategy in ("master_portfolio_all", "master_portfolio_combined"):
                self._json(master_portfolio_backtest_report("nifty"))
            elif strategy in ("master_portfolio", "master_portfolio_nifty", "portfolio", "unified_master"):
                self._json(master_portfolio_backtest_report("nifty"))
            elif strategy in ("master_portfolio_sensex",):
                self._json(master_portfolio_backtest_report("sensex"))
            elif strategy in ("gap_and_go_all", "gap_and_go_combined", "gap_williams_all"):
                self._json(gap_and_go_backtest_report("nifty"))
            elif strategy in ("gap_and_go_williams", "gap_williams", "williams", "gap_and_go", "gap_and_go_nifty"):
                self._json(gap_and_go_backtest_report("nifty"))
            elif strategy in ("gap_and_go_sensex", "gap_sensex", "williams_sensex"):
                self._json(gap_and_go_backtest_report("sensex"))
            elif strategy in ("vix_master_nifty", "nifty_vix_master", "vix_master"):
                self._json(nifty_vix_master_backtest_report())
            elif strategy in ("vix_master_sensex", "sensex_vix_master"):
                self._json(sensex_vix_master_backtest_report())
            elif strategy in ("sensex_vix_divergence", "sensex_vix", "sensex_trap", "vix_sensex"):
                self._json(sensex_vix_divergence_backtest_report())
            elif strategy in ("vix_divergence", "vix_trap", "vix_reversal", "vix", "vix_dynamic"):
                self._json(vix_divergence_backtest_report())
            elif strategy in ("midpoint", "10y_midpoint"):
                midpoint_file = ROOT / "performance" / "nifty_10y_midpoint_trades.csv"
                if midpoint_file.exists():
                    self._json(vix_trend_runner_backtest_report(midpoint_file))
                else:
                    self._json(backtest_report())
            else:
                return self._json({"error": "unknown strategy"}, 404)

        elif url.path == "/api/settings":
            self._json(public_settings())
        elif url.path in ("/api/portfolio/config", "/api/portfolio-config"):
            try:
                p = ROOT / "master_portfolio_config.json"
                if p.exists():
                    self._json(json.loads(p.read_text(encoding="utf-8")))
                else:
                    self._json({
                        "symbol": "NIFTY",
                        "mode": "priority",
                        "max_trades_per_day": 2,
                        "max_concurrent_positions": 1,
                        "setups": {
                            "trend_runner": True,
                            "vix_trap": True
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
                    })
            except Exception as e:
                self._json({"error": str(e)}, 500)
        elif url.path == "/api/funds":
            try:
                funds = broker_funds()
                self._json(funds, 200 if funds.get("ok") else 502)
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 502)
        elif url.path == "/api/positions":
            try:
                from broker import get_positions
                self._json(get_positions())
            except Exception as e:
                self._json({"ok": False, "error": str(e), "open_positions": [], "closed_positions": [], "summary": {}}, 200)
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
        elif url.path in ("/api/risk-guardian", "/api/risk-guardian/status"):
            from risk_guardian import check_and_enforce_guardian
            self._json(check_and_enforce_guardian())
        else:
            self._json({"error": "not found"}, 404)

    def _static(self, path: str) -> None:
        # Built React app (web/dist) with SPA fallback; old dashboard if not built yet.
        if not (WEB_DIST / "index.html").exists():
            body, ctype = UI_FILE.read_bytes(), "text/html; charset=utf-8"
        else:
            root = WEB_DIST.resolve()
            target = (root / path.lstrip("/")).resolve()
            is_spa_fallback = False
            if root not in target.parents or not target.is_file():
                if path.startswith("/assets/") or any(path.endswith(ext) for ext in (".js", ".css", ".map", ".woff", ".woff2", ".png", ".jpg", ".svg", ".ico")):
                    self.send_response(404)
                    self.send_header("Content-Type", "text/plain")
                    self.end_headers()
                    self.wfile.write(b"Asset not found")
                    return
                target = root / "index.html"
                is_spa_fallback = True
            body = target.read_bytes()
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"

        accept_enc = self.headers.get("Accept-Encoding", "")
        compress = "gzip" in accept_enc and len(body) > 512 and (
            "javascript" in ctype or "css" in ctype or "html" in ctype or "json" in ctype or "svg" in ctype
        )
        if compress:
            body = gzip.compress(body, compresslevel=6)

        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            if compress:
                self.send_header("Content-Encoding", "gzip")
            if "/assets/" in path and not is_spa_fallback:
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            else:
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

        if url.path == "/api/auth/login":
            body = self._body()
            pin = str(body.get("pin", "")).strip()
            if pin == get_master_pin():
                token = generate_session_token(pin)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Set-Cookie", f"algo_auth={token}; Path=/; Max-Age=2592000; SameSite=Lax")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "token": token}).encode())
                return
            else:
                return self._json({"error": "Invalid PIN"}, 401)

        if url.path == "/api/auth/logout":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Set-Cookie", "algo_auth=; Path=/; Max-Age=0; SameSite=Lax")
            self.end_headers()
            self.wfile.write(b'{"ok": true}')
            return

        if not self._is_authenticated():
            return self._json({"error": "unauthorized", "auth_required": True}, 401)

        if url.path == "/api/scalp-order":
            if not self._is_local_client():
                return self._json({"error": "manual orders are local-only"}, 403)
            try:
                self._json(submit_scalp_order(self._body()))
            except Exception as exc:
                self._json({"error": f"Scalp order failed: {exc}"}, 500)
        elif url.path == "/api/update-tp-tl":
            if not self._is_local_client():
                return self._json({"error": "manual orders are local-only"}, 403)
            try:
                self._json(update_tp_tl(self._body()))
            except Exception as exc:
                self._json({"error": f"Failed to update TP/TL: {exc}"}, 500)
        elif url.path == "/api/manual-order":
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
        elif url.path in ("/api/portfolio/config", "/api/portfolio-config"):
            try:
                body = self._body()
                p = ROOT / "master_portfolio_config.json"
                curr = {}
                if p.exists():
                    try:
                        curr = json.loads(p.read_text(encoding="utf-8"))
                    except Exception:
                        pass
                if "symbol" in body and body["symbol"] in ("NIFTY", "SENSEX"):
                    curr["symbol"] = body["symbol"]
                if "mode" in body and body["mode"] in ("priority", "concurrent"):
                    curr["mode"] = body["mode"]
                if "max_trades_per_day" in body:
                    curr["max_trades_per_day"] = int(body["max_trades_per_day"])
                if "max_concurrent_positions" in body:
                    curr["max_concurrent_positions"] = int(body["max_concurrent_positions"])
                if "setups" in body and isinstance(body["setups"], dict):
                    if "setups" not in curr:
                        curr["setups"] = {}
                    for k in ("trend_runner", "vix_trap", "williams_fractal", "vix_master_morning", "vix_master_afternoon", "gap_and_go_morning", "williams_afternoon"):
                        if k in body["setups"]:
                            curr["setups"][k] = bool(body["setups"][k])
                if "spot_ratchet_settings" in body and isinstance(body["spot_ratchet_settings"], dict):
                    if "spot_ratchet_settings" not in curr:
                        curr["spot_ratchet_settings"] = {}
                    for k, val in body["spot_ratchet_settings"].items():
                        try:
                            curr["spot_ratchet_settings"][k] = float(val)
                        except (ValueError, TypeError):
                            pass
                if "sensex_spot_ratchet_settings" in body and isinstance(body["sensex_spot_ratchet_settings"], dict):
                    if "sensex_spot_ratchet_settings" not in curr:
                        curr["sensex_spot_ratchet_settings"] = {}
                    for k, val in body["sensex_spot_ratchet_settings"].items():
                        try:
                            curr["sensex_spot_ratchet_settings"][k] = float(val)
                        except (ValueError, TypeError):
                            pass
                p.write_text(json.dumps(curr, indent=2) + "\n", encoding="utf-8")
                self._json({"ok": True, "config": curr})
            except Exception as e:
                self._json({"error": str(e)}, 500)
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
        elif url.path == "/api/risk-guardian/reset":
            if not self._is_local_client():
                return self._json({"error": "action is local-only"}, 403)
            from risk_guardian import reset_risk_lock
            reset_risk_lock()
            self._json({"ok": True, "message": "Risk Guardian lock reset successfully."})
        elif url.path == "/api/risk-guardian/config":
            if not self._is_local_client():
                return self._json({"error": "action is local-only"}, 403)
            body = self._body()
            cfg = read_config()
            if "daily_loss_limit" in body:
                cfg["daily_loss_limit"] = float(body["daily_loss_limit"])
            if "risk_guardian_enabled" in body:
                cfg["risk_guardian_enabled"] = bool(body["risk_guardian_enabled"])
            if "risk_guardian_auto_close" in body:
                cfg["risk_guardian_auto_close"] = bool(body["risk_guardian_auto_close"])
            write_config(cfg)
            from risk_guardian import check_and_enforce_guardian
            self._json(check_and_enforce_guardian())
        else:
            self._json({"error": "not found"}, 404)

    def log_message(self, *_args):
        return


if __name__ == "__main__":
    threading.Thread(target=hero_zero_capture_loop, daemon=True, name="hero-zero-capture").start()
    threading.Thread(target=sensex_expiry_collector_loop, daemon=True, name="sensex-expiry-collector").start()
    threading.Thread(target=auto_start_loop, daemon=True).start()
    threading.Thread(target=daily_backtest_sync_loop, daemon=True, name="daily-backtest-sync").start()
    threading.Thread(target=scalper_forward_loop, daemon=True, name="micro-scalper-forward").start()
    threading.Thread(target=scalp_tp_tl_sentinel_loop, daemon=True, name="scalp-tp-tl-sentinel").start()
    threading.Thread(target=trend_runner_forward_loop, daemon=True, name="trend-runner-forward").start()
    try:
        from risk_guardian import start_risk_guardian
        start_risk_guardian()
    except Exception as exc:
        print(f"Error launching risk guardian: {exc}")
    threading.Thread(target=sensex_runner_forward_loop, daemon=True, name="sensex-runner-forward").start()
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

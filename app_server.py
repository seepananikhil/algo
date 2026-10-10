#!/usr/bin/env python3
"""Local dashboard + JSON API for the NIFTY strategy (read-only, plus the STOP_TRADING kill switch).

Run: python3 app_server.py  ->  http://127.0.0.1:8090
"""

from __future__ import annotations

import csv
import json
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

from midpoint_strategy import MIDPOINT_BUFFER_POINTS, TRADE_WINDOW_MINUTES, backtest_midpoint_strategy, day_setup, pending_entry

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
HERO_ZERO_DIR = ROOT / "captured_data" / "fyers" / "hero_zero"
HOST, PORT = "127.0.0.1", 8090
IST = timezone(timedelta(hours=5, minutes=30))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_token_cache = {"at": 0.0, "mtime": None, "value": None}
_master_cache = {"mtime": None, "df": None}
_backtest_cache = {"mtime": None, "value": None}
_cache_lock = threading.Lock()
_login_proc = {"proc": None}
_capture = {"auto_started": None, "stopped_by_user": None}
AUTO_START_WINDOW = ("09:00", "09:55")
SENSEX_COLLECTOR_START = (16, 5)
SENSEX_COLLECTOR_END_HOUR = 20
SENSEX_COLLECTOR_RETRY_SECONDS = 15 * 60
HERO_ZERO_START = (15, 5)
HERO_ZERO_END = (15, 31)

# Only these config keys are exposed/editable from the UI (never app_id/secret_key).
EDITABLE_SETTINGS = {
    "lots": (int, 1, 20),
    "daily_loss_limit": (int, 100, 100000),
    "strike_offset": (int, 0, 500),
    "option_target_pct": (int, 0, 200),
    "auto_start_capture": (bool, None, None),
}


def today() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d")


def read_csv_rows(path: Path) -> list:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def token_status() -> dict:
    # Cached: each check is a Fyers API call. A new token file invalidates the cache.
    mtime = TOKEN_FILE.stat().st_mtime if TOKEN_FILE.exists() else None
    if time.time() - _token_cache["at"] < 60 and _token_cache["value"] and _token_cache["mtime"] == mtime:
        return _token_cache["value"]
    value = {"valid": False, "generated_at_utc": None}
    if TOKEN_FILE.exists():
        tok = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
        value["generated_at_utc"] = tok.get("generated_at_utc")
        try:
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


def _process_pids_by_pattern(pattern: str) -> list[int]:
    """Return PIDs matching a command pattern, cross-platform."""
    if os.name == "nt":
        escaped = pattern.replace("'", "''")
        ps = (
            "Get-CimInstance Win32_Process | "
            "Where-Object { $_.CommandLine -match [regex]::Escape('%s') } | "
            "Select-Object -ExpandProperty ProcessId"
        ) % escaped
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
    return bool(_process_pids_by_pattern("fyers_nifty_capture"))


def start_capture() -> dict:
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
    subprocess.Popen([sys.executable, "-u", str(ROOT / "fyers_nifty_capture.py")], **kwargs)
    _capture["stopped_by_user"] = None
    return {"capture_running": True, "started": True}


def stop_capture() -> dict:
    pids = _process_pids_by_pattern("fyers_nifty_capture")
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
    """Start the capture on weekdays inside AUTO_START_WINDOW unless disabled or stopped by the user today."""
    while True:
        try:
            now = datetime.now(IST)
            day = now.strftime("%Y-%m-%d")
            in_window = now.weekday() < 5 and AUTO_START_WINDOW[0] <= now.strftime("%H:%M") <= AUTO_START_WINDOW[1]
            enabled = read_config().get("auto_start_capture", True)
            if in_window and enabled and _capture["stopped_by_user"] != day and _capture["auto_started"] != day:
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
    """Launch the paper-only expiry option capture before the 15:20 premium snapshot."""
    script = ROOT / "fyers_hero_zero_capture.py"
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
            process = bool(_process_pids_by_pattern("fyers_hero_zero_capture.py"))
            retry_due = last_attempt_date != session or time.time() - last_attempt_at >= 120
            if due and not status_path.exists() and not process and retry_due:
                output_dir.mkdir(parents=True, exist_ok=True)
                last_attempt_date, last_attempt_at = session, time.time()
                log = log_path.open("a", encoding="utf-8")
                log.write(f"\n[{now:%Y-%m-%d %H:%M:%S} IST] Starting HeroZero expiry capture.\n")
                log.flush()
                subprocess.Popen(
                    [sys.executable, "-u", str(script)],
                    cwd=ROOT,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                log.close()
                print(f"[{now:%H:%M:%S}] started HeroZero expiry capture")
        except Exception as exc:
            output_dir.mkdir(parents=True, exist_ok=True)
            with log_path.open("a", encoding="utf-8") as log:
                log.write(f"[{now:%Y-%m-%d %H:%M:%S} IST] Scheduler failed: {exc}\n")
            print(f"HeroZero scheduler failed: {exc}")
        time.sleep(30)


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


def candles(date: str) -> pd.DataFrame:
    path = LIVE_DIR / f"nifty_1min_{date}.csv"
    if path.exists():
        df = pd.read_csv(path)
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        return df
    m = master()
    if m.empty:
        return m
    return m[m["timestamp"].dt.strftime("%Y-%m-%d") == date].reset_index(drop=True)


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
    out["auto_start_capture"] = bool(cfg.get("auto_start_capture", True))
    out["live_trading"] = bool(cfg.get("live_trading"))
    out["capture_running"] = capture_running()
    return out


def update_settings(body: dict) -> tuple:
    cfg = read_config()
    for key, value in body.items():
        if key == "live_trading":
            if not isinstance(value, bool):
                return {"error": "live_trading must be true/false"}, 400
            if value and body.get("confirm") != "LIVE":
                return {"error": "type LIVE to confirm real-money trading"}, 400
            cfg["live_trading"] = value
        elif key in EDITABLE_SETTINGS:
            kind, lo, hi = EDITABLE_SETTINGS[key]
            if kind is bool:
                if not isinstance(value, bool):
                    return {"error": f"{key} must be true/false"}, 400
            else:
                if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
                    return {"error": f"{key} must be an integer between {lo} and {hi}"}, 400
            cfg[key] = value
        elif key != "confirm":
            return {"error": f"unknown setting: {key}"}, 400
    tmp = CONFIG_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(CONFIG_FILE)
    out = public_settings()
    out["restart_required"] = out["capture_running"]
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


def forming_candle(date: str, last_closed: str) -> dict:
    """Current minute's candle built from the 1-second file (not yet closed on Fyers)."""
    path = LIVE_DIR / f"nifty_1s_{date}.csv"
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


def current_rule_trades(df: pd.DataFrame) -> list:
    if df.empty:
        return []
    t = backtest_midpoint_strategy(df)
    if t.empty:
        return []
    return [
        {
            "side": "CALL" if r.side == "LONG" else "PUT",
            "entry": pd.Timestamp(r.entry_time).strftime("%H:%M"),
            "entry_price": round(r.entry, 2),
            "sl": round(r.stop, 2),
            "target": round(r.target, 2),
            "exit": pd.Timestamp(r.exit_time).strftime("%H:%M"),
            "exit_price": round(r.exit_price, 2),
            "reason": r.reason,
            "pnl_points": round(r.pnl_points, 2),
        }
        for r in t.itertuples()
    ]


def setup_info(df: pd.DataFrame) -> dict:
    if df.empty:
        return {}
    s = day_setup(df, list(df.index))
    out = {"so_far_high": float(df["high"].max()), "so_far_low": float(df["low"].min())}
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
    secs = LIVE_DIR / f"nifty_1s_{today()}.csv"
    last_tick = None
    if secs.exists():
        lines = secs.read_text(encoding="utf-8").strip().splitlines()
        if len(lines) > 1:
            ts, ltp, _ = lines[-1].split(",")
            last_tick = {"time": ts[11:], "ltp": float(ltp)}
    return {
        "now": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        "token": token_status(),
        "capture_running": capture_running(),
        "auto_start_capture": bool(cfg.get("auto_start_capture", True)),
        "mode": "LIVE" if cfg.get("live_trading") else "PAPER",
        "lots": cfg.get("lots", 1),
        "daily_loss_limit": cfg.get("daily_loss_limit"),
        "kill_switch": STOP_FILE.exists(),
        "last_tick": last_tick,
    }


def option_trades() -> list:
    """One row per option trade (BUY paired with the next SELL), all days."""
    out = []
    for path in sorted(LIVE_DIR.glob("live_orders_*.csv")):
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


def est_charges(buy_value: float, sell_value: float) -> float:
    """Approximate Fyers/NSE option-buy round-trip costs (rates may change; treat as an estimate)."""
    brokerage = 40.0  # Rs 20 per executed order
    stt = 0.001 * sell_value
    txn = 0.0003503 * (buy_value + sell_value)
    sebi = 0.000001 * (buy_value + sell_value)
    stamp = 0.00003 * buy_value
    gst = 0.18 * (brokerage + txn + sebi)
    return round(brokerage + stt + txn + sebi + stamp + gst, 2)


def paper_report() -> dict:
    """Paper/live option trades with estimated charges, net equity curve and drawdown."""
    return build_paper_report(option_trades())


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
                    "HEROZERO REPLAY · SPOT UNVERIFIED" if "spot_stale" in row.get("source", "")
                    else "HEROZERO 1M REPLAY" if "historical_1m_replay" in row.get("source", "")
                    else "HEROZERO PAPER"
                ),
            })
    return out


def hero_zero_report() -> dict:
    return build_paper_report(hero_zero_option_trades())


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
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

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
            df = candles(date)
            cutoff = ""
            if not df.empty:
                end = df["timestamp"].iloc[0] + pd.Timedelta(minutes=TRADE_WINDOW_MINUTES)
                df = df[df["timestamp"] <= end].reset_index(drop=True)
                cutoff = end.strftime("%H:%M")
            rows = [] if df.empty else [
                {"time": r.timestamp.strftime("%H:%M"), "open": r.open, "high": r.high, "low": r.low, "close": r.close}
                for r in df.itertuples()
            ]
            forming = forming_candle(date, rows[-1]["time"] if rows else "")
            if cutoff and forming.get("time", "") > cutoff:
                forming = {}
            self._json({
                "date": date,
                "cutoff": cutoff,
                "candles": rows,
                "forming": forming,
                "setup": setup_info(df),
                "trades": current_rule_trades(df),
            })
        elif url.path == "/api/signals":
            self._json(read_csv_rows(LIVE_DIR / f"signals_{date}.csv"))
        elif url.path == "/api/orders":
            self._json(read_csv_rows(LIVE_DIR / f"live_orders_{date}.csv"))
        elif url.path == "/api/trades":
            self._json(option_trades())
        elif url.path == "/api/paper-report":
            strategy = q.get("strategy", [""])[0]
            if strategy not in ("", "midpoint", "hero_zero"):
                return self._json({"error": "unknown strategy"}, 404)
            report = hero_zero_report() if strategy == "hero_zero" else paper_report()
            self._json(report)
        elif url.path == "/api/paper-trades":
            self._json(read_csv_rows(LIVE_DIR / "paper_trades.csv"))
        elif url.path == "/api/log":
            n = min(int(q.get("lines", ["200"])[0]), 2000)
            self._json(today_log(LIVE_DIR / "capture.log", n))
        elif url.path == "/api/days":
            self._json(available_days())
        elif url.path == "/api/backtest":
            strategy = q.get("strategy", [""])[0]
            if strategy not in ("", "midpoint"):
                return self._json({"error": "unknown strategy"}, 404)
            self._json(backtest_report())
        elif url.path == "/api/settings":
            self._json(public_settings())
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
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body)

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
        if url.path == "/api/kill-switch/on":
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
        else:
            self._json({"error": "not found"}, 404)

    def log_message(self, *_args):
        return


if __name__ == "__main__":
    threading.Thread(target=hero_zero_capture_loop, daemon=True, name="hero-zero-capture").start()
    threading.Thread(target=sensex_expiry_collector_loop, daemon=True, name="sensex-expiry-collector").start()
    threading.Thread(target=auto_start_loop, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Dashboard: http://{HOST}:{PORT}/  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass

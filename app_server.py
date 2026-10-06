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
LIVE_DIR = ROOT / "captured_data" / "fyers" / "live"
TOKEN_FILE = ROOT / "captured_data" / "fyers" / "fyers_access_token.json"
CONFIG_FILE = ROOT / "fyers_config.json"
STOP_FILE = ROOT / "STOP_TRADING"
UI_FILE = ROOT / "ui" / "dashboard.html"
WEB_DIST = ROOT / "web" / "dist"
MASTER_CSV = ROOT / "captured_data" / "fyers" / "fyers_spot_1min_extended.csv"
HOST, PORT = "127.0.0.1", 8090
IST = timezone(timedelta(hours=5, minutes=30))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_token_cache = {"at": 0.0, "mtime": None, "value": None}
_master_cache = {"mtime": None, "df": None}
_backtest_cache = {"mtime": None, "value": None}
_cache_lock = threading.Lock()
_login_proc = {"proc": None}

# Only these config keys are exposed/editable from the UI (never app_id/secret_key).
EDITABLE_SETTINGS = {
    "lots": (int, 1, 20),
    "daily_loss_limit": (int, 100, 100000),
    "strike_offset": (int, 0, 500),
    "skip_expiry_day": (bool, None, None),
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

            r = fyersModel.FyersModel(client_id=tok["app_id"], token=tok["access_token"], is_async=False, log_path="/tmp").get_profile()
            value["valid"] = r.get("s") == "ok"
        except Exception:
            pass
    _token_cache.update(at=time.time(), mtime=mtime, value=value)
    return value


def capture_running() -> bool:
    return subprocess.run(["pgrep", "-f", "fyers_nifty_capture"], capture_output=True).returncode == 0


def master() -> pd.DataFrame:
    """Master 1-min history (stored in UTC), converted to naive IST like the live files."""
    if not MASTER_CSV.exists():
        return pd.DataFrame()
    mtime = MASTER_CSV.stat().st_mtime
    with _cache_lock:
        if _master_cache["mtime"] != mtime:
            df = pd.read_csv(MASTER_CSV)
            ts = pd.to_datetime(df["timestamp"], errors="coerce")
            df["timestamp"] = ts.dt.tz_localize("UTC").dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
            df = df.dropna(subset=["timestamp", "open", "high", "low", "close"]).sort_values("timestamp").reset_index(drop=True)
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
    mtime = MASTER_CSV.stat().st_mtime
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


def tail(path: Path, lines: int) -> list:
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]


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
        elif url.path == "/api/paper-trades":
            self._json(read_csv_rows(LIVE_DIR / "paper_trades.csv"))
        elif url.path == "/api/log":
            n = min(int(q.get("lines", ["200"])[0]), 2000)
            self._json(tail(LIVE_DIR / "capture.log", n))
        elif url.path == "/api/days":
            self._json(available_days())
        elif url.path == "/api/backtest":
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
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Dashboard: http://{HOST}:{PORT}/  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass

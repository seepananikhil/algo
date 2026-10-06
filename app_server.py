#!/usr/bin/env python3
"""Local dashboard + JSON API for the NIFTY strategy (read-only, plus the STOP_TRADING kill switch).

Run: python3 app_server.py  ->  http://127.0.0.1:8090
"""

from __future__ import annotations

import csv
import json
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd

from midpoint_strategy import backtest_midpoint_strategy, day_setup, pending_entry

ROOT = Path(__file__).resolve().parent
LIVE_DIR = ROOT / "captured_data" / "fyers" / "live"
TOKEN_FILE = ROOT / "captured_data" / "fyers" / "fyers_access_token.json"
CONFIG_FILE = ROOT / "fyers_config.json"
STOP_FILE = ROOT / "STOP_TRADING"
UI_FILE = ROOT / "ui" / "dashboard.html"
HOST, PORT = "127.0.0.1", 8090
IST = timezone(timedelta(hours=5, minutes=30))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_token_cache = {"at": 0.0, "value": None}


def today() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d")


def read_csv_rows(path: Path) -> list:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def token_status() -> dict:
    # Cached: each check is a Fyers API call.
    if time.time() - _token_cache["at"] < 60 and _token_cache["value"]:
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
    _token_cache.update(at=time.time(), value=value)
    return value


def capture_running() -> bool:
    return subprocess.run(["pgrep", "-f", "fyers_nifty_capture"], capture_output=True).returncode == 0


def candles(date: str) -> pd.DataFrame:
    path = LIVE_DIR / f"nifty_1min_{date}.csv"
    if not path.exists():
        return pd.DataFrame()
    df = pd.read_csv(path)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


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
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}
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

        if url.path in ("/", "/index.html"):
            body = UI_FILE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
        elif url.path == "/api/status":
            self._json(status())
        elif url.path == "/api/day":
            df = candles(date)
            rows = [] if df.empty else [
                {"time": r.timestamp.strftime("%H:%M"), "open": r.open, "high": r.high, "low": r.low, "close": r.close}
                for r in df.itertuples()
            ]
            self._json({
                "date": date,
                "candles": rows,
                "forming": forming_candle(date, rows[-1]["time"] if rows else ""),
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
        else:
            self._json({"error": "not found"}, 404)

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

#!/usr/bin/env python3
"""Targeted Hero-Zero option capture for NIFTY expiry sessions.

At 15:19 IST: Queries NIFTY spot, identifies nearby strikes around ATM (±150 pts).
At 15:20 IST: Takes a fast REST snapshot, selects 1 CE and 1 PE in the ₹8.0–₹12.0 target band.
From 15:20 to 15:29:50 IST: Tracks selected positions and logs ticks.
At 15:29:50 IST: Closes positions at market on final candle before expiry.
"""

from __future__ import annotations

import csv
import json
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fyers_apiv3 import fyersModel

from fyers_orders import available_equity_funds, load_nifty_options, place_live_order

ROOT = Path(__file__).resolve().parent
TOKEN_FILE = ROOT / "captured_data" / "fyers" / "fyers_access_token.json"
CONFIG_FILE = ROOT / "fyers_config.json"
OUTPUT_DIR = ROOT / "captured_data" / "fyers" / "hero_zero"
TMP_DIR = ROOT / "tmp" / "fyers" / "hero_zero"
IST = timezone(timedelta(hours=5, minutes=30))
NIFTY_INDEX = "NSE:NIFTY50-INDEX"

SNAPSHOT_TIME = (15, 20)
EXIT_TIME = (15, 29, 50)
CAPTURE_END = (15, 30, 30)

NIFTY_PRICE_BAND = (8.0, 12.0)
FALLBACK_PRICE_BAND = (5.0, 16.0)

CANDIDATE_HEADER = [
    "date", "underlying", "expiry", "symbol", "option_type", "strike", "lot_size",
    "spot_ltp", "distance_from_spot", "band_low", "band_high", "snapshot_at",
    "received_at", "quote_age_seconds", "snapshot_ltp", "volume_at_snapshot", "source"
]
TICK_HEADER = ["date", "timestamp", "underlying", "symbol", "ltp", "volume", "exchange_time"]
PAPER_TRADE_HEADER = [
    "date", "underlying", "expiry", "symbol", "option_type", "strike", "lot_size",
    "spot_ltp", "distance_from_spot", "entry_time", "entry_price", "entry_volume",
    "exit_time", "exit_price", "exit_volume", "pnl_per_unit", "pnl_rs", "status",
    "exit_reason", "source"
]
LIVE_ORDER_HEADER = ["date", "time", "action", "symbol", "qty", "order_id", "fill_price", "reason", "status"]


def now_ist() -> datetime:
    return datetime.now(IST)


def append_row(path: Path, header: list, row: list) -> None:
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new:
            writer.writerow(header)
        writer.writerow(row)


def write_status(path: Path, value: dict) -> None:
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temp.replace(path)


class HeroZeroCapture:
    def __init__(self, session: date) -> None:
        token = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
        self.app_id = token["app_id"]
        self.access_token = token["access_token"]
        TMP_DIR.mkdir(parents=True, exist_ok=True)
        self.rest = fyersModel.FyersModel(
            client_id=self.app_id, token=self.access_token, is_async=False, log_path=str(TMP_DIR) + "/"
        )
        profile = self.rest.get_profile()
        if profile.get("s") != "ok":
            raise RuntimeError("Fyers token is invalid or expired")

        self.session = session
        config = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}
        self.live_trading = bool(config.get("hero_zero_live_trading", False))
        self.lots = max(1, int(config.get("hero_zero_lots", 1)))
        self.minimum_live_funds = float(config.get("minimum_live_funds", 10000))

        self.output_dir = OUTPUT_DIR
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.candidates_file = self.output_dir / f"hero_zero_candidates_{session}.csv"
        self.ticks_file = self.output_dir / f"hero_zero_ticks_{session}.csv"
        self.status_file = self.output_dir / f"hero_zero_status_{session}.json"
        self.live_orders_file = self.output_dir / f"hero_zero_orders_{session}.csv"

        self.candidates: dict[str, dict] = {}
        self.live_positions: dict[str, dict] = {}
        self.live_results: dict[str, dict] = {}
        self.live_order_halted = False
        self.live_reserved_funds = 0.0

    def _log_live_order(self, action: str, candidate: dict, quantity: int, order_id: str, fill: str | float, reason: str, status: str) -> None:
        append_row(self.live_orders_file, LIVE_ORDER_HEADER, [
            self.session.isoformat(), now_ist().strftime("%H:%M:%S"), action, candidate["symbol"], quantity,
            order_id, fill, reason, status,
        ])

    def _enter_live_order(self, candidate: dict) -> None:
        if self.live_order_halted:
            return
        symbol = candidate["symbol"]
        quantity = int(candidate["lot_size"]) * self.lots
        try:
            available = available_equity_funds(self.rest.funds())
            if available is None:
                self.live_order_halted = True
                self._log_live_order("SKIP", candidate, quantity, "", "", "available_funds_unavailable", "not_submitted")
                print("HeroZero LIVE halted: available funds unavailable; no order submitted")
                return
            if available < self.minimum_live_funds:
                self.live_order_halted = True
                self._log_live_order("SKIP", candidate, quantity, "", "", "below_minimum_funds", "not_submitted")
                print(f"HeroZero LIVE halted: Rs {available:.2f} available, Rs {self.minimum_live_funds:.2f} required")
                return

            quotes = self.rest.quotes(data={"symbols": symbol})
            if quotes.get("s") != "ok" or not quotes.get("d"):
                self._log_live_order("SKIP", candidate, quantity, "", "", "option_quote_unavailable", "not_submitted")
                return
            premium = float(quotes["d"][0]["v"]["lp"])
            estimated_debit = premium * quantity * 1.05
            required_funds = self.live_reserved_funds + estimated_debit
            if available < required_funds:
                self._log_live_order("SKIP", candidate, quantity, "", "", "insufficient_entry_funds", "not_submitted")
                return

            order_id, fill = place_live_order(self.rest, symbol, quantity, 1)
            self.live_positions[symbol] = {
                "candidate": candidate,
                "quantity": quantity,
                "entry_order_id": order_id,
                "entry_price": fill,
                "entry_time": now_ist(),
                "reserved_funds": estimated_debit,
            }
            self.live_reserved_funds += estimated_debit
            self._log_live_order("BUY", candidate, quantity, order_id, fill, "hero_zero_entry", "filled")
            print(f"HeroZero LIVE BUY {symbol} qty {quantity} @ {fill}")
        except Exception as exc:
            self.live_order_halted = True
            self._log_live_order("BUY", candidate, quantity, "", "", str(exc), "failed")
            print(f"HeroZero LIVE entry failed; halting additional entries: {exc}")

    def _exit_live_positions(self) -> None:
        for symbol, position in list(self.live_positions.items()):
            candidate = position["candidate"]
            quantity = position["quantity"]
            try:
                order_id, fill = place_live_order(self.rest, symbol, quantity, -1)
                exited_at = now_ist()
                result = {**position, "exit_order_id": order_id, "exit_price": fill, "exit_time": exited_at}
                self.live_results[symbol] = result
                self._log_live_order("SELL", candidate, quantity, order_id, fill, "expiry_exit", "filled")
                self.live_reserved_funds = max(0.0, self.live_reserved_funds - position["reserved_funds"])
                self.live_positions.pop(symbol, None)
                print(f"HeroZero LIVE SELL {symbol} qty {quantity} @ {fill}")
            except Exception as exc:
                self._log_live_order("SELL", candidate, quantity, "", "", str(exc), "failed_open_position")
                print(f"CRITICAL: HeroZero LIVE exit failed for {symbol}; close it manually: {exc}")

    def _quote_with_retry(self, symbols_str: str, max_retries: int = 3) -> dict:
        for attempt in range(max_retries):
            try:
                resp = self.rest.quotes(data={"symbols": symbols_str})
                if resp.get("s") == "ok":
                    return resp
            except Exception as exc:
                print(f"Quotes call failed (attempt {attempt+1}/{max_retries}): {exc}")
                try:
                    self.rest = fyersModel.FyersModel(
                        client_id=self.app_id, token=self.access_token, is_async=False, log_path=str(TMP_DIR) + "/"
                    )
                except Exception:
                    pass
            time.sleep(0.5)
        return {}

    def _select_candidates(self, nifty_today) -> dict[str, dict]:
        """Query Nifty spot and nearby strikes, then select 1 CE and 1 PE."""
        now = now_ist()
        spot_resp = self._quote_with_retry(NIFTY_INDEX)
        if not spot_resp.get("d"):
            print("Failed to get NIFTY spot quote after retries")
            return {}
        spot_ltp = float(spot_resp["d"][0]["v"]["lp"])
        atm = round(spot_ltp / 50.0) * 50.0
        candidate_strikes = [
            atm - 250.0, atm - 200.0, atm - 150.0, atm - 100.0, atm - 50.0,
            atm,
            atm + 50.0, atm + 100.0, atm + 150.0, atm + 200.0, atm + 250.0,
        ]

        sub = nifty_today[nifty_today["strike"].isin(candidate_strikes)]
        if sub.empty:
            print("No nearby strikes found in today's expiry master")
            return {}

        symbols = list(sub["symbol"].unique())
        quote_resp = self._quote_with_retry(",".join(symbols))
        quotes = {}
        for d in quote_resp.get("d") or []:
            sym = d.get("n")
            v = d.get("v") or {}
            if sym and v.get("lp") is not None:
                quotes[sym] = {
                    "ltp": float(v["lp"]),
                    "volume": v.get("volume", ""),
                    "exchange_time": v.get("tt", ""),
                }

        chosen = {}
        for opt_type in ("CE", "PE"):
            for band_low, band_high in (NIFTY_PRICE_BAND, FALLBACK_PRICE_BAND):
                matching = []
                for r in sub.itertuples(index=False):
                    if str(r.opt_type) != opt_type:
                        continue
                    sym = str(r.symbol)
                    q = quotes.get(sym)
                    if not q or q["ltp"] <= 0:
                        continue
                    ltp = q["ltp"]
                    if band_low <= ltp <= band_high:
                        matching.append({
                            "underlying": "NIFTY",
                            "expiry": str(r.expiry),
                            "symbol": sym,
                            "lot_size": int(r.lot_size),
                            "option_type": opt_type,
                            "strike": float(r.strike),
                            "spot_ltp": spot_ltp,
                            "distance_from_spot": round(float(r.strike) - spot_ltp, 2),
                            "band_low": band_low,
                            "band_high": band_high,
                            "snapshot_at": now,
                            "snapshot_ltp": ltp,
                            "quote": q,
                        })
                if matching:
                    best = sorted(
                        matching,
                        key=lambda c: (abs(c["snapshot_ltp"] - 10.0), abs(c["distance_from_spot"]))
                    )[0]
                    chosen[best["symbol"]] = best
                    break

        has_ce = any(c["option_type"] == "CE" for c in chosen.values())
        has_pe = any(c["option_type"] == "PE" for c in chosen.values())
        if not (has_ce and has_pe):
            print(f"[{now:%H:%M:%S}] Candidate check failed: CE={has_ce}, PE={has_pe}. Backing off!")
            return {}

        return chosen

    def run(self) -> dict:
        nifty = load_nifty_options()
        nifty_today = nifty[nifty["expiry"] == self.session]
        if nifty_today.empty:
            result = {
                "date": self.session.isoformat(),
                "status": "not_expiry_session",
                "expiry_underlyings": {"NIFTY": []},
            }
            write_status(self.status_file, result)
            print(f"{self.session}: no NIFTY expiry contracts; HeroZero skipped")
            return result

        print(f"[{now_ist():%H:%M:%S}] HeroZero ready for NIFTY expiry {self.session} ({len(nifty_today)} contracts)")

        # 1. Wait until 15:19:58 IST for the 15:20 snapshot
        target_snapshot = now_ist().replace(hour=SNAPSHOT_TIME[0], minute=SNAPSHOT_TIME[1], second=0, microsecond=0)
        now = now_ist()
        if now < target_snapshot:
            wait_sec = (target_snapshot - now).total_seconds()
            print(f"[{now:%H:%M:%S}] Waiting {wait_sec:.0f}s until 15:20:00 IST snapshot...")
            time.sleep(max(0.0, wait_sec - 1.0))
            while now_ist() < target_snapshot:
                time.sleep(0.05)

        # 2. Take fast REST snapshot at 15:20 IST (retries for up to 30s if transient error)
        snap_deadline = max(now_ist() + timedelta(seconds=30), target_snapshot + timedelta(seconds=30))
        snap_now = now_ist()
        while now_ist() < snap_deadline:
            snap_now = now_ist()
            self.candidates = self._select_candidates(nifty_today)
            if self.candidates and len(self.candidates) == 2:
                break
            time.sleep(2.0)

        if not self.candidates or len(self.candidates) != 2:
            print(f"[{snap_now:%H:%M:%S}] HeroZero BACK OFF: Either CE or PE missing in target band. No entry taken.")
            result = {
                "date": self.session.isoformat(),
                "status": "backed_off_incomplete_strangle",
                "trading_mode": "LIVE" if self.live_trading else "PAPER",
                "selected_options": len(self.candidates),
                "paper_trades": 0,
                "live_trades": 0,
                "open_live_positions": 0,
                "reason": "Missing either CE or PE in target band; avoided single-leg entry",
            }
            write_status(self.status_file, result)
            return result

        print(f"[{snap_now:%H:%M:%S}] HeroZero confirmed BOTH legs ({len(self.candidates)} options):")
        for sym, c in self.candidates.items():
            print(f"  -> {c['option_type']} {c['strike']} ({sym}): LTP = {c['snapshot_ltp']} (spot dist {c['distance_from_spot']:+0.1f})")
            append_row(self.candidates_file, CANDIDATE_HEADER, [
                self.session.isoformat(), "NIFTY", c["expiry"], sym,
                c["option_type"], c["strike"], c["lot_size"],
                c["spot_ltp"], c["distance_from_spot"], c["band_low"], c["band_high"],
                snap_now.strftime("%Y-%m-%d %H:%M:%S"), snap_now.strftime("%Y-%m-%d %H:%M:%S"),
                0.0, c["snapshot_ltp"], c["quote"].get("volume", ""), "rest_snapshot",
            ])
            append_row(self.ticks_file, TICK_HEADER, [
                self.session.isoformat(), snap_now.strftime("%Y-%m-%d %H:%M:%S.%f"),
                "NIFTY", sym, c["snapshot_ltp"], c["quote"].get("volume", ""), c["quote"].get("exchange_time", ""),
            ])

        # 3. Enter LIVE orders if enabled (STRICTLY both CE and PE)
        if self.live_trading and len(self.candidates) == 2:
            print(f"[{now_ist():%H:%M:%S}] Entering BOTH legs live...")
            for candidate in self.candidates.values():
                self._enter_live_order(candidate)

        # 4. Track positions every 2 seconds until 15:29:50 exit
        exit_target = now_ist().replace(hour=EXIT_TIME[0], minute=EXIT_TIME[1], second=EXIT_TIME[2], microsecond=0)
        tracked_symbols = list(self.candidates.keys()) + [NIFTY_INDEX]
        latest_quotes = {}

        while now_ist() < exit_target:
            if tracked_symbols:
                try:
                    q_resp = self.rest.quotes(data={"symbols": ",".join(tracked_symbols)})
                    tick_now = now_ist()
                    for d in q_resp.get("d") or []:
                        s = d.get("n")
                        v = d.get("v") or {}
                        if s and v.get("lp") is not None:
                            lp = float(v["lp"])
                            vol = v.get("volume", "")
                            tt = v.get("tt", "")
                            latest_quotes[s] = {"ltp": lp, "volume": vol, "received_at": tick_now}
                            if s in self.candidates:
                                append_row(self.ticks_file, TICK_HEADER, [
                                    self.session.isoformat(), tick_now.strftime("%Y-%m-%d %H:%M:%S.%f"),
                                    "NIFTY", s, lp, vol, tt,
                                ])
                except Exception:
                    pass
            time.sleep(2.0)

        # 5. Exit LIVE positions at 15:29:50 IST
        if self.live_trading and self.live_positions:
            self._exit_live_positions()

        # 6. Fetch final exit quotes
        if tracked_symbols:
            try:
                final_resp = self.rest.quotes(data={"symbols": ",".join(tracked_symbols)})
                final_now = now_ist()
                for d in final_resp.get("d") or []:
                    s = d.get("n")
                    v = d.get("v") or {}
                    if s and v.get("lp") is not None:
                        latest_quotes[s] = {"ltp": float(v["lp"]), "volume": v.get("volume", ""), "received_at": final_now}
            except Exception:
                pass

        # 7. Write trades to CSV
        trades_file = self.output_dir / f"hero_zero_trades_{self.session}.csv"
        paper_count = 0
        live_count = 0
        for sym, candidate in self.candidates.items():
            result = self.live_results.get(sym)
            if result:
                entry_price = result["entry_price"]
                exit_price = result["exit_price"]
                qty = result["quantity"]
                pnl_per_unit = round(exit_price - entry_price, 2)
                pnl_rs = round(pnl_per_unit * qty, 2)
                append_row(trades_file, PAPER_TRADE_HEADER, [
                    self.session.isoformat(), "NIFTY", candidate["expiry"], sym,
                    candidate["option_type"], candidate["strike"], qty,
                    candidate["spot_ltp"], candidate["distance_from_spot"],
                    result["entry_time"].strftime("%Y-%m-%d %H:%M:%S"), entry_price,
                    candidate["quote"].get("volume", ""), result["exit_time"].strftime("%Y-%m-%d %H:%M:%S"),
                    exit_price, "", pnl_per_unit, pnl_rs,
                    "closed", "hero_zero_live_market_exit", "hero_zero_live",
                ])
                live_count += 1
            else:
                entry_price = candidate["snapshot_ltp"]
                q_exit = latest_quotes.get(sym)
                exit_price = q_exit["ltp"] if q_exit else entry_price
                qty = int(candidate["lot_size"]) * self.lots
                pnl_per_unit = round(exit_price - entry_price, 2)
                pnl_rs = round(pnl_per_unit * qty, 2)
                exit_time_str = (q_exit["received_at"] if q_exit else now_ist()).strftime("%Y-%m-%d %H:%M:%S")
                append_row(trades_file, PAPER_TRADE_HEADER, [
                    self.session.isoformat(), "NIFTY", candidate["expiry"], sym,
                    candidate["option_type"], candidate["strike"], qty,
                    candidate["spot_ltp"], candidate["distance_from_spot"],
                    candidate["snapshot_at"].strftime("%Y-%m-%d %H:%M:%S"), entry_price,
                    candidate["quote"].get("volume", ""), exit_time_str,
                    exit_price, q_exit.get("volume", "") if q_exit else "", pnl_per_unit, pnl_rs,
                    "closed", "time_exit_15:30",
                    "hero_zero_live_paper_fallback" if self.live_trading else "live_ticks",
                ])
                paper_count += 1

        result = {
            "date": self.session.isoformat(),
            "status": "captured",
            "trading_mode": "LIVE" if self.live_trading else "PAPER",
            "expiry_underlyings": {"NIFTY": [self.session.isoformat()]},
            "selected_options": len(self.candidates),
            "paper_trades": paper_count,
            "live_trades": live_count,
            "open_live_positions": len(self.live_positions),
            "bands": {"NIFTY": list(NIFTY_PRICE_BAND)},
            "selection_time": "15:20 Asia/Kolkata",
            "exit_time": "15:30 Asia/Kolkata",
            "candidates_csv": self.candidates_file.name,
            "ticks_csv": self.ticks_file.name,
            "paper_trades_csv": f"hero_zero_trades_{self.session}.csv",
            "live_orders_csv": self.live_orders_file.name if self.live_trading else None,
        }
        write_status(self.status_file, result)
        print(f"[{now_ist():%H:%M:%S}] HeroZero session completed: {json.dumps(result)}")
        return result


def main() -> None:
    session = now_ist().date()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    status_file = OUTPUT_DIR / f"hero_zero_status_{session}.json"
    result = HeroZeroCapture(session).run()


if __name__ == "__main__":
    main()

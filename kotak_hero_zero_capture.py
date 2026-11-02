#!/usr/bin/env python3
"""Targeted Hero-Zero option capture for SENSEX and NIFTY expiry sessions via Kotak Neo.

Rules & Timing:
- Runs on expiry days (SENSEX BSE F&O or NIFTY NSE F&O).
- Snapshot Time: 15:18:00 IST (3:18 PM).
- Fast Strike Selection (Direct ATM offset):
    * SENSEX: ATM + 100 for CE, ATM - 100 for PE (₹25-₹35 sweet spot)
    * NIFTY:  ATM + 50 for CE,  ATM - 50 for PE (₹15-₹25 sweet spot)
    * Instant 1-second lookup without querying the full option chain.
- Exit Time: 15:29:50 IST (closes at market on the final candle before expiry).
- Works in PAPER mode (default) or LIVE mode (if hero_zero_live_trading=true).
- Logs trades to captured_data/fyers/hero_zero/hero_zero_trades_<session>.csv.
"""

from __future__ import annotations

import csv
import json
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from kotak_orders import (
    available_kotak_funds,
    get_kotak_client,
    kotak_token_status,
    place_kotak_order,
)

ROOT = Path(__file__).resolve().parent
CONFIG_FILE = ROOT / "fyers_config.json"
OUTPUT_DIR = ROOT / "captured_data" / "fyers" / "hero_zero"
TMP_DIR = ROOT / "tmp" / "kotak" / "hero_zero"
IST = timezone(timedelta(hours=5, minutes=30))

SNAPSHOT_TIME = (15, 18)
EXIT_TIME = (15, 29, 50)
CAPTURE_END = (15, 30, 30)

CANDIDATE_HEADER = [
    "date", "underlying", "expiry", "symbol", "option_type", "strike", "lot_size",
    "spot_ltp", "distance_from_spot", "band_low", "band_high", "snapshot_at",
    "received_at", "quote_age_seconds", "snapshot_ltp", "volume_at_snapshot", "source",
]
TICK_HEADER = ["date", "timestamp", "underlying", "symbol", "ltp", "volume", "exchange_time"]
PAPER_TRADE_HEADER = [
    "date", "underlying", "expiry", "symbol", "option_type", "strike", "lot_size",
    "spot_ltp", "distance_from_spot", "entry_time", "entry_price", "entry_volume",
    "exit_time", "exit_price", "exit_volume", "pnl_per_unit", "pnl_rs", "status",
    "exit_reason", "source",
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


def parse_expiry(item: dict) -> Optional[date]:
    """Parse expiry from Kotak Neo scrip item supporting pExpiryDate (e.g. 29Oct2026) and lExpiryDate timestamp."""
    p_exp = item.get("pExpiryDate")
    if p_exp:
        try:
            return datetime.strptime(str(p_exp).strip(), "%d%b%Y").date()
        except Exception:
            pass
    l_exp = item.get("lExpiryDate")
    if l_exp and int(l_exp) > 0:
        try:
            return datetime.fromtimestamp(int(l_exp), tz=IST).date()
        except Exception:
            pass
    return None


def load_expiry_options(client, session: date) -> tuple[str, list[dict], dict]:
    """Check both SENSEX (BSE) and NIFTY (NSE) for contracts expiring today."""
    # 1. Check SENSEX on bse_fo
    sensex_rows = []
    for opt_type in ("CE", "PE"):
        try:
            scrips = client.search_scrip(exchange_segment="bse_fo", symbol="SENSEX", option_type=opt_type) or []
            for item in scrips:
                if item.get("pSymbolName") == "SENSEX":
                    exp_date = parse_expiry(item)
                    if exp_date == session:
                        raw_stk = item.get("dStrikePrice;", 0)
                        sensex_rows.append({
                            "underlying": "SENSEX",
                            "exchange": "bse_fo",
                            "symbol": str(item.get("pTrdSymbol", "")),
                            "token": str(item.get("pSymbol", "")),
                            "lot_size": int(item.get("lLotSize", 20)),
                            "strike": float(raw_stk) / 100.0,
                            "opt_type": opt_type,
                            "expiry": exp_date,
                        })
        except Exception as e:
            print(f"[load_opts] SENSEX {opt_type} error: {e}")

    if sensex_rows:
        cfg = {"underlying": "SENSEX", "exchange": "bse_fo", "strike_step": 100.0, "offset": 100.0, "lot_size": 20}
        return "SENSEX", sensex_rows, cfg

    # 2. Check NIFTY on nse_fo
    nifty_rows = []
    for opt_type in ("CE", "PE"):
        try:
            scrips = client.search_scrip(exchange_segment="nse_fo", symbol="NIFTY", option_type=opt_type) or []
            for item in scrips:
                if item.get("pSymbolName") == "NIFTY":
                    exp_date = parse_expiry(item)
                    if exp_date == session:
                        raw_stk = item.get("dStrikePrice;", 0)
                        nifty_rows.append({
                            "underlying": "NIFTY",
                            "exchange": "nse_fo",
                            "symbol": str(item.get("pTrdSymbol", "")),
                            "token": str(item.get("pSymbol", "")),
                            "lot_size": int(item.get("lLotSize", 25)),
                            "strike": float(raw_stk) / 100.0,
                            "opt_type": opt_type,
                            "expiry": exp_date,
                        })
        except Exception as e:
            print(f"[load_opts] NIFTY {opt_type} error: {e}")

    if nifty_rows:
        cfg = {"underlying": "NIFTY", "exchange": "nse_fo", "strike_step": 50.0, "offset": 50.0, "lot_size": 25}
        return "NIFTY", nifty_rows, cfg

    return "", [], {}


class HeroZeroCapture:
    def __init__(self, session: date) -> None:
        status = kotak_token_status()
        if not status.get("valid"):
            raise RuntimeError(f"Kotak Neo token is invalid or expired: {status.get('reason', status.get('error', ''))}")

        self.client = get_kotak_client()
        if self.client is None:
            raise RuntimeError("Kotak Neo client could not be initialised")

        self.session = session
        config = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}
        self.live_trading = bool(config.get("hero_zero_live_trading", False))
        self.lots = max(1, int(config.get("hero_zero_lots", 1)))
        self.minimum_live_funds = float(config.get("minimum_live_funds", 10000))

        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        TMP_DIR.mkdir(parents=True, exist_ok=True)
        self.candidates_file = OUTPUT_DIR / f"hero_zero_candidates_{session}.csv"
        self.ticks_file = OUTPUT_DIR / f"hero_zero_ticks_{session}.csv"
        self.status_file = OUTPUT_DIR / f"hero_zero_status_{session}.json"
        self.live_orders_file = OUTPUT_DIR / f"hero_zero_orders_{session}.csv"

        self.candidates: dict[str, dict] = {}
        self.live_positions: dict[str, dict] = {}
        self.live_results: dict[str, dict] = {}
        self.live_order_halted = False
        self.live_reserved_funds = 0.0

    def _get_spot(self, underlying: str) -> tuple[Optional[float], dict]:
        """Fetch cash index spot quote directly from BSE/NSE cash segment."""
        token = "SENSEX" if underlying == "SENSEX" else "Nifty 50"
        segment = "bse_cm" if underlying == "SENSEX" else "nse_cm"
        try:
            resp = self.client.quotes([{"instrument_token": token, "exchange_segment": segment}])
            if isinstance(resp, list) and resp:
                q = resp[0]
                ltp = q.get("ltp") or q.get("last_trade_price")
                ohlc = q.get("ohlc") or {}
                if ltp and float(ltp) > 0:
                    return float(ltp), ohlc
        except Exception as exc:
            print(f"[get_spot] {underlying} ({segment}) quote failed: {exc}")

        # Fallback to search_scrip for near futures if cash index quote fails
        try:
            exchange = "bse_fo" if underlying == "SENSEX" else "nse_fo"
            res = self.client.search_scrip(
                exchange_segment=exchange,
                symbol=underlying,
                option_type="XX" if exchange == "bse_fo" else "FUT",
            )
            if isinstance(res, list):
                futs = [x for x in res if x.get("pSymbolName") == underlying and "FUT" in str(x.get("pTrdSymbol", ""))]
                if futs:
                    tok = str(futs[0].get("pSymbol", ""))
                    q = self.client.quotes([{"instrument_token": tok, "exchange_segment": exchange}])
                    if isinstance(q, list) and q:
                        ltp = q[0].get("ltp") or q[0].get("last_trade_price")
                        ohlc = q[0].get("ohlc") or {}
                        if ltp and float(ltp) > 0:
                            return float(ltp), ohlc
        except Exception as exc:
            print(f"[get_spot fallback] {underlying} lookup failed: {exc}")
        return None, {}

    def _batch_quotes(self, token_list: list[str], exchange: str) -> dict[str, dict]:
        if not token_list:
            return {}
        try:
            req = [{"instrument_token": t, "exchange_segment": exchange} for t in token_list]
            resp = self.client.quotes(req)
            result = {}
            if isinstance(resp, list):
                for item in resp:
                    if not isinstance(item, dict):
                        continue
                    tok = str(item.get("instrument_token", ""))
                    ltp = item.get("ltp") or item.get("last_trade_price")
                    vol = item.get("volume", "")
                    tt = item.get("exchange_time", item.get("last_trade_time", ""))
                    if ltp is not None:
                        result[tok] = {"ltp": float(ltp), "volume": vol, "exchange_time": tt}
            return result
        except Exception as exc:
            print(f"[batch_quotes] error: {exc}")
            return {}

    def _select_candidates_dynamic(self, contracts: list[dict], cfg: dict, spot_ltp: float) -> dict[str, dict]:
        """Dynamic sweet-spot strike selection:
        - SENSEX: Target ~Rs 25-30 (acceptable band Rs 20-35, fallback Rs 15-42)
        - NIFTY:  Target ~Rs 15-25 (acceptable band Rs 12-28, fallback Rs 8-35)
        Scans strikes around ATM and selects the contract closest to the sweet-spot midpoint.
        """
        now = now_ist()
        underlying = cfg["underlying"]
        exchange = cfg["exchange"]
        step = cfg["strike_step"]

        atm = round(spot_ltp / step) * step

        if underlying == "SENSEX":
            target_mid = 27.5
            primary_band = (20.0, 35.0)
            fallback_band = (15.0, 42.0)
            # Scan strikes near ATM (CE >= ATM, PE <= ATM) up to 400 pts
            ce_strikes = [atm + i * step for i in range(0, 5)]
            pe_strikes = [atm - i * step for i in range(0, 5)]
        else:
            target_mid = 20.0
            primary_band = (12.0, 28.0)
            fallback_band = (8.0, 35.0)
            ce_strikes = [atm + i * step for i in range(0, 5)]
            pe_strikes = [atm - i * step for i in range(0, 5)]

        print(f"[{now:%H:%M:%S}] {underlying} Spot: {spot_ltp:.2f} | ATM: {atm:.0f} | Scanning sweet-spot options around target Rs {target_mid:.1f}")

        ce_pool = [c for c in contracts if c["opt_type"] == "CE" and any(abs(c["strike"] - s) < 0.1 for s in ce_strikes)]
        pe_pool = [c for c in contracts if c["opt_type"] == "PE" and any(abs(c["strike"] - s) < 0.1 for s in pe_strikes)]

        all_pool = ce_pool + pe_pool
        if not all_pool:
            print(f"No matching strikes found near ATM {atm}")
            return {}

        toks = [c["token"] for c in all_pool]
        qs = self._batch_quotes(toks, exchange)

        chosen = {}
        for opt_type, pool in (("CE", ce_pool), ("PE", pe_pool)):
            best_contract = None
            best_quote = None

            for band in (primary_band, fallback_band):
                band_matches = []
                for c in pool:
                    q = qs.get(c["token"])
                    if not q or q["ltp"] <= 0:
                        continue
                    ltp = q["ltp"]
                    if band[0] <= ltp <= band[1]:
                        band_matches.append((c, q, abs(ltp - target_mid)))

                if band_matches:
                    band_matches.sort(key=lambda x: x[2])
                    best_contract, best_quote, _ = band_matches[0]
                    break

            if best_contract and best_quote:
                chosen[best_contract["symbol"]] = {
                    **best_contract,
                    "spot_ltp": spot_ltp,
                    "distance_from_spot": round(best_contract["strike"] - spot_ltp, 2),
                    "band_low": primary_band[0],
                    "band_high": primary_band[1],
                    "snapshot_at": now,
                    "snapshot_ltp": best_quote["ltp"],
                    "quote": best_quote,
                }
            else:
                print(f"Warning: No {underlying} {opt_type} option found within safe price band {fallback_band}")

        return chosen

    def _check_key_level_filter(self, underlying: str, cfg: dict, spot_ltp: float, ohlc: dict) -> tuple[bool, str, dict]:
        """Key Level & Volatility Gate Filter:
        1. Macro Day Range >= 300 pts (for SENSEX).
        2. Proximity to 500-level (<= 65 pts) OR Day High/Low (<= 60 pts).
        """
        if underlying != "SENSEX":
            dist_round = abs(spot_ltp - round(spot_ltp / 100.0) * 100.0)
            return True, f"{underlying} key level check passed (dist={dist_round:.1f})", {"spot": spot_ltp}

        dh = float(ohlc.get("high") or 0.0)
        dl = float(ohlc.get("low") or 0.0)
        if dh > 0 and dl > 0 and dh >= dl:
            day_range = dh - dl
            dist_500 = abs(spot_ltp - round(spot_ltp / 500.0) * 500.0)
            dist_dh = abs(spot_ltp - dh)
            dist_dl = abs(spot_ltp - dl)
            dist_extreme = min(dist_dh, dist_dl)

            passed = (day_range >= 300.0) and (dist_500 <= 65.0 or dist_extreme <= 60.0)
            details = {
                "spot": spot_ltp,
                "day_high": dh,
                "day_low": dl,
                "day_range": round(day_range, 2),
                "dist_500": round(dist_500, 2),
                "dist_extreme": round(dist_extreme, 2),
            }
            if not passed:
                reason = (
                    f"Day Range {day_range:.1f} < 300 or not near 500-level ({dist_500:.1f} pts) / "
                    f"Day Extreme ({dist_extreme:.1f} pts)"
                )
                return False, reason, details
            return True, f"Qualified: Range {day_range:.1f} pts, 500 Dist {dist_500:.1f} pts, Extreme Dist {dist_extreme:.1f} pts", details

        # Fallback if OHLC missing from quote
        dist_500 = abs(spot_ltp - round(spot_ltp / 500.0) * 500.0)
        passed = dist_500 <= 65.0
        details = {"spot": spot_ltp, "dist_500": round(dist_500, 2), "fallback": True}
        reason = f"Fallback 500-level check: dist {dist_500:.1f} pts (passed={passed})"
        return passed, reason, details

    def _enter_live_orders(self, cfg: dict) -> None:
        """Execute real market orders on Kotak Neo if live trading is enabled."""
        if not self.live_trading or self.live_order_halted:
            return

        funds_info = available_kotak_funds()
        if not funds_info.get("ok"):
            print(f"HeroZero LIVE halted: unable to verify Kotak funds: {funds_info.get('error')}")
            self.live_order_halted = True
            return

        avail = funds_info.get("available_equity_funds", 0.0)
        if avail < self.minimum_live_funds:
            print(f"HeroZero LIVE halted: Available funds Rs {avail:.2f} < Minimum required Rs {self.minimum_live_funds:.2f}")
            self.live_order_halted = True
            return

        for sym, c in self.candidates.items():
            qty = c["lot_size"] * self.lots
            try:
                order_id, fill = place_kotak_order(
                    symbol=sym,
                    qty=qty,
                    side=1,  # BUY
                    product="MIS",
                    exchange_segment=cfg["exchange"],
                )
                self.live_positions[sym] = {
                    "candidate": c,
                    "quantity": qty,
                    "order_id": order_id,
                    "fill_price": fill,
                    "entry_time": now_ist(),
                }
                append_row(self.live_orders_file, LIVE_ORDER_HEADER, [
                    self.session.isoformat(), now_ist().strftime("%H:%M:%S"), "BUY", sym, qty,
                    order_id, fill, "hero_zero_entry", "filled",
                ])
                print(f"HeroZero LIVE BUY {sym} qty {qty} @ Rs {fill:.2f} (order {order_id})")
            except Exception as exc:
                print(f"HeroZero LIVE order failed for {sym}: {exc}")
                append_row(self.live_orders_file, LIVE_ORDER_HEADER, [
                    self.session.isoformat(), now_ist().strftime("%H:%M:%S"), "BUY", sym, qty,
                    "", "", str(exc), "failed",
                ])

    def _exit_live_positions(self, cfg: dict) -> None:
        """Close open live positions on Kotak Neo at expiry exit."""
        if not self.live_trading or not self.live_positions:
            return

        for sym, pos in list(self.live_positions.items()):
            qty = pos["quantity"]
            try:
                order_id, fill = place_kotak_order(
                    symbol=sym,
                    qty=qty,
                    side=-1,  # SELL
                    product="MIS",
                    exchange_segment=cfg["exchange"],
                )
                append_row(self.live_orders_file, LIVE_ORDER_HEADER, [
                    self.session.isoformat(), now_ist().strftime("%H:%M:%S"), "SELL", sym, qty,
                    order_id, fill, "hero_zero_exit", "filled",
                ])
                print(f"HeroZero LIVE SELL {sym} qty {qty} @ Rs {fill:.2f} (order {order_id})")
                self.live_positions.pop(sym, None)
            except Exception as exc:
                print(f"CRITICAL: HeroZero LIVE SELL failed for {sym}: {exc}. Please close manually!")
                append_row(self.live_orders_file, LIVE_ORDER_HEADER, [
                    self.session.isoformat(), now_ist().strftime("%H:%M:%S"), "SELL", sym, qty,
                    "", "", str(exc), "failed_exit",
                ])

    def run(self) -> dict:
        underlying, contracts, cfg = load_expiry_options(self.client, self.session)
        if not contracts:
            result = {
                "date": self.session.isoformat(),
                "status": "not_expiry_session",
                "expiry_underlyings": {"SENSEX": [], "NIFTY": []},
            }
            write_status(self.status_file, result)
            print(f"{self.session}: no SENSEX or NIFTY expiry contracts today; HeroZero skipped")
            return result

        print(f"[{now_ist():%H:%M:%S}] HeroZero ready for {underlying} expiry {self.session} ({len(contracts)} contracts)")

        # 1. Wait until 15:18:00 IST for the snapshot
        target_snapshot = now_ist().replace(hour=SNAPSHOT_TIME[0], minute=SNAPSHOT_TIME[1], second=0, microsecond=0)
        now = now_ist()
        if now < target_snapshot:
            wait_sec = (target_snapshot - now).total_seconds()
            print(f"[{now:%H:%M:%S}] Waiting {wait_sec:.0f}s until 15:18:00 IST snapshot...")
            time.sleep(max(0.0, wait_sec - 1.0))
            while now_ist() < target_snapshot:
                time.sleep(0.05)

        # 2. Key Level & Volatility Gate Filter
        spot_ltp, ohlc = self._get_spot(underlying)
        if spot_ltp is None or spot_ltp <= 0:
            print(f"Failed to get {underlying} spot quote for filter check")
            return {"date": self.session.isoformat(), "status": "failed_spot_quote"}

        passed_filter, filter_reason, filter_details = self._check_key_level_filter(underlying, cfg, spot_ltp, ohlc)
        print(f"[{now_ist():%H:%M:%S}] Key Level Filter: {filter_reason}")
        if not passed_filter:
            result = {
                "date": self.session.isoformat(),
                "status": "skipped_filter_key_level",
                "underlying": underlying,
                "reason": filter_reason,
                "filter_details": filter_details,
                "trading_mode": "LIVE" if self.live_trading else "PAPER",
            }
            write_status(self.status_file, result)
            print(f"HeroZero SKIPPED: {filter_reason}. Capital preserved.")
            return result

        # 3. Select candidates at 15:18 IST (dynamically closest to Rs 25-30 sweet spot)
        self.candidates = self._select_candidates_dynamic(contracts, cfg, spot_ltp)
        if len(self.candidates) != 2:
            print("Candidate selection failed. Backing off.")
            result = {
                "date": self.session.isoformat(),
                "status": "backed_off_incomplete_strangle",
                "trading_mode": "LIVE" if self.live_trading else "PAPER",
                "reason": "Could not find both CE and PE legs within target price band",
            }
            write_status(self.status_file, result)
            return result

        snap_now = now_ist()
        print(f"[{snap_now:%H:%M:%S}] HeroZero selected sweet-spot strangle:")
        for sym, c in self.candidates.items():
            print(f"  -> {c['opt_type']} {c['strike']:.0f} ({sym}) @ LTP {c['snapshot_ltp']}")
            append_row(self.candidates_file, CANDIDATE_HEADER, [
                self.session.isoformat(), underlying, c["expiry"], sym,
                c["opt_type"], c["strike"], c["lot_size"],
                c["spot_ltp"], c["distance_from_spot"], c["band_low"], c["band_high"],
                snap_now.strftime("%Y-%m-%d %H:%M:%S"), snap_now.strftime("%Y-%m-%d %H:%M:%S"),
                0.0, c["snapshot_ltp"], c["quote"].get("volume", ""), "kotak_dynamic_sweet_spot",
            ])

        # 4. Enter LIVE orders if enabled (otherwise PAPER mode)
        if self.live_trading:
            print("Live trading enabled — executing Kotak orders...")
            self._enter_live_orders(cfg)
        else:
            print("Running in PAPER mode — tracking positions...")

        # 5. Track positions until 15:29:50 exit
        exit_target = now_ist().replace(hour=EXIT_TIME[0], minute=EXIT_TIME[1], second=EXIT_TIME[2], microsecond=0)
        tok_list = [c["token"] for c in self.candidates.values()]
        latest_quotes = {}
        exit_reason = "time_exit_15:30"

        while now_ist() < exit_target:
            qs = self._batch_quotes(tok_list, cfg["exchange"])
            tick_now = now_ist()
            for sym, c in self.candidates.items():
                q = qs.get(c["token"])
                if q:
                    latest_quotes[sym] = {**q, "received_at": tick_now}
                    append_row(self.ticks_file, TICK_HEADER, [
                        self.session.isoformat(), tick_now.strftime("%Y-%m-%d %H:%M:%S.%f"),
                        underlying, sym, q["ltp"], q.get("volume", ""), q.get("exchange_time", ""),
                    ])
            time.sleep(2.0)

        # 6. Fetch final exit quotes at 15:29:50 and exit LIVE orders
        final_qs = self._batch_quotes(tok_list, cfg["exchange"])
        for sym, c in self.candidates.items():
            q = final_qs.get(c["token"])
            if q:
                latest_quotes[sym] = {**q, "received_at": now_ist()}

        if self.live_trading:
            self._exit_live_positions(cfg)

        # 7. Write paper trades
        trades_file = OUTPUT_DIR / f"hero_zero_trades_{self.session}.csv"
        for sym, c in self.candidates.items():
            entry_p = c["snapshot_ltp"]
            q_exit = latest_quotes.get(sym)
            exit_p = q_exit["ltp"] if q_exit else entry_p
            qty = c["lot_size"] * self.lots
            pnl_unit = round(exit_p - entry_p, 2)
            pnl_rs = round(pnl_unit * qty, 2)
            exit_time_str = (q_exit["received_at"] if q_exit else now_ist()).strftime("%Y-%m-%d %H:%M:%S")

            append_row(trades_file, PAPER_TRADE_HEADER, [
                self.session.isoformat(), underlying, c["expiry"], sym,
                c["opt_type"], c["strike"], qty,
                c["spot_ltp"], c["distance_from_spot"],
                c["snapshot_at"].strftime("%Y-%m-%d %H:%M:%S"), entry_p,
                c["quote"].get("volume", ""), exit_time_str,
                exit_p, q_exit.get("volume", "") if q_exit else "", pnl_unit, pnl_rs,
                "closed", exit_reason, "hero_zero_paper",
            ])

        result = {
            "date": self.session.isoformat(),
            "status": "captured",
            "underlying": underlying,
            "trading_mode": "LIVE" if self.live_trading else "PAPER",
            "paper_trades": 2,
            "exit_reason": exit_reason,
            "status_file": str(self.status_file),
        }
        write_status(self.status_file, result)
        print(f"HeroZero completed: {result}")

        # 7. Auto-archive spot-relative options ladder (ATM +- 3 strikes) for historical analysis
        try:
            from fetch_expiry_options_spot_relative import fetch_options_relative_to_spot
            fetch_options_relative_to_spot(self.session, strike_count=3)
        except Exception as e:
            print(f"[HeroZero] Auto-archive options error: {e}")

        return result


def main() -> None:
    session = now_ist().date()
    HeroZeroCapture(session).run()


if __name__ == "__main__":
    main()

"""Unified Broker interface supporting Fyers and Kotak Neo."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional, Tuple

ROOT = Path(__file__).resolve().parent
CONFIG_FILE = ROOT / "fyers_config.json"
TOKEN_FILE = ROOT / "captured_data" / "fyers" / "fyers_access_token.json"
TMP_DIR = ROOT / ".tmp"


# Persistent caches to prevent UI MTM flickering during intermittent broker quote drops
_last_positions_cache: dict = {}
_last_known_ltps: dict = {}
_last_positions_time: float = 0.0
_last_positions_err_time: float = 0.0

def get_active_broker() -> str:
    """Return 'KOTAK_NEO' (sole active broker)."""
    return "KOTAK_NEO"


def fyers_funds() -> dict:
    if not TOKEN_FILE.exists():
        return {"ok": False, "error": "Fyers token is missing; log in first."}
    try:
        from fyers_apiv3 import fyersModel
        from fyers_orders import available_equity_funds

        tok = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
        client = fyersModel.FyersModel(
            client_id=tok["app_id"],
            token=tok["access_token"],
            is_async=False,
            log_path=str(TMP_DIR),
        )
        response = client.funds()
        available = available_equity_funds(response)
        if available is None:
            message = response.get("message") or "Fyers did not return an available equity balance."
            return {"ok": False, "error": message}
        return {"ok": True, "available_equity_funds": round(available, 2)}
    except Exception as exc:
        return {"ok": False, "error": f"Unable to fetch Fyers funds: {exc}"}


def get_funds() -> dict:
    """Fetch available trading funds from the currently active broker."""
    broker = get_active_broker()
    if broker == "KOTAK_NEO":
        from kotak_orders import available_kotak_funds
        res = available_kotak_funds()
        res["broker"] = "KOTAK_NEO"
        return res
    else:
        res = fyers_funds()
        res["broker"] = "FYERS"
        return res


def get_all_broker_status() -> dict:
    """Return connectivity and token status for both brokers."""
    from app_server import token_status as fyers_token_status
    from kotak_orders import kotak_token_status

    active = get_active_broker()
    fyers_stat = fyers_token_status()
    kotak_stat = kotak_token_status()

    return {
        "active_broker": active,
        "fyers": {
            "valid": fyers_stat.get("valid", False),
            "generated_at_utc": fyers_stat.get("generated_at_utc"),
        },
        "kotak_neo": {
            "valid": kotak_stat.get("valid", False),
            "ucc": kotak_stat.get("ucc"),
            "greeting_name": kotak_stat.get("greeting_name"),
            "logged_in_at": kotak_stat.get("logged_in_at"),
            "reason": kotak_stat.get("reason"),
        },
    }


def kotak_positions() -> dict:
    global _last_positions_cache, _last_positions_time, _last_positions_err_time
    import time
    now = time.time()
    # Serve cached positions if requested within 2.5s to avoid duplicate API calls
    if (now - _last_positions_time) < 2.5 and _last_positions_cache.get("ok"):
        return _last_positions_cache
    # If recent broker error, backoff for 8s to prevent hammering failing broker API
    if (now - _last_positions_err_time) < 8.0 and _last_positions_cache.get("ok"):
        return _last_positions_cache

    from kotak_orders import get_kotak_client, kotak_token_status
    status = kotak_token_status()
    if not status.get("valid"):
        return {"ok": False, "error": "Kotak Neo session expired or missing", "open_positions": [], "closed_positions": [], "summary": {}}
    client = get_kotak_client()
    if not client:
        return {"ok": False, "error": "Kotak client not initialized", "open_positions": [], "closed_positions": [], "summary": {}}

    try:
        resp = client.positions()
        if not isinstance(resp, dict) or resp.get("stat") != "ok":
            err = resp.get("errMsg") or resp.get("stat") or "Failed to fetch Kotak positions"
            if _last_positions_cache.get("ok"):
                return _last_positions_cache
            return {"ok": False, "error": str(err), "open_positions": [], "closed_positions": [], "summary": {}}

        rows = resp.get("data") or []
        open_pos = []
        closed_pos = []
        tot_realized = 0.0
        tot_open_invested = 0.0
        tot_unrealized = 0.0

        for r in rows:
            sym = str(r.get("trdSym", ""))
            prod = str(r.get("prod") or r.get("prodCode") or "NRML").upper()
            fl_b = int(r.get("flBuyQty", 0))
            fl_s = int(r.get("flSellQty", 0))

            # Exclude long-term equity / CNC holdings with no trading activity today from intraday algo P&L
            if prod in ("CNC", "DELIVERY", "CASH") and fl_b == 0 and fl_s == 0:
                continue
            b_qty = int(r.get("flBuyQty", 0)) + int(r.get("cfBuyQty", 0))
            s_qty = int(r.get("flSellQty", 0)) + int(r.get("cfSellQty", 0))
            b_amt = float(r.get("buyAmt", 0)) + float(r.get("cfBuyAmt", 0))
            s_amt = float(r.get("sellAmt", 0)) + float(r.get("cfSellAmt", 0))
            net_qty = b_qty - s_qty
            b_avg = round(b_amt / b_qty, 2) if b_qty > 0 else 0.0
            s_avg = round(s_amt / s_qty, 2) if s_qty > 0 else 0.0
            lot_sz = int(r.get("lotSz", 1)) or 1
            side = "CALL" if ("CE" in sym or r.get("optTp") == "CE") else ("PUT" if ("PE" in sym or r.get("optTp") == "PE") else "EQUITY")

            if net_qty == 0:
                pnl = round(s_amt - b_amt, 2)
                tot_realized += pnl
                closed_pos.append({
                    "symbol": sym,
                    "side": side,
                    "qty": b_qty,
                    "buy_avg": b_avg,
                    "sell_avg": s_avg,
                    "buy_amt": b_amt,
                    "sell_amt": s_amt,
                    "realized_pnl": pnl,
                    "exchange": r.get("exSeg") or ("bse_fo" if "SENSEX" in sym else "nse_fo"),
                    "product": str(r.get("prod") or r.get("prodCode") or "NRML"),
                })
            else:
                # Open position: calculate partial realized if some quantity was already sold/bought
                partial_realized = 0.0
                if net_qty > 0:
                    # Long position
                    if s_qty > 0:
                        partial_realized = round(s_amt - (s_qty * b_avg), 2)
                        tot_realized += partial_realized
                    invested = round(net_qty * b_avg, 2)
                else:
                    # Short position
                    if b_qty > 0:
                        partial_realized = round((b_qty * s_avg) - b_amt, 2)
                        tot_realized += partial_realized
                    invested = round(abs(net_qty) * s_avg, 2)

                tot_open_invested += invested
                open_pos.append({
                    "symbol": sym,
                    "side": side,
                    "net_qty": net_qty,
                    "lot_size": lot_sz,
                    "lots": abs(net_qty) // lot_sz if lot_sz > 0 else abs(net_qty),
                    "buy_avg": b_avg,
                    "sell_avg": s_avg,
                    "invested": invested,
                    "partial_realized": partial_realized,
                    "tok": str(r.get("tok", "")),
                    "exchange": r.get("exSeg") or ("bse_fo" if "SENSEX" in sym else "nse_fo"),
                    "product": str(r.get("prod") or r.get("prodCode") or "NRML"),
                    "expiry": r.get("expDt", ""),
                })

        # Fetch live market quotes for open positions to compute live Unrealized P&L
        tokens = [
            {"instrument_token": str(p["tok"]), "exchange_segment": p["exchange"]}
            for p in open_pos if p.get("tok")
        ]
        quotes_map = {}
        if tokens:
            try:
                q_resp = client.quotes(instrument_tokens=tokens)
                if isinstance(q_resp, list):
                    for item in q_resp:
                        if isinstance(item, dict):
                            t = str(item.get("exchange_token") or item.get("instrument_token") or "")
                            try:
                                ltp_val = float(item.get("ltp") or 0.0)
                            except (ValueError, TypeError):
                                ltp_val = 0.0
                            if t and ltp_val > 0:
                                quotes_map[t] = ltp_val
                                _last_known_ltps[t] = ltp_val
            except Exception:
                pass

        tot_open_val = 0.0
        for p in open_pos:
            tok = str(p.get("tok", ""))
            net_qty = p["net_qty"]
            # Fall back to last known live market LTP to prevent MTM flickering to zero on dropped ticks
            ltp = quotes_map.get(tok) or _last_known_ltps.get(tok) or _last_known_ltps.get(p["symbol"]) or (p["buy_avg"] if net_qty > 0 else p["sell_avg"])
            p["ltp"] = round(ltp, 2)
            _last_known_ltps[tok] = ltp
            _last_known_ltps[p["symbol"]] = ltp

            if net_qty > 0:
                cur_val = round(net_qty * ltp, 2)
                unrealized = round(net_qty * (ltp - p["buy_avg"]), 2)
                pnl_pct = round(((ltp - p["buy_avg"]) / p["buy_avg"]) * 100, 2) if p["buy_avg"] > 0 else 0.0
            else:
                cur_val = round(abs(net_qty) * ltp, 2)
                unrealized = round(abs(net_qty) * (p["sell_avg"] - ltp), 2)
                pnl_pct = round(((p["sell_avg"] - ltp) / p["sell_avg"]) * 100, 2) if p["sell_avg"] > 0 else 0.0

            p["current_value"] = cur_val
            tot_open_val += cur_val
            p["unrealized_pnl"] = unrealized
            p["pnl_pct"] = pnl_pct
            tot_unrealized += unrealized

        # Sort stably by symbol so positions never shuffle across polls
        open_pos.sort(key=lambda x: str(x.get("symbol", "")))
        closed_pos.sort(key=lambda x: str(x.get("symbol", "")))

        result = {
            "ok": True,
            "broker": "KOTAK_NEO",
            "open_positions": open_pos,
            "closed_positions": closed_pos,
            "summary": {
                "realized_pnl": round(tot_realized, 2),
                "unrealized_pnl": round(tot_unrealized, 2),
                "net_pnl": round(tot_realized + tot_unrealized, 2),
                "open_count": len(open_pos),
                "closed_count": len(closed_pos),
                "total_invested": round(tot_open_invested, 2),
                "current_value": round(tot_open_val, 2),
            },
        }
        _last_positions_cache = result
        _last_positions_time = time.time()
        return result
    except Exception as exc:
        _last_positions_err_time = time.time()
        if _last_positions_cache.get("ok"):
            return _last_positions_cache
        return {"ok": False, "error": f"Error parsing Kotak positions: {exc}", "open_positions": [], "closed_positions": [], "summary": {}}


def fyers_positions() -> dict:
    if not TOKEN_FILE.exists():
        return {"ok": False, "error": "Fyers token missing", "open_positions": [], "closed_positions": [], "summary": {}}
    try:
        from fyers_apiv3 import fyersModel
        tok = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
        client = fyersModel.FyersModel(
            client_id=tok["app_id"],
            token=tok["access_token"],
            is_async=False,
            log_path=str(TMP_DIR),
        )
        resp = client.positions()
        if resp.get("s") != "ok":
            return {"ok": False, "error": resp.get("message", "Fyers positions failed"), "open_positions": [], "closed_positions": [], "summary": {}}

        net_positions = resp.get("netPositions") or []
        open_pos = []
        closed_pos = []
        tot_realized = 0.0
        tot_unrealized = 0.0
        tot_open_invested = 0.0

        for r in net_positions:
            sym = str(r.get("symbol", ""))
            net_qty = int(r.get("netQty", 0))
            side = "CALL" if sym.endswith("CE") else ("PUT" if sym.endswith("PE") else "EQUITY")
            buy_avg = float(r.get("buyAvg", 0) or r.get("netAvg", 0))
            sell_avg = float(r.get("sellAvg", 0))
            buy_qty = int(r.get("buyQty", 0))
            realized = float(r.get("realized_profit", 0))
            unrealized = float(r.get("unrealized_profit", 0))
            tot_realized += realized
            tot_unrealized += unrealized

            prod_type = str(r.get("productType", "INTRADAY"))
            if net_qty == 0:
                closed_pos.append({
                    "symbol": sym,
                    "side": side,
                    "qty": buy_qty,
                    "buy_avg": round(buy_avg, 2),
                    "sell_avg": round(sell_avg, 2),
                    "realized_pnl": round(realized, 2),
                    "exchange": "NSE",
                    "product": prod_type,
                })
            else:
                invested = buy_avg * abs(net_qty)
                tot_open_invested += invested
                open_pos.append({
                    "symbol": sym,
                    "side": side,
                    "net_qty": net_qty,
                    "lot_size": 65 if "NIFTY" in sym else 1,
                    "lots": abs(net_qty) // 65 if "NIFTY" in sym else abs(net_qty),
                    "buy_avg": round(buy_avg, 2),
                    "sell_avg": round(sell_avg, 2),
                    "invested": round(invested, 2),
                    "unrealized_pnl": round(unrealized, 2),
                    "exchange": "NSE",
                    "product": prod_type,
                })

        return {
            "ok": True,
            "broker": "FYERS",
            "open_positions": open_pos,
            "closed_positions": closed_pos,
            "summary": {
                "realized_pnl": round(tot_realized, 2),
                "unrealized_pnl": round(tot_unrealized, 2),
                "net_pnl": round(tot_realized + tot_unrealized, 2),
                "open_count": len(open_pos),
                "closed_count": len(closed_pos),
                "total_invested": round(tot_open_invested, 2),
            },
        }
    except Exception as exc:
        return {"ok": False, "error": f"Error fetching Fyers positions: {exc}", "open_positions": [], "closed_positions": [], "summary": {}}


def get_positions() -> dict:
    """Fetch live positions and P&L from the currently active broker."""
    broker = get_active_broker()
    if broker == "KOTAK_NEO":
        return kotak_positions()
    else:
        return fyers_positions()


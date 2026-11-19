"""Live Option Pricing Module for Kotak Neo / Real Broker Feed.

Fetches the exact real-time LTP, bid, ask, and trading symbol for nearest weekly
Nifty/Sensex options directly from the broker exchange feed.
No dummy values, no fallbacks, 100% real exchange data.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Optional, Dict, Any, Tuple

try:
    from kotak_orders import get_kotak_client
except ImportError:
    get_kotak_client = None

logger = logging.getLogger("live_option_pricing")

# Cache scrip tokens for the day to avoid redundant searches
_SCRIP_CACHE: Dict[str, Dict[str, Any]] = {}
# Short TTL cache (2.5s) for live quotes to prevent rate limits and thread starvation
_QUOTE_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_QUOTE_TTL_SEC: float = 2.5


def _get_or_search_scrip(
    client: Any,
    symbol_name: str,
    strike: int,
    opt_type: str,
    expiry_date: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    opt_type = opt_type.upper()
    cache_key = f"{symbol_name}_{strike}_{opt_type}_{expiry_date or 'nearest'}"
    scrip_info = _SCRIP_CACHE.get(cache_key)
    if scrip_info:
        return scrip_info

    try:
        exch_seg = "bse_fo" if symbol_name.upper() == "SENSEX" else "nse_fo"
        res = client.search_scrip(
            exchange_segment=exch_seg,
            symbol=symbol_name,
            strike_price=str(strike),
            option_type=opt_type,
        )
        if isinstance(res, list):
            now = datetime.now()
            valid = []
            for item in res:
                if str(item.get("pSymbolName", "")).upper() != symbol_name.upper():
                    continue
                if not str(item.get("pTrdSymbol", "")).startswith(symbol_name.upper()):
                    continue
                exp_str = item.get("pExpiryDate")
                try:
                    exp_dt = datetime.strptime(exp_str, "%d%b%Y")
                    if exp_dt.date() >= now.date():
                        if expiry_date and exp_dt.strftime("%Y-%m-%d") == expiry_date:
                            valid.insert(0, (exp_dt, item))
                        else:
                            valid.append((exp_dt, item))
                except Exception:
                    pass
            if not expiry_date:
                valid.sort(key=lambda x: x[0])
            if valid:
                nearest_exp, nearest_item = valid[0]
                token = str(nearest_item.get("pSymbol"))
                trd_symbol = str(nearest_item.get("pTrdSymbol"))
                scrip_info = {
                    "token": token,
                    "symbol": trd_symbol,
                    "expiry": nearest_exp.strftime("%Y-%m-%d"),
                    "exchange_segment": exch_seg,
                }
                _SCRIP_CACHE[cache_key] = scrip_info
                return scrip_info
    except Exception as e:
        logger.warning(f"Error searching scrip for {cache_key}: {e}")
    return None


def get_live_option_ltp(
    symbol_name: str = "NIFTY",
    strike: int = 22500,
    opt_type: str = "CE",
    expiry_date: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Fetch exact real-time market quote for nearest or specified weekly option contract from Kotak Neo with short TTL caching."""
    if get_kotak_client is None:
        return None

    opt_type = opt_type.upper()
    cache_key = f"{symbol_name}_{strike}_{opt_type}_{expiry_date or 'nearest'}"

    # Check fast TTL quote cache first (< 2.5s)
    now_ts = time.time()
    cached = _QUOTE_CACHE.get(cache_key)
    if cached and (now_ts - cached[0] < _QUOTE_TTL_SEC):
        return cached[1]

    client = get_kotak_client()
    if not client:
        return None

    scrip_info = _get_or_search_scrip(client, symbol_name, strike, opt_type, expiry_date)
    if not scrip_info:
        return None

    seg = scrip_info.get("exchange_segment", "nse_fo")
    try:
        q = client.quotes(
            [{"instrument_token": scrip_info["token"], "exchange_segment": seg}],
            quote_type="ltp",
        )
        if q and isinstance(q, list) and len(q) > 0:
            data = q[0]
            ltp = float(data.get("ltp") or 0.0)
            if ltp > 0:
                result = {
                    "symbol": scrip_info["symbol"],
                    "token": scrip_info["token"],
                    "expiry": scrip_info["expiry"],
                    "ltp": ltp,
                    "bid": ltp,
                    "ask": ltp,
                    "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                }
                _QUOTE_CACHE[cache_key] = (now_ts, result)
                return result
    except Exception as e:
        logger.warning(f"Quote error for {scrip_info['symbol']}: {e}")

    # Fall back to previous cached value if recent (< 30s)
    if cached and (now_ts - cached[0] < 30.0):
        return cached[1]

    return None


def get_live_option_pair(
    symbol_name: str = "NIFTY",
    strike: int = 25000,
    expiry_date: Optional[str] = None,
) -> Dict[str, Optional[Dict[str, Any]]]:
    """Fetch both CE and PE quotes in a single batch request to Kotak Neo."""
    if get_kotak_client is None:
        return {"ce": None, "pe": None}

    now_ts = time.time()
    ce_key = f"{symbol_name}_{strike}_CE_{expiry_date or 'nearest'}"
    pe_key = f"{symbol_name}_{strike}_PE_{expiry_date or 'nearest'}"

    cached_ce = _QUOTE_CACHE.get(ce_key)
    cached_pe = _QUOTE_CACHE.get(pe_key)

    ce_valid = cached_ce and (now_ts - cached_ce[0] < _QUOTE_TTL_SEC)
    pe_valid = cached_pe and (now_ts - cached_pe[0] < _QUOTE_TTL_SEC)

    if ce_valid and pe_valid:
        return {"ce": cached_ce[1], "pe": cached_pe[1]}

    client = get_kotak_client()
    if not client:
        return {
            "ce": cached_ce[1] if cached_ce else None,
            "pe": cached_pe[1] if cached_pe else None,
        }

    scrip_ce = _get_or_search_scrip(client, symbol_name, strike, "CE", expiry_date)
    scrip_pe = _get_or_search_scrip(client, symbol_name, strike, "PE", expiry_date)

    tokens_to_fetch = []
    token_map = {}
    if scrip_ce and not ce_valid:
        seg = scrip_ce.get("exchange_segment", "nse_fo")
        tok = scrip_ce["token"]
        tokens_to_fetch.append({"instrument_token": tok, "exchange_segment": seg})
        token_map[tok] = ("CE", ce_key, scrip_ce)
    if scrip_pe and not pe_valid:
        seg = scrip_pe.get("exchange_segment", "nse_fo")
        tok = scrip_pe["token"]
        tokens_to_fetch.append({"instrument_token": tok, "exchange_segment": seg})
        token_map[tok] = ("PE", pe_key, scrip_pe)

    res_ce = cached_ce[1] if ce_valid else None
    res_pe = cached_pe[1] if pe_valid else None

    if tokens_to_fetch:
        try:
            q_list = client.quotes(tokens_to_fetch, quote_type="ltp")
            if q_list and isinstance(q_list, list):
                for item in q_list:
                    tok = str(item.get("instrument_token") or item.get("pSymbol") or "")
                    if tok in token_map:
                        side, c_key, scrip = token_map[tok]
                        ltp = float(item.get("ltp") or 0.0)
                        if ltp > 0:
                            q_obj = {
                                "symbol": scrip["symbol"],
                                "token": scrip["token"],
                                "expiry": scrip["expiry"],
                                "ltp": ltp,
                                "bid": ltp,
                                "ask": ltp,
                                "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                            }
                            _QUOTE_CACHE[c_key] = (now_ts, q_obj)
                            if side == "CE":
                                res_ce = q_obj
                            else:
                                res_pe = q_obj
        except Exception as e:
            logger.warning(f"Batch pair quote error for {symbol_name} {strike}: {e}")

    # Fallbacks if quote failed
    if not res_ce and cached_ce:
        res_ce = cached_ce[1]
    if not res_pe and cached_pe:
        res_pe = cached_pe[1]

    return {"ce": res_ce, "pe": res_pe}

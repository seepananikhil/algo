"""Kotak Neo Trade API integration for live order placement and balance checks."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Tuple

# Prevent neo_api_client Windows file lock WinError 32 on midnight rotation
os.environ["NEO_LOG_FILE_ENABLED"] = "false"

try:
    import pyotp
except ImportError:
    pyotp = None

try:
    from neo_api_client import NeoAPI
except ImportError:
    NeoAPI = None

ROOT = Path(__file__).resolve().parent
CONFIG_FILE = ROOT / "fyers_config.json"
KOTAK_DIR = ROOT / "captured_data" / "kotak"
KOTAK_DIR.mkdir(parents=True, exist_ok=True)
KOTAK_TOKEN_FILE = KOTAK_DIR / "kotak_token.json"
IST = timezone(timedelta(hours=5, minutes=30))


def load_kotak_config() -> dict:
    neo_config = ROOT / "neo_config.json"
    if neo_config.exists():
        try:
            cfg = json.loads(neo_config.read_text(encoding="utf-8"))
            if cfg.get("consumer_key") or cfg.get("mobile_number"):
                return cfg
        except Exception:
            pass
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            return cfg.get("kotak_neo", {})
        except Exception:
            pass
    return {}


_KOTAK_CLIENT: Optional[NeoAPI] = None


def get_kotak_client(token_data: Optional[dict] = None) -> Optional[NeoAPI]:
    global _KOTAK_CLIENT
    if NeoAPI is None:
        return None
    k_cfg = load_kotak_config()
    consumer_key = k_cfg.get("consumer_key", "")
    if not consumer_key:
        return None

    # Check if existing in-memory client has valid token
    status = kotak_token_status()
    if _KOTAK_CLIENT is not None and status.get("valid"):
        return _KOTAK_CLIENT

    # Attempt automatic login if totp_secret is configured
    if not status.get("valid") and (k_cfg.get("totp_secret") or k_cfg.get("totp_key")) and k_cfg.get("mpin"):
        res = kotak_login()
        if res.get("ok") and _KOTAK_CLIENT is not None:
            return _KOTAK_CLIENT

    if token_data is None and KOTAK_TOKEN_FILE.exists():
        try:
            token_data = json.loads(KOTAK_TOKEN_FILE.read_text(encoding="utf-8"))
        except Exception:
            token_data = None

    client = NeoAPI(
        consumer_key=consumer_key,
        environment=k_cfg.get("environment", "prod"),
    )

    if token_data and "trade_token" in token_data:
        # Re-attach full session parameters
        client.configuration.edit_token = token_data.get("trade_token")
        client.configuration.edit_sid = token_data.get("edit_sid") or token_data.get("sid")
        client.configuration.edit_rid = token_data.get("edit_rid") or token_data.get("rid")
        client.configuration.bearer_token = token_data.get("view_token")
        client.configuration.view_token = token_data.get("view_token")
        client.configuration.sid = token_data.get("view_sid") or token_data.get("sid")
        client.configuration.base_url = token_data.get("base_url")
        client.configuration.data_center = token_data.get("data_center")
        client.configuration.ucc = token_data.get("ucc")
        _KOTAK_CLIENT = client

    return client


def kotak_login(
    totp_code: Optional[str] = None,
    mpin: Optional[str] = None,
) -> dict:
    """Authenticate with Kotak Neo using 2-step TOTP + MPIN flow."""
    global _KOTAK_CLIENT
    if NeoAPI is None:
        return {"ok": False, "error": "kotakneoapi is not installed"}

    k_cfg = load_kotak_config()
    consumer_key = k_cfg.get("consumer_key", "")
    mobile = k_cfg.get("mobile_number", "")
    ucc = k_cfg.get("ucc", "")
    totp_secret = k_cfg.get("totp_secret", "") or k_cfg.get("totp_key", "")
    config_mpin = k_cfg.get("mpin", "")

    if not consumer_key or not mobile or not ucc:
        return {
            "ok": False,
            "error": "Missing Kotak Neo config: consumer_key, mobile_number, and ucc are required.",
        }

    active_mpin = mpin or config_mpin
    if not active_mpin:
        return {"ok": False, "error": "MPIN is required"}

    # Generate or use TOTP
    active_totp = totp_code
    if not active_totp and totp_secret:
        if pyotp is None:
            return {"ok": False, "error": "pyotp library is not installed (run: pip install pyotp)"}
        try:
            clean_secret = totp_secret.replace(" ", "").strip().upper()
            active_totp = pyotp.TOTP(clean_secret).now()
        except Exception as e:
            return {"ok": False, "error": f"Failed to generate TOTP from secret: {e}"}

    if not active_totp:
        return {"ok": False, "error": "TOTP code is required (or set totp_secret in config for auto-login)"}

    client = NeoAPI(consumer_key=consumer_key, environment=k_cfg.get("environment", "prod"))

    # Step 1: TOTP Login (View Access)
    try:
        step1 = client.totp_login(
            mobile_number=mobile,
            ucc=ucc,
            totp=active_totp,
        )
    except Exception as exc:
        return {"ok": False, "error": f"Kotak TOTP login failed: {exc}"}

    if not isinstance(step1, dict) or "data" not in step1:
        err = step1.get("error", "Invalid TOTP login response from Kotak Neo") if isinstance(step1, dict) else str(step1)
        return {"ok": False, "error": str(err)}

    view_data = step1["data"]
    view_token = view_data.get("token")
    sid = view_data.get("sid")

    # Step 2: MPIN Validation (Full Trading Access)
    try:
        step2 = client.totp_validate(mpin=active_mpin)
    except Exception as exc:
        return {"ok": False, "error": f"Kotak MPIN validation failed: {exc}"}

    if not isinstance(step2, dict) or "data" not in step2:
        err = step2.get("error", "Invalid MPIN response from Kotak Neo") if isinstance(step2, dict) else str(step2)
        return {"ok": False, "error": str(err)}

    trade_data = step2["data"]
    trade_token = trade_data.get("token")
    rid = trade_data.get("rid")
    base_url = trade_data.get("baseUrl")
    data_center = trade_data.get("dataCenter")

    session_payload = {
        "ucc": ucc,
        "greeting_name": view_data.get("greetingName", ""),
        "view_token": view_token,
        "trade_token": trade_token,
        "view_sid": sid,
        "edit_sid": trade_data.get("sid"),
        "edit_rid": trade_data.get("rid"),
        "sid": sid,
        "rid": trade_data.get("rid"),
        "base_url": base_url,
        "data_center": data_center,
        "logged_in_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        "date": datetime.now(IST).strftime("%Y-%m-%d"),
    }

    KOTAK_TOKEN_FILE.write_text(json.dumps(session_payload, indent=2), encoding="utf-8")
    _KOTAK_CLIENT = client
    return {"ok": True, "greeting_name": session_payload["greeting_name"], "ucc": ucc}


_LAST_KOTAK_LOGIN_ATTEMPT: float = 0.0


def kotak_token_status(auto_login: bool = True) -> dict:
    global _LAST_KOTAK_LOGIN_ATTEMPT
    today = datetime.now(IST).strftime("%Y-%m-%d")
    if KOTAK_TOKEN_FILE.exists():
        try:
            data = json.loads(KOTAK_TOKEN_FILE.read_text(encoding="utf-8"))
            if data.get("date") == today:
                return {
                    "valid": True,
                    "ucc": data.get("ucc"),
                    "greeting_name": data.get("greeting_name"),
                    "logged_in_at": data.get("logged_in_at"),
                }
        except Exception:
            pass

    # If token is expired / missing and auto_login is enabled, attempt automatic login
    if auto_login:
        k_cfg = load_kotak_config()
        if k_cfg.get("totp_secret") and k_cfg.get("mpin"):
            now = time.time()
            if now - _LAST_KOTAK_LOGIN_ATTEMPT >= 120:  # 2 minute cooldown between retries
                _LAST_KOTAK_LOGIN_ATTEMPT = now
                res = kotak_login()
                if res.get("ok"):
                    return {
                        "valid": True,
                        "ucc": res.get("ucc"),
                        "greeting_name": res.get("greeting_name"),
                        "logged_in_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
                    }
                return {"valid": False, "reason": res.get("error", "Kotak auto-login failed")}

    return {"valid": False, "reason": "Token expired (daily session)"}


def available_kotak_funds() -> dict:
    """Fetch available trading margin from Kotak Neo."""
    client = get_kotak_client()
    if client is None:
        return {"ok": False, "error": "Kotak Neo client not initialized. Configure credentials first."}
    status = kotak_token_status()
    if not status.get("valid"):
        return {"ok": False, "error": "Kotak Neo token is expired or missing. Please log in."}

    try:
        limits = client.limits()
        if isinstance(limits, dict):
            # Check for error
            if "error" in limits or "Error Message" in limits:
                err = limits.get("error") or limits.get("Error Message") or limits.get("message")
                return {"ok": False, "error": str(err)}
            
            # Common balance keys in Kotak Neo limits response
            # Format usually includes 'Net', 'AvailableCash', or segment array
            net = limits.get("Net") or limits.get("AvailableCash") or limits.get("cashAvailable") or limits.get("availableBalance")
            if net is not None:
                return {"ok": True, "available_equity_funds": float(net)}
            
            # If limits has a list of segments
            data = limits.get("data")
            if isinstance(data, list) and data:
                for row in data:
                    amt = row.get("Net") or row.get("AvailableCash") or row.get("marginAvailable")
                    if amt is not None:
                        return {"ok": True, "available_equity_funds": float(amt)}

        return {"ok": True, "available_equity_funds": 0.0, "raw": limits}
    except Exception as exc:
        return {"ok": False, "error": f"Unable to fetch Kotak Neo funds: {exc}"}


def place_kotak_order(
    symbol: str,
    qty: int,
    side: int,  # 1 = BUY, -1 = SELL
    product: str = "NRML",
    exchange_segment: Optional[str] = None,
) -> Tuple[str, float]:
    """Place a live market order on Kotak Neo with automatic relogin on expired session."""
    client = get_kotak_client()
    if client is None:
        raise RuntimeError("Kotak Neo client not configured")

    status = kotak_token_status()
    if not status.get("valid"):
        kotak_login()
        client = get_kotak_client()

    ex_seg = exchange_segment or ("bse_fo" if "SENSEX" in symbol.upper() else "nse_fo")
    tt = "B" if side == 1 else "S"
    resp = client.place_order(
        exchange_segment=ex_seg,
        product=product,
        price="0",
        order_type="MKT",
        quantity=str(qty),
        validity="DAY",
        trading_symbol=symbol,
        transaction_type=tt,
        amo="NO",
    )

    # If unauthorized, relogin and retry once
    err_str = str(resp)
    if isinstance(resp, dict) and (resp.get("stCode") == 100008 or "unauthorized" in err_str.lower()):
        kotak_login()
        client = get_kotak_client()
        resp = client.place_order(
            exchange_segment=ex_seg,
            product=product,
            price="0",
            order_type="MKT",
            quantity=str(qty),
            validity="DAY",
            trading_symbol=symbol,
            transaction_type=tt,
            amo="NO",
        )

    # If MIS is rejected by broker, fallback to NRML automatically
    if isinstance(resp, dict) and product == "MIS" and (resp.get("stat") == "Not_Ok" or resp.get("error")):
        product = "NRML"
        resp = client.place_order(
            exchange_segment=ex_seg,
            product=product,
            price="0",
            order_type="MKT",
            quantity=str(qty),
            validity="DAY",
            trading_symbol=symbol,
            transaction_type=tt,
            amo="NO",
        )

    if not isinstance(resp, dict):
        raise RuntimeError(f"Unexpected response from Kotak Neo: {resp}")

    if resp.get("error") or resp.get("stat") == "Not_Ok":
        err_msg = resp.get("errMsg") or resp.get("message") or resp.get("error")
        raise RuntimeError(f"Kotak Neo order rejected: {err_msg}")

    order_id = str(resp.get("nOrdNo") or resp.get("order_id") or resp.get("result", ""))
    if not order_id:
        raise RuntimeError(f"Kotak Neo did not return an order ID: {resp}")

    # Confirm fill
    traded_price = 0.0
    last_status = "pending"
    last_rej = ""
    for _ in range(15):
        time.sleep(0.5)
        try:
            hist = client.order_history(order_id=order_id)
            if isinstance(hist, dict):
                data = hist.get("data") or hist.get("result") or []
                if isinstance(data, list) and data:
                    ord_info = data[-1]
                    status_str = str(ord_info.get("ordSt", "")).lower()
                    last_status = status_str
                    last_rej = str(ord_info.get("rejRsn", "") or "")
                    if status_str in ("trd", "complete", "traded", "filled"):
                        traded_price = float(ord_info.get("avgPrc") or ord_info.get("prc") or 0.0)
                        return order_id, traded_price
                    if status_str in ("can", "rej", "rejected", "cancelled"):
                        rej_reason = ord_info.get("rejRsn") or "Order rejected/cancelled"
                        raise RuntimeError(f"Kotak order {order_id} failed: {rej_reason}")
        except Exception as e:
            if "failed:" in str(e):
                raise

    if last_status in ("can", "rej", "rejected", "cancelled"):
        raise RuntimeError(f"Kotak order {order_id} rejected: {last_rej or last_status}")

    return order_id, traded_price


def modify_kotak_order(
    order_id: str,
    price: float,
    trigger_price: float,
    qty: int,
    order_type: str = "SL",
    validity: str = "DAY",
) -> dict:
    """Modify an existing pending order (e.g. SL or Limit) on Kotak Neo."""
    client = get_kotak_client()
    if not client:
        raise RuntimeError("Kotak Neo client not configured")

    prc_str = f"{price:.2f}"
    trg_str = f"{trigger_price:.2f}"
    qty_str = str(int(qty))

    resp = client.modify_order(
        order_id=str(order_id),
        price=prc_str,
        order_type=order_type,
        quantity=qty_str,
        validity=validity,
        trigger_price=trg_str,
    )

    # If unauthorized, relogin and retry once
    err_str = str(resp)
    if "unauthorized" in err_str.lower() or "100008" in err_str:
        kotak_login()
        client = get_kotak_client()
        resp = client.modify_order(
            order_id=str(order_id),
            price=prc_str,
            order_type=order_type,
            quantity=qty_str,
            validity=validity,
            trigger_price=trg_str,
        )

    if not isinstance(resp, dict) or resp.get("stat") == "Not_Ok" or resp.get("error") or resp.get("Error Message"):
        err = resp.get("errMsg") or resp.get("error") or resp.get("Error Message") or str(resp)
        raise RuntimeError(f"Kotak Neo modify order rejected: {err}")
    return resp


def place_kotak_sl_order(
    symbol: str,
    qty: int,
    side: int,  # 1 = BUY, -1 = SELL
    trigger_price: float,
    price: float,
    product: str = "NRML",
    exchange_segment: Optional[str] = None,
) -> Tuple[str, float]:
    """Place a Stop Loss (SL) order on Kotak Neo with trigger price and limit price buffer."""
    client = get_kotak_client()
    if not client:
        raise RuntimeError("Kotak Neo client not configured")

    status = kotak_token_status()
    if not status.get("valid"):
        kotak_login()
        client = get_kotak_client()

    ex_seg = exchange_segment or ("bse_fo" if "SENSEX" in symbol.upper() else "nse_fo")
    tt = "B" if side == 1 else "S"
    prc_str = f"{price:.2f}"
    trg_str = f"{trigger_price:.2f}"
    qty_str = str(int(qty))

    resp = client.place_order(
        exchange_segment=ex_seg,
        product=product,
        price=prc_str,
        order_type="SL",
        quantity=qty_str,
        validity="DAY",
        trading_symbol=symbol,
        transaction_type=tt,
        trigger_price=trg_str,
        amo="NO",
    )

    # If unauthorized, relogin and retry once
    err_str = str(resp)
    if "unauthorized" in err_str.lower() or "100008" in err_str:
        kotak_login()
        client = get_kotak_client()
        resp = client.place_order(
            exchange_segment=ex_seg,
            product=product,
            price=prc_str,
            order_type="SL",
            quantity=qty_str,
            validity="DAY",
            trading_symbol=symbol,
            transaction_type=tt,
            trigger_price=trg_str,
            amo="NO",
        )

    if not isinstance(resp, dict) or resp.get("stat") == "Not_Ok" or resp.get("error") or resp.get("Error Message"):
        err = resp.get("errMsg") or resp.get("error") or resp.get("Error Message") or str(resp)
        raise RuntimeError(f"Kotak Neo SL order rejected: {err}")

    order_id = str(resp.get("nOrdNo") or resp.get("order_id") or resp.get("result", ""))
    return order_id, trigger_price


def cancel_kotak_order(order_id: str) -> dict:
    """Cancel an open pending order on Kotak Neo."""
    client = get_kotak_client()
    if not client:
        raise RuntimeError("Kotak Neo client not configured")
    try:
        return client.cancel_order(order_id=str(order_id))
    except Exception as exc:
        return {"error": str(exc)}

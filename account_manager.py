#!/usr/bin/env python3
"""Multi-tenant Kotak Neo Account Manager.

Uses Python's built-in SQLite (data/accounts.db) - zero external dependencies.
Manages primary master account and client sub-accounts:
  - Secure credential storage
  - Automated morning Option B TOTP authentication (pyotp)
  - Live available trading funds / margin inspection
  - Individual 1-on-1 Telegram session notifications
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("account_manager")
logger.setLevel(logging.INFO)

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "accounts.db"
NEO_CONFIG_PATH = ROOT / "neo_config.json"
TELEGRAM_CONFIG_PATH = ROOT / "telegram_config.json"

IST = timezone(timedelta(hours=5, minutes=30))


def _get_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Initializes SQLite schema and ensures primary account migration."""
    with _get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_name TEXT NOT NULL,
                is_primary INTEGER DEFAULT 0,
                broker TEXT DEFAULT 'KOTAK_NEO',
                consumer_key TEXT DEFAULT '',
                consumer_secret TEXT DEFAULT '',
                mobile_number TEXT DEFAULT '',
                ucc TEXT DEFAULT '',
                mpin TEXT DEFAULT '',
                totp_key TEXT DEFAULT '',
                auth_mode TEXT DEFAULT 'AUTO_TOTP',
                telegram_chat_id TEXT DEFAULT '',
                lot_multiplier INTEGER DEFAULT 1,
                max_daily_loss REAL DEFAULT 2000.0,
                is_active INTEGER DEFAULT 1,
                session_token TEXT DEFAULT '',
                session_valid INTEGER DEFAULT 0,
                session_auth_time TEXT DEFAULT '',
                available_funds REAL DEFAULT 0.0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.commit()

    # Automatically migrate existing primary credentials if present
    migrate_primary_account()


def migrate_primary_account():
    """Migrates existing neo_config.json / env vars into Primary Account (id=1)."""
    consumer_key = os.getenv("NEO_CONSUMER_KEY", "")
    mobile = os.getenv("NEO_MOBILE_NUMBER", "")
    ucc = os.getenv("NEO_UCC", "")
    mpin = os.getenv("NEO_MPIN", "")
    totp_key = os.getenv("NEO_TOTP_KEY", "")

    if NEO_CONFIG_PATH.exists():
        try:
            cfg = json.loads(NEO_CONFIG_PATH.read_text(encoding="utf-8"))
            consumer_key = consumer_key or cfg.get("consumer_key", "")
            mobile = mobile or cfg.get("mobile_number", "")
            ucc = ucc or cfg.get("ucc", "")
            mpin = mpin or cfg.get("mpin", "")
            totp_key = totp_key or cfg.get("totp_key", "") or cfg.get("totp_secret", "")
        except Exception as e:
            logger.warning("Error reading neo_config.json: %s", e)

    # Get primary telegram chat id
    chat_id = ""
    if TELEGRAM_CONFIG_PATH.exists():
        try:
            t_cfg = json.loads(TELEGRAM_CONFIG_PATH.read_text(encoding="utf-8"))
            chat_id = t_cfg.get("chat_id", "")
        except Exception:
            pass

    with _get_db() as conn:
        primary = conn.execute("SELECT * FROM accounts WHERE is_primary = 1 LIMIT 1").fetchone()
        now_str = datetime.now(IST).isoformat()

        if primary:
            # Update credentials if neo_config has new data
            updates = []
            params = []
            if consumer_key and consumer_key != primary["consumer_key"]:
                updates.append("consumer_key = ?")
                params.append(consumer_key)
            if mobile and mobile != primary["mobile_number"]:
                updates.append("mobile_number = ?")
                params.append(mobile)
            if ucc and ucc != primary["ucc"]:
                updates.append("ucc = ?")
                params.append(ucc)
            if mpin and mpin != primary["mpin"]:
                updates.append("mpin = ?")
                params.append(mpin)
            if totp_key and totp_key != primary["totp_key"]:
                updates.append("totp_key = ?")
                params.append(totp_key)
            if chat_id and not primary["telegram_chat_id"]:
                updates.append("telegram_chat_id = ?")
                params.append(chat_id)

            if updates:
                updates.append("updated_at = ?")
                params.append(now_str)
                params.append(primary["id"])
                conn.execute(f"UPDATE accounts SET {', '.join(updates)} WHERE id = ?", params)
                conn.commit()
        else:
            # Insert Account #1 as Primary
            conn.execute(
                """
                INSERT INTO accounts (
                    account_name, is_primary, broker, consumer_key, mobile_number, ucc,
                    mpin, totp_key, auth_mode, telegram_chat_id, lot_multiplier,
                    max_daily_loss, is_active, created_at, updated_at
                ) VALUES (?, 1, 'KOTAK_NEO', ?, ?, ?, ?, ?, 'AUTO_TOTP', ?, 1, 2500.0, 1, ?, ?)
                """,
                (
                    "Nikhil (Primary)",
                    consumer_key,
                    mobile,
                    ucc,
                    mpin,
                    totp_key,
                    chat_id,
                    now_str,
                    now_str,
                ),
            )
            conn.commit()
            logger.info("Created Primary Account #1 in SQLite accounts.db")


def list_accounts(include_secrets: bool = False) -> List[Dict[str, Any]]:
    """Lists all accounts. By default hides passwords/MPINs/secrets."""
    with _get_db() as conn:
        rows = conn.execute("SELECT * FROM accounts ORDER BY is_primary DESC, id ASC").fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if not include_secrets:
                d["mpin_set"] = bool(d.get("mpin"))
                d["totp_key_set"] = bool(d.get("totp_key"))
                d["consumer_key_masked"] = _mask(d.get("consumer_key", ""))
                d["mobile_masked"] = _mask_mobile(d.get("mobile_number", ""))
                d.pop("mpin", None)
                d.pop("totp_key", None)
                d.pop("consumer_secret", None)
                d.pop("session_token", None)
            result.append(d)
        return result


def get_account(account_id: int, include_secrets: bool = False) -> Optional[Dict[str, Any]]:
    with _get_db() as conn:
        r = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
        if not r:
            return None
        d = dict(r)
        if not include_secrets:
            d["mpin_set"] = bool(d.get("mpin"))
            d["totp_key_set"] = bool(d.get("totp_key"))
            d["consumer_key_masked"] = _mask(d.get("consumer_key", ""))
            d["mobile_masked"] = _mask_mobile(d.get("mobile_number", ""))
            d.pop("mpin", None)
            d.pop("totp_key", None)
            d.pop("consumer_secret", None)
            d.pop("session_token", None)
        return d


def add_account(data: Dict[str, Any]) -> Dict[str, Any]:
    """Adds a new client account."""
    name = (data.get("account_name") or "").strip()
    if not name:
        return {"ok": False, "error": "Account name is required"}

    ucc = (data.get("ucc") or "").strip().upper()
    mobile = (data.get("mobile_number") or "").strip()
    consumer_key = (data.get("consumer_key") or "").strip()
    mpin = (data.get("mpin") or "").strip()
    totp_key = (data.get("totp_key") or "").strip().replace(" ", "").upper()
    telegram_chat_id = (data.get("telegram_chat_id") or "").strip()
    lot_multiplier = int(data.get("lot_multiplier") or 1)
    max_daily_loss = float(data.get("max_daily_loss") or 2000.0)
    now_str = datetime.now(IST).isoformat()

    with _get_db() as conn:
        cursor = conn.execute(
            """
            INSERT INTO accounts (
                account_name, is_primary, broker, consumer_key, mobile_number, ucc,
                mpin, totp_key, auth_mode, telegram_chat_id, lot_multiplier,
                max_daily_loss, is_active, created_at, updated_at
            ) VALUES (?, 0, 'KOTAK_NEO', ?, ?, ?, ?, ?, 'AUTO_TOTP', ?, ?, ?, 1, ?, ?)
            """,
            (
                name,
                consumer_key,
                mobile,
                ucc,
                mpin,
                totp_key,
                telegram_chat_id,
                lot_multiplier,
                max_daily_loss,
                now_str,
                now_str,
            ),
        )
        conn.commit()
        new_id = cursor.lastrowid
        return {"ok": True, "id": new_id, "message": f"Account '{name}' added successfully"}


def update_account(account_id: int, data: Dict[str, Any]) -> Dict[str, Any]:
    with _get_db() as conn:
        acc = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
        if not acc:
            return {"ok": False, "error": f"Account {account_id} not found"}

        fields = []
        params = []
        for key in ["account_name", "ucc", "mobile_number", "consumer_key", "telegram_chat_id"]:
            if key in data:
                fields.append(f"{key} = ?")
                params.append(str(data[key]).strip())

        if "mpin" in data and data["mpin"]:
            fields.append("mpin = ?")
            params.append(str(data["mpin"]).strip())

        if "totp_key" in data and data["totp_key"]:
            fields.append("totp_key = ?")
            params.append(str(data["totp_key"]).replace(" ", "").strip().upper())

        if "lot_multiplier" in data:
            fields.append("lot_multiplier = ?")
            params.append(int(data["lot_multiplier"]))

        if "max_daily_loss" in data:
            fields.append("max_daily_loss = ?")
            params.append(float(data["max_daily_loss"]))

        if "is_active" in data:
            fields.append("is_active = ?")
            params.append(1 if data["is_active"] else 0)

        if not fields:
            return {"ok": True, "message": "No changes to update"}

        fields.append("updated_at = ?")
        params.append(datetime.now(IST).isoformat())
        params.append(account_id)

        conn.execute(f"UPDATE accounts SET {', '.join(fields)} WHERE id = ?", params)
        conn.commit()
        return {"ok": True, "message": "Account updated successfully"}


def delete_account(account_id: int) -> Dict[str, Any]:
    with _get_db() as conn:
        acc = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
        if not acc:
            return {"ok": False, "error": f"Account {account_id} not found"}
        if acc["is_primary"]:
            return {"ok": False, "error": "Cannot delete Primary Account"}
        conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
        conn.commit()
        return {"ok": True, "message": f"Account '{acc['account_name']}' deleted"}


def get_account_by_telegram_chat(chat_id: str, include_secrets: bool = False) -> Optional[Dict[str, Any]]:
    """Retrieves an account by its Telegram chat_id."""
    with _get_db() as conn:
        r = conn.execute("SELECT * FROM accounts WHERE telegram_chat_id = ? ORDER BY is_primary ASC, id DESC LIMIT 1", (str(chat_id).strip(),)).fetchone()
        if not r:
            return None
        d = dict(r)
        if not include_secrets:
            d["mpin_set"] = bool(d.get("mpin"))
            d["totp_key_set"] = bool(d.get("totp_key"))
            d["consumer_key_masked"] = _mask(d.get("consumer_key", ""))
            d["mobile_masked"] = _mask_mobile(d.get("mobile_number", ""))
            d.pop("mpin", None)
            d.pop("totp_key", None)
            d.pop("consumer_secret", None)
            d.pop("session_token", None)
        return d


def upsert_telegram_account(
    chat_id: str,
    account_name: str,
    ucc: str,
    mobile: str,
    consumer_key: str,
    mpin: str,
    totp_key: str,
) -> Dict[str, Any]:
    """Creates or updates a client account linked to their Telegram chat_id."""
    chat_id = str(chat_id).strip()
    ucc = str(ucc).strip().upper()
    mobile = str(mobile).strip()
    consumer_key = str(consumer_key).strip()
    mpin = str(mpin).strip()
    totp_key = str(totp_key).replace(" ", "").strip().upper()
    now_str = datetime.now(IST).isoformat()

    with _get_db() as conn:
        existing = conn.execute(
            "SELECT * FROM accounts WHERE telegram_chat_id = ? AND is_primary = 0 LIMIT 1",
            (chat_id,),
        ).fetchone()

        if existing:
            acc_id = existing["id"]
            conn.execute(
                """
                UPDATE accounts
                SET account_name = ?, ucc = ?, mobile_number = ?, consumer_key = ?,
                    mpin = ?, totp_key = ?, is_active = 1, updated_at = ?
                WHERE id = ?
                """,
                (account_name, ucc, mobile, consumer_key, mpin, totp_key, now_str, acc_id),
            )
            conn.commit()
            return {"ok": True, "id": acc_id, "is_new": False, "message": f"Updated account for {account_name}"}
        else:
            cursor = conn.execute(
                """
                INSERT INTO accounts (
                    account_name, is_primary, broker, consumer_key, mobile_number, ucc,
                    mpin, totp_key, auth_mode, telegram_chat_id, lot_multiplier,
                    max_daily_loss, is_active, created_at, updated_at
                ) VALUES (?, 0, 'KOTAK_NEO', ?, ?, ?, ?, ?, 'AUTO_TOTP', ?, 1, 2500.0, 1, ?, ?)
                """,
                (account_name, consumer_key, mobile, ucc, mpin, totp_key, chat_id, now_str, now_str),
            )
            conn.commit()
            return {"ok": True, "id": cursor.lastrowid, "is_new": True, "message": f"Created new account for {account_name}"}


# =====================================================================
# Authenticate & Live Funds & Individual Telegram Messaging
# =====================================================================

def auth_account_and_notify(account_id: int, send_telegram: bool = True) -> Dict[str, Any]:
    """Logs into Kotak Neo for the specified account, checks funds, and notifies user via Telegram."""
    acc = get_account(account_id, include_secrets=True)
    if not acc:
        return {"ok": False, "error": "Account not found"}

    consumer_key = acc.get("consumer_key", "")
    mobile = acc.get("mobile_number", "")
    ucc = acc.get("ucc", "")
    mpin = acc.get("mpin", "")
    totp_key = acc.get("totp_key", "")
    name = acc.get("account_name", "Trader")
    chat_id = acc.get("telegram_chat_id", "")

    if not consumer_key or not mobile or not ucc or not mpin:
        return {
            "ok": False,
            "error": "Missing credentials. Required: Consumer Key, Mobile, UCC, and MPIN.",
        }

    # Step 0: Generate TOTP code using pyotp
    if not totp_key:
        return {"ok": False, "error": "TOTP Secret Key is missing. Option B requires a valid TOTP Key."}

    try:
        import pyotp
        clean_totp_key = totp_key.replace(" ", "").strip().upper()
        totp_code = pyotp.TOTP(clean_totp_key).now()
    except Exception as e:
        return {"ok": False, "error": f"Failed to generate TOTP code: {e}"}

    # Step 1: Kotak Neo API login
    try:
        from neo_api_client import NeoAPI
    except ImportError:
        return {"ok": False, "error": "kotakneoapi library is not installed"}

    try:
        client = NeoAPI(consumer_key=consumer_key, environment="prod")
        step1 = client.totp_login(mobile_number=mobile, ucc=ucc, totp=totp_code)
    except Exception as exc:
        err_msg = f"Kotak TOTP Login failed: {exc}"
        _update_session_failure(account_id, err_msg)
        if send_telegram and chat_id:
            _send_telegram_direct(
                chat_id,
                f"⚠️ <b>Kotak Neo Login Failed</b>\n"
                f"• <b>Account:</b> {name} ({ucc})\n"
                f"• <b>Error:</b> {exc}\n"
                f"• Please verify your credentials or TOTP key.",
            )
        return {"ok": False, "error": err_msg}

    if not isinstance(step1, dict) or "data" not in step1:
        err_msg = step1.get("error", "Invalid TOTP response from Kotak Neo") if isinstance(step1, dict) else str(step1)
        _update_session_failure(account_id, str(err_msg))
        return {"ok": False, "error": str(err_msg)}

    # Step 2: MPIN validate
    try:
        step2 = client.totp_validate(mpin=mpin)
    except Exception as exc:
        err_msg = f"Kotak MPIN validation failed: {exc}"
        _update_session_failure(account_id, err_msg)
        return {"ok": False, "error": err_msg}

    if not isinstance(step2, dict) or "data" not in step2:
        err_msg = step2.get("error", "Invalid MPIN response from Kotak Neo") if isinstance(step2, dict) else str(step2)
        _update_session_failure(account_id, str(err_msg))
        return {"ok": False, "error": str(err_msg)}

    token = step2["data"].get("token", "")
    now_ist = datetime.now(IST)
    auth_time_str = now_ist.strftime("%d %b %Y, %I:%M %p")

    # Step 3: Fetch Available Funds / Trading Limits
    available_funds = 0.0
    try:
        limits = client.limits()
        if isinstance(limits, dict):
            amt = limits.get("Net") or limits.get("AvailableCash") or limits.get("cashAvailable") or limits.get("availableBalance")
            if amt is not None:
                available_funds = float(amt)
            elif isinstance(limits.get("data"), list) and limits["data"]:
                for row in limits["data"]:
                    row_amt = row.get("Net") or row.get("AvailableCash") or row.get("marginAvailable")
                    if row_amt is not None:
                        available_funds = float(row_amt)
                        break
    except Exception as e:
        logger.warning("Could not fetch funds for %s: %s", name, e)

    # Step 4: Update SQLite Database
    with _get_db() as conn:
        conn.execute(
            """
            UPDATE accounts
            SET session_token = ?, session_valid = 1, session_auth_time = ?, available_funds = ?, updated_at = ?
            WHERE id = ?
            """,
            (token, auth_time_str, available_funds, now_ist.isoformat(), account_id),
        )
        conn.commit()

    # Step 5: Send Individual 1-on-1 Telegram Message
    if send_telegram and chat_id:
        funds_text = f"₹{available_funds:,.2f}" if available_funds > 0 else "Active"
        msg = (
            f"🌅 <b>Good morning, {name}!</b>\n\n"
            f"✅ <b>Kotak Neo Authorized &amp; Active</b>\n"
            f"• <b>Account:</b> {name} (<code>{ucc}</code>)\n"
            f"• <b>Available Margin:</b> <b>{funds_text}</b>\n"
            f"• <b>2FA:</b> Auto-Auth (08:45 AM Daily)\n"
            f"• <b>Multiplier:</b> {acc.get('lot_multiplier', 1)}x\n"
            f"• <b>Time:</b> {auth_time_str} IST\n\n"
            f"<i>Live trading engine monitoring market.</i>"
        )
        _send_telegram_direct(chat_id, msg)

    return {
        "ok": True,
        "message": f"Account '{name}' authenticated successfully!",
        "ucc": ucc,
        "available_funds": available_funds,
        "auth_time": auth_time_str,
    }


def auth_all_morning_accounts() -> List[Dict[str, Any]]:
    """Iterates through all active accounts, authenticates via Option B TOTP, checks limits, and sends individual Telegram alerts."""
    with _get_db() as conn:
        rows = conn.execute("SELECT id FROM accounts WHERE is_active = 1 ORDER BY is_primary DESC, id ASC").fetchall()
        account_ids = [r["id"] for r in rows]

    results = []
    for aid in account_ids:
        try:
            res = auth_account_and_notify(aid, send_telegram=True)
            results.append({"id": aid, **res})
        except Exception as e:
            logger.error("Error during batch morning auth for account %s: %s", aid, e)
            results.append({"id": aid, "ok": False, "error": str(e)})
        time.sleep(1.5)
    return results


def _update_session_failure(account_id: int, error_msg: str):
    with _get_db() as conn:
        conn.execute(
            "UPDATE accounts SET session_valid = 0, session_auth_time = ? WHERE id = ?",
            (f"Failed: {error_msg[:60]}", account_id),
        )
        conn.commit()


def _send_telegram_direct(chat_id: str, message: str) -> bool:
    """Sends a Telegram message to an individual chat ID using telegram_config.json bot_token."""
    try:
        import requests
        if not TELEGRAM_CONFIG_PATH.exists():
            return False
        cfg = json.loads(TELEGRAM_CONFIG_PATH.read_text(encoding="utf-8"))
        bot_token = cfg.get("bot_token")
        if not bot_token or not chat_id:
            return False

        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": message,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        res = requests.post(url, json=payload, timeout=8)
        return res.status_code == 200
    except Exception as e:
        logger.warning("Telegram direct message failed: %s", e)
        return False


def _mask(s: str) -> str:
    if not s or len(s) < 6:
        return "••••••"
    return s[:3] + "••••" + s[-3:]


def _mask_mobile(s: str) -> str:
    if not s or len(s) < 10:
        return "••••••••••"
    return s[:2] + "••••••" + s[-2:]


# Initialize DB on load
try:
    init_db()
except Exception as _e:
    logger.error("Failed to initialize account database: %s", _e)

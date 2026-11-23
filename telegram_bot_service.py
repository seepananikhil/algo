#!/usr/bin/env python3
"""Telegram Bot Self-Onboarding & Management Service.

Enables 100% private self-onboarding for clients directly inside Telegram:
- Zero static IP or web URLs shared with customers
- Automated Option B TOTP 2FA setup (hands-free morning login)
- Live broker margin verification upon connection
- Sensitive credential cleanup (auto-deleting MPIN & TOTP messages from chat)
- Client commands: /onboard, /funds, /status, /pause, /resume, /help
- Admin commands: /admin, /authall
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

import requests
import pyotp
import pytz

from account_manager import (
    get_account_by_telegram_chat,
    upsert_telegram_account,
    auth_account_and_notify,
    auth_all_morning_accounts,
    list_accounts,
    get_account,
)

logger = logging.getLogger("telegram_bot_service")
if not logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("[%(asctime)s] [%(levelname)s] [TG-Bot] %(message)s", "%H:%M:%S")
    )
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "telegram_config.json"
IST = pytz.timezone("Asia/Kolkata")

# In-memory onboarding wizards: chat_id -> state
_wizards: Dict[int, Dict[str, Any]] = {}
_wizards_lock = threading.Lock()

_bot_thread: Optional[threading.Thread] = None
_bot_running = False


def _get_bot_token() -> str:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if not token and CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            token = cfg.get("bot_token", "").strip()
        except Exception:
            pass
    return token


def _get_primary_chat_id() -> str:
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    if not chat_id and CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            chat_id = str(cfg.get("chat_id", "")).strip()
        except Exception:
            pass
    return chat_id


def send_tg_message(
    chat_id: int | str,
    text: str,
    parse_mode: str = "HTML",
    reply_markup: Optional[Dict[str, Any]] = None,
) -> Optional[int]:
    """Sends a message to a chat_id. Returns the message_id if successful."""
    token = _get_bot_token()
    if not token:
        return None
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload: Dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    try:
        res = requests.post(url, json=payload, timeout=10)
        data = res.json()
        if data.get("ok"):
            return data["result"]["message_id"]
    except Exception as e:
        logger.warning("Error sending Telegram message: %s", e)
    return None


def delete_tg_message(chat_id: int | str, message_id: int) -> bool:
    """Deletes a message from chat for privacy/security (e.g. MPIN / TOTP secret)."""
    token = _get_bot_token()
    if not token:
        return False
    url = f"https://api.telegram.org/bot{token}/deleteMessage"
    try:
        res = requests.post(url, json={"chat_id": chat_id, "message_id": message_id}, timeout=6)
        return res.json().get("ok", False)
    except Exception:
        return False


def _format_rupees(amt: Optional[float]) -> str:
    if amt is None:
        return "Not available"
    return f"₹{amt:,.2f}"


def handle_start(chat_id: int, user: Dict[str, Any]):
    first_name = user.get("first_name", "Trader")
    acc = get_account_by_telegram_chat(str(chat_id))

    if acc:
        status_badge = "🟢 ACTIVE" if acc.get("is_active") else "⏸ PAUSED"
        funds_str = _format_rupees(acc.get("available_funds"))
        text = (
            f"👋 <b>Welcome back, {first_name}!</b>\n\n"
            f"• <b>Account:</b> {acc.get('account_name')} (<code>{acc.get('ucc', 'N/A')}</code>)\n"
            f"• <b>Status:</b> {status_badge}\n"
            f"• <b>Available Margin:</b> <b>{funds_str}</b>\n"
            f"• <b>2FA:</b> Auto-Auth (08:45 AM Daily)\n"
            f"• <b>Multiplier:</b> {acc.get('lot_multiplier', 1)}x\n\n"
            f"<b>Commands:</b>\n"
            f"• /funds - Live margin balance\n"
            f"• /status - Daily session status\n"
            f"• /pause - Pause algo trading\n"
            f"• /resume - Resume algo trading\n"
            f"• /onboard - Update credentials\n"
            f"• /help - Help & commands"
        )
    else:
        text = (
            f"👋 <b>Hello, {first_name}!</b>\n\n"
            f"Welcome to the <b>Nikhil Algo Trading Network</b>.\n\n"
            f"Connect your Kotak Neo trading account directly in Telegram:\n"
            f"✨ Zero web links or IP addresses needed\n"
            f"✨ Automated 08:45 AM morning login without daily OTPs\n"
            f"✨ Private 1-on-1 daily margin reports\n\n"
            f"👉 Send <b>/onboard</b> to connect your account."
        )

    send_tg_message(chat_id, text)


def handle_onboard_start(chat_id: int, user: Dict[str, Any]):
    with _wizards_lock:
        _wizards[chat_id] = {
            "step": "AWAIT_UCC",
            "name": user.get("first_name", "Client"),
            "data": {},
        }

    text = (
        f"🚀 <b>Kotak Neo Account Onboarding (Step 1 of 5)</b>\n\n"
        f"Please reply with your <b>Kotak Client Code (UCC)</b>:\n"
        f"<i>(Example: <code>Y4KQT</code> or <code>123456</code>)</i>\n\n"
        f"Send /cancel at any time to exit."
    )
    send_tg_message(chat_id, text)


def handle_cancel(chat_id: int):
    with _wizards_lock:
        if chat_id in _wizards:
            del _wizards[chat_id]
            send_tg_message(chat_id, "❌ Onboarding cancelled. Send /onboard whenever you are ready.")
        else:
            send_tg_message(chat_id, "No active wizard. Send /help for commands.")


def handle_funds(chat_id: int):
    acc = get_account_by_telegram_chat(str(chat_id))
    if not acc:
        send_tg_message(
            chat_id,
            "⚠️ No Kotak Neo account found for your Telegram ID.\nSend /onboard to connect your account.",
        )
        return

    funds_val = acc.get("available_funds")
    auth_time = acc.get("session_auth_time") or "Pending morning auth"
    is_valid = bool(acc.get("session_valid"))

    text = (
        f"💰 <b>Trading Funds &amp; Margin Balance</b>\n\n"
        f"• <b>Account:</b> {acc.get('account_name')} (<code>{acc.get('ucc')}</code>)\n"
        f"• <b>Available Margin:</b> <b>{_format_rupees(funds_val)}</b>\n"
        f"• <b>Session Token:</b> {'🟢 Active Today' if is_valid else '🟡 Requires Morning Auth'}\n"
        f"• <b>Last Auth Time:</b> {auth_time}\n"
        f"• <b>Lot Multiplier:</b> {acc.get('lot_multiplier', 1)}x\n"
        f"• <b>Max Daily Loss Limit:</b> {_format_rupees(acc.get('max_daily_loss'))}\n\n"
        f"<i>Funds are inspected live from Kotak Neo API.</i>"
    )
    send_tg_message(chat_id, text)


def handle_status(chat_id: int):
    acc = get_account_by_telegram_chat(str(chat_id))
    if not acc:
        send_tg_message(chat_id, "⚠️ No account found. Send /onboard to get started.")
        return

    is_active = bool(acc.get("is_active"))
    session_valid = bool(acc.get("session_valid"))

    text = (
        f"📊 <b>Account &amp; Algorithm Status</b>\n\n"
        f"• <b>Account:</b> {acc.get('account_name')} (<code>{acc.get('ucc')}</code>)\n"
        f"• <b>Algo Trading:</b> {'🟢 ACTIVE' if is_active else '⏸ PAUSED'}\n"
        f"• <b>Session Auth:</b> {'🟢 Connected' if session_valid else '🟡 Expired / Pending'}\n"
        f"• <b>2FA:</b> Auto-Auth (08:45 AM Daily)\n"
        f"• <b>Available Margin:</b> {_format_rupees(acc.get('available_funds'))}\n\n"
        f"Use /pause to halt trading or /resume to re-enable."
    )
    send_tg_message(chat_id, text)


def handle_pause(chat_id: int):
    acc = get_account_by_telegram_chat(str(chat_id))
    if not acc:
        send_tg_message(chat_id, "⚠️ No account found. Send /onboard to connect.")
        return

    from account_manager import update_account
    update_account(acc["id"], {"is_active": 0})
    send_tg_message(
        chat_id,
        f"⏸ <b>Trading Paused for {acc.get('account_name')}</b>\n\n"
        f"Your account will NOT take any new automated trades.\n"
        f"Send /resume anytime to restart.",
    )


def handle_resume(chat_id: int):
    acc = get_account_by_telegram_chat(str(chat_id))
    if not acc:
        send_tg_message(chat_id, "⚠️ No account found. Send /onboard to connect.")
        return

    from account_manager import update_account
    update_account(acc["id"], {"is_active": 1})
    send_tg_message(
        chat_id,
        f"▶️ <b>Trading Resumed for {acc.get('account_name')}</b>\n\n"
        f"Your account is active and will take setups according to your {acc.get('lot_multiplier', 1)}x sizing.",
    )


def handle_help(chat_id: int):
    text = (
        f"📖 <b>Kotak Neo Algo Trading Help</b>\n\n"
        f"<b>Commands:</b>\n"
        f"• /start - Welcome menu & status\n"
        f"• /onboard - Connect or re-configure Kotak Neo\n"
        f"• /funds - Check live trading margin\n"
        f"• /status - Check system and session token status\n"
        f"• /pause - Temporarily pause automated trade execution\n"
        f"• /resume - Re-enable trade execution\n"
        f"• /cancel - Cancel active configuration wizard\n\n"
        f"<b>🔐 Automated 2FA (08:45 AM Daily):</b>\n"
        f"Uses your 32-character TOTP secret key from the Kotak Neo app. Every trading morning at 08:45 AM, the engine automatically logs in, checks your margin, and alerts you.\n\n"
        f"<b>Need Support?</b> Contact your algorithm manager."
    )
    send_tg_message(chat_id, text)


def handle_admin(chat_id: int):
    primary_chat = _get_primary_chat_id()
    if str(chat_id) != primary_chat:
        send_tg_message(chat_id, "⛔ Unauthorized. Admin command only.")
        return

    accounts = list_accounts(include_secrets=False)
    total_margin = sum(a.get("available_funds") or 0.0 for a in accounts)
    active_count = sum(1 for a in accounts if a.get("is_active"))

    lines = [
        f"👑 <b>Admin Portfolio Overview</b>",
        f"• <b>Total Accounts:</b> {len(accounts)} ({active_count} Active)",
        f"• <b>Combined Live Margin:</b> <b>{_format_rupees(total_margin)}</b>",
        "",
        "<b>Roster:</b>",
    ]

    for a in accounts:
        role = "⭐ Master" if a.get("is_primary") else f"#{a['id']}"
        stat = "🟢" if a.get("session_valid") else "⚪"
        lines.append(
            f"{stat} <b>{a['account_name']}</b> ({role}) | <code>{a.get('ucc')}</code>\n"
            f"   Margin: {_format_rupees(a.get('available_funds'))} | Multiplier: {a.get('lot_multiplier')}x"
        )

    lines.append("\n⚡ Send <b>/authall</b> to authenticate all active accounts now.")
    send_tg_message(chat_id, "\n".join(lines))


def handle_authall(chat_id: int):
    primary_chat = _get_primary_chat_id()
    if str(chat_id) != primary_chat:
        send_tg_message(chat_id, "⛔ Unauthorized.")
        return

    send_tg_message(chat_id, "🌅 <b>Running Morning Authentication on all active accounts...</b>")
    res = auth_all_morning_accounts()
    successes = sum(1 for r in res if r.get("ok"))
    fails = len(res) - successes

    send_tg_message(
        chat_id,
        f"🏁 <b>Morning Auth Finished:</b>\n"
        f"• <b>Successful:</b> {successes}\n"
        f"• <b>Failed:</b> {fails}\n\n"
        f"Personal margin notifications have been dispatched to each client.",
    )


def process_wizard_step(chat_id: int, text: str, message_id: int, user: Dict[str, Any]):
    with _wizards_lock:
        state = _wizards.get(chat_id)
        if not state:
            return

    step = state["step"]
    clean_text = text.strip()

    # Step 1: UCC
    if step == "AWAIT_UCC":
        ucc = clean_text.upper().replace(" ", "")
        if len(ucc) < 3 or len(ucc) > 12:
            send_tg_message(chat_id, "⚠️ Invalid UCC code. Please send a valid Kotak Client Code (e.g. <code>Y4KQT</code>):")
            return

        with _wizards_lock:
            state["data"]["ucc"] = ucc
            state["step"] = "AWAIT_MOBILE"

        msg = (
            f"📱 <b>Step 2 of 5: Registered Mobile Number</b>\n\n"
            f"UCC recorded: <code>{ucc}</code>\n\n"
            f"Please reply with your <b>10-digit registered mobile number</b> linked with Kotak Neo (e.g. <code>9876543210</code>):"
        )
        send_tg_message(chat_id, msg)
        return

    # Step 2: Mobile
    if step == "AWAIT_MOBILE":
        digits = re.sub(r"\D", "", clean_text)
        if len(digits) == 10:
            mobile = f"+91{digits}"
        elif len(digits) == 12 and digits.startswith("91"):
            mobile = f"+{digits}"
        else:
            send_tg_message(chat_id, "⚠️ Please enter a valid 10-digit Indian mobile number:")
            return

        with _wizards_lock:
            state["data"]["mobile_number"] = mobile
            state["step"] = "AWAIT_CONSUMER_KEY"

        msg = (
            f"🔑 <b>Step 3 of 5: Kotak Neo Consumer Key</b>\n\n"
            f"Mobile recorded: <code>{mobile}</code>\n\n"
            f"Please reply with your <b>Kotak Neo API Consumer Key</b>:\n"
            f"<i>(From Kotak Neo Developer Portal, e.g. <code>1deb9014-xxxx-xxxx-xxxx</code>)</i>"
        )
        send_tg_message(chat_id, msg)
        return

    # Step 3: Consumer Key
    if step == "AWAIT_CONSUMER_KEY":
        consumer_key = clean_text.replace(" ", "")
        if len(consumer_key) < 8:
            send_tg_message(chat_id, "⚠️ Invalid Consumer Key. Please paste your valid Kotak Neo Consumer Key:")
            return

        with _wizards_lock:
            state["data"]["consumer_key"] = consumer_key
            state["step"] = "AWAIT_MPIN"

        msg = (
            f"🔒 <b>Step 4 of 5: 6-Digit MPIN</b>\n\n"
            f"Consumer Key registered: <code>{consumer_key[:4]}••••{consumer_key[-4:]}</code>\n\n"
            f"Please reply with your <b>6-digit Kotak Neo MPIN</b> (e.g. <code>123456</code>):\n\n"
            f"🛡️ <i>(For your privacy, your reply will be automatically deleted from this chat immediately upon receipt)</i>"
        )
        send_tg_message(chat_id, msg)
        return

    # Step 4: 6-Digit MPIN
    if step == "AWAIT_MPIN":
        # Immediately delete sensitive MPIN from chat
        delete_tg_message(chat_id, message_id)

        mpin = re.sub(r"\D", "", clean_text)
        if len(mpin) != 6:
            send_tg_message(chat_id, "⚠️ MPIN must be exactly 6 digits. Please re-enter your 6-digit MPIN:")
            return

        with _wizards_lock:
            state["data"]["mpin"] = mpin
            state["step"] = "AWAIT_TOTP"

        msg = (
            f"🔐 <b>Step 5 of 5: Auto-Seed TOTP Key</b>\n\n"
            f"MPIN securely registered.\n\n"
            f"Now, please reply with your <b>32-character TOTP Secret Key</b> from Kotak Neo app:\n\n"
            f"📖 <b>How to get it in 30 seconds:</b>\n"
            f"1. Open <b>Kotak Neo App</b> → Tap <b>Profile Icon</b> (top right)\n"
            f"2. <b>Security &amp; Settings</b> → <b>2-Step Verification</b>\n"
            f"3. Select <b>Setup via Authenticator App</b>\n"
            f"4. Tap <b>\"Can't scan QR code?\"</b> at the bottom\n"
            f"5. <b>Copy the 32-character Secret Key</b> and paste it here:\n\n"
            f"🛡️ <i>(This message will also be auto-deleted immediately upon receipt for your privacy)</i>"
        )
        send_tg_message(chat_id, msg)
        return

    # Step 5: Option B TOTP Key & Instant Verification
    if step == "AWAIT_TOTP":
        # Immediately delete sensitive TOTP secret from chat
        delete_tg_message(chat_id, message_id)

        clean_totp = clean_text.replace(" ", "").upper()
        if len(clean_totp) < 16:
            send_tg_message(chat_id, "⚠️ The TOTP key entered appears too short. Please paste the full 32-character key from Kotak Neo:")
            return

        # Verify key validity with pyotp
        try:
            test_totp = pyotp.TOTP(clean_totp).now()
        except Exception as e:
            send_tg_message(chat_id, f"⚠️ Invalid Base32 TOTP secret key: {e}. Please check and paste again:")
            return

        d = state["data"]
        d["totp_key"] = clean_totp

        send_tg_message(chat_id, "⏳ <b>Verifying Kotak Neo connection &amp; inspecting live trading margin...</b>")

        # Upsert account in SQLite
        account_name = user.get("first_name", "Client")
        if user.get("last_name"):
            account_name += f" {user.get('last_name')}"

        save_res = upsert_telegram_account(
            chat_id=str(chat_id),
            account_name=account_name,
            ucc=d["ucc"],
            mobile=d["mobile_number"],
            consumer_key=d["consumer_key"],
            mpin=d["mpin"],
            totp_key=d["totp_key"],
        )

        acc_id = save_res["id"]

        # Run instant Auth + Live Margin fetch
        auth_res = auth_account_and_notify(acc_id, send_telegram=False)

        with _wizards_lock:
            if chat_id in _wizards:
                del _wizards[chat_id]

        if auth_res.get("ok"):
            funds_val = auth_res.get("available_funds", 0.0)
            funds_str = _format_rupees(funds_val)

            success_card = (
                f"🎉 <b>Account Connected &amp; Verified!</b>\n\n"
                f"Welcome aboard, <b>{account_name}</b>!\n\n"
                f"• <b>Client Code:</b> <code>{d['ucc']}</code>\n"
                f"• <b>Available Margin:</b> <b>{funds_str}</b>\n"
                f"• <b>2FA:</b> Auto-Auth (08:45 AM Daily)\n"
                f"• <b>Session:</b> 🟢 Authorized &amp; Active\n\n"
                f"🌅 <i>Every market morning at 08:45 AM, your session logs in automatically with your daily margin update.</i>\n\n"
                f"<b>Commands:</b>\n"
                f"• /funds - Live margin balance\n"
                f"• /status - Trading status\n"
                f"• /pause - Pause execution\n"
                f"• /resume - Resume execution"
            )
            send_tg_message(chat_id, success_card)

            # Also notify primary admin of new client onboarding
            primary_chat = _get_primary_chat_id()
            if primary_chat and primary_chat != str(chat_id):
                send_tg_message(
                    primary_chat,
                    f"🔔 <b>New Client Connected via Telegram Bot</b>\n"
                    f"• <b>Name:</b> {account_name}\n"
                    f"• <b>UCC:</b> <code>{d['ucc']}</code>\n"
                    f"• <b>Available Margin:</b> {funds_str}\n"
                    f"• <b>Telegram:</b> <code>{chat_id}</code>",
                )
        else:
            err = auth_res.get("error", "Unknown verification error")
            fail_msg = (
                f"❌ <b>Kotak Neo Authentication Failed</b>\n\n"
                f"• <b>Error:</b> <code>{err}</code>\n\n"
                f"Please ensure:\n"
                f"1. Your Consumer Key and MPIN are exact.\n"
                f"2. Your 32-character TOTP key was copied directly from Kotak Neo app.\n\n"
                f"Send <b>/onboard</b> to try again."
            )
            send_tg_message(chat_id, fail_msg)


def process_telegram_update(update: Dict[str, Any]):
    """Processes a single update object from Telegram."""
    msg = update.get("message")
    if not msg:
        return

    chat = msg.get("chat", {})
    chat_id = chat.get("id")
    text = (msg.get("text") or "").strip()
    msg_id = msg.get("message_id")
    user = msg.get("from", {})

    if not chat_id or not text:
        return

    # Check for top-level commands
    lower_text = text.lower()
    if lower_text.startswith("/start"):
        handle_start(chat_id, user)
        return
    elif lower_text.startswith("/onboard") or lower_text.startswith("/register"):
        handle_onboard_start(chat_id, user)
        return
    elif lower_text.startswith("/cancel"):
        handle_cancel(chat_id)
        return
    elif lower_text.startswith("/funds") or lower_text.startswith("/margin") or lower_text.startswith("/balance"):
        handle_funds(chat_id)
        return
    elif lower_text.startswith("/status"):
        handle_status(chat_id)
        return
    elif lower_text.startswith("/pause"):
        handle_pause(chat_id)
        return
    elif lower_text.startswith("/resume"):
        handle_resume(chat_id)
        return
    elif lower_text.startswith("/help"):
        handle_help(chat_id)
        return
    elif lower_text.startswith("/admin"):
        handle_admin(chat_id)
        return
    elif lower_text.startswith("/authall"):
        handle_authall(chat_id)
        return

    # If user is in an active wizard step
    with _wizards_lock:
        in_wizard = chat_id in _wizards

    if in_wizard:
        process_wizard_step(chat_id, text, msg_id, user)
    else:
        # Unknown message fallback
        send_tg_message(
            chat_id,
            "👋 Send /help to view available commands or /onboard to connect your Kotak Neo account.",
        )


def _bot_polling_loop():
    """Continuous long-polling loop for Telegram updates."""
    global _bot_running
    offset = 0
    token = _get_bot_token()
    if not token:
        logger.warning("No bot_token configured in telegram_config.json; bot listener will not start.")
        return

    logger.info("🤖 Telegram Bot listener starting with long-polling...")
    _bot_running = True

    while _bot_running:
        try:
            url = f"https://api.telegram.org/bot{token}/getUpdates"
            params = {"offset": offset, "timeout": 20}
            res = requests.get(url, params=params, timeout=25)
            if res.status_code == 200:
                data = res.json()
                if data.get("ok"):
                    for update in data.get("result", []):
                        offset = max(offset, update["update_id"] + 1)
                        try:
                            process_telegram_update(update)
                        except Exception as e:
                            logger.error("Error processing update %s: %s", update.get("update_id"), e)
            elif res.status_code == 409:
                logger.warning("Conflict: Another instance of Telegram bot listener is running. Retrying in 10s...")
                time.sleep(10)
            else:
                time.sleep(3)
        except requests.exceptions.Timeout:
            continue
        except requests.exceptions.ConnectionError:
            time.sleep(5)
        except Exception as exc:
            logger.error("Error in Telegram bot polling loop: %s", exc)
            time.sleep(4)


def start_telegram_bot_daemon():
    """Starts the Telegram bot listener in a background daemon thread."""
    global _bot_thread
    if _bot_thread and _bot_thread.is_alive():
        return
    _bot_thread = threading.Thread(target=_bot_polling_loop, name="tg_bot_poller", daemon=True)
    _bot_thread.start()
    logger.info("✅ Telegram Bot Onboarding Daemon launched successfully.")


if __name__ == "__main__":
    start_telegram_bot_daemon()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        _bot_running = False
        print("Bot stopped.")

#!/usr/bin/env python3
"""Telegram Notification Engine for Algo Trading.

Provides non-blocking (async / daemon thread pool) alerts for:
- Trade Entries (Symbol, Option Strike, Spot Price, SL, Lots)
- Profit Ratchet / Pyramiding Alerts (Tier 1-6 locked profits)
- Trade Exits & PnL (Spot points, Option points, Realized ₹ PnL, Exit Reason)
- System status / Error alerts

Configuration:
    Stored in `telegram_config.json` (gitignored) or via environment variables:
        TELEGRAM_BOT_TOKEN
        TELEGRAM_CHAT_ID

Usage:
    python telegram_notifier.py --setup
    python telegram_notifier.py --test
    python telegram_notifier.py --get-chat-id <BOT_TOKEN>
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger("telegram_notifier")
if not logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] [Telegram] %(message)s", "%H:%M:%S"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "telegram_config.json"

_executor = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="tg_worker")


def load_telegram_config() -> Dict[str, Any]:
    """Loads Telegram config from json file or environment variables."""
    cfg: Dict[str, Any] = {
        "bot_token": os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
        "chat_id": os.getenv("TELEGRAM_CHAT_ID", "").strip(),
        "enabled": True,
    }

    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    if data.get("bot_token"):
                        cfg["bot_token"] = str(data["bot_token"]).strip()
                    if data.get("chat_id"):
                        cfg["chat_id"] = str(data["chat_id"]).strip()
                    if "enabled" in data:
                        cfg["enabled"] = bool(data["enabled"])
        except Exception as e:
            logger.warning("Failed to parse telegram_config.json: %s", e)

    return cfg


def is_configured() -> bool:
    """Returns True if a bot token and chat id are set and notifications are enabled."""
    cfg = load_telegram_config()
    return bool(cfg.get("bot_token") and cfg.get("chat_id") and cfg.get("enabled", True))


def _post_telegram_sync(text: str, parse_mode: str = "HTML", timeout: int = 5) -> bool:
    """Synchronous HTTP POST to Telegram Bot API."""
    cfg = load_telegram_config()
    bot_token = cfg.get("bot_token")
    chat_id = cfg.get("chat_id")

    if not bot_token or not chat_id or not cfg.get("enabled", True):
        return False

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
    }

    try:
        resp = requests.post(url, json=payload, timeout=timeout)
        if resp.status_code == 200:
            return True
        else:
            logger.error("Telegram API error: HTTP %d - %s", resp.status_code, resp.text)
            return False
    except Exception as exc:
        logger.warning("Failed to send Telegram message: %s", exc)
        return False


def send_telegram_message(text: str, parse_mode: str = "HTML", async_send: bool = True) -> bool:
    """Sends a Telegram message.

    By default runs asynchronously on a worker thread to never block market loops.
    """
    if not is_configured():
        return False

    if async_send:
        _executor.submit(_post_telegram_sync, text, parse_mode)
        return True
    else:
        return _post_telegram_sync(text, parse_mode)


# =====================================================================
# High-Level Trading Alert Formatters
# =====================================================================

def notify_trade_entry(
    symbol: str,
    stage: str,
    side: str,
    option_str: str,
    spot_entry: float,
    sl_pts: float,
    initial_sl: float,
    lots: int,
    qty: int,
    target_pts: Optional[float] = None,
    option_symbol: Optional[str] = None,
    option_entry_price: Optional[float] = None,
    vix_chg: Optional[float] = None,
) -> None:
    """Sends a formatted trade entry alert."""
    side_icon = "🟢 <b>BUY CALL (LONG)</b>" if side.upper() == "LONG" else "🔴 <b>BUY PUT (SHORT)</b>"
    tgt_str = f"<b>+{target_pts:.1f} pts</b> ({spot_entry + (target_pts if side.upper() == 'LONG' else -target_pts):.1f})" if target_pts else "<i>Uncapped (Ride Trend)</i>"
    vix_str = f" | ΔVIX: <code>{vix_chg:+.2f}%</code>" if vix_chg is not None else ""

    lines = [
        f"⚡ <b>NEW TRADE TRIGGERED: {symbol}</b>",
        f"━━━━━━━━━━━━━━━━━━━",
        f"Action: {side_icon}",
        f"Strategy: <code>{stage}</code>{vix_str}",
        f"Contract: <b>{option_str}</b>",
    ]

    if option_symbol and option_entry_price:
        lines.append(f"Option LTP: <code>₹{option_entry_price:.2f}</code> (<code>{option_symbol}</code>)")

    lines.extend([
        f"Position Size: <b>{lots} Lot(s)</b> (<code>{qty} Qty</code>)",
        f"Spot Entry: <code>{spot_entry:.2f}</code>",
        f"Initial SL: <code>{initial_sl:.2f}</code> (Risk: <b>{sl_pts:.1f} pts</b>)",
        f"Target: {tgt_str}",
    ])

    text = "\n".join(lines)
    send_telegram_message(text)


def notify_ratchet(
    symbol: str,
    side: str,
    tier_name: str,
    max_fav: float,
    new_sl: float,
    locked_pts: float,
    pyramided: bool = False,
    pyramid_info: str = "",
) -> None:
    """Sends a profit ratchet / stop moved alert."""
    icon = "🛡️" if "BREAKEVEN" in tier_name.upper() else "🎯"
    lines = [
        f"{icon} <b>PROFIT RATCHET: {symbol}</b>",
        f"━━━━━━━━━━━━━━━━━━━",
        f"Tier: <b>{tier_name}</b>",
        f"Max Run: <b>+{max_fav:.1f} pts</b> in favor",
        f"New Trailing SL: <code>{new_sl:.2f}</code>",
        f"Profit Locked: <b>+{locked_pts:.1f} pts</b>",
    ]
    if pyramided:
        lines.append(f"🔥 <b>Risk-Free Pyramid Added:</b> {pyramid_info}")

    text = "\n".join(lines)
    send_telegram_message(text)


def notify_trade_exit(
    symbol: str,
    side: str,
    option_str: str,
    pnl_pts: float,
    option_pnl_pts: float,
    pnl_rupees: float,
    exit_reason: str,
    exit_price: float,
    exit_time: str,
    total_lots: int,
    qty: int,
) -> None:
    """Sends a trade exit & PnL alert."""
    if pnl_rupees >= 0:
        result_icon = "💰 <b>PROFITABLE EXIT</b>"
        pnl_badge = f"🟢 <b>+₹{pnl_rupees:,.2f}</b>"
    else:
        result_icon = "🛑 <b>STOP LOSS HIT</b>"
        pnl_badge = f"🔴 <b>-₹{abs(pnl_rupees):,.2f}</b>"

    lines = [
        f"{result_icon} — <b>{symbol}</b>",
        f"━━━━━━━━━━━━━━━━━━━",
        f"Contract: <code>{option_str}</code>",
        f"Exit Reason: <b>{exit_reason}</b> @ <code>{exit_time}</code>",
        f"Exit Spot: <code>{exit_price:.2f}</code>",
        f"Spot PnL: <b>{pnl_pts:+.1f} pts</b>",
        f"Option PnL: <b>{option_pnl_pts:+.2f} pts</b>",
        f"Net PnL: {pnl_badge} (<code>{total_lots} Lots / {qty} Qty</code>)",
    ]

    text = "\n".join(lines)
    send_telegram_message(text)


def notify_system(title: str, details: str, level: str = "INFO") -> None:
    """Sends a system alert (feed status, errors, warnings)."""
    icons = {
        "INFO": "ℹ️",
        "WARNING": "⚠️",
        "ERROR": "🚨",
        "SUCCESS": "✅",
    }
    icon = icons.get(level.upper(), "ℹ️")
    text = f"{icon} <b>[{level.upper()}] {title}</b>\n\n{details}"
    send_telegram_message(text)


# =====================================================================
# CLI Setup and Verification Helpers
# =====================================================================

def query_chat_id(bot_token: str) -> None:
    """Queries getUpdates on Telegram Bot API to show recent chat IDs."""
    url = f"https://api.telegram.org/bot{bot_token}/getUpdates"
    print(f"\nQuerying Telegram getUpdates API for bot...")
    try:
        resp = requests.get(url, timeout=10)
        data = resp.json()
        if not data.get("ok"):
            print(f"Error from Telegram: {data.get('description')}")
            return

        results = data.get("result", [])
        if not results:
            print("\nNo messages received yet!")
            print("1. Open Telegram on your phone/desktop.")
            print("2. Search for your Bot username and send it any message (e.g. 'hello').")
            print("3. Re-run this command to see your Chat ID.")
            return

        print("\nFound recent messages from users/channels:")
        seen_chats = set()
        for update in results:
            msg = update.get("message") or update.get("channel_post") or {}
            chat = msg.get("chat", {})
            cid = chat.get("id")
            if cid and cid not in seen_chats:
                seen_chats.add(cid)
                name = chat.get("first_name", "") + " " + chat.get("last_name", "")
                uname = chat.get("username", "")
                ctype = chat.get("type", "private")
                print(f"  -> Chat ID: {cid} | Name: {name.strip()} | @{uname} | Type: {ctype}")
        print("\nUse the desired Chat ID in your configuration.")
    except Exception as exc:
        print(f"Failed to query updates: {exc}")


def interactive_setup() -> None:
    """Interactive wizard to configure telegram credentials."""
    print("=" * 65)
    print("       TELEGRAM NOTIFICATION SETUP WIZARD")
    print("=" * 65)
    print("Instructions to create a Telegram bot:")
    print(" 1. In Telegram, search for '@BotFather'")
    print(" 2. Send '/newbot' and follow prompts to name your bot")
    print(" 3. Copy the HTTP API token provided by BotFather")
    print(" 4. Send a test message (e.g. 'hi') to your new bot")
    print(" 5. (Optional) Run: python telegram_notifier.py --get-chat-id <TOKEN>")
    print("=" * 65)

    curr = load_telegram_config()
    token = input(f"Enter Telegram Bot Token [{curr.get('bot_token', '')}]: ").strip() or curr.get("bot_token", "")
    chat_id = input(f"Enter Telegram Chat ID [{curr.get('chat_id', '')}]: ").strip() or curr.get("chat_id", "")

    if not token or not chat_id:
        print("Error: Both Bot Token and Chat ID are required.")
        return

    new_cfg = {
        "bot_token": token,
        "chat_id": chat_id,
        "enabled": True,
    }
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(new_cfg, f, indent=2)

    print(f"\nConfiguration saved to {CONFIG_PATH.name}!")
    print("Testing connection...")
    success = _post_telegram_sync("✅ <b>Telegram Integration Connected!</b>\n\nAlgo trading alerts are now active.", timeout=8)
    if success:
        print("Success! Check your Telegram app for the confirmation message.")
    else:
        print("Failed to send message. Please verify your Bot Token and Chat ID.")


def send_test_alert() -> None:
    """Sends a sample trade alert to verify formatting."""
    if not is_configured():
        print(f"Telegram is not configured. Run: python telegram_notifier.py --setup")
        return

    print("Sending test trade entry alert...")
    notify_trade_entry(
        symbol="NIFTY",
        stage="MORNING_TREND",
        side="LONG",
        option_str="NIFTY 24200 CE (ITM-150)",
        spot_entry=24350.25,
        sl_pts=30.0,
        initial_sl=24320.25,
        lots=2,
        qty=50,
        target_pts=None,
        option_symbol="NIFTY26NOV24200CE",
        option_entry_price=185.50,
        vix_chg=-1.85,
    )

    print("Sending test ratchet alert...")
    notify_ratchet(
        symbol="NIFTY",
        side="LONG",
        tier_name="RATCHET TIER 1 (+60 pts)",
        max_fav=68.5,
        new_sl=24370.25,
        locked_pts=20.0,
        pyramided=True,
        pyramid_info="Added 1 Lot @ 24410 (Net Risk: Zero)",
    )

    print("Sending test exit alert...")
    notify_trade_exit(
        symbol="NIFTY",
        side="LONG",
        option_str="NIFTY 24200 CE (ITM-150)",
        pnl_pts=95.5,
        option_pnl_pts=72.0,
        pnl_rupees=3600.0,
        exit_reason="TRAIL_SL_HIT",
        exit_price=24445.75,
        exit_time="14:22",
        total_lots=2,
        qty=50,
    )
    print("Test alerts dispatched! Check your Telegram.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Telegram Notification Module")
    parser.add_argument("--setup", action="store_true", help="Run interactive setup wizard")
    parser.add_argument("--test", action="store_true", help="Send sample test trading alerts")
    parser.add_argument("--get-chat-id", type=str, metavar="TOKEN", help="Query chat ID from bot token")
    args = parser.parse_args()

    if args.setup:
        interactive_setup()
    elif args.get_chat_id:
        query_chat_id(args.get_chat_id)
    elif args.test:
        send_test_alert()
    else:
        parser.print_help()

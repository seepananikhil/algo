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
import re
import logging
import os
import sys
import threading
import time
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
_last_sent_cache: Dict[str, tuple[float, str]] = {}
_send_lock = threading.Lock()


def is_deployed_environment() -> bool:
    """Detects if running in a deployed/production environment vs local dev."""
    for var in ("DEPLOYED", "IS_DEPLOYED", "PRODUCTION", "IS_PRODUCTION", "ENABLE_TELEGRAM", "TELEGRAM_ENABLED"):
        val = os.getenv(var, "").strip().lower()
        if val in ("1", "true", "yes", "on"):
            return True
    if os.getenv("ALGO_ENV", "").strip().lower() in ("prod", "production", "deployed"):
        return True
    if os.getenv("NODE_ENV", "").strip().lower() in ("production",):
        return True
    for cloud_var in ("RAILWAY_ENVIRONMENT", "RENDER", "HEROKU", "VERCEL", "FLY_APP_NAME", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST"):
        if os.getenv(cloud_var):
            return True
    return False


def load_telegram_config() -> Dict[str, Any]:
    """Loads Telegram config from json file or environment variables."""
    cfg: Dict[str, Any] = {
        "bot_token": os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
        "chat_id": os.getenv("TELEGRAM_CHAT_ID", "").strip(),
        "enabled": False,  # Local dev default: OFF
        "auto_enable_deployed": True,
        "is_deployed": is_deployed_environment(),
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
                    if "auto_enable_deployed" in data:
                        cfg["auto_enable_deployed"] = bool(data["auto_enable_deployed"])
        except Exception as e:
            logger.warning("Failed to parse telegram_config.json: %s", e)

    # Deployed environment handling:
    # If explicitly running in deployed/production environment, auto-enable when auto_enable_deployed is True
    deployed = is_deployed_environment()
    cfg["is_deployed"] = deployed
    if deployed and cfg.get("auto_enable_deployed", True):
        cfg["enabled"] = True

    # Direct environment variable override takes top precedence
    env_enabled = os.getenv("ENABLE_TELEGRAM") or os.getenv("TELEGRAM_ENABLED")
    if env_enabled is not None:
        cfg["enabled"] = env_enabled.strip().lower() in ("1", "true", "yes", "on")

    return cfg


def save_telegram_config(
    enabled: Optional[bool] = None,
    auto_enable_deployed: Optional[bool] = None,
    bot_token: Optional[str] = None,
    chat_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Saves updated Telegram configuration to telegram_config.json."""
    curr: Dict[str, Any] = {}
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                curr = json.load(f)
        except Exception:
            pass

    if bot_token is not None:
        curr["bot_token"] = bot_token.strip()
    if chat_id is not None:
        curr["chat_id"] = str(chat_id).strip()
    if enabled is not None:
        curr["enabled"] = bool(enabled)
    if auto_enable_deployed is not None:
        curr["auto_enable_deployed"] = bool(auto_enable_deployed)

    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(curr, f, indent=2)

    return load_telegram_config()


def is_configured() -> bool:
    """Returns True if a bot token and chat id are set and notifications are enabled."""
    cfg = load_telegram_config()
    return bool(cfg.get("bot_token") and cfg.get("chat_id") and cfg.get("enabled", True))


def _post_telegram_sync(
    text: str,
    parse_mode: str = "HTML",
    timeout: int = 10,
    force: bool = False,
) -> tuple[bool, str]:
    """Synchronous HTTP POST to Telegram Bot API.
    
    Returns (success: bool, status_message: str).
    """
    cfg = load_telegram_config()
    bot_token = cfg.get("bot_token")
    chat_id = cfg.get("chat_id")

    if not bot_token or not chat_id:
        return False, "Bot Token or Chat ID is missing in configuration."

    if not force and not cfg.get("enabled", True):
        return False, "Telegram notifications are currently turned OFF."

    now = time.time()
    chat_key = str(chat_id).strip()
    clean_text = text.strip()

    with _send_lock:
        last_t, last_txt = _last_sent_cache.get(chat_key, (0.0, ""))
        if clean_text == last_txt and (now - last_t) < 10.0:
            logger.warning("Dropped duplicate notification to %s (sent %.1fs ago): %s", chat_id, now - last_t, clean_text[:50])
            return False, "Duplicate message suppressed by anti-spam."
        _last_sent_cache[chat_key] = (now, clean_text)
        if len(_last_sent_cache) > 200:
            oldest = sorted(_last_sent_cache.keys(), key=lambda k: _last_sent_cache[k][0])[:50]
            for k in oldest:
                _last_sent_cache.pop(k, None)

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
    }

    try:
        resp = requests.post(url, json=payload, timeout=timeout)
        try:
            data = resp.json()
        except Exception:
            data = {}

        if resp.status_code == 200 and data.get("ok"):
            return True, "Alert sent successfully to Telegram!"
        else:
            desc = data.get("description", resp.text or f"HTTP {resp.status_code}")
            logger.error("Telegram API error: HTTP %d - %s", resp.status_code, desc)
            if "bot was blocked by the user" in desc.lower():
                return False, "Bot is blocked: Open Telegram, search @NikhilAlgoAlertSBot and tap 'Start' or 'Unblock'."
            elif "chat not found" in desc.lower():
                return False, "Chat not found: Open Telegram, search @NikhilAlgoAlertSBot and send '/start'."
            return False, f"Telegram API Error ({resp.status_code}): {desc}"
    except Exception as exc:
        logger.warning("Failed to send Telegram message: %s", exc)
        return False, f"Network error: {exc}"


def send_telegram_message(
    text: str,
    parse_mode: str = "HTML",
    async_send: bool = True,
    force: bool = False,
) -> bool:
    """Sends a Telegram message.

    By default runs asynchronously on a worker thread to never block market loops.
    """
    if not force and not is_configured():
        return False

    if async_send:
        _executor.submit(_post_telegram_sync, text, parse_mode, 6, force)
        return True
    else:
        success, _ = _post_telegram_sync(text, parse_mode, 6, force)
        return success


# =====================================================================
# High-Level Trading Alert Formatters (Clean Spacing & Readable Gaps)
# =====================================================================

def format_strategy_name(strategy: Optional[str]) -> str:
    s = (strategy or "").upper()
    if "REENTRY" in s or "STAGE2" in s:
        return "Trend Runner (Re-Entry)"
    elif "TREND" in s or "RUNNER" in s or "MORNING" in s or "STAGE1" in s:
        return "Trend Runner"
    elif "KEY_LEVEL" in s or "FADE" in s or "REVERSE" in s:
        return "Key Levels"
    elif "MIDPOINT" in s:
        return "Midpoint Scalp"
    elif "PHOENIX" in s or "SWINGER" in s:
        return "Phoenix Swinger"
    return strategy.replace("_", " ").title() if strategy else "Trend Runner"


def clean_option_name(option_str: str) -> str:
    """Strips out (ITM-150), (ATM), (OTM-...) etc. keeping just NIFTY 24200 CE."""
    if not option_str:
        return ""
    return re.sub(r"\s*\([^)]*\)", "", option_str).strip()


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
    strategy: Optional[str] = None,
    force: bool = False,
) -> None:
    """Sends a clean, spaced trade entry alert with clear visual hierarchy and full position details."""
    action = "BUY CALL" if side.upper() == "LONG" else "BUY PUT"
    dot = "🟢" if side.upper() == "LONG" else "🔴"
    strat_name = format_strategy_name(strategy or stage)
    clean_opt = clean_option_name(option_str)

    prem_lines = []
    if option_entry_price and option_entry_price > 0:
        prem_lines.append(f"💵 <b>Option Entry Price:</b> ₹{option_entry_price:,.2f}")
        total_prem = option_entry_price * qty
        prem_lines.append(f"💼 <b>Capital Deployed:</b> ₹{total_prem:,.2f}")
    prem_block = ("\n" + "\n".join(prem_lines)) if prem_lines else ""

    vix_line = f"\n🌊 <b>India VIX Δ:</b> {vix_chg:+.2f}% (Momentum Confirmed)" if vix_chg is not None else ""
    target_line = f"\n🎯 <b>Target:</b> +{target_pts:.0f} pts" if target_pts else ""

    text = (
        f"{dot} <b>TRADE ENTRY · {symbol}</b>\n\n"
        f"⚡ <b>Setup:</b> {strat_name}\n"
        f"🎯 <b>Position Taken:</b> <b>{action} · {clean_opt}</b>\n"
        f"📦 <b>Size:</b> {lots} Lot{'s' if lots > 1 else ''} ({qty} qty)"
        f"{prem_block}\n\n"
        f"📍 <b>Spot Entry:</b> {spot_entry:,.2f}\n"
        f"🛑 <b>Stop Loss:</b> {initial_sl:,.2f} ({sl_pts:.1f} pts)"
        f"{target_line}"
        f"{vix_line}\n\n"
        f"🛡️ <i>Trailing 5m 20-EMA active (No ratchets · Clean exit on signal)</i>"
    )
    send_telegram_message(text, force=force)


def notify_ratchet(
    symbol: str,
    side: str,
    tier_name: str,
    max_fav: float,
    new_sl: float,
    locked_pts: float,
    pyramided: bool = False,
    pyramid_info: str = "",
    strategy: Optional[str] = "Trend Runner",
    force: bool = False,
) -> None:
    """Silenced: Ratchet alerts removed per user instruction (FnO alerts are Entry & Exit only)."""
    return


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
    strategy: Optional[str] = "Trend Runner",
    force: bool = False,
) -> None:
    """Sends a clean, spaced trade exit & PnL alert."""
    badge_icon = "🟢" if pnl_rupees >= 0 else "🔴"
    badge_pnl = f"+₹{pnl_rupees:,.2f}" if pnl_rupees >= 0 else f"-₹{abs(pnl_rupees):,.2f}"

    strat_name = format_strategy_name(strategy)
    clean_opt = clean_option_name(option_str)
    clean_reason = exit_reason.replace("_", " ").title()

    opt_pts_str = f" ({option_pnl_pts:+.2f} pts)" if option_pnl_pts != 0 else ""

    text = (
        f"🏁 <b>TRADE EXIT · {symbol}</b>\n\n"
        f"💰 <b>Realized PnL:</b> {badge_icon} <b>{badge_pnl}</b>{opt_pts_str}\n"
        f"🎯 <b>Position Closed:</b> {clean_opt} ({total_lots} Lot{'s' if total_lots > 1 else ''} / {qty} qty)\n\n"
        f"💵 <b>Exit Price:</b> ₹{exit_price:,.2f}\n"
        f"📍 <b>Exit Reason:</b> <b>{clean_reason}</b>\n"
        f"⏰ <b>Exit Time:</b> {exit_time}\n"
        f"📊 <b>Spot Movement:</b> {pnl_pts:+.1f} pts\n\n"
        f"⚡ <i>Strategy: {strat_name}</i>"
    )
    send_telegram_message(text, force=force)


def notify_swinger_trade_entry(
    symbol: str,
    name: str,
    leg: int,
    entry_price: float,
    qty: int,
    invested: float,
    sl_price: float,
    sl_pct: float,
    force: bool = False,
) -> None:
    """Disabled: Swinger cash equity positions disabled (system is FnO only)."""
    return None


def notify_swinger_trade_exit(
    symbol: str,
    name: str,
    exit_price: float,
    avg_price: float,
    qty: int,
    pnl: float,
    pnl_pct: float,
    days_held: int,
    reason: str,
    force: bool = False,
) -> None:
    """Disabled: Swinger cash equity positions disabled (system is FnO only)."""
    return None


def notify_eod_report(
    date_str: str,
    trades: list[dict[str, Any]],
    open_positions: Optional[list[dict[str, Any]]] = None,
    portfolio_value: Optional[float] = None,
    force: bool = False,
) -> bool:
    """Sends a clean, spaced EOD performance summary ONLY IF trades were taken or open positions exist.
    
    Each item in `trades` should have:
      - symbol: str
      - pnl: float (in rupees)
      - reason: str (optional)
      - pnl_pct or pnl_pts: float (optional)
      - contract: str (optional)
    """
    if not trades and not open_positions and not force:
        # Don't spam if nothing happened today
        return False

    total_realized = sum(float(t.get("pnl", 0.0)) for t in trades)
    wins = [t for t in trades if float(t.get("pnl", 0.0)) > 0]
    losses = [t for t in trades if float(t.get("pnl", 0.0)) < 0]
    win_count = len(wins)
    loss_count = len(losses)
    total_trades = len(trades)
    win_rate = (win_count / total_trades * 100.0) if total_trades > 0 else 0.0

    total_win_pnl = sum(float(t.get("pnl", 0.0)) for t in wins)
    total_loss_pnl = abs(sum(float(t.get("pnl", 0.0)) for t in losses))
    pf = (total_win_pnl / total_loss_pnl) if total_loss_pnl > 0 else (99.0 if total_win_pnl > 0 else 1.0)

    pnl_formatted = f"+₹{total_realized:,.0f}" if total_realized >= 0 else f"-₹{abs(total_realized):,.0f}"
    pnl_dot = "🟢" if total_realized >= 0 else "🔴"

    lines = [
        f"📊 <b>EOD FnO PERFORMANCE REPORT</b>",
        f"📅 <b>Date:</b> {date_str}",
        f"",
        f"💰 <b>Final Realized PnL:</b> {pnl_dot} <b>{pnl_formatted}</b>",
    ]

    if total_trades > 0:
        lines.extend([
            f"🎯 <b>Win Rate:</b> {win_rate:.1f}% ({win_count}W / {loss_count}L)",
            f"⚖️ <b>Profit Factor:</b> {pf:.2f} (Total {total_trades} trades)",
            f"",
            f"<b>FnO Trades Closed Today:</b>",
        ])

        for t in trades:
            sym = t.get("symbol", "INDEX")
            p = float(t.get("pnl", 0.0))
            dot = "🟢" if p >= 0 else "🔴"
            p_str = f"+₹{p:,.0f}" if p >= 0 else f"-₹{abs(p):,.0f}"
            contract = t.get("contract") or t.get("name") or sym
            clean_c = clean_option_name(contract)
            reason = t.get("reason", "").replace("_", " ").title()
            reason_str = f" · <i>{reason}</i>" if reason else ""
            lines.append(f"• {dot} <b>{clean_c}:</b> {p_str}{reason_str}")
    else:
        lines.append(f"ℹ️ <i>No trades closed today.</i>")

    lines.append("")
    lines.append(f"⚡ <i>Nikhil Algo FnO Trading Engine</i>")

    text = "\n".join(lines)
    return send_telegram_message(text, force=force)


def dispatch_daily_eod_report(target_date: Optional[str] = None, force: bool = False) -> bool:
    """Collects today's closed FnO trades (NIFTY & SENSEX options) and dispatches the EOD report.
    
    Only sends if at least one trade was taken today, unless force=True.
    """
    from datetime import datetime
    today_s = target_date or datetime.now().strftime("%Y-%m-%d")
    trades_today: list[dict[str, Any]] = []

    # 1. Check Trend Runner Nifty Paper Trades
    tr_file = ROOT / "performance" / "trend_runner_paper_trades.csv"
    if tr_file.exists():
        try:
            import pandas as pd
            df = pd.read_csv(tr_file)
            if not df.empty and "date" in df.columns:
                t_rows = df[df["date"].astype(str) == today_s]
                for _, r in t_rows.iterrows():
                    trades_today.append({
                        "symbol": str(r.get("symbol", "NIFTY")),
                        "contract": str(r.get("option_str", r.get("symbol", "NIFTY"))),
                        "pnl": float(r.get("pnl_rupees", 0.0)),
                        "reason": str(r.get("exit_reason", "EOD")),
                    })
        except Exception as e:
            logger.warning("Error reading Nifty paper trades: %s", e)

    # 2. Check Trend Runner Sensex Paper Trades
    tr_s_file = ROOT / "performance" / "trend_runner_sensex_paper_trades.csv"
    if tr_s_file.exists():
        try:
            import pandas as pd
            df_s = pd.read_csv(tr_s_file)
            if not df_s.empty and "date" in df_s.columns:
                t_s_rows = df_s[df_s["date"].astype(str) == today_s]
                for _, r in t_s_rows.iterrows():
                    trades_today.append({
                        "symbol": str(r.get("symbol", "SENSEX")),
                        "contract": str(r.get("option_str", r.get("symbol", "SENSEX"))),
                        "pnl": float(r.get("pnl_rupees", 0.0)),
                        "reason": str(r.get("exit_reason", "EOD")),
                    })
        except Exception as e:
            logger.warning("Error reading Sensex paper trades: %s", e)

    if not trades_today and not force:
        logger.info("No FnO trades closed today on %s; skipping EOD report.", today_s)
        return False

    return notify_eod_report(
        date_str=today_s,
        trades=trades_today,
        open_positions=None,
        portfolio_value=None,
        force=force,
    )


def notify_system(title: str, details: str, level: str = "INFO") -> None:
    """Sends a clean, spaced system alert."""
    icons = {"INFO": "ℹ️", "WARNING": "⚠️", "ERROR": "🚨", "SUCCESS": "✅"}
    icon = icons.get(level.upper(), "ℹ️")
    text = (
        f"{icon} <b>SYSTEM ALERT · {title}</b>\n\n"
        f"{details}"
    )
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
    """Sends sample trade alerts and an EOD report to verify formatting and spacing."""
    cfg = load_telegram_config()
    if not cfg.get("bot_token") or not cfg.get("chat_id"):
        print(f"Telegram Bot Token or Chat ID is missing. Run: python telegram_notifier.py --setup")
        return

    # Temporarily allow test alerts to fire even when local notifications are silenced
    prev_enabled = cfg.get("enabled", False)
    cfg["enabled"] = True

    print("1/4 Sending test trade entry alert...")
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
        force=True,
    )
    time.sleep(0.5)

    print("2/4 Sending test ratchet alert...")
    notify_ratchet(
        symbol="NIFTY",
        side="LONG",
        tier_name="Tier 1 (+60 pts)",
        max_fav=68.5,
        new_sl=24370.25,
        locked_pts=20.0,
        pyramided=True,
        pyramid_info="Added 1 Lot @ 24,410 (Net Risk: Zero)",
        force=True,
    )
    time.sleep(0.5)

    print("3/4 Sending test exit alert...")
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
        force=True,
    )
    time.sleep(0.5)

    print("4/4 Sending test EOD performance report with final PnL...")
    sample_trades = [
        {"symbol": "NIFTY", "contract": "NIFTY 24200 CE", "pnl": 3600.0, "reason": "Trailing SL Hit"},
        {"symbol": "BANKNIFTY", "contract": "BANKNIFTY 52000 CE", "pnl": 5250.0, "reason": "Target 2 Reached"},
        {"symbol": "FINNIFTY", "contract": "FINNIFTY 23500 CE", "pnl": -1200.0, "reason": "Initial SL Hit"},
    ]
    sample_open = [
        {"symbol": "WOCKPHARMA", "unrealized_pnl": 3450.0},
        {"symbol": "STLTECH", "unrealized_pnl": 1280.0},
    ]
    notify_eod_report(
        date_str="22 Nov 2026",
        trades=sample_trades,
        open_positions=sample_open,
        portfolio_value=627822.0,
        force=True,
    )
    time.sleep(1.0)
    print("All test alerts dispatched! Check your Telegram.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Telegram Notification Module")
    parser.add_argument("--setup", action="store_true", help="Run interactive setup wizard")
    parser.add_argument("--test", action="store_true", help="Send sample test trading alerts")
    parser.add_argument("--eod", action="store_true", help="Trigger EOD report for today's closed paper/live trades")
    parser.add_argument("--enable", action="store_true", help="Turn Telegram alerts ON")
    parser.add_argument("--disable", action="store_true", help="Turn Telegram alerts OFF (local default)")
    parser.add_argument("--status", action="store_true", help="Check current Telegram alert configuration and status")
    parser.add_argument("--get-chat-id", type=str, metavar="TOKEN", help="Query chat ID from bot token")
    args = parser.parse_args()

    if args.setup:
        interactive_setup()
    elif args.get_chat_id:
        query_chat_id(args.get_chat_id)
    elif args.enable:
        cfg = save_telegram_config(enabled=True)
        print(f"Telegram alerts turned ON (enabled: {cfg['enabled']}, deployed: {cfg['is_deployed']})")
    elif args.disable:
        cfg = save_telegram_config(enabled=False)
        print(f"Telegram alerts turned OFF (enabled: {cfg['enabled']}, deployed: {cfg['is_deployed']})")
    elif args.status:
        cfg = load_telegram_config()
        active = is_configured()
        print("=" * 55)
        print("          TELEGRAM CONFIGURATION STATUS")
        print("=" * 55)
        print(f"  Active & Sending:       {'YES (ACTIVE)' if active else 'NO (SILENCED / OFF)'}")
        print(f"  Config Enabled Flag:    {cfg.get('enabled')}")
        print(f"  Auto-Enable on Deploy:  {cfg.get('auto_enable_deployed')}")
        print(f"  Detected Environment:   {'DEPLOYED / PRODUCTION' if cfg.get('is_deployed') else 'LOCAL DEV'}")
        print(f"  Bot Token Set:          {'YES' if bool(cfg.get('bot_token')) else 'NO'}")
        print(f"  Chat ID Set:            {'YES (' + str(cfg.get('chat_id')) + ')' if bool(cfg.get('chat_id')) else 'NO'}")
        print("=" * 55)
    elif args.test:
        send_test_alert()
    elif args.eod:
        sent = dispatch_daily_eod_report(force=True)
        if sent:
            print(f"EOD report sent successfully.")
        else:
            print(f"No trades closed today; report not sent.")
    else:
        parser.print_help()

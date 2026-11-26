import json
import requests
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "telegram_config.json"

with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    cfg = json.load(f)

token = cfg.get("bot_token")

samples = [
    """🔴 <b>TRADE ENTRY · NIFTY</b>

⚡ <b>Setup:</b> Trend Runner (15m ORB)
🎯 <b>Position Taken:</b> <b>BUY PUT · NIFTY 25800 PE</b>
📦 <b>Size:</b> 1 Lot (25 qty)
💵 <b>Option Entry Price:</b> ₹145.20
💼 <b>Capital Deployed:</b> ₹3,630.00

📍 <b>Spot Entry:</b> 25,633.40
🛑 <b>Stop Loss:</b> 25,663.40 (30.0 pts)
🌊 <b>India VIX Δ:</b> +5.77% (Bearish Momentum Confirmed)

⏰ <b>Entry Time:</b> 09:32 IST
🛡️ <i>Trailing 5m 20-EMA active (No ratchets · Clean exit on signal)</i>""",

    """🔴 <b>TRADE ENTRY · SENSEX</b>

⚡ <b>Setup:</b> Trend Runner (15m ORB)
🎯 <b>Position Taken:</b> <b>BUY PUT · SENSEX 83400 PE</b>
📦 <b>Size:</b> 1 Lot (20 qty)
💵 <b>Option Entry Price:</b> ₹666.70
💼 <b>Capital Deployed:</b> ₹13,334.00

📍 <b>Spot Entry:</b> 83,850.10
🛑 <b>Stop Loss:</b> 83,950.10 (100.0 pts)
🌊 <b>India VIX Δ:</b> +6.12% (High Volatility Expansion)

⏰ <b>Entry Time:</b> 09:35 IST
🛡️ <i>Trailing 5m 20-EMA active (No ratchets · Clean exit on signal)</i>""",

    """🏁 <b>TRADE EXIT · SENSEX</b>

💰 <b>Realized PnL:</b> 🟢 <b>+₹11,542.00</b> (+577.10 pts)
🎯 <b>Position Closed:</b> SENSEX 83400 PE (1 Lot / 20 qty)

💵 <b>Option Price:</b> ₹666.70 ➔ <b>₹1,243.80</b>
📍 <b>Exit Reason:</b> <b>EOD 15:15 Close</b>
⏰ <b>Exit Time:</b> 15:15 IST
📊 <b>Spot Movement:</b> +972.25 pts

⚡ <i>Strategy: Trend Runner (Dual Confluence)</i>""",

    """📊 <b>EOD FnO PERFORMANCE REPORT</b>
📅 <b>Date:</b> 2026-11-24

💰 <b>Final Realized PnL:</b> 🟢 <b>+₹16,524.50</b>
🎯 <b>Win Rate:</b> 100.0% (2W / 0L)
⚖️ <b>Profit Factor:</b> 99.00 (Total 2 trades)

<b>FnO Trades Closed Today:</b>
• 🟢 <b>SENSEX 83400 PE:</b> +₹11,542 · <i>Eod 1515 Runner</i>
• 🟢 <b>NIFTY 25800 PE:</b> +₹4,982 · <i>Eod 1515 Runner</i>

⚡ <i>Nikhil Algo FnO Trading Engine</i>"""
]

chats = ["1068839450", cfg.get("chat_id")]
for cid in chats:
    if not cid:
        continue
    print(f"Sending samples to Chat ID: {cid}")
    for idx, s in enumerate(samples, 1):
        try:
            res = requests.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={
                    "chat_id": cid,
                    "text": s,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": True,
                },
                timeout=10,
            )
            data = res.json()
            ok = data.get("ok")
            msg_id = data.get("result", {}).get("message_id")
            print(f"  Sample {idx}: ok={ok}, msg_id={msg_id}")
        except Exception as e:
            print(f"  Sample {idx} error: {e}")
        time.sleep(1)

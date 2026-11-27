# Apex Duo — Strategy & Locked Configuration Guide

A clear, plain-English overview of how **Apex Duo** trades **NIFTY 50** and **SENSEX** options, what rules are permanently locked, and what happens step-by-step during a trading session.

---

## 1. Core Philosophy
- **Trend-Following Momentum System**: Captures strong directional intraday moves after the morning Opening Range breaks, and rides the trend until both indices confirm a momentum shift — or until `15:15 IST`.
- **Dual-Index Confirmation (Apex Duo)**: NIFTY and SENSEX must **both** agree on direction before entering, and **both** must confirm a trend break before exiting. This filters out single-index fakeouts and choppy shakeouts.
- **No Profit Caps & No Pyramiding**: Winning trades are never capped at a fixed target, and positions are never pyramided mid-trade.

---

## 2. Locked Configuration (Fixed Engine Rules)
These core rules are static and identical across **Backtest**, **Paper**, and **Live**:

| Rule | NIFTY 50 | SENSEX |
|---|---|---|
| **Opening Range (OR) Window** | `09:15 – 09:30 IST` (min `30` pts range) | `09:15 – 09:30 IST` (min `80` pts range) |
| **Entry Window** | `09:30 – 13:00 IST` (`10:45` cutoff for CALLs) | `09:30 – 13:00 IST` (`10:45` cutoff for CALLs) |
| **Midday Chop Blackout** | `11:00 – 12:00 IST` (no fresh Trade 1 entries) | `11:00 – 12:00 IST` (no fresh Trade 1 entries) |
| **Breakout Candle Body** | `≥ 70%` (strict VIX) or `≥ 80%` (directional VIX) | `≥ 70%` (strict VIX) or `≥ 80%` (directional VIX) |
| **Rejection Wick Limit** | Upper/Lower wick `≤ 30%` of range or `≤ 4` pts | Upper/Lower wick `≤ 30%` of range or `≤ 15` pts |
| **VIX Bias Filter** | CALL: `≤ -1.8%` (`≤ 0%` if `80%+` body) · PUT: `≥ 0.0%` | CALL: `≤ -1.8%` (`≤ 0%` if `80%+` body) · PUT: `≥ 0.0%` |
| **Dual-Activation Window** | Both indices must agree within `60` minutes | Both indices must agree within `60` minutes |
| **Protective Initial SL** | **`55` spot points** (checked every `1m` bar) | **`220` spot points** (checked every `1m` bar) |
| **1m 200-EMA Arming** | Activates after **`+50` spot points** favorable move | Activates after **`+150` spot points** favorable move |
| **1m 200-EMA Exit Buffer** | `10.0` spot points beyond 1m 200-EMA | `30.0` spot points beyond 1m 200-EMA |
| **Re-Entry Cool-Off** | `20` minutes after Trade 1 exit, up to `13:30 IST` (max `2` trades/day) | `20` minutes after Trade 1 exit, up to `13:30 IST` (max `2` trades/day) |
| **End-of-Day Square-Off** | `15:15 IST` | `15:15 IST` |
| **Pyramiding / Ratchets** | **Disabled** (pure `1m 200-EMA` + Initial SL) | **Disabled** (pure `1m 200-EMA` + Initial SL) |

### What You Control in Settings
- **Lot Sizing**: `1` lot base (`65` qty NIFTY / `20` qty SENSEX), or Dynamic (`1` vs `2` lots on A+ conviction).
- **Daily Loss Limit**: Circuit breaker (e.g. `₹2,500`) that halts trading for the day if breached.
- **Execution Mode**: **Paper Simulation** vs **Live Broker** (Kotak Neo) per index.

---

## 3. Exactly What Happens Step-by-Step

### Step 1: Morning Setup (`09:15 – 09:30 IST`)
- The engine records the **Opening Range** (High and Low of the first 15 minutes).
- If the Opening Range is too narrow (`< 30` pts on NIFTY or `< 80` pts on SENSEX), that index stands down for the morning.

### Step 2: Entry & Dual Confluence (`09:30 – 13:00 IST`)
- The engine scans **1-minute candles** for a clean breakout beyond the Opening Range:
  - Must close green above OR High (for **CALL**) or red below OR Low (for **PUT**).
  - Must be a strong **valid breakout candle**: solid body (`70%+` or `80%+`) with minimal rejection wick (`≤ 30%` or within `4` / `15` pts noise) and aligned with India VIX.
  - **CALL Cutoff**: Fresh CALL entries are only allowed until **`10:45 IST`**; PUT entries remain open until `13:00 IST`.
- **Dual-Activation Gate**: When one index triggers, it *arms* and waits up to **60 minutes** for the sister index to trigger in the **same direction**.
  - In **Live/Paper (`FIRST_TRIGGERED` mode)**: Whichever index confirms the pair takes **1 active position** (blocking the other index so you never double-expose).
  - In **Backtest (`CONCURRENT` mode)**: Both indices' trades are simulated together to measure full dual-index edge.

### Step 3: Trade Management & Exits
1. **Protective Initial Stop Loss (`55` pts NIFTY / `220` pts SENSEX)**:
   - Checked on **every 1-minute bar** from entry. If price moves against the trade by `55` pts (NIFTY) or `220` pts (SENSEX), it exits immediately to cap loss.
2. **Armed 1m 200-EMA Dual-Cross Trail**:
   - Once the trade moves **`+50` pts** (NIFTY) or **`+150` pts** (SENSEX) in your favor, the `1m 200-EMA` trailing exit arms.
   - At each **1-minute candle close**, the engine checks whether **both** NIFTY and SENSEX have closed beyond their continuous `1m 200-EMA` (past the `10p / 30p` noise buffer).
   - If **only one** index crosses its `1m 200-EMA` while the other holds, the trade **stays open** (filtering out single-index shakeouts).
   - Once **both** indices confirm a `1m 200-EMA` close beyond the buffer, the trade exits cleanly.
3. **Hard Time Exit (`15:15 IST`)**:
   - Any position still open at `15:15 IST` is squared off automatically before market close.

### Step 4: Re-Entry (Trade 2)
- If Trade 1 exits early (either via Initial SL or an `EMA20_CROSS`), the engine waits **`20` minutes** (cool-off) and can take **1 re-entry** (up to `13:30 IST`) if both indices break out again with a valid BO candle.

---

## 4. Historical Performance Summary (10-Year Backtest, 1 Lot)
- **NIFTY (`2017–2026`, 65 Qty)**: `1,867` trades · **`52.4%` Win Rate** · `+42,499.9` pts · Max Drawdown `601.4` pts · Calmar **`70.7x`** · Profit Factor **`2.12`** · **`₹27,62,495.45`**
- **SENSEX (`2023–2026`, 20 Qty)**: `777` trades · **`54.2%` Win Rate** · `+73,065.1` pts · Max Drawdown `1,584.0` pts · Calmar **`46.1x`** · Profit Factor **`2.25`** · **`₹14,61,301.20`**
- **Combined 1-Lot Master Portfolio**: **`₹38,99,926.40`**

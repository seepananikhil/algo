import { useCallback, useEffect, useRef, useState } from "react"

export type Status = {
  now: string
  token: {
    valid: boolean
    generated_at_utc: string | null
    broker?: string
    ucc?: string | null
    greeting_name?: string | null
    reason?: string | null
  }
  broker?: "FYERS" | "KOTAK_NEO"
  broker_status?: {
    active_broker: "FYERS" | "KOTAK_NEO"
    fyers: { valid: boolean; generated_at_utc: string | null }
    kotak_neo: {
      valid: boolean
      ucc: string | null
      greeting_name: string | null
      logged_in_at: string | null
      reason: string | null
    }
  }
  capture_running: boolean
  market_open_day?: boolean
  mode: "PAPER" | "LIVE"
  lots: number
  daily_loss_limit: number | null
  kill_switch: boolean
  risk_guardian?: {
    status: 'ACTIVE' | 'LOCKED' | 'BREACHED_JUST_NOW' | 'DISABLED'
    is_locked: boolean
    enabled: boolean
    daily_loss_limit: number
    current_pnl: number
    remaining_buffer: number
    open_count: number
    lock_info?: {
      date: string
      breached_at: string
      limit: number
      pnl: number
      reason: string
    } | null
    checked_at?: string
  }
  last_tick: { time: string; ltp: number; change?: number; per_change?: number; prev_close?: number } | null
  sensex_last_tick: { time: string; ltp: number; change?: number; per_change?: number; prev_close?: number } | null
  scalper?: {
    enabled: boolean
    mode: "PAPER" | "LIVE"
    sl_pts: number
    target_pts: number
    max_trades: number
    trades_today_count: number
    today_trades?: any[]
  }
}

export type Candle = { time: string; open: number; high: number; low: number; close: number }

export type RuleTrade = {
  side: "CALL" | "PUT" | "LONG" | "SHORT" | "CE" | "PE" | (string & {})
  entry: string
  entry_price: number
  sl: number
  target: number
  exit: string
  exit_price: number
  reason: string
  pnl_points: number
  setup?: string
}

export type Setup = {
  so_far_high?: number
  so_far_low?: number
  range_high?: number
  range_low?: number
  mid?: number
  buffer?: number
  range_fixed_at?: string
  key_levels?: { price: number; distance: number; nearby: boolean }[]
  key_level_zone?: { level: number; buffer: number } | null
  key_breaks?: { time: string; price: number; side: "CALL" | "PUT"; confirmed: boolean; distance: number }[]
  armed?: { side: "CALL" | "PUT"; candle: string; level: number; stop: number }
}

export type DayData = {
  date: string
  symbol?: string
  prev_close?: number | null
  candles: Candle[]
  forming: Partial<Candle>
  setup: Setup
  trades: RuleTrade[]
  boxes?: CompressionBox[]
  signals?: Signal[]
  paper_trades?: PaperTrade[]
  option_trades?: OptionTrade[]
  first_paper_date?: string | null
  execution_mode?: "PAPER" | "LIVE"
}

export type Signal = Record<string, string>

/** Pair live ENTRY/EXIT signals into trades; an ENTRY without EXIT is still open. */
export function tradesFromSignals(signals: Signal[]): RuleTrade[] {
  const out: RuleTrade[] = []
  let open: RuleTrade | null = null
  for (const s of signals) {
    if (s.event === "ENTRY") {
      open = {
        side: s.side as RuleTrade["side"],
        entry: s.entry_time,
        entry_price: Number(s.price),
        sl: Number(s.sl),
        target: Number(s.target),
        exit: "",
        exit_price: NaN,
        reason: "open",
        pnl_points: 0,
      }
      out.push(open)
    } else if (s.event === "EXIT" && open) {
      open.exit = s.candle_time.slice(0, 5)
      open.exit_price = Number(s.price)
      open.reason = s.reason
      open.pnl_points = Number(s.pnl_points)
      open = null
    }
  }
  return out
}

export type PositionRow = {
  symbol: string
  side: "CALL" | "PUT" | "LONG" | "SHORT" | "CE" | "PE" | (string & {}) | "EQUITY"
  net_qty?: number
  qty?: number
  lot_size?: number
  lots?: number
  buy_avg: number
  sell_avg: number
  buy_amt?: number
  sell_amt?: number
  invested?: number
  ltp?: number
  current_value?: number
  unrealized_pnl?: number
  pnl_pct?: number
  realized_pnl?: number
  exchange?: string
  product?: string
  expiry?: string
}

export type PositionsResponse = {
  ok: boolean
  broker: "FYERS" | "KOTAK_NEO"
  error?: string
  open_positions: PositionRow[]
  closed_positions: PositionRow[]
  summary: {
    realized_pnl: number
    unrealized_pnl: number
    net_pnl: number
    open_count: number
    closed_count: number
    total_invested: number
    current_value?: number
  }
}

export type OptionTrade = {
  date: string
  side: "CALL" | "PUT" | "LONG" | "SHORT" | "CE" | "PE" | (string & {})
  option: string
  qty: number
  entry: string
  nifty_in: number
  buy_price: number
  buy_value_rs: number
  exit: string
  nifty_out: number
  sell_price: number
  sell_value_rs: number
  exit_reason: string
  nifty_points: number
  pnl_points: number
  pnl_rs: number
  option_pnl_rs?: number
  futures_pnl_rs?: number
  sl?: number
  target?: number
  tp_pts?: number
  tl_pts?: number
  raw_symbol?: string
  trigger_label?: string
  charges_rs?: number
  net_rs?: number
  mode?: string
  spot_at_entry?: number
  level?: number | null
  strategy?: string
  symbol?: string
  is_open?: boolean
}

export function formatTimeAgo(epochMs: number): string {
  const diffSec = Math.floor((Date.now() - epochMs) / 1000)
  if (diffSec < 5) return "just now"
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  return `${diffHr}h ${diffMin % 60}m ago`
}

/** Drop synthetic midpoint EXIT signals that fire at/after the time of an actual filled trade. */
export function withoutSupersededExitSignals(signals: Signal[], fills: OptionTrade[]): Signal[] {
  return signals.filter((signal) => {
    if (signal.event !== "EXIT") return true
    const actual = fills.find((fill) => fill.side === signal.side && fill.entry === (signal.entry_time ?? "").slice(0, 5))
    return !actual?.exit || actual.exit >= (signal.candle_time ?? "").slice(0, 5)
  })
}

/** Plot actual option fill times at their associated NIFTY index prices. */
export function chartTradesFromOptionFills(fills: OptionTrade[]): RuleTrade[] {
  return fills.map((fill) => ({
    side: fill.side,
    entry: fill.entry,
    entry_price: fill.nifty_in || fill.spot_at_entry || 0,
    sl: fill.sl != null && !Number.isNaN(fill.sl) ? fill.sl : Number.NaN,
    target: fill.target != null && !Number.isNaN(fill.target) ? fill.target : Number.NaN,
    exit: fill.exit,
    exit_price: fill.nifty_out || 0,
    reason: fill.exit_reason,
    pnl_points: fill.nifty_points ?? fill.pnl_points ?? 0,
  }))
}

export type BacktestTrade = RuleTrade & { date: string; equity: number; drawdown: number; bars_held?: number; setup?: string }

export type PaperReport = {
  summary: {
    trades: number
    days: number
    wins: number
    losses: number
    win_rate_pct: number
    gross_rs: number
    charges_rs: number
    net_rs: number
    points: number
    avg_win_rs: number
    avg_loss_rs: number
    max_drawdown_rs: number
    winning_days: number
  }
  trades: (OptionTrade & {
    charges_rs: number
    net_rs: number
    equity: number
    drawdown: number
  })[]
  daily: { date: string; trades: number; gross_rs: number; charges_rs: number; net_rs: number; points: number }[]
  monthly: { month: string; trades: number; gross_rs: number; charges_rs: number; net_rs: number; win_rate_pct: number }[]
  exit_reasons: { reason: string; count: number; points: number; pnl_rs: number }[]
}

export type KeyLevelTrade = {
  date: string
  side: "CALL" | "PUT" | "LONG" | "SHORT" | "CE" | "PE" | (string & {})
  level: number
  break_time: string
  confirm_time: string
  entry_time: string
  entry_price: number
  stop: number
  target: number
  exit_time: string
  exit_price: number | null
  pnl_points: number
  setup?: string
  exit_reason: string
  status: "open" | "closed"
  source?: string
}

export type KeyLevelBook = {
  summary: {
    trades: number
    open_trades: number
    wins: number
    losses: number
    win_rate_pct: number
    net_points: number
    avg_points: number
    max_drawdown_points: number
  }
  trades: KeyLevelTrade[]
  daily: { date: string; trades: number; open_trades: number; net_points: number }[]
}

export type OptionPaperTrade = {
  date: string
  strategy: "midpoint" | "key_levels"
  side: "CALL" | "PUT" | "LONG" | "SHORT" | "CE" | "PE" | (string & {})
  level: number | null
  break_time: string
  confirm_time: string
  entry_time: string
  entry_spot: number
  entry_option_price: number
  exit_time: string | null
  exit_spot: number | null
  exit_option_price: number | null
  exit_reason: string | null
  sl_spot: number
  target_spot: number
  points: number | null
  pnl_rs: number | null
  status: "open" | "closed"
  source: string
}

export function optionPaperTradeToFill(opt: OptionPaperTrade): OptionTrade {
  const pnl = opt.pnl_rs ?? 0
  const charges = Math.round((opt.entry_option_price + (opt.exit_option_price ?? opt.entry_option_price)) * 65 * 0.0006 + 40)
  return {
    date: opt.date,
    side: opt.side,
    option: `${opt.strategy === "key_levels" ? "KL" : "MP"} · ${opt.level ? opt.level : ""}`,
    qty: 65,
    entry: opt.entry_time,
    nifty_in: opt.entry_spot,
    buy_price: opt.entry_option_price,
    buy_value_rs: opt.entry_option_price * 65,
    exit: opt.exit_time ?? "",
    nifty_out: opt.exit_spot ?? 0,
    sell_price: opt.exit_option_price ?? 0,
    sell_value_rs: (opt.exit_option_price ?? 0) * 65,
    exit_reason: opt.exit_reason ?? (opt.status === "open" ? "open" : ""),
    nifty_points: opt.points ?? 0,
    pnl_points: opt.points ?? 0,
    pnl_rs: pnl,
    sl: opt.sl_spot,
    target: opt.target_spot,
    trigger_label: opt.source || (opt.strategy === "key_levels" ? "Key Level Paper" : "Midpoint Paper"),
    charges_rs: charges,
    net_rs: pnl - charges,
    mode: "PAPER",
    spot_at_entry: opt.entry_spot,
  }
}

export type CapitalTrade = {
  date: string
  trade_num: number
  stage: string
  side: "CALL" | "PUT" | "LONG" | "SHORT" | "CE" | "PE" | (string & {})
  option: string
  entry_time: string
  entry_price: number
  sl: number
  target: number
  exit_time: string
  exit_price: number
  exit_reason: string
  pnl_points: number
  pnl_rupees: number
  futures_pnl_rupees: number
  diff_rupees: number
  max_fav: number
  max_adv: number
  rr: number
  lots: number
  qty: number
  vix_chg: number
  initial_sl: number
  charges_rupees: number
  net_rupees: number
  equity: number
  drawdown: number
}

export type CapitalDaily = {
  date: string
  trades: number
  pnl_rupees: number
  charges_rupees: number
  net_rupees: number
  pnl_points: number
  futures_pnl_rupees: number
  diff_rupees: number
  win_rate_pct: number
  net_rs: number
}

export type CapitalReport = {
  summary: {
    trades: number
    days: number
    wins: number
    losses: number
    win_rate_pct: number
    gross_rs: number
    charges_rs: number
    net_rs: number
    points: number
    avg_win_rs: number
    avg_loss_rs: number
    max_drawdown_rs: number
    winning_days: number
    futures_gross_rs: number
    futures_net_rs: number
    diff_total_rs: number
    starting_capital?: number
    ending_capital?: number
  }
  trades: CapitalTrade[]
  daily: CapitalDaily[]
  monthly: { month: string; trades: number; gross_rs: number; charges_rs: number; net_rs: number; win_rate_pct: number }[]
  exit_reasons: { reason: string; count: number; points: number; pnl_rs: number }[]
  stages: { stage: string; count: number; points: number; pnl_rs: number; win_rate_pct: number }[]
  sides: { side: string; count: number; points: number; pnl_rs: number; win_rate_pct: number }[]
  curve?: any[]
}

export type Backtest = {
  summary: {
    from: string
    to: string
    days: number
    trades: number
    wins: number
    losses: number
    win_rate_pct: number
    total_points: number
    dynamic_points?: number
    dynamic_rupees?: number
    avg_points: number
    max_drawdown: number
    best: number
    worst: number
    lot_size: number
    option_delta?: number
  }
  trades: BacktestTrade[]
  monthly: { month: string; trades: number; points: number; win_rate_pct: number }[]
  daily: { date: string; trades: number; net_rs: number; points: number }[]
  exit_reasons: { reason: string; count: number; points?: number }[]
}

export type FundsStatus = {
  ok: boolean
  broker?: "FYERS" | "KOTAK_NEO"
  error?: string
  total_balance?: number
  available_balance?: number
  used_margin?: number
  realized_pnl?: number
  unrealized_pnl?: number
  updated_at?: string
  available_equity_funds?: any
}

export type ManualOptionContract = {
  strike: number
  option_type: "CE" | "PE"
  symbol: string
  expiry: string
  token: string
  lot_size: number
  tick_size: number
}

export type ManualExpiryGroup = {
  expiry: string
  label: string
  days_to_expiry: number
  lot_size: number
  strikes: number[]
  contracts: ManualOptionContract[]
}

export type ManualOptionChoices = {
  ok: boolean
  symbol: string
  spot: number
  atm: number
  expiries: ManualExpiryGroup[]
  max_lots?: number
  error?: string
}

export type ManualOptionQuote = {
  ok: boolean
  symbol: string
  token: string
  expiry: string
  strike: number
  option_type: "CE" | "PE"
  last_price: number
  change: number
  pChange: number
  bid: number
  ask: number
  high: number
  low: number
  prev_close: number
  volume: number
  lot_size: number
  updated_at: string
  error?: string
}

export async function getJSON<T>(url: string): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("algo_auth") : null
  const headers: Record<string, string> = {}
  if (token) headers["Authorization"] = `Bearer ${token}`
  const res = await fetch(url, { cache: "no-store", headers })
  const data = await res.json()
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("algo_auth")
    }
    throw new Error(data?.error ?? `HTTP ${res.status}`)
  }
  return data as T
}

export async function postJSON<T>(url: string, body?: unknown): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("algo_auth") : null
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Dashboard": "1" }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("algo_auth")
    }
    throw new Error(data?.error ?? `HTTP ${res.status}`)
  }
  return data as T
}

/** Fetch `url` now and every `intervalMs` (0 = once). Pass null to skip. */
export function usePoll<T>(url: string | null, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const urlRef = useRef(url)
  const requestId = useRef(0)
  urlRef.current = url

  const reload = useCallback(async () => {
    const u = urlRef.current
    if (!u) return false
    const id = ++requestId.current
    try {
      const d = await getJSON<T>(u)
      if (urlRef.current === u && requestId.current === id) {
        setData(d)
        setError(null)
        return true
      }
      return false
    } catch (e) {
      if (urlRef.current === u && requestId.current === id) {
        setError(e instanceof Error ? e.message : String(e))
      }
      return false
    } finally {
      if (urlRef.current === u && requestId.current === id) setLoading(false)
    }
  }, [])

  useEffect(() => {
    requestId.current += 1
    setData(null)
    setError(null)
    setLoading(Boolean(url))
    if (!url) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const succeeded = await reload()
      if (!active || (succeeded && !intervalMs)) return
      timer = setTimeout(poll, succeeded ? intervalMs : 3000)
    }
    void poll()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      requestId.current += 1
    }
  }, [url, intervalMs, reload])

  return { data, error, loading, reload }
}

const rs = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
const num = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })

export const fmtRs = (n: number | string | null | undefined) => {
  if (n == null) return "—"
  const val = typeof n === "number" ? n : Number(n)
  return Number.isNaN(val) || !Number.isFinite(val) ? "—" : rs.format(val)
}

export const fmtPts = (n: number | string | null | undefined) => {
  if (n == null) return "—"
  const val = typeof n === "number" ? n : Number(n)
  return Number.isNaN(val) || !Number.isFinite(val) ? "—" : `${val >= 0 ? "+" : ""}${num.format(val)}`
}

export const fmtNum = (n: number | string | null | undefined) => {
  if (n == null) return "—"
  const val = typeof n === "number" ? n : Number(n)
  return Number.isNaN(val) || !Number.isFinite(val) ? "—" : num.format(val)
}

export const pnlClass = (n: number | string | null | undefined) => {
  if (n == null) return "text-muted-foreground"
  const val = typeof n === "number" ? n : Number(n)
  if (Number.isNaN(val) || val === 0) return "text-muted-foreground"
  return val > 0 ? "text-emerald-600 dark:text-emerald-400 font-semibold" : "text-rose-600 dark:text-rose-400 font-semibold"
}

export const prettyReason = (r: string) =>
  r
    .replace(/^entry_window_close$/, "No trade (range uncrossed)")
    .replace(/^target$/, "Target hit")
    .replace(/^stop$/, "Stop hit")
    .replace(/^reverse_sl$/, "Reverse SL hit")
    .replace(/^reverse_target$/, "Reverse Target hit")
    .replace(/^reverse_timeout$/, "Reverse Timeout")
    .replace(/^timeout$/, "Window timed out")
    .replace(/^kill_switch$/, "Kill switch")
    .replace(/^manual$/, "Manual exit")
    .replace(/^open$/, "Active")
    .replace(/^reverse_after_void_/, "2nd trade (after void) · ")
    .replace(/_/g, " ")

export type PaperTrade = {
  date: string
  side: "CALL" | "PUT" | "LONG" | "SHORT" | "CE" | "PE" | (string & {})
  entry_time: string
  entry_price: string
  exit_time: string
  exit_price: string
  reason: string
  points: string
  rupees_1_lot: string
}

export type KeyLevelDay = any
export type KeyLevelReport = any
export type Settings = any
export type ManualOrderResult = any
export type ManualTradingSnapshot = any

export type CompressionBox = {
  box_id: string
  timeframe: string
  start_time: string
  end_time: string
  start_dt: string
  end_dt: string
  ceiling: number
  floor: number
  midpoint: number
  range_pts: number
  duration_bars: number
  status: 'coiling' | 'breakout_up' | 'breakout_down' | 'exhausted' | (string & {})
  break_time?: string | null
  break_price?: number | null
  ceil_touches?: number
  floor_touches?: number
  touch_times?: string[]
  touch_prices?: number[]
}

export type RaiseStep = {
  time: string
  datetime: string
  price: number
  reason: string
}

export type HoldAndRaiseTrade = {
  trade_id: string
  box_id: string
  timeframe: string
  side: 'BUY' | 'SELL'
  entry_time: string
  entry_datetime: string
  entry_price: number
  initial_sl: number
  current_sl: number
  exit_time?: string | null
  exit_datetime?: string | null
  exit_price?: number | null
  exit_reason?: string | null
  pnl_points: number
  r_multiple: number
  raise_steps: RaiseStep[]
  pyramid_lots: Array<{ time: string; datetime: string; price: number; lot_num: number; note: string }>
}

export type HoldAndRaiseData = {
  date: string
  timeframe: '1m' | '5m' | '15m' | '1h'
  candles: Array<{
    time: string
    datetime: string
    open: number
    high: number
    low: number
    close: number
    volume: number
    date: string
    atr: number
  }>
  boxes: CompressionBox[]
  trades: HoldAndRaiseTrade[]
  metrics: {
    total_boxes: number
    total_trades: number
    win_trades: number
    win_rate: number
    total_points: number
    avg_points_per_trade: number
  }
}

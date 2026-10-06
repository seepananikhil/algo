import { useCallback, useEffect, useRef, useState } from "react"

export type Status = {
  now: string
  token: { valid: boolean; generated_at_utc: string | null }
  capture_running: boolean
  mode: "PAPER" | "LIVE"
  lots: number
  daily_loss_limit: number | null
  kill_switch: boolean
  last_tick: { time: string; ltp: number } | null
}

export type Candle = { time: string; open: number; high: number; low: number; close: number }

export type RuleTrade = {
  side: "CALL" | "PUT"
  entry: string
  entry_price: number
  sl: number
  target: number
  exit: string
  exit_price: number
  reason: string
  pnl_points: number
}

export type Setup = {
  so_far_high?: number
  so_far_low?: number
  range_high?: number
  range_low?: number
  mid?: number
  buffer?: number
  range_fixed_at?: string
  armed?: { side: "CALL" | "PUT"; candle: string; level: number; stop: number }
}

export type DayData = {
  date: string
  candles: Candle[]
  forming: Partial<Candle>
  setup: Setup
  trades: RuleTrade[]
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

export type OptionTrade = {
  date: string
  side: "CALL" | "PUT"
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
  pnl_rs: number
  nifty_points: number
  exit_reason: string
  mode: string
}

export type BacktestTrade = RuleTrade & { date: string; equity: number; drawdown: number }

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
    avg_points: number
    max_drawdown: number
    best: number
    worst: number
    lot_size: number
  }
  trades: BacktestTrade[]
  monthly: { month: string; points: number }[]
  daily: { date: string; points: number; trades: number }[]
  exit_reasons: { reason: string; count: number }[]
}

export type Settings = {
  lots: number
  daily_loss_limit: number
  strike_offset: number
  skip_expiry_day: boolean
  live_trading: boolean
  capture_running: boolean
  restart_required?: boolean
}

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" })
  const data = await r.json()
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`)
  return data as T
}

export async function postJSON<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    // X-Dashboard is required by the backend (blocks cross-site posts).
    headers: { "Content-Type": "application/json", "X-Dashboard": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await r.json()
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`)
  return data as T
}

/** Fetch `url` now and every `intervalMs` (0 = once). Pass null to skip. */
export function usePoll<T>(url: string | null, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const urlRef = useRef(url)
  urlRef.current = url

  const reload = useCallback(async () => {
    const u = urlRef.current
    if (!u) return
    try {
      const d = await getJSON<T>(u)
      if (urlRef.current === u) {
        setData(d)
        setError(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    reload()
    if (!url || !intervalMs) return
    const id = setInterval(reload, intervalMs)
    return () => clearInterval(id)
  }, [url, intervalMs, reload])

  return { data, error, loading, reload }
}

const rs = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
const num = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })

export const fmtRs = (v: number) => rs.format(v)
export const fmtNum = (v: number | undefined | null) => (v == null || Number.isNaN(v) ? "—" : num.format(v))
export const fmtPts = (v: number) => `${v > 0 ? "+" : ""}${num.format(v)}`
export const pnlClass = (v: number) => (v > 0 ? "text-emerald-500" : v < 0 ? "text-red-500" : "text-muted-foreground")
export const prettyReason = (r: string) =>
  r
    .replace(/^reverse_after_sl_/, "2nd trade (after loss) · ")
    .replace(/^reverse_after_void_/, "2nd trade (after void) · ")
    .replace(/_/g, " ")

export type PaperTrade = {
  date: string
  side: "CALL" | "PUT"
  entry_time: string
  entry_price: string
  exit_time: string
  exit_price: string
  exit_reason: string
  points: string
  rupees_1_lot: string
}

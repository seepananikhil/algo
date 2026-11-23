import { useEffect, useMemo, useRef, useState } from "react"
import { DayDetail } from "@/components/day-detail"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { StatCard } from "@/components/common"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { BarChart2, Calendar, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, TrendingUp } from "lucide-react"
import { toast } from "sonner"
import { fmtNum, fmtPts, pnlClass, prettyReason, usePoll, postJSON, getJSON, type Backtest } from "@/lib/api"
import { TravelCalendarPopup } from "@/components/travel-calendar-popup"

function computeInstrumentStats(tradeList: any[], lotSize: number) {
  if (!tradeList || tradeList.length === 0) {
    return {
      trades: 0, wins: 0, losses: 0, win_rate_pct: 0,
      total_points: 0, total_rupees: 0, profit_factor: 0,
      avg_points: 0, avg_rupees: 0, max_drawdown_pts: 0, max_drawdown_rs: 0,
      lot_size: lotSize
    }
  }
  const n = tradeList.length
  const wins = tradeList.filter(t => (t.pnl_points ?? 0) > 0).length
  const losses = tradeList.filter(t => (t.pnl_points ?? 0) < 0).length
  const win_rate_pct = Math.round((wins / n) * 1000) / 10
  const total_points = Math.round(tradeList.reduce((acc, t) => acc + (t.pnl_points ?? 0), 0) * 10) / 10
  const total_rupees = Math.round(tradeList.reduce((acc, t) => acc + (t.pnl_rupees ?? ((t.pnl_points ?? 0) * lotSize * 0.6)), 0))
  const winPts = tradeList.filter(t => (t.pnl_points ?? 0) > 0).reduce((acc, t) => acc + t.pnl_points, 0)
  const lossPts = Math.abs(tradeList.filter(t => (t.pnl_points ?? 0) < 0).reduce((acc, t) => acc + t.pnl_points, 0))
  const profit_factor = lossPts > 0 ? Math.round((winPts / lossPts) * 100) / 100 : 99.9
  const avg_points = Math.round((total_points / n) * 10) / 10
  const avg_rupees = Math.round(total_rupees / n)

  let eqRs = 0, peakRs = 0, maxDdRs = 0
  let eqPts = 0, peakPts = 0, maxDdPts = 0
  for (const t of tradeList) {
    const rs = t.pnl_rupees ?? ((t.pnl_points ?? 0) * lotSize * 0.6)
    eqRs += rs
    peakRs = Math.max(peakRs, eqRs)
    maxDdRs = Math.min(maxDdRs, eqRs - peakRs)

    const pts = t.pnl_points ?? 0
    eqPts += pts
    peakPts = Math.max(peakPts, eqPts)
    maxDdPts = Math.min(maxDdPts, eqPts - peakPts)
  }

  return {
    trades: n,
    wins,
    losses,
    win_rate_pct,
    total_points,
    total_rupees,
    profit_factor,
    avg_points,
    avg_rupees,
    max_drawdown_pts: Math.round(maxDdPts * 10) / 10,
    max_drawdown_rs: Math.round(maxDdRs),
    lot_size: lotSize
  }
}

/** Backtest restricted to one year ("all" = everything), with equity/drawdown restarting at 0. */
function forYear(data: Backtest, year: string, symbolFilter: "all" | "nifty" | "sensex" = "all"): Backtest {
  const safeData: Backtest = {
    ...data,
    summary: data.summary ?? {},
    trades: data?.trades ?? [],
    daily: data.daily ?? [],
    monthly: data.monthly ?? [],
    exit_reasons: data.exit_reasons ?? [],
    nifty_summary: data.nifty_summary,
    sensex_summary: data.sensex_summary,
    comparison: data.comparison,
  }

  const allTradesForYear = year === "all" ? safeData.trades : safeData.trades.filter((t) => t.date && t.date.startsWith(year))

  const nifty_trades = allTradesForYear.filter((t) => !(t.entry_price > 50000 || t.symbol === "SENSEX" || (t as any).engine?.includes("SENSEX")))
  const sensex_trades = allTradesForYear.filter((t) => t.entry_price > 50000 || t.symbol === "SENSEX" || (t as any).engine?.includes("SENSEX"))
  // When year is "all", filter Nifty to match Sensex's multi-year trading span (2023 - Present) for fair comparison
  const nifty_comparison_trades = year === "all" ? nifty_trades.filter((t) => t.date >= "2023-01-01") : nifty_trades
  const nifty_summary = computeInstrumentStats(nifty_comparison_trades, 25)
  const sensex_summary = computeInstrumentStats(sensex_trades, 10)

  const pnl_leader = nifty_summary.total_rupees >= sensex_summary.total_rupees ? "NIFTY" : "SENSEX"
  const pf_leader = nifty_summary.profit_factor >= sensex_summary.profit_factor ? "NIFTY" : "SENSEX"
  const wr_leader = nifty_summary.win_rate_pct >= sensex_summary.win_rate_pct ? "NIFTY" : "SENSEX"
  const dd_leader = Math.abs(nifty_summary.max_drawdown_rs) <= Math.abs(sensex_summary.max_drawdown_rs) ? "NIFTY" : "SENSEX"
  const pnl_diff_rupees = Math.abs(nifty_summary.total_rupees - sensex_summary.total_rupees)

  const comparison = {
    period: year === "all" ? "All Time" : `Year ${year}`,
    nifty: nifty_summary,
    sensex: sensex_summary,
    pnl_leader,
    pf_leader,
    wr_leader,
    dd_leader,
    pnl_diff_rupees,
    overall_winner: pnl_leader
  }

  const activeTrades = symbolFilter === "nifty"
    ? nifty_trades
    : symbolFilter === "sensex"
    ? sensex_trades
    : allTradesForYear

  let equity = 0
  let peak = 0
  const trades = activeTrades.map((t) => {
    equity += t.pnl_points
    peak = Math.max(peak, equity)
    return { ...t, equity, drawdown: equity - peak }
  })

  // Recompute daily aggregated for the filtered view
  const dailyMap = new Map<string, { date: string; trades: number; net_rs: number; points: number }>()
  trades.forEach((t) => {
    const d = dailyMap.get(t.date) ?? { date: t.date, trades: 0, net_rs: 0, points: 0 }
    d.trades += 1
    d.points = Math.round((d.points + t.pnl_points) * 100) / 100
    d.net_rs += (t.pnl_rupees ?? 0)
    dailyMap.set(t.date, d)
  })
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date))

  // Recompute monthly aggregated for the filtered view
  const monthlyMap = new Map<string, { month: string; trades: number; points: number; win_rate_pct: number }>()
  trades.forEach((t) => {
    const m = t.date.slice(0, 7)
    const cur = monthlyMap.get(m) ?? { month: m, trades: 0, points: 0, win_rate_pct: 0 }
    cur.trades += 1
    cur.points = Math.round((cur.points + t.pnl_points) * 100) / 100
    monthlyMap.set(m, cur)
  })
  const monthly = [...monthlyMap.values()].sort((a, b) => a.month.localeCompare(b.month))

  const reasons = new Map<string, number>()
  trades.forEach((t) => reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1))

  const pts = trades.map((t) => t.pnl_points)
  const wins = pts.filter((p) => p > 0)
  const losses = pts.filter((p) => p < 0)

  return {
    ...safeData,
    summary: {
      ...safeData.summary,
      trades: trades.length,
      days: daily.length,
      wins: wins.length,
      losses: losses.length,
      win_rate_pct: trades.length ? Math.round((wins.length / trades.length) * 1000) / 10 : 0,
      base_points: Math.round(pts.reduce((a, b) => a + b, 0) * 10) / 10,
      total_points: Math.round(pts.reduce((a, b) => a + b, 0) * 10) / 10,
      max_drawdown: trades.length ? Math.round(Math.min(...trades.map((t) => t.drawdown)) * 10) / 10 : 0,
      avg_points: trades.length ? Math.round((pts.reduce((a, b) => a + b, 0) / trades.length) * 10) / 10 : 0,
      best: pts.length ? Math.max(...pts) : 0,
      worst: pts.length ? Math.min(...pts) : 0,
    },
    trades,
    daily,
    monthly,
    exit_reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    nifty_summary,
    sensex_summary,
    comparison,
  }
}

const axis = { stroke: "var(--muted-foreground)", fontSize: 11, tickLine: false, axisLine: false }
const tooltip = {
  contentStyle: { background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "var(--muted-foreground)" },
}

function getStrategyDisplayName(t: any, defaultStrategy: string): string {
  if (t.strategy_label && t.strategy_label.trim()) return t.strategy_label
  const engine = (t.engine || "").toUpperCase()
  if (engine.includes("TREND") || defaultStrategy === "trend_runner") return "Trend Runner"
  if (engine.includes("APEX") || engine.includes("MASTER") || defaultStrategy === "master_portfolio") return "Master Portfolio"
  if (engine.includes("SCALP") || defaultStrategy === "the_scalper") return "The Scalper"
  if (engine.includes("VIX") || defaultStrategy === "vix_trap") return "VIX Trap"
  if (engine.includes("PIVOT") || defaultStrategy === "pivot_runner") return "Pivot Runner"
  return "Algo Strategy"
}


function getExitReasonBadge(reason: string) {
  const r = (reason || "").toUpperCase()
  if (r.includes("EMA20") || r.includes("EMA")) {
    return {
      label: "5m 20-EMA Trail",
      className: "bg-indigo-500/15 text-indigo-400 border border-indigo-500/20",
    }
  }
  if (r.includes("EOD") || r.includes("1515")) {
    return {
      label: "EOD Runner (15:15)",
      className: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20",
    }
  }
  if (r.includes("CATASTROPHIC")) {
    return {
      label: "Hard SL Hit",
      className: "bg-rose-500/15 text-rose-400 border border-rose-500/20",
    }
  }
  if (r === "TARGET") {
    return {
      label: "Target Achieved",
      className: "bg-emerald-500/15 text-emerald-400",
    }
  }
  if (r === "STOP_LOSS") {
    return {
      label: "Stop Loss Hit",
      className: "bg-rose-500/15 text-rose-400",
    }
  }
  if (r.includes("RATCHET")) {
    return {
      label: "Ratchet Lock (+80pt)",
      className: "bg-sky-500/15 text-sky-400",
    }
  }
  if (r.includes("TRAILING")) {
    return {
      label: "Trailing SL Protected",
      className: "bg-amber-500/15 text-amber-400",
    }
  }
  if (r.includes("TIME")) {
    return {
      label: "EOD Squareoff",
      className: "bg-muted text-muted-foreground",
    }
  }
  return {
    label: prettyReason(reason),
    className: "bg-muted/70 text-muted-foreground",
  }
}

type MainStrategy = "master_portfolio" | "trend_runner" | "vix_trap" | "the_scalper" | "pivot_runner"
type AnalyticsView = "stats" | "terminal"

export function BacktestPage() {
  const [mainStrategy, setMainStrategy] = useState<MainStrategy>(() => {
    const saved = localStorage.getItem("backtest_main_strategy") as MainStrategy
    if (saved === "master_portfolio" || saved === "trend_runner" || saved === "vix_trap" || saved === "the_scalper") return saved
    return "master_portfolio"
  })

  const [analyticsView, setAnalyticsView] = useState<AnalyticsView>(() => {
    const saved = localStorage.getItem("backtest_analytics_view") as AnalyticsView
    if (saved === "stats" || saved === "terminal") return saved
    return "stats"
  })
  const [sessionSymbol, setSessionSymbol] = useState<"NIFTY" | "SENSEX" | null>(null)
  const [sessionInstrumentTab, setSessionInstrumentTab] = useState<"ALL" | "NIFTY" | "SENSEX">("ALL")
  const [selectedTradeIndex, setSelectedTradeIndex] = useState<number>(0)
  const [calendarModalOpen, setCalendarModalOpen] = useState(false)
  const calendarTriggerRef = useRef<HTMLButtonElement>(null)

  const apiUrl = useMemo(() => {
    if (mainStrategy === "master_portfolio") {
      return "/api/backtest?strategy=master_portfolio_all"
    } else if (mainStrategy === "trend_runner") {
      return "/api/backtest?strategy=trend_runner_all"
    } else if (mainStrategy === "the_scalper") {
      return "/api/backtest?strategy=the_scalper_all"
    } else if (mainStrategy === "pivot_runner") {
      return "/api/backtest?strategy=pivot_runner"
    } else {
      return "/api/backtest?strategy=vix_trap_all"
    }
  }, [mainStrategy])

  const { data: raw, loading, error, reload } = usePoll<Backtest>(apiUrl, 0)
  const [isSyncing, setIsSyncing] = useState(false)

  const handleSyncBacktest = async () => {
    try {
      setIsSyncing(true)
      toast.info("Triggering background historical backtest update...")
      const data = await postJSON<{ ok?: boolean; running?: boolean; message?: string }>("/api/backtest/sync", {})
      toast.success(data.message || "Update started. Syncing...")
      const pollTimer = setInterval(async () => {
        try {
          const s = await getJSON<{ status?: string; running?: boolean; success?: boolean; message?: string }>("/api/backtest/sync/status")
          if (!s.running && s.status !== "running") {
            clearInterval(pollTimer)
            setIsSyncing(false)
            if (s.success || s.status === "completed") {
              toast.success("Master backtests successfully regenerated!")
              reload()
            } else {
              toast.error(s.message || "Backtest update failed")
            }
          }
        } catch {
          // ignore transient poll errors
        }
      }, 3000)
    } catch (err: any) {
      setIsSyncing(false)
      toast.error(err?.message || "Failed to trigger backtest update")
    }
  }

  const [yearPick, setYear] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)

  const years = useMemo(() => [...new Set((raw?.trades ?? []).map((t) => t.date.slice(0, 4)))].sort(), [raw])
  const year = yearPick ?? "all"
  const data = useMemo(() => (raw ? forYear(raw, year, "all") : null), [raw, year])
  const availableDays = useMemo(() => (data?.daily ?? []).map((d) => d.date).sort(), [data?.daily])

  // Auto-select the latest available trading day by default
  useEffect(() => {
    if (!picked && availableDays.length > 0) {
      setPicked(availableDays[availableDays.length - 1])
    }
  }, [availableDays, picked])

  const pickedDateObj = useMemo(() => {
    if (!picked) return null
    const [y, m, d] = picked.split("-").map(Number)
    return new Date(y, m - 1, d)
  }, [picked])

  const pickedFormattedDate = useMemo(() => {
    if (!pickedDateObj || !picked) return "Select Date"
    const weekday = pickedDateObj.toLocaleString("en-US", { weekday: "short" })
    const month = pickedDateObj.toLocaleString("en-US", { month: "short" })
    const day = pickedDateObj.getDate()
    const yr = pickedDateObj.getFullYear()
    return `${day} ${month} ${yr} (${weekday})`
  }, [pickedDateObj, picked])

  const handleSelectDate = (date: string) => {
    const dYear = date.slice(0, 4)
    if (yearPick && yearPick !== dYear) {
      setYear(dYear)
    }
    setPicked(date)
    setSessionInstrumentTab("ALL")
    setSessionSymbol(null)
    setSelectedTradeIndex(0)
    setAnalyticsView("terminal")
    localStorage.setItem("backtest_analytics_view", "terminal")
  }

  const handleMonthClick = (month: string) => {
    const matching = availableDays.filter((d) => d.startsWith(month))
    if (matching.length > 0) {
      const targetDay = matching[matching.length - 1]
      handleSelectDate(targetDay)
      toast.info(`Switched to ${month} session: ${targetDay}`)
    } else {
      toast.error(`No trading sessions found for ${month}`)
    }
  }

  const curIdx = picked ? availableDays.indexOf(picked) : -1
  const prevDay = curIdx > 0 ? availableDays[curIdx - 1] : null
  const nextDay = curIdx >= 0 && curIdx < availableDays.length - 1 ? availableDays[curIdx + 1] : null

  // Keyboard navigation for historical day browsing (Left / Right Arrow)
  useEffect(() => {
    if (availableDays.length === 0) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const idx = picked ? availableDays.indexOf(picked) : availableDays.length - 1
      if (e.key === "ArrowLeft" && idx > 0) {
        e.preventDefault()
        handleSelectDate(availableDays[idx - 1])
      } else if (e.key === "ArrowRight" && idx >= 0 && idx < availableDays.length - 1) {
        e.preventDefault()
        handleSelectDate(availableDays[idx + 1])
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [picked, availableDays])

  const pickedTrades = useMemo(() => {
    if (!picked || !data?.trades) return []
    return data.trades.filter((t) => t.date === picked)
  }, [data?.trades, picked])

  const filteredPickedTrades = useMemo(() => {
    if (sessionInstrumentTab === "ALL") return pickedTrades
    if (sessionInstrumentTab === "NIFTY") {
      return pickedTrades.filter((t) => !(t.entry_price > 50000 || t.symbol === "SENSEX" || (t as any).engine?.includes("SENSEX")))
    }
    return pickedTrades.filter((t) => t.entry_price > 50000 || t.symbol === "SENSEX" || (t as any).engine?.includes("SENSEX"))
  }, [pickedTrades, sessionInstrumentTab])

  const niftyTradesCount = useMemo(() => {
    return pickedTrades.filter((t) => !(t.entry_price > 50000 || t.symbol === "SENSEX" || (t as any).engine?.includes("SENSEX"))).length
  }, [pickedTrades])

  const sensexTradesCount = useMemo(() => {
    return pickedTrades.filter((t) => t.entry_price > 50000 || t.symbol === "SENSEX" || (t as any).engine?.includes("SENSEX")).length
  }, [pickedTrades])

  const activeChartSymbol: "NIFTY" | "SENSEX" = useMemo(() => {
    if (sessionSymbol) return sessionSymbol
    if (sessionInstrumentTab === "NIFTY") return "NIFTY"
    if (sessionInstrumentTab === "SENSEX") return "SENSEX"
    if (pickedTrades.length > 0) {
      const active = pickedTrades[selectedTradeIndex] || pickedTrades[0]
      return active.entry_price > 50000 || (active as any).symbol === "SENSEX" || (active as any).engine?.includes("SENSEX") ? "SENSEX" : "NIFTY"
    }
    return "NIFTY"
  }, [sessionSymbol, sessionInstrumentTab, pickedTrades, selectedTradeIndex])

  const activeTrade = useMemo(() => {
    return pickedTrades[selectedTradeIndex] || pickedTrades[0] || null
  }, [pickedTrades, selectedTradeIndex])

  const chartStrategy = useMemo(() => {
    if (mainStrategy === "master_portfolio") {
      return activeChartSymbol === "SENSEX" ? "master_portfolio_sensex" : "master_portfolio_nifty"
    } else if (mainStrategy === "trend_runner") {
      return activeChartSymbol === "SENSEX" ? "sensex_runner" : "trend_runner"
    } else if (mainStrategy === "the_scalper") {
      return activeChartSymbol === "SENSEX" ? "the_scalper_sensex" : "the_scalper_nifty"
    } else if (mainStrategy === "pivot_runner") {
      return activeChartSymbol === "SENSEX" ? "pivot_runner_sensex" : "pivot_runner_nifty"
    } else {
      return activeChartSymbol === "SENSEX" ? "sensex_vix_divergence" : "vix_divergence"
    }
  }, [mainStrategy, activeChartSymbol])

  const sessionNetPts = useMemo(() => {
    return filteredPickedTrades.reduce((acc, t) => acc + (t.pnl_points ?? 0), 0)
  }, [filteredPickedTrades])

  const s: any = data?.summary ?? {}
  const curve = useMemo(() => {
    if (!data?.trades) return []
    return [{ label: "start", equity: 0, drawdown: 0 }, ...data?.trades.map((t) => ({ label: `${t.date} ${t.entry}`, equity: t.equity, drawdown: t.drawdown }))]
  }, [data?.trades])

  // Profit factor calculation
  const profitFactor = useMemo(() => {
    if (!data?.trades || data.trades.length === 0) return 0
    const winPts = data.trades.filter(t => t.pnl_points > 0).reduce((acc, t) => acc + t.pnl_points, 0)
    const lossPts = Math.abs(data.trades.filter(t => t.pnl_points < 0).reduce((acc, t) => acc + t.pnl_points, 0))
    return lossPts > 0 ? Math.round((winPts / lossPts) * 100) / 100 : 99.9
  }, [data?.trades])

  const reversedMonthly = useMemo(() => {
    return [...(data?.monthly ?? [])].reverse()
  }, [data?.monthly])

  const renderTradesListCard = () => (
    <div className="h-full rounded-xl border border-border/60 shadow-xs flex flex-col overflow-hidden bg-card/95">
      {/* Header: Instrument Filter Tabs + Session Net P&L */}
      <div className="p-1.5 px-2.5 border-b border-border/40 bg-muted/20 flex items-center justify-between gap-1.5 shrink-0">
        <div className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => {
              setSessionInstrumentTab("ALL")
              setSessionSymbol(null)
            }}
            className={cn(
              "rounded px-2.5 py-0.5 text-[11px] font-bold transition-colors cursor-pointer",
              sessionInstrumentTab === "ALL" ? "bg-background text-foreground shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
            )}
          >
            All ({pickedTrades.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setSessionInstrumentTab("NIFTY")
              setSessionSymbol("NIFTY")
            }}
            className={cn(
              "rounded px-2.5 py-0.5 text-[11px] font-bold transition-colors cursor-pointer",
              sessionInstrumentTab === "NIFTY" ? "bg-background text-foreground shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
            )}
          >
            Nifty ({niftyTradesCount})
          </button>
          <button
            type="button"
            onClick={() => {
              setSessionInstrumentTab("SENSEX")
              setSessionSymbol("SENSEX")
            }}
            className={cn(
              "rounded px-2.5 py-0.5 text-[11px] font-bold transition-colors cursor-pointer",
              sessionInstrumentTab === "SENSEX" ? "bg-background text-foreground shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
            )}
          >
            Sensex ({sensexTradesCount})
          </button>
        </div>

        <div className="text-right shrink-0 flex items-center gap-1">
          <span className="text-[9px] text-muted-foreground font-mono">Net:</span>
          <span className={cn("text-[11px] font-black font-mono tabular-nums px-1.5 py-0.2 rounded", sessionNetPts >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400")}>
            {fmtPts(sessionNetPts)}
          </span>
        </div>
      </div>

      {/* Scrollable Trades List */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-2 flex flex-col gap-2">
        {filteredPickedTrades.length > 0 ? (
          filteredPickedTrades.map((t, idx) => {
            const realIdx = pickedTrades.indexOf(t)
            const isSelected = selectedTradeIndex === (realIdx >= 0 ? realIdx : idx)
            const isSensex = t.entry_price > 50000 || t.symbol === "SENSEX" || (t as any).engine?.includes("SENSEX")
            const pts = t.pnl_points
            const isWin = pts > 0
            const isLoss = pts < 0
            const isBullish = t.side === "CALL" || t.side === "LONG" || t.side === "CE" || t.side === "BUY"
            const stratName = getStrategyDisplayName(t, mainStrategy)
            const slDist = t.sl != null && !Number.isNaN(t.sl) && t.sl > 0 ? Math.abs(t.entry_price - t.sl) : null
            const rMultiple = slDist && slDist > 0 ? pts / slDist : null
            const exitBadge = getExitReasonBadge(t.reason)

            return (
              <div
                key={`${t.date}-${t.entry}-${idx}`}
                onClick={() => {
                  setSelectedTradeIndex(realIdx >= 0 ? realIdx : idx)
                  setSessionSymbol(isSensex ? "SENSEX" : "NIFTY")
                }}
                className={cn(
                  "group p-2.5 rounded-lg text-xs cursor-pointer transition-all duration-150 flex flex-col gap-1.5",
                  isSelected
                    ? isWin
                      ? "bg-emerald-500/10 border border-emerald-500/40"
                      : isLoss
                      ? "bg-rose-500/10 border border-rose-500/40"
                      : "bg-muted/60 border border-border"
                    : isWin
                    ? "bg-emerald-500/[0.03] hover:bg-emerald-500/[0.06] border border-emerald-500/15 hover:border-emerald-500/30"
                    : isLoss
                    ? "bg-rose-500/[0.03] hover:bg-rose-500/[0.06] border border-rose-500/15 hover:border-rose-500/30"
                    : "bg-card hover:bg-muted/30 border border-border/40"
                )}
              >
                {/* Row 1: Direction Badge, Symbol, Time Range & Points */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                    <span
                      className={cn(
                        "px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider text-white shrink-0",
                        isBullish ? "bg-emerald-600" : "bg-rose-600"
                      )}
                    >
                      {isBullish ? "CALL" : "PUT"}
                    </span>
                    <span
                      className={cn(
                        "px-1.5 py-0.5 rounded text-[10.5px] font-mono font-semibold shrink-0",
                        isSensex
                          ? "bg-amber-500/15 text-amber-400"
                          : "bg-primary/15 text-primary"
                      )}
                    >
                      {isSensex ? "SENSEX" : "NIFTY"}
                    </span>
                    <span className="font-mono text-xs font-semibold text-foreground/90 shrink-0">
                      {t.entry} → {t.exit || "Open"}
                    </span>
                    {t.bars_held != null && t.bars_held > 0 && (
                      <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                        ({t.bars_held}m)
                      </span>
                    )}
                  </div>

                  {/* Profit Points (No currency translation in backtest) */}
                  <div className="text-right shrink-0 flex items-center font-mono">
                    <span
                      className={cn(
                        "text-sm font-black tabular-nums",
                        isWin ? "text-emerald-400" : isLoss ? "text-rose-400" : "text-muted-foreground"
                      )}
                    >
                      {fmtPts(pts)}
                    </span>
                  </div>
                </div>

                {/* Row 2: Strategy Tag, Spot Price Trail, Exit Reason Badge & R-Multiple */}
                <div className="flex items-center justify-between gap-1.5 text-[11px] flex-wrap">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-semibold text-foreground/90 truncate max-w-[130px]" title={stratName}>
                      {stratName}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/75 truncate">
                      · {fmtNum(Math.round(t.entry_price))} → {fmtNum(Math.round(t.exit_price))}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={cn("px-2 py-0.5 rounded text-[10px] font-medium", exitBadge.className)}>
                      {exitBadge.label}
                    </span>
                    {rMultiple != null && (
                      <span
                        className={cn(
                          "text-[9.5px] font-bold font-mono px-1.5 py-0.5 rounded shrink-0",
                          rMultiple >= 0
                            ? "bg-emerald-500/15 text-emerald-400"
                            : "bg-rose-500/15 text-rose-400"
                        )}
                      >
                        {rMultiple >= 0 ? `+${rMultiple.toFixed(1)}R` : `${rMultiple.toFixed(1)}R`}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-muted-foreground">
            <Calendar className="h-7 w-7 text-muted-foreground/40 mb-1.5" />
            <p className="text-xs font-semibold text-foreground">No trades executed</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">No breakout or confluence triggered on {picked}.</p>
          </div>
        )}
      </div>
    </div>
  )

  const renderDateSelector = () => (
    <div className="relative flex items-center gap-1 shrink-0">
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={!prevDay}
        onClick={() => prevDay && handleSelectDate(prevDay)}
        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30"
        title={prevDay ? `Previous session: ${prevDay}` : "No earlier session"}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>

      <button
        ref={calendarTriggerRef}
        type="button"
        onClick={() => setCalendarModalOpen((v) => !v)}
        className="group inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md border border-border/70 bg-background/90 hover:bg-muted/80 text-xs font-semibold shadow-2xs transition-all cursor-pointer ring-1 ring-border/40 hover:ring-primary/40"
        title="Click to open calendar popup"
      >
        <Calendar className="size-3 text-primary shrink-0" />
        <span className="font-mono text-[11px] font-bold text-foreground">
          {pickedFormattedDate}
        </span>
        <ChevronDown className="size-3 text-muted-foreground group-hover:text-foreground transition-transform" />
      </button>

      <Button
        variant="ghost"
        size="icon-xs"
        disabled={!nextDay}
        onClick={() => nextDay && handleSelectDate(nextDay)}
        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30"
        title={nextDay ? `Next session: ${nextDay}` : "No later session"}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>

      <TravelCalendarPopup
        open={calendarModalOpen}
        onClose={() => setCalendarModalOpen(false)}
        daily={(raw?.daily ?? []).map((d) => ({ ...d, value: d.points }))}
        selectedDate={picked}
        onSelectDate={(newDate) => {
          handleSelectDate(newDate)
          setCalendarModalOpen(false)
        }}
        format={fmtPts}
        triggerRef={calendarTriggerRef}
      />
    </div>
  )

  return (
    <div className="w-full h-full min-h-0 flex-1 flex flex-col gap-2 p-2 overflow-hidden select-none">
      {/* 1. TOP COMMAND BAR: STRATEGY + STICKY YEAR & CALENDAR + VIEW TABS */}
      <div className="relative z-40 flex items-center justify-between gap-2 p-1.5 px-2.5 rounded-xl border border-border/60 bg-card/90 shadow-2xs backdrop-blur-md shrink-0 flex-wrap sm:flex-nowrap">
        {/* Left Side: Strategy Switcher */}
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {/* Strategy Switcher: Clean, calm segmented control */}
          <div className="flex items-center p-0.5 bg-muted/40 rounded-lg border border-border/40">
            {[
              { id: "master_portfolio", label: "Apex Duo (Trend + Trap)" },
              { id: "trend_runner", label: "Trend Runner" },
              { id: "vix_trap", label: "VIX Trap" },
              { id: "the_scalper", label: "The Scalper" },
            ].map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setMainStrategy(s.id as MainStrategy)
                  localStorage.setItem("backtest_main_strategy", s.id)
                  setSessionInstrumentTab("ALL")
                  setSessionSymbol(null)
                }}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded transition-all cursor-pointer",
                  mainStrategy === s.id
                    ? "bg-background text-foreground shadow-2xs font-bold"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Right Side: Sticky Year Selector + Calendar Date Navigator + View Tabs + Sync */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Sticky Year Selector Dropdown */}
          <div className="flex items-center gap-1 bg-muted/40 p-0.5 rounded-lg border border-border/40">
            <span className="text-[10px] font-bold text-muted-foreground uppercase px-1.5 select-none">Year:</span>
            <select
              value={yearPick ?? "all"}
              onChange={(e) => {
                const val = e.target.value === "all" ? null : e.target.value
                setYear(val)
              }}
              className="h-7 px-2 text-xs font-mono font-bold rounded-md bg-background border border-border/70 text-foreground cursor-pointer focus:outline-hidden focus:ring-1 focus:ring-primary shadow-2xs"
            >
              <option value="all">All ({years.length > 0 ? `${years[0]}–${years[years.length - 1]}` : "10Y"})</option>
              {years.slice().reverse().map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>

          <div className="h-4 w-px bg-border/60" />

          {/* Sticky Session Date Navigator with Calendar Popup */}
          {renderDateSelector()}

          <div className="h-4 w-px bg-border/60" />

          {/* View Tabs */}
          <div className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => {
                setAnalyticsView("stats")
                localStorage.setItem("backtest_analytics_view", "stats")
              }}
              className={cn(
                "rounded px-3 py-1 text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5",
                analyticsView === "stats"
                  ? "bg-background text-foreground shadow-2xs font-bold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <BarChart2 className="size-3.5 text-emerald-400" />
              <span>Stats &amp; Payoff</span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (!picked && availableDays.length > 0) {
                  setPicked(availableDays[availableDays.length - 1])
                }
                setAnalyticsView("terminal")
                localStorage.setItem("backtest_analytics_view", "terminal")
              }}
              className={cn(
                "rounded px-3 py-1 text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5",
                analyticsView === "terminal"
                  ? "bg-background text-foreground shadow-2xs font-bold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span>🕯️</span>
              <span>Chart &amp; Trades</span>
            </button>
          </div>

          <div className="h-4 w-px bg-border/60" />

          {/* Sync Button */}
          <button
            onClick={handleSyncBacktest}
            disabled={isSyncing}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-lg border transition-all cursor-pointer shadow-2xs",
              isSyncing
                ? "bg-muted/60 text-muted-foreground border-border cursor-not-allowed opacity-70"
                : "bg-muted/40 hover:bg-muted text-foreground border-border"
            )}
            title="Sync latest historical backtests"
          >
            <RefreshCw className={cn("size-3", isSyncing && "animate-spin text-primary")} />
            <span className="hidden sm:inline">{isSyncing ? "Syncing..." : "Sync"}</span>
          </button>
        </div>
      </div>

      {/* 2. MAIN RESPONSIVE VIEWPORT (ZERO WINDOW SCROLL) */}
      {error ? (
        <div className="p-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
          Backtest failed: {error}
        </div>
      ) : !data && loading ? (
        <div className="flex-1 flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 shrink-0">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
          <Skeleton className="flex-1 w-full rounded-xl" />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col gap-3">
          {/* TAB 1: STATS & PAYOFF CURVE (DEFAULT VIEW) */}
          {analyticsView === "stats" && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-3 animate-in fade-in duration-150">
              {/* Dual Instrument Cards: NIFTY & SENSEX Overall PnL Points */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 shrink-0">
                {/* NIFTY CARD */}
                <div className="p-3.5 rounded-xl border border-sky-500/25 bg-gradient-to-br from-card via-card/90 to-sky-950/10 shadow-xs flex flex-col justify-between relative overflow-hidden group">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-sky-500/5 rounded-full blur-2xl pointer-events-none" />
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-sky-500 shrink-0" />
                      <span className="text-xs font-bold text-foreground tracking-wide uppercase">
                        NIFTY 50 • Total P&L {year === "all" && <span className="text-[10px] text-muted-foreground font-normal">(2023–Present)</span>}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-sky-500/10 text-sky-400 font-mono font-medium">Lot 25</span>
                    </div>
                    <span className="text-[11px] font-mono text-muted-foreground">{data?.nifty_summary?.trades ?? 0} Trades</span>
                  </div>
                  <div className="flex items-baseline justify-between mt-1">
                    <div className="flex items-baseline gap-2">
                      <span className={cn("text-2xl lg:text-3xl font-extrabold font-mono tracking-tight", pnlClass(data?.nifty_summary?.total_points))}>
                        {fmtPts(data?.nifty_summary?.total_points)}
                      </span>
                      <span className="text-xs font-semibold text-muted-foreground">pts</span>
                    </div>
                    <div className="text-right">
                      <div className={cn("text-base font-bold font-mono", pnlClass(data?.nifty_summary?.total_rupees))}>
                        ₹{fmtNum(data?.nifty_summary?.total_rupees ?? 0)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono mt-3 pt-2.5 border-t border-border/40">
                    <span>Win Rate: <strong className="text-foreground">{data?.nifty_summary?.win_rate_pct ?? 0}%</strong> ({data?.nifty_summary?.wins ?? 0}W · {data?.nifty_summary?.losses ?? 0}L)</span>
                    <span>Edge: <strong className="text-emerald-400">{data?.nifty_summary?.profit_factor ?? 0}x</strong></span>
                    <span>Max DD: <strong className="text-red-400">{fmtPts(data?.nifty_summary?.max_drawdown_pts)}</strong></span>
                  </div>
                </div>

                {/* SENSEX CARD */}
                <div className="p-3.5 rounded-xl border border-amber-500/25 bg-gradient-to-br from-card via-card/90 to-amber-950/10 shadow-xs flex flex-col justify-between relative overflow-hidden group">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 rounded-full blur-2xl pointer-events-none" />
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-amber-500 shrink-0" />
                      <span className="text-xs font-bold text-foreground tracking-wide uppercase">SENSEX • Total P&L</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-amber-500/10 text-amber-400 font-mono font-medium">Lot 10</span>
                    </div>
                    <span className="text-[11px] font-mono text-muted-foreground">{data?.sensex_summary?.trades ?? 0} Trades</span>
                  </div>
                  <div className="flex items-baseline justify-between mt-1">
                    <div className="flex items-baseline gap-2">
                      <span className={cn("text-2xl lg:text-3xl font-extrabold font-mono tracking-tight", pnlClass(data?.sensex_summary?.total_points))}>
                        {fmtPts(data?.sensex_summary?.total_points)}
                      </span>
                      <span className="text-xs font-semibold text-muted-foreground">pts</span>
                    </div>
                    <div className="text-right">
                      <div className={cn("text-base font-bold font-mono", pnlClass(data?.sensex_summary?.total_rupees))}>
                        ₹{fmtNum(data?.sensex_summary?.total_rupees ?? 0)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono mt-3 pt-2.5 border-t border-border/40">
                    <span>Win Rate: <strong className="text-foreground">{data?.sensex_summary?.win_rate_pct ?? 0}%</strong> ({data?.sensex_summary?.wins ?? 0}W · {data?.sensex_summary?.losses ?? 0}L)</span>
                    <span>Edge: <strong className="text-emerald-400">{data?.sensex_summary?.profit_factor ?? 0}x</strong></span>
                    <span>Max DD: <strong className="text-red-400">{fmtPts(data?.sensex_summary?.max_drawdown_pts)}</strong></span>
                  </div>
                </div>
              </div>

              {/* Top Row: 6 KPI Stat Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 shrink-0">
                <StatCard
                  label="Net P&L"
                  value={fmtPts(s.base_points ?? s.total_points)}
                  className={pnlClass(s.base_points ?? s.total_points)}
                  hint="Cumulative pts"
                />
                <StatCard
                  label="Total Trades"
                  value={s.trades || 0}
                  hint={
                    <span className="font-medium text-xs">
                      <span className="text-emerald-500">{s.wins || 0}W</span> · <span className="text-red-500">{s.losses || 0}L</span>
                    </span>
                  }
                />
                <StatCard
                  label="Win Rate"
                  value={`${s.win_rate_pct ?? 0}%`}
                  hint={`Edge Factor: ${profitFactor}x`}
                  className={s.win_rate_pct >= 50 ? "text-emerald-500" : "text-foreground"}
                />
                <StatCard
                  label="Avg / Session"
                  value={fmtPts(s.avg_points)}
                  className={pnlClass(s.avg_points)}
                  hint="Expectancy per day"
                />
                <StatCard
                  label="Max Drawdown"
                  value={fmtPts(s.max_drawdown)}
                  className="text-red-500"
                  hint="Peak to trough"
                />
                <StatCard
                  label="Best / Worst Day"
                  value={
                    <div className="flex items-baseline gap-1 text-base font-mono">
                      <span className="text-emerald-500">{fmtPts(s.best)}</span>
                      <span className="text-muted-foreground text-xs">/</span>
                      <span className="text-red-500">{fmtPts(s.worst)}</span>
                    </div>
                  }
                  hint="Max Extremes"
                />
              </div>

              {/* Charts Row: Cumulative Payoff & Drawdown Curve (Left) + Monthly P&L Distribution (Right) Side-by-Side */}
              <div className="min-h-[360px] lg:h-[400px] flex flex-col lg:flex-row gap-2.5">
                {/* Left: Cumulative Payoff & Drawdown Curve */}
                <Card className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden border border-border/60 shadow-xs bg-card/90">
                  <div className="p-2 sm:px-3 border-b border-border/40 flex items-center justify-between shrink-0 bg-muted/15">
                    <div className="flex items-center gap-2 min-w-0">
                      <TrendingUp className="size-4 text-emerald-400 shrink-0" />
                      <h2 className="text-xs font-bold text-foreground truncate">Cumulative Payoff &amp; Drawdown Curve</h2>
                      <span className="text-[11px] text-muted-foreground font-mono shrink-0">({s.trades || 0} trades across {s.days || 0} days)</span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] font-mono shrink-0">
                      <span className="flex items-center gap-1.5"><span className="w-2.5 h-1 bg-emerald-500 rounded-xs" /> Peak: <span className="text-emerald-400 font-bold">{fmtPts(s.base_points ?? s.total_points)}</span></span>
                      <span className="flex items-center gap-1.5"><span className="w-2.5 h-1 bg-red-500 rounded-xs" /> Max DD: <span className="text-red-400 font-bold">{fmtNum(s.max_drawdown)}</span></span>
                    </div>
                  </div>

                  <div className="flex-1 min-h-0 p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={curve} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                            <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                          </linearGradient>
                          <linearGradient id="dd" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#ef4444" stopOpacity={0.0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} opacity={0.6} />
                        <XAxis dataKey="label" hide />
                        <YAxis {...axis} tickFormatter={(v) => `${v}`} />
                        <Tooltip {...tooltip} formatter={(v: any, name: any) => [`${fmtPts(Number(v))}`, name === "equity" ? "Equity" : "Drawdown"]} />
                        <Area type="monotone" dataKey="equity" stroke="#10b981" strokeWidth={2} fill="url(#eq)" />
                        <Area type="monotone" dataKey="drawdown" stroke="#ef4444" strokeWidth={1} fill="url(#dd)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </Card>

                {/* Right: Clickable Horizontally-Scrollable Monthly Distribution Bar Chart */}
                <Card className="w-full lg:w-[460px] xl:w-[520px] shrink-0 min-h-0 flex flex-col overflow-hidden border border-border/60 shadow-xs bg-card/90">
                  <CardHeader className="p-2 sm:px-3 border-b border-border/40 flex flex-row items-center justify-between shrink-0 bg-muted/15">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <BarChart2 className="size-3.5 text-sky-400 shrink-0" />
                      <h3 className="text-xs font-bold text-foreground truncate">Monthly P&amp;L Distribution</h3>
                      {data?.monthly && data.monthly.length > 0 && (
                        <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                          (<span className="text-emerald-500 font-bold">{data.monthly.filter((m: any) => m.points > 0).length}</span>/{data.monthly.length})
                        </span>
                      )}
                    </div>
                    <span className="text-[9.5px] font-mono text-primary flex items-center gap-1 cursor-default shrink-0">
                      <span>💡</span>
                      <span>Click bar to view</span>
                    </span>
                  </CardHeader>
                  <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden p-1.5 sm:px-2 scrollbar-thin">
                    <div style={{ minWidth: "100%", width: `${Math.max(100, (data?.monthly?.length || 0) * 44)}px`, height: "100%" }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={reversedMonthly} margin={{ top: 6, right: 10, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} opacity={0.5} />
                          <XAxis dataKey="month" {...axis} />
                          <YAxis {...axis} tickFormatter={(v) => `${v}`} />
                          <Tooltip
                            {...tooltip}
                            formatter={(v: any) => [`${fmtPts(Number(v))} (Click to view session)`, "Points"]}
                          />
                          <Bar
                            dataKey="points"
                            radius={[3, 3, 0, 0]}
                            className="cursor-pointer"
                            onClick={(entry: any) => {
                              const m = entry?.month || entry?.payload?.month
                              if (m) handleMonthClick(m)
                            }}
                          >
                            {reversedMonthly.map((m, i) => (
                              <Cell
                                key={i}
                                fill={m.points >= 0 ? "#10b981" : "#ef4444"}
                                className="cursor-pointer hover:opacity-75 transition-opacity"
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </Card>
              </div>

              {/* Session Trades Ledger */}
              <div className="w-full">
                {renderTradesListCard()}
              </div>
            </div>
          )}

          {/* TAB 2: CHART & TRADES VIEW (65% CHART / 35% TRADES) */}
          {analyticsView === "terminal" && (
            <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-2.5 items-stretch overflow-hidden animate-in fade-in duration-150">
              {/* LEFT SIDE (65%): CANDLESTICK CHART */}
              <div className="w-full lg:w-[65%] flex flex-col min-w-0 h-full min-h-0 overflow-hidden">
                {picked ? (
                  <DayDetail
                    key={`${picked}-${chartStrategy}-${activeChartSymbol}`}
                    date={picked}
                    mode="backtest"
                    strategy={chartStrategy}
                    symbol={activeChartSymbol}
                    chartOnly={true}
                    allowTimeframeSwitch={false}
                    simpleChart={true}
                    height="h-full min-h-0 flex-1"
                    focusTime={activeTrade?.entry}
                    activeTrade={activeTrade}
                  />
                ) : (
                  <div className="h-full flex flex-col items-center justify-center p-6 text-center text-muted-foreground border rounded-xl bg-card">
                    <Calendar className="size-8 text-muted-foreground/40 mb-2" />
                    <p className="text-sm font-semibold text-foreground">No session selected</p>
                    <p className="text-xs text-muted-foreground mt-1">Select a trading session from the date selector above.</p>
                  </div>
                )}
              </div>

              {/* RIGHT SIDE (35%): SCROLLABLE TRADES LIST */}
              <div className="w-full lg:w-[35%] flex flex-col min-w-0 h-full min-h-0 overflow-hidden">
                {renderTradesListCard()}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

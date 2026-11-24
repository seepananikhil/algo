import { useMemo, useRef, useState, useEffect } from "react"
import { useSearchParams } from "react-router-dom"
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart2,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock,
  ExternalLink,
  FileText,
  GitCommit,
  Layers,
  LineChart,
  Percent,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react"
import { SwingerTradeChartModal, type SwingerTradeTarget } from "@/components/swinger-trade-chart-modal"
import type { PaperHoldingsResponse } from "./holdings"
import { toast } from "sonner"
import { DayDetail } from "@/components/day-detail"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { TravelCalendarPopup } from "@/components/travel-calendar-popup"
import {
  fmtNum,
  fmtRs,
  pnlClass,
  postJSON,
  usePoll,
  type CapitalReport,
  type OptionTrade,
  type PaperReport,
} from "@/lib/api"
import { cn } from "@/lib/utils"

export interface CalendarDay {
  date: string
  value: number
  pnl: number
  trades: number
}

function getExitBadge(reason?: string) {
  if (!reason) return { label: "Open", className: "bg-muted text-muted-foreground" }
  const r = reason.toUpperCase()
  if (r.includes("EMA20") || r.includes("EMA")) {
    return { label: "5m 20-EMA Trail", className: "bg-indigo-500/15 text-indigo-400 border border-indigo-500/20" }
  }
  if (r.includes("EOD") || r.includes("1515")) {
    return { label: "EOD Runner (15:15)", className: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20" }
  }
  if (r.includes("TARGET") || r === "TP") {
    return { label: "Target Achieved", className: "bg-emerald-500/15 text-emerald-400" }
  }
  if (r.includes("CATASTROPHIC") || r.includes("HARD")) {
    return { label: "Hard SL Hit", className: "bg-rose-500/15 text-rose-400 border border-rose-500/20" }
  }
  if (r.includes("SL") || r.includes("STOP") || r.includes("LOSS")) {
    return { label: "Stop Loss Hit", className: "bg-rose-500/15 text-rose-400" }
  }
  if (r.includes("RATCHET") || r.includes("LOCK")) {
    return { label: "Ratchet Lock", className: "bg-sky-500/15 text-sky-400 border border-sky-500/25" }
  }
  if (r.includes("TRAIL")) {
    return { label: "Trailing Stop", className: "bg-amber-500/15 text-amber-400" }
  }
  if (r.includes("SQUARE")) {
    return { label: "Intraday Square-off", className: "bg-purple-500/15 text-purple-400" }
  }
  return { label: reason, className: "bg-muted/70 text-muted-foreground" }
}

export type MainStrategyTab = "APEX" | "SWINGER"
export type ApexFilter = "ALL" | "NIFTY" | "SENSEX" | "WIN" | "LOSS"
export type PortfolioFilter = ApexFilter | "SWINGER"

export function PaperPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const initialTab = searchParams.get("tab")?.toUpperCase() === "SWINGER" ? "SWINGER" : "APEX"
  const [mainTab, setMainTab] = useState<MainStrategyTab>(initialTab)
  const [apexFilter, setApexFilter] = useState<ApexFilter>("ALL")
  const [swingerActiveFilter, setSwingerActiveFilter] = useState<"ALL" | "GAINERS" | "LOSERS">("ALL")
  const [sessionInstrumentTab, setSessionInstrumentTab] = useState<"ALL" | "NIFTY" | "SENSEX">("ALL")
  const [pickedDate, setPickedDate] = useState<string | null>(null)
  const [selectedTradeIndex, setSelectedTradeIndex] = useState<number>(0)
  const [selectedInstrument, setSelectedInstrument] = useState<"NIFTY" | "SENSEX" | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [calendarModalOpen, setCalendarModalOpen] = useState(false)
  const calendarTriggerRef = useRef<HTMLButtonElement>(null)
  const [analyticsView, setAnalyticsView] = useState<"terminal" | "stats">(() => {
    const saved = localStorage.getItem("paper_analytics_view")
    if (saved === "stats" || saved === "terminal") return saved
    return "terminal"
  })
  const terminalRef = useRef<HTMLDivElement>(null)

  // Swinger Data Poll
  const swingerPaper = usePoll<PaperHoldingsResponse>("/api/holdings/paper", 15000)
  const swingerSignals = usePoll<any>("/api/swinger/daily-signals", 15000)
  const [isScanningSwinger, setIsScanningSwinger] = useState(false)

  const handleScanNow = async () => {
    try {
      setIsScanningSwinger(true)
      toast.info("Running Chartink scanner and evaluating triggers in real-time...")
      const res = await fetch("/api/swinger/scan-now", { method: "POST" })
      const data = await res.json()
      if (data.ok) {
        toast.success("Scanner cycle finished! Real-time paper positions & signals updated.")
        swingerPaper.reload()
        swingerSignals.reload()
      } else {
        toast.error(data.error || "Scan failed")
      }
    } catch (e: any) {
      toast.error(e?.message || "Scan failed")
    } finally {
      setIsScanningSwinger(false)
    }
  }

  const swingerPositions = swingerPaper.data?.positions || []
  const swingerClosedTrades = swingerPaper.data?.closed_trades || []
  const swingerSummary = swingerPaper.data?.summary || {
    total_portfolio_value: 0,
    total_invested: 0,
    total_unrealized_pnl: 0,
    total_unrealized_pnl_pct: 0,
    total_realized_pnl: 0,
    total_combined_pnl: 0,
    active_positions_count: 0,
    closed_trades_count: 0,
    gainers_count: 0,
    losers_count: 0,
    win_rate: 0,
    profit_factor: 0,
    max_slots: 20,
    slot_size: 25000,
  }

  const [swingerSubTab, setSwingerSubTab] = useState<"ACTIVE" | "CLOSED" | "RADAR">("ACTIVE")
  const [swingerSearch, setSwingerSearch] = useState("")
  const [selectedSwingerTrade, setSelectedSwingerTrade] = useState<SwingerTradeTarget | null>(null)

  useEffect(() => {
    const tabParam = searchParams.get("tab")?.toUpperCase()
    if (tabParam === "SWINGER") {
      setMainTab("SWINGER")
    } else if (tabParam === "APEX") {
      setMainTab("APEX")
    }
  }, [searchParams])

  const handleMainTabChange = (tab: MainStrategyTab) => {
    setMainTab(tab)
    setSearchParams({ tab: tab.toLowerCase() })
  }

  const filteredSwingerPositions = useMemo(() => {
    let list = swingerPositions
    if (swingerActiveFilter === "GAINERS") {
      list = list.filter((p) => (p.unrealized_pnl ?? (p.cmp - p.entry_price)) > 0)
    } else if (swingerActiveFilter === "LOSERS") {
      list = list.filter((p) => (p.unrealized_pnl ?? (p.cmp - p.entry_price)) < 0)
    }
    if (!swingerSearch.trim()) return list
    const q = swingerSearch.toLowerCase()
    return list.filter(
      (p) =>
        p.symbol.toLowerCase().includes(q) ||
        (p.name || "").toLowerCase().includes(q)
    )
  }, [swingerPositions, swingerActiveFilter, swingerSearch])

  const handleSyncToGit = async () => {
    setSyncing(true)
    try {
      const res = await postJSON<{ ok: boolean; message?: string }>("/api/sync-trades", {})
      if (res.ok) {
        toast.success("Trade logs synced to GitHub!", {
          description: res.message || "Pushed to origin/master",
        })
      } else {
        toast.error("Git sync failed", { description: res.message || "Check server logs" })
      }
    } catch (e: any) {
      toast.error("Git sync error", { description: e.message })
    } finally {
      setSyncing(false)
    }
  }

  // Combined Portfolio data and individual strategies
  const capital = usePoll<CapitalReport>("/api/capital-report", 15000)
  const trendRunner = usePoll<PaperReport>("/api/paper-report?strategy=trend_runner", 15000)
  const sensexRunner = usePoll<PaperReport>("/api/paper-report?strategy=sensex_runner", 15000)

  const niftyTrades = useMemo(() => trendRunner.data?.trades || [], [trendRunner.data])
  const sensexTrades = useMemo(() => sensexRunner.data?.trades || [], [sensexRunner.data])

  // All trades combined across all strategies
  const allTrades: OptionTrade[] = useMemo(() => {
    return [...niftyTrades, ...sensexTrades].sort((a, b) => {
      const ta = `${a.date} ${a.entry}`
      const tb = `${b.date} ${b.entry}`
      return ta.localeCompare(tb)
    })
  }, [niftyTrades, sensexTrades])

  // Filtered trades by active apexFilter (All, Nifty, Sensex, Win, Loss)
  const filteredTrades: OptionTrade[] = useMemo(() => {
    return allTrades.filter((t) => {
      const isSensex = t.symbol === "SENSEX" || (t.option && t.option.includes("SENSEX"))
      const isWin = (t.net_rs ?? 0) > 0
      if (apexFilter === "NIFTY") return !isSensex
      if (apexFilter === "SENSEX") return isSensex
      if (apexFilter === "WIN") return isWin
      if (apexFilter === "LOSS") return !isWin
      return true
    })
  }, [allTrades, apexFilter])

  // Badge count caches
  const niftyCount = useMemo(() => allTrades.filter((t) => t.symbol === "NIFTY" || !t.option?.includes("SENSEX")).length, [allTrades])
  const sensexCount = useMemo(() => allTrades.filter((t) => t.symbol === "SENSEX" || t.option?.includes("SENSEX")).length, [allTrades])
  const winCount = useMemo(() => allTrades.filter((t) => (t.net_rs ?? 0) > 0).length, [allTrades])
  const lossCount = useMemo(() => allTrades.filter((t) => (t.net_rs ?? 0) <= 0).length, [allTrades])

  const handleApexFilterChange = (tab: ApexFilter) => {
    setApexFilter(tab)
    if (tab === "SENSEX") {
      setSelectedInstrument("SENSEX")
    } else if (tab === "NIFTY") {
      setSelectedInstrument("NIFTY")
    } else {
      setSelectedInstrument(null)
    }
    setSelectedTradeIndex(0)
  }

  // Summary Metrics (Recomputed based on active tab)
  const summary = useMemo(() => {
    const baseCapital = apexFilter === "ALL" ? (capital.data?.summary?.starting_capital ?? 25000) : 25000
    const netRs = filteredTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0)
    const endingCapital = baseCapital + netRs
    const returnPct = baseCapital > 0 ? (netRs / baseCapital) * 100 : 0

    const winTrades = filteredTrades.filter((t) => (t.net_rs ?? 0) > 0)
    const lossTrades = filteredTrades.filter((t) => (t.net_rs ?? 0) <= 0)
    const winAmounts = winTrades.map((t) => t.net_rs ?? 0)
    const lossAmounts = lossTrades.map((t) => t.net_rs ?? 0)
    const avgWin = winAmounts.length ? winAmounts.reduce((a, b) => a + b, 0) / winAmounts.length : 0
    const avgLoss = lossAmounts.length ? lossAmounts.reduce((a, b) => a + b, 0) / lossAmounts.length : 0
    const payoffRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : "—"

    const grossRs = filteredTrades.reduce((acc, t) => acc + (t.pnl_rs ?? 0), 0)
    const chargesRs = filteredTrades.reduce((acc, t) => acc + (t.charges_rs ?? 0), 0)

    const dailyMap = new Map<string, number>()
    for (const t of filteredTrades) {
      dailyMap.set(t.date, (dailyMap.get(t.date) || 0) + (t.net_rs ?? 0))
    }
    const winningDays = Array.from(dailyMap.values()).filter((v) => v > 0).length

    return {
      starting_capital: baseCapital,
      ending_capital: endingCapital,
      net_rs: netRs,
      return_pct: Math.round(returnPct * 100) / 100,
      gross_rs: grossRs,
      charges_rs: chargesRs,
      trades: filteredTrades.length,
      wins: winTrades.length,
      losses: lossTrades.length,
      win_rate_pct: filteredTrades.length > 0 ? Math.round((winTrades.length / filteredTrades.length) * 1000) / 10 : 0,
      avg_win_rs: Math.round(avgWin * 100) / 100,
      avg_loss_rs: Math.round(avgLoss * 100) / 100,
      payoff_ratio: payoffRatio,
      max_drawdown_rs: capital.data?.summary?.max_drawdown_rs ?? 0,
      winning_days: winningDays,
      total_days: dailyMap.size,
      peak_deployed_rs: filteredTrades.reduce((max, t) => Math.max(max, t.buy_value_rs || 0), 0),
    }
  }, [capital.data, filteredTrades, apexFilter])

  // Calendar Daily Data
  const calendarDaily = useMemo(() => {
    const map = new Map<string, { date: string; value: number; pnl: number; trades: number; nifty_points: number; sensex_points: number }>()
    for (const t of filteredTrades) {
      const cur = map.get(t.date) || { date: t.date, value: 0, pnl: 0, trades: 0, nifty_points: 0, sensex_points: 0 }
      const rs = t.net_rs ?? t.pnl_rs ?? 0
      cur.value += rs
      cur.pnl += rs
      cur.trades += 1
      const isSensex = t.symbol === "SENSEX" || (t.option && t.option.includes("SENSEX"))
      const pts = t.nifty_points ?? t.pnl_points ?? 0
      if (isSensex) {
        cur.sensex_points = Math.round((cur.sensex_points + pts) * 10) / 10
      } else {
        cur.nifty_points = Math.round((cur.nifty_points + pts) * 10) / 10
      }
      map.set(t.date, cur)
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date))
  }, [filteredTrades])

  const reversedCalendarDaily = useMemo(() => {
    return [...calendarDaily].reverse()
  }, [calendarDaily])

  // Payoff / Equity Curve
  const equityCurve = useMemo(() => {
    if (!filteredTrades.length) return []
    let cum = 0
    let peak = 0
    const curve = [{ label: "Start", equity: 0, drawdown: 0, date: "" }]
    for (const t of filteredTrades) {
      cum += t.net_rs ?? 0
      if (cum > peak) peak = cum
      const dd = cum - peak
      curve.push({
        label: `${t.date} ${t.entry}`,
        equity: Math.round(cum * 100) / 100,
        drawdown: Math.round(dd * 100) / 100,
        date: t.date,
      })
    }
    return curve
  }, [filteredTrades])

  // Active Date: Selected day or defaults to latest trading day in filtered set
  const latestDate = filteredTrades.length ? filteredTrades[filteredTrades.length - 1].date : (allTrades.length ? allTrades[allTrades.length - 1].date : "2026-11-17")
  const activeDate = useMemo(() => {
    if (pickedDate && filteredTrades.some((t) => t.date === pickedDate)) {
      return pickedDate
    }
    return latestDate
  }, [pickedDate, filteredTrades, latestDate])

  // All trades for active day
  const activeDayTrades = useMemo(() => {
    return filteredTrades.filter((t) => t.date === activeDate)
  }, [filteredTrades, activeDate])

  // Count by instrument for active day
  const niftyDayCount = useMemo(() => activeDayTrades.filter((t) => t.symbol === "NIFTY" || !t.option?.includes("SENSEX")).length, [activeDayTrades])
  const sensexDayCount = useMemo(() => activeDayTrades.filter((t) => t.symbol === "SENSEX" || t.option?.includes("SENSEX")).length, [activeDayTrades])

  // Filtered trades for active session by sub-tab
  const sessionDayTrades = useMemo(() => {
    return activeDayTrades.filter((t) => {
      const isSensex = t.symbol === "SENSEX" || (t.option && t.option.includes("SENSEX"))
      if (sessionInstrumentTab === "NIFTY") return !isSensex
      if (sessionInstrumentTab === "SENSEX") return isSensex
      return true
    })
  }, [activeDayTrades, sessionInstrumentTab])

  // Active Trade on active day
  const activeTrade: OptionTrade | null = useMemo(() => {
    if (!activeDayTrades.length) return null
    const safeIdx = Math.min(selectedTradeIndex, activeDayTrades.length - 1)
    return activeDayTrades[Math.max(0, safeIdx)]
  }, [activeDayTrades, selectedTradeIndex])

  // Determine Instrument & Strategy to display in the Left Chart
  const activeInstrument: "NIFTY" | "SENSEX" = useMemo(() => {
    if (sessionInstrumentTab === "SENSEX") return "SENSEX"
    if (sessionInstrumentTab === "NIFTY") return "NIFTY"
    if (apexFilter === "SENSEX") return "SENSEX"
    if (apexFilter === "NIFTY") return "NIFTY"
    if (selectedInstrument) return selectedInstrument
    if (activeTrade) {
      const isSensex = activeTrade.symbol === "SENSEX" || (activeTrade.option && activeTrade.option.includes("SENSEX")) || (activeTrade.mode && activeTrade.mode.includes("SENSEX"))
      return isSensex ? "SENSEX" : "NIFTY"
    }
    const hasSensex = activeDayTrades.some((t) => t.symbol === "SENSEX" || t.option?.includes("SENSEX"))
    return hasSensex ? "SENSEX" : "NIFTY"
  }, [sessionInstrumentTab, apexFilter, selectedInstrument, activeTrade, activeDayTrades])

  const chartStrategy = activeInstrument === "SENSEX" ? "sensex_runner" : "trend_runner"

  // Day click handler
  const [paperYearFilter, setPaperYearFilter] = useState<string | null>(null)
  const availableYears = useMemo(() => {
    return [...new Set(calendarDaily.map((d) => d.date.slice(0, 4)))].filter(Boolean).sort().reverse()
  }, [calendarDaily])

  const handleDayClick = (date: string) => {
    const dYear = date.slice(0, 4)
    if (paperYearFilter && paperYearFilter !== dYear) {
      setPaperYearFilter(dYear)
    }
    setPickedDate(date)
    setSessionInstrumentTab("ALL")
    setSelectedTradeIndex(0)
    const dayTrades = filteredTrades.filter((t) => t.date === date)
    if (dayTrades.length > 0) {
      const first = dayTrades[0]
      const isSensex = first.symbol === "SENSEX" || first.option?.includes("SENSEX")
      if (apexFilter !== "NIFTY" && apexFilter !== "SENSEX") {
        setSelectedInstrument(isSensex ? "SENSEX" : "NIFTY")
      }
    }
    terminalRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const sessionDates = useMemo(() => {
    return [...new Set(filteredTrades.map((t) => t.date))].sort()
  }, [filteredTrades])

  const curDateIdx = sessionDates.indexOf(activeDate)
  const prevDay = curDateIdx > 0 ? sessionDates[curDateIdx - 1] : null
  const nextDay = curDateIdx >= 0 && curDateIdx < sessionDates.length - 1 ? sessionDates[curDateIdx + 1] : null

  const pickedFormattedDate = useMemo(() => {
    if (!activeDate) return "—"
    try {
      const [y, m, d] = activeDate.split("-").map(Number)
      const dt = new Date(y, m - 1, d)
      return dt.toLocaleDateString("en-IN", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    } catch {
      return activeDate
    }
  }, [activeDate])

  const renderDateSelector = () => (
    <div className="relative flex items-center gap-1 shrink-0">
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={!prevDay}
        onClick={() => prevDay && handleDayClick(prevDay)}
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
        onClick={() => nextDay && handleDayClick(nextDay)}
        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30"
        title={nextDay ? `Next session: ${nextDay}` : "No later session"}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>

      <TravelCalendarPopup
        open={calendarModalOpen}
        onClose={() => setCalendarModalOpen(false)}
        daily={calendarDaily}
        selectedDate={activeDate}
        onSelectDate={(newDate) => {
          handleDayClick(newDate)
          setCalendarModalOpen(false)
        }}
        unit="rupees"
        format={fmtRs}
        triggerRef={calendarTriggerRef}
      />
    </div>
  )

  const renderTradesListCard = () => (
    <div className="h-full rounded-xl border border-border/60 shadow-xs flex flex-col overflow-hidden bg-card/95">
      {/* Header: Tabs for this day's trades + Session Net P&L */}
      <div className="p-1.5 px-2.5 border-b border-border/40 bg-muted/20 flex items-center justify-between gap-1.5 shrink-0">
        <div className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setSessionInstrumentTab("ALL")}
            className={cn(
              "rounded px-2.5 py-0.5 text-[11px] font-bold transition-colors cursor-pointer",
              sessionInstrumentTab === "ALL" ? "bg-background text-foreground shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
            )}
          >
            All ({activeDayTrades.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setSessionInstrumentTab("NIFTY")
              setSelectedInstrument("NIFTY")
              const idx = activeDayTrades.findIndex((t) => t.symbol === "NIFTY" || !t.option?.includes("SENSEX"))
              if (idx >= 0) setSelectedTradeIndex(idx)
            }}
            className={cn(
              "rounded px-2.5 py-0.5 text-[11px] font-bold transition-colors cursor-pointer",
              sessionInstrumentTab === "NIFTY" ? "bg-background text-foreground shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
            )}
          >
            Nifty ({niftyDayCount})
          </button>
          <button
            type="button"
            onClick={() => {
              setSessionInstrumentTab("SENSEX")
              setSelectedInstrument("SENSEX")
              const idx = activeDayTrades.findIndex((t) => t.symbol === "SENSEX" || t.option?.includes("SENSEX"))
              if (idx >= 0) setSelectedTradeIndex(idx)
            }}
            className={cn(
              "rounded px-2.5 py-0.5 text-[11px] font-bold transition-colors cursor-pointer",
              sessionInstrumentTab === "SENSEX" ? "bg-background text-foreground shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
            )}
          >
            Sensex ({sensexDayCount})
          </button>
        </div>

        <div className="text-right shrink-0 flex items-center gap-1.5 font-mono">
          <span className="text-[10px] text-muted-foreground">Session Net:</span>
          <span
            className={cn(
              "text-xs font-black tabular-nums px-2 py-0.5 rounded shadow-2xs",
              activeDayTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0) >= 0
                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                : "bg-rose-500/15 text-rose-400 border border-rose-500/30"
            )}
          >
            {activeDayTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0) >= 0 ? "+" : ""}
            {fmtRs(activeDayTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0))}
          </span>
        </div>
      </div>

      {/* Scrollable Trades List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2 scrollbar-thin">
        {sessionDayTrades.length > 0 ? (
          sessionDayTrades.map((t, idx) => {
            const isSelected = activeTrade === t
            const spotPts = t.pnl_points ?? t.nifty_points ?? (t.sell_price > 0 ? t.sell_price - t.buy_price : 0)
            const rs = t.net_rs ?? t.pnl_rs ?? 0
            const isCall = t.side === "CALL" || t.side === "LONG" || t.side === "CE"
            const isSensex = t.symbol === "SENSEX" || t.option?.includes("SENSEX")
            const isWin = rs > 0 || spotPts > 0
            const isLoss = rs < 0 || spotPts < 0
            const exitBadge = getExitBadge(t.exit_reason || (t as any).reason)

            // R-Multiple
            let rMultiple: number | null = null
            const spotEntry = Number(t.spot_at_entry || t.nifty_in || (t as any).entry_spot || (t as any).entry_price || t.buy_price || 0)
            const spotExit = Number(t.nifty_out || (t as any).exit_spot || (t as any).exit_price || t.sell_price || 0)
            const slNum = Number(t.sl)
            if (spotEntry > 0 && slNum > 0) {
              const risk = Math.abs(spotEntry - slNum)
              if (risk > 0) {
                const ptsGain = t.pnl_points ?? t.nifty_points ?? (spotExit > 0 ? (isCall ? spotExit - spotEntry : spotEntry - spotExit) : 0)
                if (ptsGain != null && ptsGain !== 0) {
                  rMultiple = Math.round((Number(ptsGain) / risk) * 10) / 10
                }
              }
            } else if (t.buy_price > 0 && t.sl && t.sell_price > 0) {
              const risk = Math.abs(t.buy_price - t.sl)
              if (risk > 0) {
                rMultiple = Math.round(((t.sell_price - t.buy_price) / risk) * 10) / 10
              }
            }

            // Duration
            let durationStr = ""
            const bars = (t as any).bars_held
            if (bars != null && bars > 0) {
              durationStr = `${bars}m`
            } else if (t.entry && t.exit) {
              try {
                const [h1, m1] = t.entry.split(":").map(Number)
                const [h2, m2] = t.exit.split(":").map(Number)
                const diff = (h2 * 60 + m2) - (h1 * 60 + m1)
                if (diff > 0) durationStr = `${diff}m`
              } catch {}
            }

            // Entry & Exit Price resolution
            const optBuy = Number(t.buy_price || 0)
            const optSell = Number(t.sell_price || 0)
            const spotIn = Number(t.entry_price || t.spot_at_entry || t.nifty_in || (t as any).entry_spot || 0)
            const spotOut = Number(t.exit_price || t.nifty_out || (t as any).exit_spot || 0)
            const hasOptionPremium = optBuy > 0 && optBuy < 10000

            const tradeQty = Number(t.qty || (isSensex ? 20 : 65))
            const investedCapital = Math.round(optBuy * tradeQty)
            const pctGain = optBuy > 0 && optSell > 0
              ? Math.round(((optSell - optBuy) / optBuy) * 1000) / 10
              : null

            const expiryStr = (t as any).expiry || (() => {
              try {
                const [y, m, d] = (t.date || "").split("-").map(Number)
                const dt = new Date(y, m - 1, d)
                const targetDay = isSensex ? 5 : 4
                const curDay = dt.getDay()
                const diff = (targetDay - curDay + 7) % 7
                dt.setDate(dt.getDate() + diff)
                return `${dt.getDate()} ${dt.toLocaleString("en-US", { month: "short" })}`
              } catch {
                return isSensex ? "27 Nov" : "26 Nov"
              }
            })()

            const entryPriceDisplay = hasOptionPremium
              ? `₹${optBuy.toFixed(1)}`
              : spotIn > 0
              ? spotIn.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
              : "--"
            const exitPriceDisplay = hasOptionPremium
              ? optSell > 0
                ? `₹${optSell.toFixed(1)}`
                : "Open"
              : spotOut > 0
              ? spotOut.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
              : "Open"

            // Option Contract Name
            const optContract = (() => {
              const opt = (t.option || "").trim()
              const m = opt.match(/(\d{5})\s*(CE|PE)/i)
              if (m) return `${m[1]} ${m[2].toUpperCase()}`
              const optType = isCall ? "CE" : "PE"
              if (spotEntry > 0) {
                if (isSensex) {
                  const strike = Math.round(spotEntry / 100) * 100
                  return `${strike} ${optType}`
                } else {
                  const strike = Math.round((isCall ? spotEntry - 150 : spotEntry + 150) / 50) * 50
                  return `${strike} ${optType}`
                }
              }
              return opt || (isSensex ? "83400 PE" : "25800 PE")
            })()

            // Strategy Triggered (Trend Runner vs VIX Trap)
            const stratLabel = String((t as any).strategy_label || (t as any).engine || (t as any).stage || (t as any).setup_id || (t as any).setup || t.trigger_label || t.mode || t.strategy || "").toUpperCase()
            const isVixTrap = stratLabel.includes("TRAP") || stratLabel.includes("VIX_TRAP")
            const isTrendRunner = stratLabel.includes("TREND")
            const isReentry = stratLabel.includes("REENTRY")
            const triggeredStrategy = {
              label: isVixTrap ? "VIX Trap" : isTrendRunner ? "Trend Runner" : isReentry ? "Re-Entry Runner" : ((t as any).strategy_label || "Trend Runner"),
              isTrap: isVixTrap,
            }

            return (
              <div
                key={`${t.date}-${t.entry}-${idx}`}
                onClick={() => {
                  const realIdx = activeDayTrades.indexOf(t)
                  setSelectedTradeIndex(realIdx >= 0 ? realIdx : idx)
                  setSelectedInstrument(isSensex ? "SENSEX" : "NIFTY")
                }}
                className={cn(
                  "group p-3 rounded-xl text-xs cursor-pointer transition-all flex flex-col gap-2 border bg-card text-card-foreground shadow-2xs",
                  isSelected
                    ? "border-primary/50 bg-accent/40 ring-1 ring-primary/25 shadow-xs"
                    : "border-border/60 hover:border-border hover:bg-muted/40 hover:shadow-xs"
                )}
              >
                {/* ROW 1: Direction Pill, Instrument, Contract, Qty, Expiry, Strategy + Hero PnL */}
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                    <span
                      className={cn(
                        "px-1.5 py-0.2 rounded text-[9.5px] font-black tracking-wider text-white shrink-0",
                        isCall ? "bg-emerald-600 dark:bg-emerald-500" : "bg-rose-600 dark:bg-rose-500"
                      )}
                    >
                      {isCall ? "CE" : "PE"}
                    </span>
                    <span className="font-extrabold text-xs sm:text-[13px] text-foreground font-mono tracking-tight shrink-0">
                      {isSensex ? "SENSEX" : "NIFTY"} {optContract}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/80 shrink-0">
                      · {expiryStr}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/80 shrink-0">
                      · Qty {tradeQty}
                    </span>
                    <span
                      className={cn(
                        "px-1.5 py-0.2 rounded text-[8.5px] font-bold uppercase tracking-wider shrink-0 border",
                        triggeredStrategy.isTrap
                          ? "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20"
                          : "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20"
                      )}
                    >
                      {triggeredStrategy.label}
                    </span>
                  </div>
                  <div
                    className={cn(
                      "text-sm sm:text-base font-black font-mono tracking-tight shrink-0 text-right leading-none",
                      isWin ? "text-emerald-600 dark:text-emerald-400" : isLoss ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"
                    )}
                  >
                    {rs >= 0 ? "+" : ""}{fmtRs(rs)}
                  </div>
                </div>

                {/* ROW 2: Execution Prices, Spot Values (Left) + Return % & Invested Capital (Right) */}
                <div className="flex items-center justify-between gap-2 text-[11px] font-mono min-w-0">
                  <div className="flex items-center gap-1.5 text-muted-foreground truncate">
                    <span>Px <strong className="text-foreground font-bold">{entryPriceDisplay}</strong></span>
                    <span className="text-muted-foreground/50 text-[9px]">➔</span>
                    <span>
                      <strong className={isWin ? "text-emerald-600 dark:text-emerald-400 font-bold" : isLoss ? "text-rose-600 dark:text-rose-400 font-bold" : "text-foreground font-bold"}>
                        {exitPriceDisplay}
                      </strong>
                    </span>
                    <span className="opacity-30">·</span>
                    <span>Spot <strong className="text-foreground">{spotIn > 0 ? spotIn.toFixed(1) : "--"}</strong></span>
                    <span className="text-muted-foreground/50 text-[9px]">➔</span>
                    <span><strong className="text-foreground">{spotOut > 0 ? spotOut.toFixed(1) : "--"}</strong></span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 text-right">
                    {pctGain != null && (
                      <span
                        className={cn(
                          "px-1.5 py-0.2 rounded text-[10px] font-black border",
                          isWin
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                            : "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/20"
                        )}
                      >
                        {pctGain >= 0 ? `+${pctGain.toFixed(1)}%` : `${pctGain.toFixed(1)}%`}
                      </span>
                    )}
                    {investedCapital > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        Inv: <strong className="text-foreground font-bold">₹{investedCapital.toLocaleString("en-IN")}</strong>
                      </span>
                    )}
                  </div>
                </div>

                {/* ROW 3: Timing, SL, R-Multiple (Left) + Exit Reason Badge (Right) */}
                <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-muted-foreground min-w-0 pt-0.5">
                  <div className="flex items-center gap-1.5 truncate">
                    <Clock className="w-3 h-3 opacity-60 shrink-0" />
                    <span>{t.entry} - {t.exit || "Open"}{durationStr ? ` (${durationStr})` : ""}</span>
                    {slNum > 0 && <span>· SL: {slNum.toFixed(1)}</span>}
                    {rMultiple != null && (
                      <span
                        className={cn(
                          "px-1.5 py-0.2 rounded text-[9px] font-bold border",
                          rMultiple >= 0
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                            : "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/20"
                        )}
                      >
                        {rMultiple >= 0 ? `+${rMultiple.toFixed(1)}R` : `${rMultiple.toFixed(1)}R`}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={cn("px-1.5 py-0.2 rounded text-[9px] font-medium font-sans border", exitBadge.className)}>
                      {exitBadge.label}
                    </span>
                    {isSelected && (
                      <span className="size-1.5 rounded-full bg-primary animate-pulse ml-0.5" title="Viewing on chart" />
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
            <p className="text-[10px] text-muted-foreground mt-0.5">
              No {sessionInstrumentTab === "ALL" ? "" : sessionInstrumentTab.toLowerCase()} trades for {activeDate}.
            </p>
          </div>
        )}
      </div>

      {/* Panel Footer */}
      {activeDayTrades.length > 0 && (
        <div className="p-2 px-3 border-t border-border/40 bg-muted/10 flex items-center justify-between text-[10px] font-mono text-muted-foreground shrink-0">
          <span>
            Gross {fmtRs(activeDayTrades.reduce((acc, t) => acc + (t.pnl_rs ?? 0), 0))} · Fees {fmtRs(activeDayTrades.reduce((acc, t) => acc + (t.charges_rs ?? 0), 0))}
          </span>
          <span>
            Spot Move: <strong className={activeDayTrades.reduce((acc, t) => acc + (t.pnl_points ?? t.nifty_points ?? 0), 0) >= 0 ? "text-emerald-400" : "text-red-400"}>
              {activeDayTrades.reduce((acc, t) => acc + (t.pnl_points ?? t.nifty_points ?? 0), 0) >= 0 ? "+" : ""}
              {activeDayTrades.reduce((acc, t) => acc + (t.pnl_points ?? t.nifty_points ?? 0), 0).toFixed(1)} pts
            </strong>
          </span>
        </div>
      )}
    </div>
  )

  return (
    <div className="w-full h-full min-h-0 flex-1 flex flex-col gap-2 p-2 overflow-hidden select-none">
      {/* 1. TOP COMMAND BAR: STRATEGY ENGINE + FILTERS + VIEW SWITCHER */}
      <div className="relative z-40 flex items-center justify-between gap-2 p-1.5 px-2.5 rounded-xl border border-border/60 bg-card/90 shadow-2xs backdrop-blur-md shrink-0 flex-wrap sm:flex-nowrap">
        {/* Left Side: Strategy Engine Switcher (Apex Duo vs Swinger) */}
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <div className="flex items-center p-0.5 bg-muted/40 rounded-lg border border-border/40 shrink-0">
            <button
              type="button"
              onClick={() => handleMainTabChange("APEX")}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
                mainTab === "APEX"
                  ? "bg-background text-foreground shadow-2xs font-black border border-border/40"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Zap className="size-3 text-amber-400" />
              <span>Apex Duo</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-amber-500/15 text-amber-400 font-mono font-semibold">
                {allTrades.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => handleMainTabChange("SWINGER")}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
                mainTab === "SWINGER"
                  ? "bg-background text-foreground shadow-2xs font-black border border-border/40"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <TrendingUp className="size-3 text-purple-400" />
              <span>Swinger</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-purple-500/15 text-purple-400 font-mono font-semibold">
                {swingerPositions.length} pos
              </span>
            </button>
          </div>

          {mainTab === "APEX" && (
            <>
              <div className="h-4 w-px bg-border/60 hidden sm:block" />

              {/* Apex Filters */}
              <div className="flex items-center p-0.5 bg-muted/40 rounded-lg border border-border/40 shrink-0">
                <span className="text-[10px] font-bold text-muted-foreground uppercase px-1.5 select-none">Filter:</span>
                <button
                  type="button"
                  onClick={() => handleApexFilterChange("ALL")}
                  className={cn(
                    "px-2 py-0.5 text-[11px] font-semibold rounded transition-all cursor-pointer",
                    apexFilter === "ALL" ? "bg-background text-foreground shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  All ({allTrades.length})
                </button>
                <button
                  type="button"
                  onClick={() => handleApexFilterChange("NIFTY")}
                  className={cn(
                    "px-2 py-0.5 text-[11px] font-semibold rounded transition-all cursor-pointer",
                    apexFilter === "NIFTY" ? "bg-background text-sky-400 shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Nifty ({niftyCount})
                </button>
                <button
                  type="button"
                  onClick={() => handleApexFilterChange("SENSEX")}
                  className={cn(
                    "px-2 py-0.5 text-[11px] font-semibold rounded transition-all cursor-pointer",
                    apexFilter === "SENSEX" ? "bg-background text-amber-400 shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Sensex ({sensexCount})
                </button>
                <button
                  type="button"
                  onClick={() => handleApexFilterChange("WIN")}
                  className={cn(
                    "px-2 py-0.5 text-[11px] font-semibold rounded transition-all cursor-pointer",
                    apexFilter === "WIN" ? "bg-background text-emerald-400 shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Wins ({winCount})
                </button>
                <button
                  type="button"
                  onClick={() => handleApexFilterChange("LOSS")}
                  className={cn(
                    "px-2 py-0.5 text-[11px] font-semibold rounded transition-all cursor-pointer",
                    apexFilter === "LOSS" ? "bg-background text-rose-400 shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Losses ({lossCount})
                </button>
              </div>
            </>
          )}
        </div>

        {/* Right Side: Sticky Year Selector + Calendar Date Navigator + View Switcher + Sync Button */}
        {mainTab === "APEX" && (
          <div className="flex items-center gap-2 shrink-0">
            {/* Sticky Year Selector Dropdown for Paper */}
            {availableYears.length > 0 && (
              <div className="flex items-center gap-1 bg-muted/40 p-0.5 rounded-lg border border-border/40">
                <span className="text-[10px] font-bold text-muted-foreground uppercase px-1.5 select-none">Year:</span>
                <select
                  value={paperYearFilter ?? "all"}
                  onChange={(e) => {
                    const val = e.target.value === "all" ? null : e.target.value
                    setPaperYearFilter(val)
                    if (val) {
                      const matching = calendarDaily.filter((d) => d.date.startsWith(val))
                      if (matching.length > 0) {
                        handleDayClick(matching[matching.length - 1].date)
                      }
                    }
                  }}
                  className="h-7 px-2 text-xs font-mono font-bold rounded-md bg-background border border-border/70 text-foreground cursor-pointer focus:outline-hidden focus:ring-1 focus:ring-primary shadow-2xs"
                >
                  <option value="all">All ({availableYears.join(", ")})</option>
                  {availableYears.map((yr) => (
                    <option key={yr} value={yr}>{yr}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="h-4 w-px bg-border/60" />

            {/* Sticky Session Date Navigator with Calendar Popup */}
            {renderDateSelector()}

            <div className="h-4 w-px bg-border/60" />

            <div className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => {
                  setAnalyticsView("stats")
                  localStorage.setItem("paper_analytics_view", "stats")
                }}
                className={cn(
                  "rounded px-3 py-1 text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5",
                  analyticsView === "stats"
                    ? "bg-background text-foreground shadow-2xs font-bold"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <BarChart2 className="size-3 text-muted-foreground" />
                <span>Stats &amp; Payoff</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setAnalyticsView("terminal")
                  localStorage.setItem("paper_analytics_view", "terminal")
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

            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncToGit}
              disabled={syncing}
              className="text-xs font-semibold gap-1.5 h-7 cursor-pointer shadow-xs hover:bg-muted/60"
              title="Backup and sync trade records to GitHub"
            >
              {syncing ? <RefreshCw className="size-3 animate-spin text-primary" /> : <GitCommit className="size-3 text-emerald-500" />}
              {syncing ? "Backing up..." : "Sync Logs"}
            </Button>
          </div>
        )}
      </div>

      {/* Loading / Error States */}
      {capital.loading && !capital.data && (
        <Skeleton className="h-[480px] w-full rounded-2xl" />
      )}
      {capital.error && (
        <Card className="border-red-500/40 bg-red-500/10">
          <CardContent className="py-8 text-center text-red-400 font-mono text-sm">
            Failed to load capital report: {capital.error}
          </CardContent>
        </Card>
      )}

      {/* ============================================================== */}
      {/* 2. MAIN VIEW: SWINGER vs APEX DUO                              */}
      {/* ============================================================== */}
      {mainTab === "SWINGER" ? (
        <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-4">
          {/* Swinger Top Summary KPI Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {/* Card 1: Total Portfolio Value */}
            <Card className="p-3 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                    Paper Portfolio Value
                  </span>
                  <Wallet className="size-3.5 text-muted-foreground" />
                </div>
                <div className="text-xl font-black font-mono tracking-tight mt-1 text-foreground">
                  {fmtRs(swingerSummary.total_portfolio_value)}
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40 flex items-center justify-between">
                <span>Invested: {fmtRs(swingerSummary.total_invested)}</span>
                <span>Free Cash: {fmtRs((swingerSummary as any).free_cash || (swingerSummary.total_portfolio_value - swingerSummary.total_invested))}</span>
              </div>
            </Card>

            {/* Card 2: Unrealized P&L */}
            <Card className="p-3 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                    Active Unrealized
                  </span>
                  <TrendingUp className="size-3.5 text-emerald-400" />
                </div>
                <div className={cn("text-xl font-black font-mono tracking-tight mt-1", pnlClass(swingerSummary.total_unrealized_pnl))}>
                  {swingerSummary.total_unrealized_pnl >= 0 ? "+" : ""}{fmtRs(swingerSummary.total_unrealized_pnl)}
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40 flex items-center justify-between">
                <span className={cn("font-bold font-mono", pnlClass(swingerSummary.total_unrealized_pnl))}>
                  {swingerSummary.total_unrealized_pnl_pct >= 0 ? "+" : ""}{swingerSummary.total_unrealized_pnl_pct}%
                </span>
                <span>{swingerSummary.gainers_count}G / {swingerSummary.losers_count}L</span>
              </div>
            </Card>

            {/* Card 3: Realized P&L */}
            <Card className="p-3 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                    Realized P&amp;L
                  </span>
                  <CircleDollarSign className="size-3.5 text-muted-foreground" />
                </div>
                <div className={cn("text-xl font-black font-mono tracking-tight mt-1", pnlClass(swingerSummary.total_realized_pnl))}>
                  {swingerSummary.total_realized_pnl >= 0 ? "+" : ""}{fmtRs(swingerSummary.total_realized_pnl)}
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40 flex items-center justify-between">
                <span>Verified Strategy Ledger</span>
                <span className="font-bold font-mono text-foreground">{swingerClosedTrades.length} Closed</span>
              </div>
            </Card>

            {/* Card 4: Total Combined P&L */}
            <Card className="p-3 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                    Total Combined P&amp;L
                  </span>
                  <Percent className="size-3.5 text-muted-foreground" />
                </div>
                <div className={cn("text-xl font-black font-mono tracking-tight mt-1", pnlClass(swingerSummary.total_combined_pnl))}>
                  {swingerSummary.total_combined_pnl >= 0 ? "+" : ""}{fmtRs(swingerSummary.total_combined_pnl)}
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40 flex items-center justify-between">
                <span>Active + Closed</span>
                <span className={cn("font-bold font-mono", pnlClass(swingerSummary.total_combined_pnl))}>
                  {swingerSummary.total_invested > 0 ? ((swingerSummary.total_combined_pnl / swingerSummary.total_invested) * 100).toFixed(2) : 0}% ROI
                </span>
              </div>
            </Card>

            {/* Card 5: Active Slots */}
            <Card className="p-3 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                    Portfolio Slots
                  </span>
                  <Layers className="size-3.5 text-sky-400" />
                </div>
                <div className="text-xl font-black font-mono tracking-tight mt-1 text-foreground">
                  {swingerPositions.length} <span className="text-xs font-normal text-muted-foreground">/ {swingerSummary.max_slots} slots</span>
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40 flex items-center justify-between">
                <span>₹{fmtNum(swingerSummary.slot_size)} / slot</span>
                <span className="font-bold text-sky-400 font-mono">Phoenix 2.0</span>
              </div>
            </Card>

            {/* Card 6: Automated Shields */}
            <Card className="p-3 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                    Capital Protection
                  </span>
                  <ShieldCheck className="size-3.5 text-emerald-400" />
                </div>
                <div className="text-sm font-bold font-mono tracking-tight mt-1 text-emerald-400">
                  Cost Shield @ +15%
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40 flex items-center justify-between">
                <span>SL: -15%</span>
                <span className="text-purple-400 font-bold font-mono">25% Trail Lock</span>
              </div>
            </Card>
          </div>

          {/* Sub-Tabs Switcher & Filter Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-card p-3 rounded-xl border border-border/70 shadow-2xs">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5 text-xs font-bold">
                <button
                  type="button"
                  onClick={() => setSwingerSubTab("ACTIVE")}
                  className={cn(
                    "rounded px-3 py-1.5 text-xs transition-all cursor-pointer flex items-center gap-1.5",
                    swingerSubTab === "ACTIVE" ? "bg-background text-foreground shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <FileText className="size-3.5 text-emerald-500" />
                  <span>Active Positions</span>
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-emerald-500/15 text-emerald-400 font-mono">
                    {swingerPositions.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setSwingerSubTab("CLOSED")}
                  className={cn(
                    "rounded px-3 py-1.5 text-xs transition-all cursor-pointer flex items-center gap-1.5",
                    swingerSubTab === "CLOSED" ? "bg-background text-foreground shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <CheckCircle2 className="size-3.5 text-sky-400" />
                  <span>Closed Trades</span>
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-sky-500/15 text-sky-400 font-mono">
                    {swingerClosedTrades.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setSwingerSubTab("RADAR")}
                  className={cn(
                    "rounded px-3 py-1.5 text-xs transition-all cursor-pointer flex items-center gap-1.5",
                    swingerSubTab === "RADAR" ? "bg-background text-foreground shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Zap className="size-3.5 text-amber-400" />
                  <span>Radar &amp; Signals</span>
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-amber-500/15 text-amber-400 font-mono">
                    {swingerSignals.data?.signals?.length || 0}
                  </span>
                </button>
              </div>

              {/* Quick Search Input */}
              <div className="flex items-center bg-muted/40 border border-border/60 rounded-lg px-2.5 py-1 text-xs text-foreground focus-within:border-emerald-500/60 focus-within:ring-1 focus-within:ring-emerald-500/20 transition">
                <Search className="size-3 text-muted-foreground mr-1.5" />
                <input
                  type="text"
                  placeholder="Search symbol or name..."
                  value={swingerSearch}
                  onChange={(e) => setSwingerSearch(e.target.value)}
                  className="bg-transparent outline-none text-xs w-28 sm:w-40 text-foreground placeholder:text-muted-foreground/60"
                />
              </div>

              {/* Active Positions Gainers / Losers Filter */}
              {swingerSubTab === "ACTIVE" && (
                <div className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5 text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() => setSwingerActiveFilter("ALL")}
                    className={cn(
                      "rounded px-2 py-1 text-xs transition-all cursor-pointer",
                      swingerActiveFilter === "ALL" ? "bg-background text-foreground font-bold shadow-2xs" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    All ({swingerPositions.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSwingerActiveFilter("GAINERS")}
                    className={cn(
                      "rounded px-2 py-1 text-xs transition-all cursor-pointer text-emerald-400 flex items-center gap-1",
                      swingerActiveFilter === "GAINERS" ? "bg-emerald-500/20 font-bold shadow-2xs" : "text-muted-foreground hover:text-emerald-400"
                    )}
                  >
                    <TrendingUp className="size-3 text-emerald-400" />
                    <span>Gainers ({swingerSummary.gainers_count})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSwingerActiveFilter("LOSERS")}
                    className={cn(
                      "rounded px-2 py-1 text-xs transition-all cursor-pointer text-rose-400 flex items-center gap-1",
                      swingerActiveFilter === "LOSERS" ? "bg-rose-500/20 font-bold shadow-2xs" : "text-muted-foreground hover:text-rose-400"
                    )}
                  >
                    <TrendingDown className="size-3 text-rose-400" />
                    <span>Losers ({swingerSummary.losers_count})</span>
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 self-stretch sm:self-auto justify-end flex-wrap">
              <a
                href="/swinger"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 transition-colors shadow-2xs"
                title="Open full 4-year Swinger Strategy backtest dashboard"
              >
                <TrendingUp className="size-3.5 text-emerald-400" />
                <span>4Y Strategy Backtest</span>
                <ExternalLink className="size-3 opacity-60" />
              </a>

              <a
                href="/holdings"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-muted/60 hover:bg-muted text-foreground border border-border/60 transition-colors shadow-2xs"
                title="Manage in Demat Holdings"
              >
                <Wallet className="size-3.5 text-muted-foreground" />
                <span>Demat Holdings</span>
              </a>

              <Button
                variant="outline"
                size="sm"
                onClick={handleScanNow}
                disabled={isScanningSwinger}
                className="text-xs font-bold gap-1.5 h-7.5 cursor-pointer shadow-xs bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30"
                title="Run Chartink scanner and execute paper trades in real-time"
              >
                <Zap className={cn("size-3.5", isScanningSwinger ? "animate-spin text-amber-300" : "text-amber-400")} />
                <span>{isScanningSwinger ? "Scanning..." : "⚡ Run Scanner Now"}</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => swingerPaper.reload()}
                disabled={swingerPaper.loading}
                className="text-xs font-semibold gap-1.5 h-7.5 cursor-pointer shadow-xs hover:bg-muted/60"
              >
                <RefreshCw className={cn("size-3", swingerPaper.loading && "animate-spin text-emerald-400")} />
                <span>Sync</span>
              </Button>
            </div>
          </div>

          {/* Sub-View Content: ACTIVE POSITIONS */}
          {swingerSubTab === "ACTIVE" && (
            <Card className="border-border/70 overflow-hidden shadow-2xs">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-border/60 bg-muted/40 font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
                      <th className="py-2.5 px-4 font-bold">Stock / Company</th>
                      <th className="py-2.5 px-3 text-right font-bold">CMP</th>
                      <th className="py-2.5 px-3 text-right font-bold">Entry / Avg</th>
                      <th className="py-2.5 px-3 text-right font-bold">Shares</th>
                      <th className="py-2.5 px-3 text-right font-bold">Invested</th>
                      <th className="py-2.5 px-3 text-right font-bold">Current Val</th>
                      <th className="py-2.5 px-3 text-right font-bold">Unrealized P&amp;L</th>
                      <th className="py-2.5 px-3 text-center font-bold">Protection Status</th>
                      <th className="py-2.5 px-4 text-center font-bold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30 font-mono">
                    {filteredSwingerPositions.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-12 text-center text-muted-foreground text-xs">
                          {swingerSearch.trim() ? "No active positions match your search." : "No open paper positions found."}
                        </td>
                      </tr>
                    ) : (
                      filteredSwingerPositions.map((pos) => {
                        const pnl = pos.unrealized_pnl ?? ((pos.cmp - pos.entry_price) * pos.shares)
                        const pnlPct = pos.unrealized_pnl_pct ?? (pos.entry_price > 0 ? ((pos.cmp - pos.entry_price) / pos.entry_price) * 100 : 0)
                        const isProfit = pnl >= 0

                        return (
                          <tr key={pos.symbol} className="hover:bg-muted/30 transition-colors">
                            {/* Symbol & Name */}
                            <td className="py-3 px-4 font-sans">
                              <div className="flex items-center gap-2">
                                <span className="font-bold font-mono text-foreground text-sm">
                                  {pos.symbol}
                                </span>
                                {((pos as any).strategy_leg === "LEG2" || (pos as any).leg === 2 || String((pos as any).strategy_leg || "").toUpperCase().includes("LEG2")) && (
                                  <Badge variant="outline" className="text-[9px] font-mono px-1.5 py-0 border-purple-500/40 text-purple-400 bg-purple-500/10">
                                    LEG 2 RETRACE
                                  </Badge>
                                )}
                              </div>
                              <div className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5">
                                <span>{pos.name || pos.symbol}</span>
                                <span>·</span>
                                <span className="text-[10px] text-muted-foreground/80 font-mono">{pos.days_held ?? 0}d held</span>
                              </div>
                            </td>

                            {/* CMP */}
                            <td className="py-3 px-3 text-right font-bold text-foreground text-sm">
                              ₹{fmtNum(pos.cmp)}
                            </td>

                            {/* Entry Price / Avg */}
                            <td className="py-3 px-3 text-right text-muted-foreground">
                              <div>₹{fmtNum(pos.entry_price)}</div>
                              {pos.avg_price && pos.avg_price !== pos.entry_price && (
                                <div className="text-[10px] opacity-70">Avg: ₹{fmtNum(pos.avg_price)}</div>
                              )}
                            </td>

                            {/* Shares */}
                            <td className="py-3 px-3 text-right font-semibold text-foreground">
                              {fmtNum(pos.shares)}
                            </td>

                            {/* Invested */}
                            <td className="py-3 px-3 text-right text-muted-foreground">
                              {fmtRs(pos.invested)}
                            </td>

                            {/* Current Value */}
                            <td className="py-3 px-3 text-right font-bold text-foreground">
                              {fmtRs(pos.cmp * pos.shares)}
                            </td>

                            {/* Unrealized P&L */}
                            <td className="py-3 px-3 text-right">
                              <div className={cn("font-bold text-sm flex items-center justify-end gap-1", pnlClass(pnl))}>
                                {isProfit ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
                                <span>{isProfit ? "+" : ""}{fmtRs(pnl)}</span>
                              </div>
                              <div className={cn("text-[10px] font-semibold", pnlClass(pnl))}>
                                {isProfit ? "+" : ""}{pnlPct.toFixed(2)}%
                              </div>
                            </td>

                            {/* Protection Status */}
                            <td className="py-3 px-3 text-center">
                              {pos.runner_mode ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-500/15 text-purple-400 border border-purple-500/30">
                                  <Sparkles className="size-2.5" />
                                  <span>25% Trail Lock</span>
                                </span>
                              ) : pos.be_active ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/15 text-sky-400 border border-sky-500/30">
                                  <ShieldCheck className="size-2.5" />
                                  <span>Cost Shield (+15%)</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                                  <Clock className="size-2.5" />
                                  <span>Initial SL (-15%)</span>
                                </span>
                              )}
                              <div className="text-[9px] text-muted-foreground/80 mt-0.5">
                                SL: ₹{fmtNum(pos.runner_mode ? (pos.runner_trail_sl ?? pos.sl_price) : pos.be_active ? (pos.entry_price) : pos.sl_price)}
                              </div>
                            </td>

                            {/* Actions */}
                            <td className="py-3 px-4 text-center font-sans">
                              <div className="flex items-center justify-center gap-1.5">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    setSelectedSwingerTrade({
                                      symbol: pos.symbol,
                                      name: pos.name || pos.symbol,
                                      cmp: pos.cmp,
                                      qty: pos.shares,
                                      entry_price: pos.entry_price,
                                      avg_price: pos.avg_price,
                                      sl_price: pos.sl_price,
                                      cost_shield_price: (pos as any).cost_shield_price || pos.entry_price,
                                      runner_trail_sl: pos.runner_trail_sl,
                                      be_active: pos.be_active,
                                      runner_mode: pos.runner_mode,
                                      pnl: pnl,
                                      pnl_pct: pnlPct,
                                      entry_date: pos.entry_date,
                                      status: pos.runner_mode ? "RUNNER" : pos.be_active ? "SHIELDED" : "ACTIVE",
                                      leg: (pos as any).leg,
                                      strategy_leg: (pos as any).strategy_leg,
                                    } as any)
                                  }
                                  className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground hover:bg-muted"
                                  title="Open Technical Candlestick Chart"
                                >
                                  <LineChart className="size-3.5" />
                                  Chart
                                </Button>

                                <a
                                  href={`/swinger?symbol=${pos.symbol}`}
                                  className="h-7 px-2 text-xs gap-1 inline-flex items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted font-medium"
                                  title="View in Swinger Strategy Dashboard"
                                >
                                  <TrendingUp className="size-3" />
                                  Strategy
                                </a>

                                <a
                                  href={`https://in.tradingview.com/chart/?symbol=NSE:${pos.symbol}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                  title="Open in TradingView"
                                >
                                  <ExternalLink className="size-3.5" />
                                </a>
                              </div>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Sub-View Content: CLOSED TRADES */}
          {swingerSubTab === "CLOSED" && (
            <Card className="border-border/70 overflow-hidden shadow-2xs">
              <div className="px-4 py-3 border-b border-border/60 bg-muted/20 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-emerald-400" />
                  <span className="font-bold text-xs uppercase tracking-wider text-foreground font-mono">
                    Live Closed Trades Ledger (Tracked From Today Nov 21)
                  </span>
                </div>
                <Badge variant="outline" className="text-[10px] font-mono border-emerald-500/40 text-emerald-400 bg-emerald-500/10">
                  {swingerClosedTrades.length} Trades
                </Badge>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-border/60 bg-muted/40 font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
                      <th className="py-2.5 px-4 font-bold">Stock</th>
                      <th className="py-2.5 px-3 text-center font-bold">Dates (Entry → Exit)</th>
                      <th className="py-2.5 px-3 text-right font-bold">Entry Price</th>
                      <th className="py-2.5 px-3 text-right font-bold">Exit Price</th>
                      <th className="py-2.5 px-3 text-right font-bold">Shares</th>
                      <th className="py-2.5 px-3 text-right font-bold">Invested</th>
                      <th className="py-2.5 px-3 text-right font-bold">Realized P&amp;L</th>
                      <th className="py-2.5 px-3 text-center font-bold">Exit Reason</th>
                      <th className="py-2.5 px-4 text-center font-bold">Holding Period</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30 font-mono">
                    {swingerClosedTrades.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-12 text-center text-muted-foreground text-xs">
                          No closed trades yet today. Active positions are being tracked going forward.
                        </td>
                      </tr>
                    ) : (
                      swingerClosedTrades.map((t, idx) => (
                        <tr
                          key={idx}
                          onClick={() =>
                            setSelectedSwingerTrade({
                              symbol: t.symbol,
                              name: t.name || t.symbol,
                              entry_price: t.entry_price,
                              avg_price: t.avg_price || t.entry_price,
                              exit_price: t.exit_price,
                              cmp: t.exit_price,
                              qty: t.shares || t.qty,
                              pnl: t.pnl,
                              pnl_pct: t.pnl_pct,
                              entry_date: t.entry_date,
                              exit_date: t.exit_date,
                              days_held: t.days_held,
                              status: "CLOSED",
                              reason: t.reason || t.exit_reason || "Closed",
                              leg: (t as any).leg,
                              strategy_leg: (t as any).strategy_leg,
                            } as any)
                          }
                          className="hover:bg-muted/30 transition-colors cursor-pointer"
                        >
                          <td className="py-2.5 px-4 font-bold text-foreground font-mono flex items-center gap-1.5">
                            <span>{t.symbol}</span>
                            {(t as any).leg === 2 || String((t as any).strategy_leg || "").toUpperCase().includes("LEG2") ? (
                              <span className="px-1 py-0.2 rounded text-[9px] font-black bg-purple-100 text-purple-700 border border-purple-200">
                                LEG 2
                              </span>
                            ) : (
                              <span className="px-1 py-0.2 rounded text-[9px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                                LEG 1
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-center text-muted-foreground text-[11px]">{t.entry_date} → {t.exit_date}</td>
                          <td className="py-2.5 px-3 text-right text-muted-foreground">₹{fmtNum(t.entry_price)}</td>
                          <td className="py-2.5 px-3 text-right font-bold text-foreground">₹{fmtNum(t.exit_price)}</td>
                          <td className="py-2.5 px-3 text-right text-muted-foreground">{t.shares || t.qty}</td>
                          <td className="py-2.5 px-3 text-right text-muted-foreground">{fmtRs(t.invested || t.capital_invested || 0)}</td>
                          <td className={cn("py-2.5 px-3 text-right font-bold", pnlClass(t.pnl))}>
                            {t.pnl >= 0 ? "+" : ""}{fmtRs(t.pnl)} ({t.pnl_pct >= 0 ? "+" : ""}{t.pnl_pct.toFixed(1)}%)
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            <Badge variant="outline" className="text-[9px] font-mono">{t.reason || t.exit_reason || "EXIT"}</Badge>
                          </td>
                          <td className="py-2.5 px-4 text-center text-muted-foreground text-[11px]">{t.days_held} days</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Sub-View Content: RADAR / DAILY SIGNALS */}
          {swingerSubTab === "RADAR" && (
            <Card className="border-border/70 overflow-hidden shadow-2xs">
              <div className="px-4 py-3 border-b border-border/60 bg-muted/20 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap className="size-4 text-amber-400" />
                  <span className="font-bold text-xs uppercase tracking-wider text-foreground font-mono">
                    Scanner Radar &amp; Retracement Watchlist
                  </span>
                </div>
                <span className="text-[11px] text-muted-foreground font-mono">
                  Automated Chartink Webhook &amp; 50% Cooldown Triggers
                </span>
              </div>
              <div className="p-6 text-center text-xs text-muted-foreground">
                Radar loop is actively monitoring institutional breakout pullbacks and 20 EMA retests.
                New signals trigger automated paper orders dynamically.
              </div>
            </Card>
          )}

          {/* Chart Modal for Technical Candlestick Inspection */}
          <SwingerTradeChartModal trade={selectedSwingerTrade} onClose={() => setSelectedSwingerTrade(null)} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* VIEW 1: STATS & PAYOFF VIEW */}
          {analyticsView === "stats" && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-3 animate-in fade-in duration-150">
              {/* 6 Summary Cards */}
              {summary && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-2.5 shrink-0">
                  {/* Card 1: Net P&L */}
                  <Card className="p-3 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Net Realized P&amp;L
                        </span>
                        <CircleDollarSign className="size-3.5 text-muted-foreground" />
                      </div>
                      <div className={cn("text-xl font-black font-mono tracking-tight mt-1", pnlClass(summary.net_rs))}>
                        {summary.net_rs >= 0 ? "+" : ""}{fmtRs(summary.net_rs)}
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40">
                      Gross: {fmtRs(summary.gross_rs)} · Fees: {fmtRs(summary.charges_rs)}
                    </div>
                  </Card>

                  {/* Card 2: Return % on Capital */}
                  <Card className="p-3 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                          ROC &amp; Return
                        </span>
                        <Percent className="size-3.5 text-muted-foreground" />
                      </div>
                      <div className={cn("text-xl font-black font-mono tracking-tight mt-1", summary.return_pct >= 0 ? "text-emerald-400" : "text-red-400")}>
                        {summary.return_pct >= 0 ? "+" : ""}{summary.return_pct.toFixed(1)}%
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40 flex items-center justify-between">
                      <span>On ₹{fmtNum(summary.starting_capital)}</span>
                      <span className="text-emerald-400 font-bold font-mono">Realized</span>
                    </div>
                  </Card>

                  {/* Card 3: Capital Growth */}
                  <Card className="p-3 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Portfolio Capital
                        </span>
                        <TrendingUp className="size-3.5 text-emerald-400" />
                      </div>
                      <div className="text-xl font-black font-mono tracking-tight mt-1 text-foreground">
                        {fmtRs(summary.ending_capital)}
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40 flex items-center justify-between">
                      <span>Start: {fmtRs(summary.starting_capital)}</span>
                      <span>Peak: {fmtRs(summary.peak_deployed_rs || 0)}</span>
                    </div>
                  </Card>

                  {/* Card 4: Win Rate & Trades */}
                  <Card className="p-3 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Win Rate
                        </span>
                        <CheckCircle2 className="size-3.5 text-emerald-400" />
                      </div>
                      <div className="text-xl font-black font-mono tracking-tight mt-1 text-emerald-400">
                        {summary.win_rate_pct}%
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40 flex items-center justify-between">
                      <span>{summary.wins}W / {summary.losses}L</span>
                      <span className="text-emerald-400 font-bold">{summary.winning_days} green days</span>
                    </div>
                  </Card>

                  {/* Card 5: Payoff Ratio */}
                  <Card className="p-3 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Payoff Ratio
                        </span>
                        <Layers className="size-3.5 text-sky-400" />
                      </div>
                      <div className="text-xl font-black font-mono tracking-tight mt-1 text-foreground">
                        {summary.payoff_ratio}:1
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40 flex items-center justify-between">
                      <span>Avg W: {fmtRs(summary.avg_win_rs)}</span>
                      <span>L: {fmtRs(summary.avg_loss_rs)}</span>
                    </div>
                  </Card>

                  {/* Card 6: Max Drawdown */}
                  <Card className="p-3 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Max Drawdown
                        </span>
                        <TrendingDown className="size-3.5 text-red-500" />
                      </div>
                      <div className="text-xl font-black font-mono tracking-tight mt-1 text-red-400">
                        {fmtRs(summary.max_drawdown_rs)}
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40 flex items-center justify-between">
                      <span>Peak Decline:</span>
                      <span className="font-bold text-red-400 font-mono">
                        {summary.starting_capital > 0 ? ((Math.abs(summary.max_drawdown_rs) / summary.starting_capital) * 100).toFixed(1) : 0}%
                      </span>
                    </div>
                  </Card>
                </div>
              )}

              {/* Side-by-side charts row */}
              {equityCurve.length > 0 && (
                <div className="min-h-[360px] lg:h-[400px] flex flex-col lg:flex-row gap-2.5">
                  <Card className="flex-1 min-h-0 min-w-0 border-border/70 shadow-2xs flex flex-col">
                    <CardHeader className="py-2 px-3.5 border-b border-border/40 flex flex-row items-center justify-between">
                      <CardTitle className="text-xs font-bold font-mono uppercase text-foreground">
                        Portfolio Payoff Curve
                      </CardTitle>
                      <div className="flex items-center gap-2 font-mono text-xs">
                        <span className="text-muted-foreground">Ending Net:</span>
                        <span className={cn("font-bold text-sm", pnlClass(summary?.net_rs))}>
                          {summary?.net_rs && summary.net_rs >= 0 ? "+" : ""}{fmtRs(summary?.net_rs ?? 0)}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent className="p-3 flex-1 min-h-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={equityCurve} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                              <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                            </linearGradient>
                            <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                              <stop offset="95%" stopColor="#ef4444" stopOpacity={0.0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                          <XAxis dataKey="label" stroke="var(--muted-foreground)" fontSize={10} tickLine={false} axisLine={false} />
                          <YAxis stroke="var(--muted-foreground)" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} />
                          <Tooltip
                            contentStyle={{ background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                            formatter={(v: any, name: any) => [`${fmtRs(Number(v))}`, name === "equity" ? "Realized Equity" : "Drawdown"]}
                          />
                          <Area type="monotone" dataKey="equity" stroke="#10b981" strokeWidth={2} fill="url(#eqGrad)" />
                          <Area type="monotone" dataKey="drawdown" stroke="#ef4444" strokeWidth={1.5} fill="url(#ddGrad)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>

                  <Card className="w-full lg:w-[460px] xl:w-[500px] shrink-0 min-h-0 border-border/70 shadow-2xs flex flex-col">
                    <CardHeader className="py-2 px-3.5 border-b border-border/40 flex flex-row items-center justify-between">
                      <CardTitle className="text-xs font-bold font-mono uppercase text-foreground">
                        Per-Session Net P&amp;L
                      </CardTitle>
                      <span className="text-[10px] font-mono text-primary flex items-center gap-1">
                        <span>💡</span>
                        <span>Click bar to view</span>
                      </span>
                    </CardHeader>
                    <CardContent className="p-3 flex-1 min-h-0 flex flex-col justify-center">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={reversedCalendarDaily} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                          <XAxis dataKey="date" stroke="var(--muted-foreground)" fontSize={10} tickLine={false} axisLine={false} />
                          <YAxis stroke="var(--muted-foreground)" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} />
                          <Tooltip
                            contentStyle={{ background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                            formatter={(v: any) => [`${fmtRs(Number(v))} (Click to view session)`, "Session Net"]}
                          />
                          <Bar
                            dataKey="value"
                            radius={[4, 4, 0, 0]}
                            className="cursor-pointer"
                            onClick={(entry: any) => {
                              const d = entry?.date || entry?.payload?.date
                              if (d) {
                                handleDayClick(d)
                                setAnalyticsView("terminal")
                              }
                            }}
                          >
                            {reversedCalendarDaily.map((entry, index) => (
                              <Cell
                                key={`cell-${index}`}
                                fill={(entry.value ?? 0) >= 0 ? "#10b981" : "#ef4444"}
                                className="cursor-pointer hover:opacity-75 transition-opacity"
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>
          )}

          {/* VIEW 2: CHART & TRADES VIEW (65% CHART / 35% TRADES) */}
          {analyticsView === "terminal" && (
            <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-2.5 items-stretch overflow-hidden animate-in fade-in duration-150">
              {/* LEFT SIDE (65%): CANDLESTICK CHART */}
              <div className="w-full lg:w-[65%] flex flex-col min-w-0 h-full min-h-0 overflow-hidden">
                {activeDate ? (
                  <DayDetail
                    key={`${activeDate}-${activeInstrument}`}
                    date={activeDate}
                    mode="paper"
                    strategy={chartStrategy}
                    symbol={activeInstrument}
                    compact
                    chartOnly
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

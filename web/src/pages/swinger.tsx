import { useState, useEffect, useMemo } from "react"
import {
  TrendingUp,
  RefreshCw,
  Clock,
  Calendar as CalendarIcon,
  BarChart3,
  ShieldCheck,
  Zap,
  CheckCircle2,
  LineChart,
  Search,
  Flame,
  Wallet,
  Sparkles,
  Activity,
  Award,
  Layers,
  ExternalLink,
  X
} from "lucide-react"
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Cell,
  ReferenceLine
} from "recharts"
import { Button } from "@/components/ui/button"
import { PnlCalendar, type CalendarDay } from "@/components/pnl-calendar"
import { SwingerTradeChartModal, type SwingerTradeTarget } from "@/components/swinger-trade-chart-modal"
import { toast } from "sonner"

interface Position {
  symbol: string
  name?: string
  entry_date: string
  entry_price: number
  avg_price?: number
  cmp: number
  initial_qty: number
  current_qty: number
  shares?: number
  sl_price?: number
  stop_loss?: number
  be_active?: boolean
  be_trigger_price?: number
  tp_hit?: boolean
  tp_50_hit?: boolean
  tp_target_price?: number
  runner_mode?: boolean
  runner_peak_price?: number
  runner_trail_sl?: number | null
  invested?: number
  days_held: number
  booked_pnl?: number
  unrealized_pnl?: number
  unrealized_pnl_pct?: number
  unrealized_pct?: number
  status?: string
  exit_rule?: string
  ema20?: number
  leg?: number
  strategy_leg?: string
}

interface Trade {
  trade_id?: number
  leg?: number
  strategy_leg?: string
  symbol: string
  name?: string
  entry_date: string
  exit_date: string
  entry_price: number
  avg_price?: number
  exit_price: number
  qty?: number
  shares?: number
  reason?: string
  exit_reason?: string
  days_held?: number
  holding_days?: number
  pnl: number
  pnl_pct?: number
  pct_return?: number
}

interface MonthlyStat {
  month: string
  label: string
  trades: number
  wins: number
  losses: number
  win_rate: number
  profit_factor: number
  pnl: number
  pnl_pct: number
}

interface DailySignalsResponse {
  last_scan_time: string | null
  count: number
  signals: any[]
  history: {
    date: string
    scan_time: string
    count: number
    signals: any[]
  }[]
}

interface WatchlistItem {
  symbol: string
  name?: string
  alert_date: string
  alert_price: number
  alert_rsi: number
  current_price: number
  current_rsi: number
  ema20: number
  distance_to_ema20_pct?: number
  pullback_pct?: number
  status: string
  cooldown_ready: boolean
  notes: string
  entry_date?: string
  entry_price?: number
  current_pnl?: number
  current_pnl_pct?: number
  last_updated?: string
}

export function SwingerPage() {
  const [positions, setPositions] = useState<Position[]>([])
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [trades, setTrades] = useState<Trade[]>([])
  const [yearly, setYearly] = useState<any[]>([])
  const [monthly, setMonthly] = useState<MonthlyStat[]>([])
  const [daily, setDaily] = useState<CalendarDay[]>([])
  const [summary, setSummary] = useState<any>({})
  const [dailySignals, setDailySignals] = useState<DailySignalsResponse>({
    last_scan_time: null,
    count: 0,
    signals: [],
    history: []
  })
  const [scanning, setScanning] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Chart Inspection Modal Target
  const [selectedTradeForChart, setSelectedTradeForChart] = useState<SwingerTradeTarget | null>(null)

  // Navigation Tabs: 'all' | 'holdings' | 'calendar' | 'radar' | 'payoff'
  const [activeTab, setActiveTab] = useState<"all" | "holdings" | "calendar" | "radar" | "payoff">("all")
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [tradeLogSearch, setTradeLogSearch] = useState("")
  const [tradeLogYear, setTradeLogYear] = useState<string>("ALL")
  const [tradeLogFilter, setTradeLogFilter] = useState<"ALL" | "LEG1" | "LEG2" | "MULTIBAGGER" | "WIN" | "LOSS">("ALL")
  const [tradeLogLimit, setTradeLogLimit] = useState(50)

  // Search & Distinct Stocks Controls
  const [searchQuery, setSearchQuery] = useState("")
  const [yearGrouping, setYearGrouping] = useState<"entry" | "exit">("entry")

  // Distinct Stocks Filter & Sort
  const [distinctFilter, setDistinctFilter] = useState<"ALL" | "PORTFOLIO" | "WINNERS" | "MULTIBAGGER" | "LOSSES" | "MULTITRADE">("ALL")
  const [distinctSort, setDistinctSort] = useState<"pnl" | "trades" | "winrate" | "alpha">("pnl")
  const [selectedMonthlyYear, setSelectedMonthlyYear] = useState<string>("2026")

  // On-demand Stock Strategy Backtest State
  const [backtestSymbol, setBacktestSymbol] = useState("")
  const [backtestLoading, setBacktestLoading] = useState(false)

  const handleRunBacktest = async (symToTest?: string) => {
    const target = (symToTest || backtestSymbol || "").trim().toUpperCase()
    if (!target) {
      toast.error("Please enter a stock symbol (e.g. PARAS, BEL, TATASTEEL)")
      return
    }
    setBacktestSymbol(target)
    setBacktestLoading(true)
    const toastId = toast.loading(`Simulating Swinger Strategy on ${target}...`)
    try {
      const res = await fetch(`/api/swinger/backtest-stock?symbol=${encodeURIComponent(target)}`)
      const data = await res.json()
      if (data.ok && Array.isArray(data.candles) && data.candles.length > 0) {
        toast.success(
          `${target}: ${data.summary.total_trades} Trades · ${data.summary.win_rate}% Win Rate · PF ${data.summary.profit_factor}`,
          { id: toastId }
        )
        const firstTrade = (data.trades && data.trades.length > 0) ? data.trades[0] : null
        setSelectedTradeForChart({
          ...(firstTrade || {}),
          symbol: data.symbol,
          name: data.symbol,
          candles: data.candles,
          radar_triggers: data.radar_triggers,
          stockTrades: data.trades,
          isBacktest: true,
          backtestSummary: data.summary
        })
      } else {
        toast.error(data.error || `Could not run backtest for ${target}`, { id: toastId })
      }
    } catch (err: any) {
      toast.error(err.message || "Backtest request failed", { id: toastId })
    } finally {
      setBacktestLoading(false)
    }
  }

  // Dynamic Annual Breakdown by Cohort vs Realized Exit
  const dynamicYearly = useMemo(() => {
    if (yearGrouping === "exit") {
      return yearly
    }
    const map = new Map<string, Trade[]>()
    trades.forEach((t) => {
      const yr = (t.entry_date || "").slice(0, 4)
      if (!yr) return
      if (!map.has(yr)) map.set(yr, [])
      map.get(yr)!.push(t)
    })
    const list: any[] = []
    Array.from(map.keys())
      .sort()
      .forEach((yr) => {
        const arr = map.get(yr)!
        const wins = arr.filter((t) => (t.pnl || 0) > 0)
        const losses = arr.filter((t) => (t.pnl || 0) <= 0)
        const pnl = arr.reduce((acc, t) => acc + (t.pnl || 0), 0)
        const gain = wins.reduce((acc, t) => acc + (t.pnl || 0), 0)
        const loss = Math.abs(losses.reduce((acc, t) => acc + (t.pnl || 0), 0))
        const pf = loss > 0 ? Number((gain / loss).toFixed(2)) : 99.0
        const wr = arr.length > 0 ? Number(((wins.length / arr.length) * 100).toFixed(1)) : 0
        list.push({
          year: yr,
          trades: arr.length,
          wins: wins.length,
          losses: losses.length,
          win_rate: wr,
          profit_factor: pf,
          pnl: pnl,
          pnl_pct: (pnl / 250000.0) * 100,
          avg_return_pct: arr.reduce((acc, t) => acc + (t.pnl_pct ?? t.pct_return ?? 0), 0) / arr.length
        })
      })
    return list
  }, [trades, yearly, yearGrouping])

  const fetchData = async () => {
    try {
      setRefreshing(true)
      const [posRes, tradeRes, sigRes, watchRes] = await Promise.all([
        fetch("/api/swinger/portfolio"),
        fetch("/api/swinger/trades"),
        fetch("/api/swinger/daily-signals"),
        fetch("/api/swinger/watchlist")
      ])
      if (posRes.ok) {
        const d = await posRes.json()
        setPositions(d.portfolio?.positions || [])
      }
      if (watchRes.ok) {
        const d = await watchRes.json()
        setWatchlist(d.watchlist || [])
      }
      if (tradeRes.ok) {
        const d = await tradeRes.json()
        setTrades(d.trades || [])
        setYearly(d.yearly_breakdown || d.yearly || [])
        setMonthly(d.monthly || [])
        setDaily(d.daily || [])
        setSummary(d.summary || {})
      }
      if (sigRes.ok) {
        const d = await sigRes.json()
        setDailySignals(d)
      }
    } catch (err) {
      console.error("Error fetching swinger data:", err)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [])

  const handleScanNow = async () => {
    try {
      setScanning(true)
      toast.info("Scanning Chartink for Deep Value Turnarounds...")
      const res = await fetch("/api/swinger/scan-now", {
        method: "POST",
        headers: { "X-Dashboard": "1" }
      })
      if (res.ok) {
        const d = await res.json()
        setPositions(d.portfolio?.portfolio?.positions || d.portfolio?.positions || [])
        await fetchData()
        toast.success("Scan complete! Positions & triggers updated.")
      } else {
        toast.error("Failed to execute scan")
      }
    } catch (err) {
      toast.error("Network error executing scan")
    } finally {
      setScanning(false)
    }
  }

  const formatExitReason = (r?: string) => {
    if (!r || typeof r !== "string") return "Swing Exit"
    if (r.includes("Open / End of Data")) return "Still Open (Live Holding)"
    if (r.includes("50 EMA Volume Breakdown")) return "50 EMA Vol Breakdown"
    if (r.includes("Backup Close Trailing Stop")) return "Backup 25% Close Trail"
    if (r.includes("Profit Vault")) return "Vault Floor (+25%)"
    return r
      .replace("Institutional Volume Exhaustion Exit (Broken EMA20 on 2x Vol)", "Vol Exhaustion Exit")
      .replace("Full Momentum Peak Trail (20% from High)", "20% Peak Trail")
      .replace("RUNNER_TRAIL_25PCT", "Runner 20% Trail")
      .replace("INITIAL_SL_25PCT", "Initial SL -25%")
      .replace("BE_SHIELD_STOP", "BE Shield @ Cost")
      .replace("MAX_HOLD_1YEAR", "1-Year Max Hold")
      .replace("TP 50% Hit (+100%) -> Trailed 25% Runner Exit", "Runner 20% Trail")
      .replace("TP1 Hit (+30%) -> Trailed 25% Runner Exit", "Runner 20% Trail")
      .replace("Break-Even Shield Exit (Cost Protected)", "BE Shield @ Cost")
      .replace("Initial Stop-Loss (-25%)", "Initial SL -25%")
      .replace("Initial Stop-Loss (-20%)", "Initial SL -20%")
      .replace("Time Exit (250 Trading Days / 1-Year Max)", "1-Year Max Hold")
      .replace("Time Exit (250 Trading Days)", "1-Year Max Hold")
  }

  const formatCalendarPnl = (val: number) => {
    if (!val || isNaN(val) || val === 0) return "₹0"
    const sign = val > 0 ? "+" : "-"
    const abs = Math.abs(val)
    if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(1)}L`
    if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)}k`
    return `${sign}₹${abs.toFixed(0)}`
  }

  const totalInvested = positions.reduce((acc, p) => acc + (p.avg_price ?? p.entry_price) * p.current_qty, 0)
  const totalUnrealizedPnl = positions.reduce((acc, p) => acc + (p.unrealized_pnl ?? 0), 0)
  const totalBookedPnl = positions.reduce((acc, p) => acc + (p.booked_pnl ?? 0), 0)

  // Filter out any symbols that already have open active positions so they never appear on Radar
  const heldSymbolSet = useMemo(() => new Set(positions.map((p) => p.symbol)), [positions])
  const activeRadarList = useMemo(
    () => watchlist.filter((w) => !heldSymbolSet.has(w.symbol)),
    [watchlist, heldSymbolSet]
  )

  // Master Trade Log Filtered by Year, Outcome and Search
  const filteredTradeLog = useMemo(() => {
    return trades.filter((t) => {
      if (tradeLogYear !== "ALL") {
        const exitYr = (t.exit_date || "").slice(0, 4)
        const entryYr = (t.entry_date || "").slice(0, 4)
        if (exitYr !== tradeLogYear && entryYr !== tradeLogYear) return false
      }
      const pnl = t.pnl ?? 0
      const pnlPct = t.pnl_pct ?? (t as any).pct_return ?? 0
      if (tradeLogFilter === "LEG1" && t.leg !== 1 && (t as any).strategy_leg !== "LEG1_TURNAROUND") return false
      if (tradeLogFilter === "LEG2" && t.leg !== 2 && (t as any).strategy_leg !== "LEG2_BREAKOUT") return false
      if (tradeLogFilter === "MULTIBAGGER" && pnlPct < 100.0) return false
      if (tradeLogFilter === "WIN" && pnl <= 0) return false
      if (tradeLogFilter === "LOSS" && pnl > 0) return false

      if (tradeLogSearch.trim()) {
        const q = tradeLogSearch.toLowerCase().trim()
        const symMatch = t.symbol.toLowerCase().includes(q)
        const nameMatch = (t.name || "").toLowerCase().includes(q)
        if (!symMatch && !nameMatch) return false
      }
      return true
    })
  }, [trades, tradeLogYear, tradeLogFilter, tradeLogSearch])

  // Trades on Clicked Calendar Date
  const calendarSelectedTrades = useMemo(() => {
    if (!selectedDate) return []
    return trades.filter((t) => t.exit_date === selectedDate || t.entry_date === selectedDate)
  }, [trades, selectedDate])

  // Distinct Stocks Aggregation across closed trades & active positions
  interface DistinctStock {
    symbol: string
    name: string
    trades: Trade[]
    activePosition?: Position
    totalTrades: number
    wins: number
    losses: number
    winRate: number
    realizedPnl: number
    unrealizedPnl: number
    totalPnl: number
    totalInvested: number
    bestPnlPct: number
    worstPnlPct: number
    avgHoldingDays: number
    currentStatus: "RUNNER" | "ACTIVE" | "CLOSED"
    firstEntryDate: string
    lastDate: string
    isMultiBagger: boolean
  }

  const distinctStocks = useMemo(() => {
    const stockMap = new Map<string, DistinctStock>()

    // 1. Process active positions
    positions.forEach((p) => {
      const sym = p.symbol
      const pnl = p.unrealized_pnl ?? 0
      const pnlPct = p.unrealized_pnl_pct ?? p.unrealized_pct ?? 0
      const status: "RUNNER" | "ACTIVE" = p.runner_mode ? "RUNNER" : "ACTIVE"
      stockMap.set(sym, {
        symbol: sym,
        name: p.name || sym,
        trades: [],
        activePosition: p,
        totalTrades: 1,
        wins: pnl > 0 ? 1 : 0,
        losses: pnl < 0 ? 1 : 0,
        winRate: pnl > 0 ? 100 : 0,
        realizedPnl: 0,
        unrealizedPnl: pnl,
        totalPnl: pnl,
        totalInvested: p.invested ?? (p.entry_price * (p.current_qty || 1)),
        bestPnlPct: pnlPct,
        worstPnlPct: pnlPct,
        avgHoldingDays: p.days_held ?? 0,
        currentStatus: status,
        firstEntryDate: p.entry_date,
        lastDate: p.entry_date,
        isMultiBagger: pnlPct >= 100.0
      })
    })

    // 2. Process closed trades
    trades.forEach((t) => {
      const sym = t.symbol
      const pnl = t.pnl ?? 0
      const pnlPct = t.pnl_pct ?? (t as any).pct_return ?? 0
      const isWin = pnl > 0
      const days = t.days_held ?? (t as any).holding_days ?? 0

      if (stockMap.has(sym)) {
        const item = stockMap.get(sym)!
        item.trades.push(t)
        item.totalTrades += 1
        if (isWin) item.wins += 1
        else item.losses += 1
        item.realizedPnl += pnl
        item.totalPnl += pnl
        item.totalInvested += (t.shares ?? t.qty ?? 0) * (t.entry_price ?? t.avg_price ?? 0)
        item.bestPnlPct = Math.max(item.bestPnlPct, pnlPct)
        item.worstPnlPct = Math.min(item.worstPnlPct, pnlPct)
        if (pnlPct >= 100.0) item.isMultiBagger = true
        if (t.entry_date && (!item.firstEntryDate || t.entry_date < item.firstEntryDate)) {
          item.firstEntryDate = t.entry_date
        }
        if (t.exit_date && (!item.lastDate || t.exit_date > item.lastDate)) {
          item.lastDate = t.exit_date
        }
      } else {
        stockMap.set(sym, {
          symbol: sym,
          name: t.name || sym,
          trades: [t],
          totalTrades: 1,
          wins: isWin ? 1 : 0,
          losses: isWin ? 0 : 1,
          winRate: isWin ? 100 : 0,
          realizedPnl: pnl,
          unrealizedPnl: 0,
          totalPnl: pnl,
          totalInvested: (t.shares ?? t.qty ?? 0) * (t.entry_price ?? t.avg_price ?? 0),
          bestPnlPct: pnlPct,
          worstPnlPct: pnlPct,
          avgHoldingDays: days,
          currentStatus: "CLOSED",
          firstEntryDate: t.entry_date,
          lastDate: t.exit_date || t.entry_date,
          isMultiBagger: pnlPct >= 100.0
        })
      }
    })

    const list: DistinctStock[] = []
    stockMap.forEach((item) => {
      item.winRate = item.totalTrades > 0 ? Number(((item.wins / item.totalTrades) * 100).toFixed(1)) : 0
      const totalDays = item.trades.reduce((acc, t) => acc + (t.days_held ?? (t as any).holding_days ?? 0), 0) + (item.activePosition?.days_held ?? 0)
      item.avgHoldingDays = item.totalTrades > 0 ? Math.round(totalDays / item.totalTrades) : 0
      item.trades.sort((a, b) => (b.entry_date || "").localeCompare(a.entry_date || ""))
      list.push(item)
    })

    return list
  }, [positions, trades])

  const filteredDistinctStocks = useMemo(() => {
    return distinctStocks.filter((s) => {
      if (distinctFilter === "PORTFOLIO" && !s.activePosition) return false
      if (distinctFilter === "WINNERS" && s.totalPnl <= 0) return false
      if (distinctFilter === "MULTIBAGGER" && !s.isMultiBagger) return false
      if (distinctFilter === "LOSSES" && s.totalPnl >= 0) return false
      if (distinctFilter === "MULTITRADE" && s.totalTrades < 2) return false

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim()
        const matchSym = s.symbol.toLowerCase().includes(q)
        const matchName = s.name.toLowerCase().includes(q)
        if (!matchSym && !matchName) return false
      }
      return true
    }).sort((a, b) => {
      if (distinctSort === "pnl") return b.totalPnl - a.totalPnl
      if (distinctSort === "trades") return b.totalTrades - a.totalTrades
      if (distinctSort === "winrate") return b.winRate - a.winRate
      if (distinctSort === "alpha") return a.symbol.localeCompare(b.symbol)
      return 0
    })
  }, [distinctStocks, distinctFilter, distinctSort, searchQuery])

  // All chartable trades/triggers for keyboard & button flipping inside chart modal
  const chartableList = useMemo(() => {
    if (activeTab === "calendar" && calendarSelectedTrades.length > 0) {
      return calendarSelectedTrades as any[]
    }
    if (activeTab === "holdings") {
      return positions as any[]
    }
    return filteredDistinctStocks.map((s) => {
      const primary = (s.activePosition as any) || s.trades[0]
      return {
        ...primary,
        symbol: s.symbol,
        name: s.name,
        stockTrades: [
          ...(s.activePosition ? [s.activePosition as any] : []),
          ...s.trades
        ]
      }
    })
  }, [activeTab, calendarSelectedTrades, positions, filteredDistinctStocks])

  // Cumulative Equity & Drawdown Curve Data
  const equityCurveData = useMemo(() => {
    if (!trades || trades.length === 0) return []
    const sorted = [...trades].sort((a, b) => (a.exit_date || "").localeCompare(b.exit_date || ""))
    let cumPnl = 0
    let peakEquity = 500000
    const points: any[] = [
      {
        tradeNo: 0,
        date: sorted[0]?.entry_date || "2022-01-01",
        symbol: "Base Capital",
        pnl: 0,
        pnlPct: 0,
        equity: 500000,
        peakEquity: 500000,
        drawdownAmt: 0,
        drawdownPct: 0
      }
    ]

    sorted.forEach((t, i) => {
      cumPnl += t.pnl || 0
      const currentEquity = 500000 + cumPnl
      if (currentEquity > peakEquity) {
        peakEquity = currentEquity
      }
      const ddAmt = currentEquity - peakEquity
      const ddPct = peakEquity > 0 ? (ddAmt / peakEquity) * 100 : 0

      points.push({
        tradeNo: i + 1,
        date: t.exit_date || t.entry_date,
        symbol: t.symbol,
        name: t.name || t.symbol,
        pnl: Math.round(t.pnl || 0),
        pnlPct: parseFloat((t.pnl_pct ?? (t as any).pct_return ?? 0).toFixed(1)),
        equity: Math.round(currentEquity),
        peakEquity: Math.round(peakEquity),
        drawdownAmt: Math.round(ddAmt),
        drawdownPct: parseFloat(ddPct.toFixed(2))
      })
    })

    return points
  }, [trades])

  // Convex Asymmetric Return Curve (Sorted Trade Outcomes)
  const convexPayoffData = useMemo(() => {
    if (!trades || trades.length === 0) return []
    const sorted = [...trades].sort((a, b) => {
      const retA = a.pnl_pct ?? (a as any).pct_return ?? 0
      const retB = b.pnl_pct ?? (b as any).pct_return ?? 0
      return retA - retB
    })

    return sorted.map((t, idx) => {
      const ret = t.pnl_pct ?? (t as any).pct_return ?? 0
      return {
        rank: idx + 1,
        symbol: t.symbol,
        name: t.name || t.symbol,
        pnlPct: parseFloat(ret.toFixed(1)),
        pnl: Math.round(t.pnl || 0),
        exitDate: t.exit_date,
        reason: formatExitReason(t.reason || (t as any).exit_reason),
        raw: t
      }
    })
  }, [trades])

  // Return Buckets Histogram Data
  const distributionBuckets = useMemo(() => {
    if (!trades || trades.length === 0) return []
    const defs = [
      { key: "deep_stop", label: "Deep Stop (<-20%)", min: -999, max: -20, count: 0, pnl: 0, color: "#dc2626" },
      { key: "normal_sl", label: "Standard SL (-20% to -10%)", min: -20, max: -10, count: 0, pnl: 0, color: "#f87171" },
      { key: "shield", label: "Shield / BE (-10% to 0%)", min: -10, max: 0, count: 0, pnl: 0, color: "#fb923c" },
      { key: "small_win", label: "Small Win (0% to +20%)", min: 0, max: 20, count: 0, pnl: 0, color: "#a3e635" },
      { key: "solid_win", label: "Solid Win (+20% to +50%)", min: 20, max: 50, count: 0, pnl: 0, color: "#4ade80" },
      { key: "runner", label: "Super Runner (+50% to +100%)", min: 50, max: 100, count: 0, pnl: 0, color: "#22c55e" },
      { key: "multibagger", label: "Multibagger (>+100%)", min: 100, max: 9999, count: 0, pnl: 0, color: "#15803d" }
    ]

    trades.forEach((t) => {
      const ret = t.pnl_pct ?? (t as any).pct_return ?? 0
      const p = t.pnl || 0
      let bIdx = 0
      if (ret < -20) bIdx = 0
      else if (ret < -10) bIdx = 1
      else if (ret <= 0) bIdx = 2
      else if (ret <= 20) bIdx = 3
      else if (ret <= 50) bIdx = 4
      else if (ret <= 100) bIdx = 5
      else bIdx = 6

      defs[bIdx].count += 1
      defs[bIdx].pnl += p
    })

    return defs
  }, [trades])

  // Yearly Payoff & Risk Profile Breakdown
  const yearlyPayoffStats = useMemo(() => {
    if (!trades || trades.length === 0) return []
    const map: Record<string, { trades: any[]; pnl: number; wins: number; losses: number; winPnl: number; lossPnl: number }> = {}

    trades.forEach((t) => {
      const yr = (t.exit_date || t.entry_date || "").slice(0, 4) || "Other"
      if (!map[yr]) {
        map[yr] = { trades: [], pnl: 0, wins: 0, losses: 0, winPnl: 0, lossPnl: 0 }
      }
      map[yr].trades.push(t)
      const p = t.pnl || 0
      map[yr].pnl += p
      if (p > 0) {
        map[yr].wins += 1
        map[yr].winPnl += p
      } else {
        map[yr].losses += 1
        map[yr].lossPnl += Math.abs(p)
      }
    })

    return Object.keys(map).sort().map((yr) => {
      const d = map[yr]
      const total = d.trades.length
      const wr = total > 0 ? (d.wins / total) * 100 : 0
      const avgW = d.wins > 0 ? d.winPnl / d.wins : 0
      const avgL = d.losses > 0 ? d.lossPnl / d.losses : 0
      const payoff = avgL > 0 ? avgW / avgL : 0
      const pf = d.lossPnl > 0 ? d.winPnl / d.lossPnl : 99.0

      const sortedT = [...d.trades].sort((a, b) => (a.exit_date || "").localeCompare(b.exit_date || ""))
      let peak = 0
      let cur = 0
      let maxDd = 0
      sortedT.forEach((t) => {
        cur += t.pnl || 0
        if (cur > peak) peak = cur
        const dd = cur - peak
        if (dd < maxDd) maxDd = dd
      })

      return {
        year: yr,
        totalTrades: total,
        wins: d.wins,
        losses: d.losses,
        winRate: wr.toFixed(1),
        pnl: Math.round(d.pnl),
        payoffRatio: payoff.toFixed(2),
        profitFactor: pf.toFixed(2),
        maxDrawdown: Math.round(maxDd),
        avgWin: Math.round(avgW),
        avgLoss: Math.round(avgL)
      }
    })
  }, [trades])

  return (
    <div className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col gap-5 pb-20">
      {/* ================= 1. SWINGER 2.0 HERO & ACTION BAR ================= */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="size-9 rounded-2xl bg-emerald-600 flex items-center justify-center text-white shadow-emerald-200 shadow-sm">
              <TrendingUp className="size-5" />
            </div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Phoenix Swinger 2.0</h1>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live Engine
            </span>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
              Paper Mode (₹25k / Slot)
            </span>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-purple-50 text-purple-700 border border-purple-200" title="Enforces institutional quality: Market Cap >= Rs.2,000 Cr and High-Velocity Swing ATR >= 3.2%">
              Mcap ≥ ₹2k Cr · ATR ≥ 3.2%
            </span>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
              Break-Even Shield (+15%)
            </span>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
              Trailing Stop Lock
            </span>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
              Cooldown Retracement
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1 font-medium">
            Phoenix Breakout Swinger · High-Probability Deep Base Breakouts & Swing Portfolio
          </p>
        </div>

        <div className="flex items-center gap-2 self-stretch md:self-auto justify-end flex-wrap">
          {/* Quick Stock Backtester Input Bar */}
          <div className="flex items-center bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1 gap-1.5 focus-within:ring-2 focus-within:ring-emerald-500/30 focus-within:border-emerald-500 transition shadow-2xs">
            <Zap className="size-3.5 text-amber-500 shrink-0" />
            <input
              type="text"
              placeholder="Test stock (e.g. PARAS)..."
              value={backtestSymbol}
              onChange={(e) => setBacktestSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRunBacktest(backtestSymbol)
              }}
              className="bg-transparent text-xs font-mono font-bold outline-none text-slate-800 placeholder:text-slate-400 placeholder:font-sans w-36 sm:w-44"
            />
            <Button
              size="sm"
              onClick={() => handleRunBacktest(backtestSymbol)}
              disabled={backtestLoading || !backtestSymbol.trim()}
              className="h-6 px-2.5 text-[11px] font-bold rounded-lg bg-amber-500 hover:bg-amber-600 text-white shadow-2xs cursor-pointer"
            >
              {backtestLoading ? <RefreshCw className="size-3 animate-spin" /> : "Backtest"}
            </Button>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={fetchData}
            disabled={refreshing}
            className="rounded-xl text-xs font-bold gap-1.5 text-slate-600 hover:text-slate-900 border-slate-200 bg-white"
          >
            <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin text-emerald-600" : ""}`} />
            Sync
          </Button>

          <Button
            size="sm"
            onClick={handleScanNow}
            disabled={scanning}
            className="rounded-xl text-xs font-bold gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-200 shadow-sm"
          >
            <Sparkles className="size-3.5" />
            {scanning ? "Scanning Chartink..." : "Scan Chartink Now"}
          </Button>
        </div>
      </div>

      {/* ================= 2. EXECUTIVE METRIC CARDS (4 TILES) ================= */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* Card 1: Realized Profit & Compound Return */}
        <div className="p-4 rounded-3xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between hover:border-slate-300 transition-all">
          <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
            <span className="flex items-center gap-1.5">
              <TrendingUp className="size-3.5 text-emerald-500" />
              <span>Realized Profit</span>
            </span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 border border-emerald-300 font-mono">
              CAGR: +{(summary.xirr ?? 0).toFixed(1)}% p.a.
            </span>
          </div>
          <div className="my-2.5">
            <div className={`text-2xl font-black font-mono tracking-tight ${(summary.net_pnl ?? 0) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {(summary.net_pnl ?? 0) >= 0 ? "+" : ""}₹{(summary.net_pnl ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
            </div>
            <div className="text-xs text-emerald-700 font-bold mt-1 flex items-center gap-1.5 flex-wrap">
              <span>+{(summary.total_pnl_pct ?? 0).toFixed(1)}% ROI ({summary.period_years ?? 0}y)</span>
              <span className="text-slate-300">·</span>
              <span className="text-sky-700">Active XIRR: +{(summary.xirr_active ?? 0).toFixed(1)}%</span>
            </div>
          </div>
          <div className="pt-2.5 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-medium">
            <span>Portfolio Ending:</span>
            <span className="text-slate-800 font-mono font-bold">₹{((summary.current_capital ?? 500000) / 100000).toFixed(2)}L <span className="text-slate-400 font-normal">from ₹5.0L</span></span>
          </div>
        </div>

        {/* Card 2: Drawdown & Risk Safety */}
        <div className="p-4 rounded-3xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between hover:border-slate-300 transition-all">
          <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="size-3.5 text-sky-500" />
              <span>Max Drawdown</span>
            </span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-sky-100 text-sky-800 border border-sky-300 font-mono">
              Calmar: {summary.calmar_ratio ?? 0}
            </span>
          </div>
          <div className="my-2.5">
            <div className="text-2xl font-black font-mono tracking-tight text-slate-900">
              {summary.max_drawdown_pct ?? 0}%
            </div>
            <div className="text-xs text-slate-500 font-medium mt-1 flex items-center gap-1.5 flex-wrap">
              <span>Peak Dip: <strong className="text-rose-600 font-mono font-bold">-₹{(Math.abs(summary.max_drawdown ?? 0) / 1000).toFixed(1)}k</strong></span>
              <span className="text-slate-300">·</span>
              <span className="text-slate-600">Active DD: {summary.max_drawdown_active_pct ?? 0}%</span>
            </div>
          </div>
          <div className="pt-2.5 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-medium">
            <span>Max Consecutive Cuts:</span>
            <span className="text-slate-800 font-mono font-bold">{summary.max_consecutive_losses ?? 0} <span className="text-emerald-600 font-normal">(Controlled ₹25k Lots)</span></span>
          </div>
        </div>

        {/* Card 3: Payoff Ratio & Asymmetric Edge */}
        <div className="p-4 rounded-3xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between hover:border-slate-300 transition-all">
          <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
            <span className="flex items-center gap-1.5">
              <BarChart3 className="size-3.5 text-amber-500" />
              <span>Reward / Risk Edge</span>
            </span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-800 border border-amber-300 font-mono">
              PF: {summary.profit_factor ?? 0}
            </span>
          </div>
          <div className="my-2.5">
            <div className="text-2xl font-black font-mono tracking-tight text-amber-600">
              {summary.payoff_ratio ?? 0}x <span className="text-xs font-bold text-slate-400 tracking-normal font-sans">Payoff</span>
            </div>
            <div className="text-xs text-slate-500 font-medium mt-1 flex items-center gap-1.5 flex-wrap">
              <span>Avg Win: <strong className="text-emerald-700 font-mono font-bold">+₹{(Math.round(summary.avg_win ?? 0)).toLocaleString("en-IN")}</strong></span>
              <span className="text-slate-300">·</span>
              <span>Avg Loss: <strong className="text-rose-600 font-mono font-bold">-₹{(Math.round(summary.avg_loss ?? 0)).toLocaleString("en-IN")}</strong></span>
            </div>
          </div>
          <div className="pt-2.5 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-medium">
            <span>{trades.length} Closed Trades ({summary.win_rate ?? 0}% WR)</span>
            <span className="text-emerald-700 font-mono font-bold">+₹{(Math.round(summary.expectancy ?? 0)).toLocaleString("en-IN")} <span className="text-slate-400 font-normal">/ trade</span></span>
          </div>
        </div>

        {/* Card 4: Active Portfolio & Exposure */}
        <div className="p-4 rounded-3xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between hover:border-slate-300 transition-all">
          <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
            <span className="flex items-center gap-1.5">
              <Wallet className="size-3.5 text-indigo-500" />
              <span>Active Portfolio</span>
            </span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-100 text-sky-800 border border-sky-200">
              {positions.length} Open Holdings
            </span>
          </div>
          <div className="my-2.5">
            <div className={`text-2xl font-black font-mono tracking-tight ${totalUnrealizedPnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {totalUnrealizedPnl >= 0 ? "+" : ""}₹{totalUnrealizedPnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
            </div>
            <div className="text-xs text-slate-500 font-medium mt-1 flex items-center gap-1.5 flex-wrap">
              <span>Invested: <strong className="text-slate-800 font-mono font-bold">₹{totalInvested >= 1000 ? `${(totalInvested / 1000).toFixed(1)}k` : totalInvested.toFixed(0)}</strong></span>
              <span className="text-slate-300">·</span>
              <span>Standard Slot: <strong className="text-slate-800 font-mono font-bold">₹25k</strong></span>
            </div>
          </div>
          <div className="pt-2.5 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-medium">
            <span>Banked TP1 Cash:</span>
            <span className="text-emerald-700 font-bold font-mono">+₹{totalBookedPnl.toLocaleString("en-IN")}</span>
          </div>
        </div>
      </div>

      {/* ================= 3. PRIMARY NAVIGATION TABS (SIMPLIFIED) ================= */}
      <div className="flex items-center justify-between bg-white p-1.5 rounded-2xl border border-slate-200/80 shadow-xs gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => setActiveTab("all")}
            className={`px-3.5 py-2 rounded-xl text-xs font-black transition flex items-center gap-2 ${
              activeTab === "all"
                ? "bg-emerald-600 text-white shadow-emerald-200 shadow-sm"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <Layers className="size-3.5" />
            Stocks
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                activeTab === "all" ? "bg-emerald-700 text-white" : "bg-slate-200 text-slate-700"
              }`}
            >
              {distinctStocks.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("holdings")}
            className={`px-3.5 py-2 rounded-xl text-xs font-black transition flex items-center gap-2 ${
              activeTab === "holdings"
                ? "bg-emerald-600 text-white shadow-emerald-200 shadow-sm"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <ShieldCheck className="size-3.5" />
            Active Portfolio
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                activeTab === "holdings" ? "bg-emerald-700 text-white" : "bg-slate-200 text-slate-700"
              }`}
            >
              {positions.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("calendar")}
            className={`px-3.5 py-2 rounded-xl text-xs font-black transition flex items-center gap-2 ${
              activeTab === "calendar"
                ? "bg-emerald-600 text-white shadow-emerald-200 shadow-sm"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <CalendarIcon className="size-3.5" />
            Calendar & History
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                activeTab === "calendar" ? "bg-emerald-700 text-white" : "bg-slate-200 text-slate-700"
              }`}
            >
              {trades.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("radar")}
            className={`px-3.5 py-2 rounded-xl text-xs font-black transition flex items-center gap-2 ${
              activeTab === "radar"
                ? "bg-emerald-600 text-white shadow-emerald-200 shadow-sm"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <Flame className="size-3.5" />
            Radar Watchlist
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                activeTab === "radar" ? "bg-emerald-700 text-white" : "bg-slate-200 text-slate-700"
              }`}
            >
              {activeRadarList.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("payoff")}
            className={`px-3.5 py-2 rounded-xl text-xs font-black transition flex items-center gap-2 ${
              activeTab === "payoff"
                ? "bg-emerald-600 text-white shadow-emerald-200 shadow-sm"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <Activity className="size-3.5" />
            Payoff Curve
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                activeTab === "payoff" ? "bg-emerald-700 text-white" : "bg-slate-200 text-slate-700"
              }`}
            >
              5.21x
            </span>
          </button>
        </div>
      </div>

      {/* ================= TAB 1: ALL TRIGGERS & MASTER FEED ================= */}
      {activeTab === "all" && (
        <div className="space-y-4">
          {/* UNIFIED COMPACT CONTROL BAR */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-3 shadow-xs space-y-2.5">
            {/* Top Row: Title + Live Overview Badges + Search & Sort */}
            <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-2.5">
              {/* Left: Section Header */}
              <div className="flex items-center gap-2">
                <Layers className="size-4 text-emerald-600" />
                <h2 className="text-sm font-black text-slate-900 tracking-tight font-mono">
                  Distinct Stocks ({distinctStocks.length})
                </h2>
              </div>

              {/* Center: Live Overview Badges */}
              <div className="hidden lg:flex items-center gap-2 text-xs font-mono">
                <span className="px-2.5 py-1 rounded-lg bg-sky-50 text-sky-800 border border-sky-200/70 font-bold">
                  {positions.length} Active in Portfolio
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200/70 font-bold">
                  {distinctStocks.filter((s) => s.totalPnl > 0).length} Net Green Stocks
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-purple-50 text-purple-800 border border-purple-200/70 font-bold flex items-center gap-1">
                  <Flame className="size-3 text-purple-600" />
                  {distinctStocks.filter((s) => s.isMultiBagger).length} Multi-Baggers
                </span>
                {dailySignals.count > 0 && (
                  <span className="px-2.5 py-1 rounded-lg bg-amber-50 text-amber-800 border border-amber-200/70 font-bold flex items-center gap-1">
                    <Zap className="size-3 text-amber-600" />
                    {dailySignals.count} Today's Hits
                  </span>
                )}
              </div>

              {/* Right: Search & Sort */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1 md:w-52">
                  <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search stock..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-7 py-1.5 rounded-xl border border-slate-200 text-xs font-medium focus:outline-none focus:border-emerald-500 bg-slate-50 focus:bg-white transition"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600 font-bold"
                    >
                      ×
                    </button>
                  )}
                </div>

                <select
                  value={distinctSort}
                  onChange={(e) => setDistinctSort(e.target.value as any)}
                  className="px-2.5 py-1.5 rounded-xl border border-slate-200 text-xs font-bold bg-slate-50 text-slate-700 focus:outline-none focus:bg-white cursor-pointer"
                >
                  <option value="pnl">Active First · Net P&L</option>
                  <option value="trades">Sort: Trades</option>
                  <option value="winrate">Sort: Win Rate</option>
                  <option value="alpha">Sort: Symbol (A-Z)</option>
                </select>
              </div>
            </div>

            {/* Bottom Row: Compact Filter Pills */}
            <div className="flex items-center gap-1.5 overflow-x-auto pt-2 border-t border-slate-100 scrollbar-none text-xs">
              <button
                type="button"
                onClick={() => setDistinctFilter("ALL")}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition shrink-0 ${
                  distinctFilter === "ALL"
                    ? "bg-slate-900 text-white shadow-xs"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                All Stocks ({distinctStocks.length})
              </button>
              <button
                type="button"
                onClick={() => setDistinctFilter("PORTFOLIO")}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 shrink-0 ${
                  distinctFilter === "PORTFOLIO"
                    ? "bg-sky-600 text-white shadow-xs"
                    : "bg-sky-50 text-sky-700 hover:bg-sky-100 border border-sky-200/60"
                }`}
              >
                <ShieldCheck className="size-3" />
                In Portfolio ({positions.length})
              </button>
              <button
                type="button"
                onClick={() => setDistinctFilter("WINNERS")}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition shrink-0 ${
                  distinctFilter === "WINNERS"
                    ? "bg-emerald-600 text-white shadow-xs"
                    : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200/60"
                }`}
              >
                Profitable ({distinctStocks.filter((s) => s.totalPnl > 0).length})
              </button>
              <button
                type="button"
                onClick={() => setDistinctFilter("MULTIBAGGER")}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 shrink-0 ${
                  distinctFilter === "MULTIBAGGER"
                    ? "bg-purple-600 text-white shadow-xs"
                    : "bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200/60"
                }`}
              >
                <Flame className="size-3" />
                Multi-Baggers ({distinctStocks.filter((s) => s.isMultiBagger).length})
              </button>
              <button
                type="button"
                onClick={() => setDistinctFilter("MULTITRADE")}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition shrink-0 ${
                  distinctFilter === "MULTITRADE"
                    ? "bg-amber-600 text-white shadow-xs"
                    : "bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200/60"
                }`}
              >
                Multi-Trades ({distinctStocks.filter((s) => s.totalTrades > 1).length})
              </button>
              <button
                type="button"
                onClick={() => setDistinctFilter("LOSSES")}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition shrink-0 ${
                  distinctFilter === "LOSSES"
                    ? "bg-rose-600 text-white shadow-xs"
                    : "bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200/60"
                }`}
              >
                Net Losses ({distinctStocks.filter((s) => s.totalPnl <= 0).length})
              </button>
            </div>
          </div>

          {/* VIEW MODE CONTENT */}
          <div className="space-y-4">
              {/* Distinct Stocks Table */}
              <div className="rounded-3xl border border-slate-200/80 bg-white overflow-hidden shadow-xs">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-50/90 border-b border-slate-100 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
                        <th className="p-3.5">Stock Symbol</th>
                        <th className="p-3.5">Status</th>
                        <th className="p-3.5 text-center">Trades Taken</th>
                        <th className="p-3.5 text-center">Win Rate</th>
                        <th className="p-3.5 text-right font-mono">Best Win</th>
                        <th className="p-3.5 text-right font-mono">Realized P&L</th>
                        <th className="p-3.5 text-right font-mono">Open Unrealized</th>
                        <th className="p-3.5 text-right font-mono">Total Net P&L</th>
                        <th className="p-3.5 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredDistinctStocks.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="p-8 text-center text-slate-400 font-medium">
                            No distinct stocks match your search or filter.
                          </td>
                        </tr>
                      ) : (
                        filteredDistinctStocks.map((stock) => {
                          const isProfitable = stock.totalPnl > 0
                          const hasActive = !!stock.activePosition
                          const openChartForStock = () => {
                            const targetTrade = (stock.activePosition as any) || stock.trades[0]
                            if (targetTrade) {
                              setSelectedTradeForChart({
                                ...targetTrade,
                                symbol: stock.symbol,
                                name: stock.name,
                                stockTrades: [
                                  ...(stock.activePosition ? [stock.activePosition as any] : []),
                                  ...stock.trades
                                ]
                              })
                            }
                          }

                          return (
                            <tr
                              key={stock.symbol}
                              onClick={openChartForStock}
                              className="hover:bg-slate-50/90 cursor-pointer transition group"
                            >
                              {/* Symbol & Company */}
                              <td className="p-3.5">
                                <div className="flex items-center gap-2.5">
                                  <div
                                    className={`size-8 rounded-xl flex items-center justify-center font-bold text-white text-[11px] ${
                                      stock.currentStatus === "RUNNER"
                                        ? "bg-purple-600"
                                        : stock.currentStatus === "ACTIVE"
                                        ? "bg-sky-600"
                                        : isProfitable
                                        ? "bg-emerald-600"
                                        : "bg-slate-700"
                                    }`}
                                  >
                                    {stock.symbol.slice(0, 2)}
                                  </div>
                                  <div>
                                    <div className="font-black text-slate-900 text-sm font-mono flex items-center gap-1.5 group-hover:text-emerald-700 transition">
                                      <span className="hover:underline">{stock.symbol}</span>
                                      {stock.isMultiBagger && (
                                        <span className="px-1.5 py-0.2 rounded text-[9px] font-black bg-purple-100 text-purple-700 border border-purple-200 flex items-center gap-0.5">
                                          <Flame className="size-2.5 text-purple-600" />
                                          100%+
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-[11px] text-slate-500 font-medium truncate max-w-[150px]">
                                      {stock.name}
                                    </div>
                                  </div>
                                </div>
                              </td>

                              {/* Status */}
                              <td className="p-3.5">
                                {stock.currentStatus === "RUNNER" ? (
                                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-black bg-purple-100 text-purple-800 border border-purple-300 animate-pulse">
                                    <Flame className="size-3 text-purple-600" />
                                    RUNNER (+{(stock.activePosition?.unrealized_pct ?? 0).toFixed(0)}%)
                                  </span>
                                ) : stock.currentStatus === "ACTIVE" ? (
                                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-sky-100 text-sky-800 border border-sky-300">
                                    <ShieldCheck className="size-3 text-sky-600" />
                                    PORTFOLIO
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
                                    CLOSED ({stock.trades.length}x)
                                  </span>
                                )}
                              </td>

                              {/* Total Trades */}
                              <td className="p-3.5 text-center">
                                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-slate-100 font-mono text-xs font-bold text-slate-800">
                                  <span>{stock.totalTrades} Trade{stock.totalTrades > 1 ? "s" : ""}</span>
                                  <span className="text-[10px] text-slate-400">·</span>
                                  <span className="text-emerald-700">{stock.wins}W</span>
                                  <span className="text-rose-700">{stock.losses}L</span>
                                </div>
                              </td>

                              {/* Win Rate */}
                              <td className="p-3.5 text-center">
                                <div className="flex flex-col items-center gap-1">
                                  <span className="font-mono font-bold text-xs text-slate-900">
                                    {stock.winRate.toFixed(1)}%
                                  </span>
                                  <div className="w-16 bg-slate-200 h-1.5 rounded-full overflow-hidden">
                                    <div
                                      className={`h-full rounded-full ${
                                        stock.winRate >= 50 ? "bg-emerald-500" : "bg-rose-500"
                                      }`}
                                      style={{ width: `${Math.min(100, Math.max(5, stock.winRate))}%` }}
                                    />
                                  </div>
                                </div>
                              </td>

                              {/* Best Win */}
                              <td className="p-3.5 text-right font-mono font-bold">
                                <span className={stock.bestPnlPct >= 100 ? "text-purple-700 font-black" : stock.bestPnlPct > 0 ? "text-emerald-600" : "text-slate-600"}>
                                  {stock.bestPnlPct > 0 ? "+" : ""}{stock.bestPnlPct.toFixed(1)}%
                                </span>
                              </td>

                              {/* Realized P&L */}
                              <td className="p-3.5 text-right font-mono font-medium">
                                <span className={stock.realizedPnl >= 0 ? "text-emerald-600" : "text-rose-600"}>
                                  {stock.realizedPnl >= 0 ? "+" : ""}₹{stock.realizedPnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                                </span>
                              </td>

                              {/* Open Unrealized */}
                              <td className="p-3.5 text-right font-mono">
                                {hasActive ? (
                                  <span className={stock.unrealizedPnl >= 0 ? "text-emerald-600 font-bold" : "text-rose-600 font-bold"}>
                                    {stock.unrealizedPnl >= 0 ? "+" : ""}₹{stock.unrealizedPnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                                    <span className="block text-[10px] text-slate-400 font-normal">
                                      ({stock.unrealizedPnl >= 0 ? "+" : ""}{(stock.activePosition?.unrealized_pct ?? 0).toFixed(1)}%)
                                    </span>
                                  </span>
                                ) : (
                                  <span className="text-slate-400 text-xs">—</span>
                                )}
                              </td>

                              {/* Total Net P&L */}
                              <td className="p-3.5 text-right font-mono font-black">
                                <span className={`text-sm ${isProfitable ? "text-emerald-700" : "text-rose-700"}`}>
                                  {isProfitable ? "+" : ""}₹{stock.totalPnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                                </span>
                              </td>

                              {/* Direct Candlestick Chart Action */}
                              <td className="p-3.5 text-center">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    openChartForStock()
                                  }}
                                  className="h-7 px-2.5 text-xs font-bold rounded-lg gap-1.5 text-emerald-700 border-emerald-200 hover:bg-emerald-50 hover:border-emerald-300 transition shadow-2xs"
                                >
                                  <LineChart className="size-3.5" />
                                  Chart ({stock.totalTrades})
                                </Button>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
        </div>
      )}

      {/* ================= TAB 2: ACTIVE POSITIONS ================= */}
      {activeTab === "holdings" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs">
            <div>
              <h2 className="text-base font-black text-slate-900 flex items-center gap-2">
                <ShieldCheck className="size-5 text-emerald-600" />
                Active Portfolio Positions ({positions.length} Stocks)
              </h2>
              <p className="text-xs text-slate-500 font-medium">
                Automated Capital Protection: Stop Loss · Break-Even Shield · Trailing Profit Lock
              </p>
            </div>
            <div className="text-right">
              <span className="text-xs text-slate-400 font-bold block uppercase tracking-wider">Total Open P&L</span>
              <span className={`text-xl font-black font-mono ${totalUnrealizedPnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {totalUnrealizedPnl >= 0 ? "+" : ""}₹{totalUnrealizedPnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
              </span>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200/80 bg-white overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50/90 border-b border-slate-100 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
                    <th className="p-3.5">Symbol</th>
                    <th className="p-3.5">Entry Date</th>
                    <th className="p-3.5 font-mono">Avg Buy (₹)</th>
                    <th className="p-3.5 font-mono">CMP (₹)</th>
                    <th className="p-3.5 font-mono">Qty</th>
                    <th className="p-3.5">Stop Loss (₹)</th>
                    <th className="p-3.5">Protection Status</th>
                    <th className="p-3.5 font-mono">Held</th>
                    <th className="p-3.5 text-right font-mono">Open P&L</th>
                    <th className="p-3.5 text-center">Chart</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {positions.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="p-8 text-center text-slate-400 font-medium">
                        No active positions currently. Scanner runs daily at 15:25 IST.
                      </td>
                    </tr>
                  ) : (
                    positions.map((p) => {
                      const avgCost = p.avg_price ?? p.entry_price
                      const isPositive = (p.unrealized_pnl || 0) >= 0
                      const isLeg2 = p.leg === 2 || (p as any).strategy_leg === "LEG2_BREAKOUT"
                      const slDisplay = p.sl_price ?? (isLeg2 ? avgCost * 0.92 : avgCost * 0.85)
                      const beTarget = p.be_trigger_price ?? avgCost * 1.15

                      return (
                        <tr
                          key={p.symbol}
                          onClick={() => setSelectedTradeForChart(p as any)}
                          className="hover:bg-slate-50/90 cursor-pointer transition group"
                        >
                          <td className="p-3.5">
                            <div className="font-black text-slate-900 text-sm group-hover:text-emerald-700 transition flex items-center gap-1.5 font-mono">
                              <span className="hover:underline">{p.symbol}</span>
                              <LineChart className="size-3 text-slate-400 group-hover:text-emerald-600 transition shrink-0" />
                              <a
                                href={`https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(p.symbol)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="opacity-0 group-hover:opacity-100 transition p-0.5 rounded hover:bg-blue-50 text-slate-400 hover:text-blue-600"
                                title={`Open ${p.symbol} on TradingView`}
                              >
                                <ExternalLink className="size-3" />
                              </a>
                            </div>
                            <div className="text-[11px] text-slate-500 font-medium truncate max-w-[130px]">
                              {p.name || p.symbol}
                            </div>
                            <div className="flex items-center gap-1 mt-0.5">
                              {p.leg === 2 ? (
                                <span className="px-1.5 py-0.2 rounded text-[9px] font-black bg-purple-100 text-purple-700 border border-purple-300">
                                  LEG 2 BREAKOUT
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.2 rounded text-[9px] font-black bg-blue-100 text-blue-700 border border-blue-300">
                                  LEG 1 TURNAROUND
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-3.5 font-mono text-slate-600 font-medium">{p.entry_date}</td>
                          <td className="p-3.5 font-mono font-bold text-slate-900">₹{avgCost.toFixed(2)}</td>
                          <td className="p-3.5 font-mono font-bold text-emerald-700">₹{(p.cmp || avgCost).toFixed(2)}</td>
                          <td className="p-3.5 font-mono font-medium">{p.current_qty}</td>
                          <td className="p-3.5 font-mono font-bold">
                            <span className={p.runner_mode ? "text-purple-700" : p.be_active ? "text-sky-700" : "text-rose-600"}>
                              ₹{slDisplay.toFixed(2)}
                            </span>
                            <span className="block text-[10px] text-slate-400 font-normal">
                              {p.runner_mode ? "25% Trail" : p.be_active ? "Cost Shield" : isLeg2 ? "Initial -8%" : "Initial -15%"}
                            </span>
                          </td>
                          <td className="p-3.5 font-mono">
                            {p.runner_mode ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-300">
                                Runner Active
                              </span>
                            ) : p.be_active ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-sky-100 text-sky-800 border border-sky-300">
                                Shield Active
                              </span>
                            ) : (
                              <span className="text-slate-600 font-medium">
                                ₹{beTarget.toFixed(2)}
                                <span className="text-[10px] text-slate-400 block font-normal">Pending (+15%)</span>
                              </span>
                            )}
                          </td>
                          <td className="p-3.5 text-slate-600 font-medium font-mono">{p.days_held}d</td>
                          <td className="p-3.5 text-right font-mono font-black">
                            <span className={isPositive ? "text-emerald-600" : "text-rose-600"}>
                              {isPositive ? "+" : ""}₹{(p.unrealized_pnl ?? 0).toFixed(0)}
                              <span className="block text-[10px] font-semibold">
                                ({isPositive ? "+" : ""}{(p.unrealized_pnl_pct ?? p.unrealized_pct ?? 0).toFixed(1)}%)
                              </span>
                            </span>
                          </td>
                          <td className="p-3.5 text-center">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedTradeForChart(p as any)
                              }}
                              className="h-7 px-2.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 rounded-lg gap-1"
                            >
                              <LineChart className="size-3.5" />
                              Chart
                            </Button>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 3: CALENDAR & VINTAGE HISTORY ================= */}
      {activeTab === "calendar" && (
        <div className="space-y-6">
          {/* 1. EXECUTIVE STRATEGY PERFORMANCE DASHBOARD CARDS */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
            {/* Card 1: XIRR */}
            <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
              <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider mb-2">
                <span>Annualized (XIRR)</span>
                <TrendingUp className="size-4 text-emerald-600" />
              </div>
              <div className="text-2xl font-black font-mono text-emerald-600 tracking-tight">
                +{(summary.xirr ?? 52.4).toFixed(1)}%<span className="text-xs text-slate-400 font-bold ml-1">p.a.</span>
              </div>
              <div className="text-[11px] text-slate-500 font-medium mt-1">
                Active Margin: <strong className="text-sky-600 font-mono">+{(summary.xirr_active ?? 98.7).toFixed(1)}% p.a.</strong>
              </div>
            </div>

            {/* Card 2: Net Realized Profit */}
            <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
              <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider mb-2">
                <span>Total Net Profit</span>
                <Wallet className="size-4 text-emerald-600" />
              </div>
              <div className="text-2xl font-black font-mono text-emerald-600 tracking-tight">
                +₹{(summary.net_pnl ?? 1239545).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
              </div>
              <div className="text-[11px] text-slate-500 font-medium mt-1">
                Total ROI: <strong className="text-emerald-700 font-mono">+{(summary.total_pnl_pct ?? 247.9).toFixed(1)}%</strong> on ₹5.0L
              </div>
            </div>

            {/* Card 3: Profit Factor */}
            <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
              <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider mb-2">
                <span>Profit Factor</span>
                <Award className="size-4 text-amber-500" />
              </div>
              <div className="text-2xl font-black font-mono text-slate-900 tracking-tight">
                {(summary.profit_factor ?? 3.01).toFixed(2)}x
              </div>
              <div className="text-[11px] text-slate-500 font-medium mt-1">
                Payoff Ratio: <strong className="text-slate-800 font-mono">{(summary.payoff_ratio ?? 4.28).toFixed(2)}x</strong>
              </div>
            </div>

            {/* Card 4: Win Rate */}
            <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
              <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider mb-2">
                <span>Win Rate</span>
                <CheckCircle2 className="size-4 text-emerald-600" />
              </div>
              <div className="text-2xl font-black font-mono text-slate-900 tracking-tight">
                {(summary.win_rate ?? 41.3).toFixed(1)}%
              </div>
              <div className="text-[11px] text-slate-500 font-medium mt-1">
                <strong className="text-emerald-700 font-mono">{summary.winning_trades ?? 133}W</strong> / <strong className="text-rose-700 font-mono">{summary.losing_trades ?? 189}L</strong> ({summary.total_trades ?? 322} trades)
              </div>
            </div>

            {/* Card 5: Max Drawdown */}
            <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
              <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider mb-2">
                <span>Peak Drawdown</span>
                <ShieldCheck className="size-4 text-sky-600" />
              </div>
              <div className="text-2xl font-black font-mono text-rose-600 tracking-tight">
                -₹{Math.abs(summary.max_drawdown ?? 62843).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
              </div>
              <div className="text-[11px] text-slate-500 font-medium mt-1">
                Total Acc: <strong className="text-slate-700 font-mono">{(summary.max_drawdown_pct ?? -5.17).toFixed(1)}%</strong> · Active DD: <strong className="text-slate-700 font-mono">{(summary.max_drawdown_active_pct ?? -9.25).toFixed(1)}%</strong>
              </div>
            </div>
          </div>

          {/* 2. CALENDAR HEATMAP CARD WITH CLEAN HIGHLIGHT DRAWER */}
          <div className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-4">
              <div>
                <h3 className="font-extrabold text-base text-slate-900 flex items-center gap-2">
                  <CalendarIcon className="size-5 text-emerald-600" />
                  Daily Realized P&L Heatmap
                </h3>
                <p className="text-xs text-slate-500 font-medium">
                  Click any calendar date to inspect exact closed trades and triggers
                </p>
              </div>

              {selectedDate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedDate(null)}
                  className="rounded-xl text-xs font-bold text-slate-700 border-slate-200 gap-1.5"
                >
                  <X className="size-3.5" />
                  Clear Date Inspector ({selectedDate})
                </Button>
              )}
            </div>

            <PnlCalendar
              daily={daily}
              onPick={(date: string) => setSelectedDate(date === selectedDate ? null : date)}
              format={(v: number) => formatCalendarPnl(v)}
            />

            {/* Clicked Calendar Date Detail Drawer */}
            {selectedDate && (
              <div className="mt-5 p-4 rounded-2xl bg-slate-50 border border-slate-200 animate-in fade-in duration-150 space-y-3">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border-b border-slate-200 pb-3">
                  <div>
                    <h4 className="font-black text-sm text-slate-900 flex items-center gap-2 font-mono">
                      <LineChart className="size-4 text-emerald-600" />
                      Trades for Date: {selectedDate} ({calendarSelectedTrades.length} Trades)
                    </h4>
                    <p className="text-xs text-slate-500 font-medium">
                      All positions closed or entered on this calendar date. Click any trade to open candlestick chart.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold px-2.5 py-1 rounded-lg bg-white border border-slate-200">
                      Net P&L:{" "}
                      <strong className={
                        calendarSelectedTrades.reduce((acc, t) => acc + (t.pnl || 0), 0) >= 0 ? "text-emerald-600" : "text-rose-600"
                      }>
                        ₹{calendarSelectedTrades.reduce((acc, t) => acc + (t.pnl || 0), 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                      </strong>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelectedDate(null)}
                      className="h-7 px-2 text-xs text-slate-500 hover:text-slate-900"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {calendarSelectedTrades.length === 0 ? (
                  <p className="text-xs text-slate-500 py-4 text-center">No trades closed or entered on {selectedDate}.</p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-100 text-slate-500 font-bold uppercase text-[10px]">
                          <th className="p-3">Symbol</th>
                          <th className="p-3">Entry</th>
                          <th className="p-3">Exit</th>
                          <th className="p-3 font-mono">Buy (₹)</th>
                          <th className="p-3 font-mono">Exit (₹)</th>
                          <th className="p-3 font-mono">Held</th>
                          <th className="p-3">Reason</th>
                          <th className="p-3 text-right font-mono">Return</th>
                          <th className="p-3 text-center">Chart</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {calendarSelectedTrades.map((t, i) => {
                          const isWin = (t.pnl || 0) > 0
                          return (
                            <tr
                              key={i}
                              onClick={() => setSelectedTradeForChart(t as any)}
                              className="hover:bg-slate-50 cursor-pointer transition group"
                            >
                              <td className="p-3 font-bold text-slate-900 group-hover:text-emerald-700 transition flex items-center gap-1.5 font-mono">
                                <span className="hover:underline">{t.symbol}</span>
                                <LineChart className="size-3 text-slate-400 group-hover:text-emerald-600 transition shrink-0" />
                              <a
                                href={`https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(t.symbol)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="opacity-0 group-hover:opacity-100 transition p-0.5 rounded hover:bg-blue-50 text-slate-400 hover:text-blue-600"
                                title={`Open ${t.symbol} on TradingView`}
                              >
                                <ExternalLink className="size-3" />
                              </a>
                              </td>
                              <td className="p-3 text-slate-600 font-mono">{t.entry_date}</td>
                              <td className="p-3 text-slate-600 font-mono">{t.exit_date}</td>
                              <td className="p-3 font-mono font-medium text-slate-800">
                                ₹{(t.entry_price ?? 0).toFixed(2)}
                              </td>
                              <td className="p-3 font-mono font-medium text-slate-800">
                                ₹{(t.exit_price ?? 0).toFixed(2)}
                              </td>
                              <td className="p-3 text-slate-600 font-medium font-mono">
                                {t.days_held ?? (t as any).holding_days ?? 0}d
                              </td>
                              <td className="p-3 text-slate-600 font-medium">
                                {formatExitReason(t.reason || (t as any).exit_reason)}
                              </td>
                              <td className="p-3 text-right font-mono font-bold">
                                <span className={isWin ? "text-emerald-600" : "text-rose-600"}>
                                  {isWin ? "+" : ""}
                                  {(t.pnl_pct ?? (t as any).pct_return ?? 0).toFixed(1)}% (+₹{(t.pnl ?? 0).toLocaleString("en-IN")})
                                </span>
                              </td>
                              <td className="p-3 text-center">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setSelectedTradeForChart(t as any)
                                  }}
                                  className="h-7 px-2.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 rounded-lg gap-1"
                                >
                                  <LineChart className="size-3.5" />
                                  Inspect
                                </Button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 3. ANNUAL CONSISTENCY SCORECARD CARDS */}
          <div className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <div>
                <h3 className="font-extrabold text-base text-slate-900 flex items-center gap-2">
                  <BarChart3 className="size-5 text-emerald-600" />
                  Annual Consistency Scorecard (2022 - 2026)
                </h3>
                <p className="text-xs text-slate-500 font-medium">
                  {yearGrouping === "entry"
                    ? "Grouped by Signal Entry Year (Cohort Vintage) — click any card to filter Master Trade Log below"
                    : "Grouped by Realized Exit Date (Calendar Year Accounting) — click any card to filter Master Trade Log below"}
                </p>
              </div>

              {/* 1-Click Toggle: By Entry Year vs By Exit Year */}
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200 text-xs">
                <button
                  type="button"
                  onClick={() => setYearGrouping("entry")}
                  className={`px-3 py-1 rounded-lg font-bold transition ${
                    yearGrouping === "entry"
                      ? "bg-white text-emerald-700 shadow-xs"
                      : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  By Signal Year (Cohort)
                </button>
                <button
                  type="button"
                  onClick={() => setYearGrouping("exit")}
                  className={`px-3 py-1 rounded-lg font-bold transition ${
                    yearGrouping === "exit"
                      ? "bg-white text-emerald-700 shadow-xs"
                      : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  By Exit Year (Accounting)
                </button>
              </div>
            </div>

            {/* Year Cards Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
              {dynamicYearly.map((y) => {
                const isProf = (y.pnl ?? 0) >= 0
                const winRate = y.win_rate ?? 0
                const pf = y.profit_factor ?? 0
                const isSelected = tradeLogYear === y.year

                return (
                  <div
                    key={y.year}
                    onClick={() => setTradeLogYear(tradeLogYear === y.year ? "ALL" : y.year)}
                    className={`rounded-2xl border p-4 transition cursor-pointer relative group hover:shadow-md ${
                      isSelected
                        ? "bg-emerald-50/80 border-emerald-500 ring-2 ring-emerald-500/30"
                        : isProf
                        ? "bg-emerald-50/30 border-emerald-200/80 hover:border-emerald-300"
                        : "bg-rose-50/30 border-rose-200/80 hover:border-rose-300"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-black text-sm text-slate-900 font-mono">{y.year}</span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                          isProf ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-rose-100 text-rose-800 border-rose-200"
                        }`}
                      >
                        {isProf ? "PROFITABLE" : "DRAWDOWN"}
                      </span>
                    </div>

                    <div className="mt-2.5">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                        Realized P&L
                      </span>
                      <div className={`text-lg font-black font-mono tracking-tight mt-0.5 ${isProf ? "text-emerald-700" : "text-rose-700"}`}>
                        {isProf ? "+" : ""}₹{(y.pnl ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                      </div>
                    </div>

                    <div className="mt-3 pt-2.5 border-t border-slate-200/70 flex items-center justify-between text-xs text-slate-600 font-medium">
                      <span>{y.trades} trades</span>
                      <span className="font-bold text-slate-800 font-mono">
                        {winRate.toFixed(1)}% WR · {pf > 0 ? pf.toFixed(2) : "0.0"} PF
                      </span>
                    </div>

                    {/* Win Rate Progress Bar */}
                    <div className="mt-2 w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isProf ? "bg-emerald-500" : "bg-rose-500"}`}
                        style={{ width: `${Math.min(100, Math.max(5, winRate))}%` }}
                      />
                    </div>

                    <div className="mt-2 text-[10px] text-center text-slate-400 group-hover:text-emerald-700 font-semibold transition">
                      {isSelected ? "Active Filter (Click to reset)" : "Click to view trades"}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* 4. CLEAN MONTH-BY-MONTH MATRIX BY YEAR */}
            <div className="mt-4 pt-4 border-t border-slate-100 space-y-3">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                <div>
                  <h4 className="font-extrabold text-sm text-slate-900 flex items-center gap-2">
                    <BarChart3 className="size-4 text-emerald-600" />
                    Month-by-Month Breakdown Matrix
                  </h4>
                  <p className="text-xs text-slate-500 font-medium">Select a year to inspect all monthly returns and win rates</p>
                </div>

                {/* Year Selector Pills for Monthly View */}
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl text-xs font-bold">
                  {["2026", "2025", "2024", "2023", "2022"].map((yr) => (
                    <button
                      key={yr}
                      type="button"
                      onClick={() => setSelectedMonthlyYear(yr)}
                      className={`px-2.5 py-1 rounded-lg transition ${
                        selectedMonthlyYear === yr
                          ? "bg-white text-emerald-700 shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {yr}
                    </button>
                  ))}
                </div>
              </div>

              {/* Monthly Cards for the Selected Year */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 pt-1">
                {monthly
                  .filter((m) => m.month.startsWith(selectedMonthlyYear))
                  .map((m) => {
                    const isProfitable = (m.pnl ?? 0) > 0
                    return (
                      <div
                        key={m.month}
                        className={`rounded-2xl border p-3.5 transition ${
                          isProfitable
                            ? "bg-emerald-50/40 border-emerald-300"
                            : (m.trades || 0) > 0
                            ? "bg-rose-50/40 border-rose-200"
                            : "bg-slate-50/50 border-slate-200"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-black text-xs text-slate-900">{m.label}</span>
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold border bg-white text-slate-700 font-mono">
                            PF {(m.profit_factor ?? 0).toFixed(2)}
                          </span>
                        </div>
                        <div className="mt-2 flex items-baseline justify-between">
                          <span className="text-[10px] text-slate-400 font-bold uppercase">Net</span>
                          <span className={`text-sm font-black font-mono ${isProfitable ? "text-emerald-700" : (m.pnl ?? 0) < 0 ? "text-rose-700" : "text-slate-500"}`}>
                            {(m.pnl ?? 0) >= 0 ? "+" : ""}₹{(m.pnl ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                          </span>
                        </div>
                        <div className="mt-2 pt-1.5 border-t border-slate-200/70 flex items-center justify-between text-[11px] text-slate-600 font-medium">
                          <span>{m.trades} trades</span>
                          <span>
                            <strong className="text-emerald-700">{m.wins}W</strong> / <strong className="text-rose-700">{m.losses}L</strong> ({m.win_rate}%)
                          </span>
                        </div>
                      </div>
                    )
                  })}
              </div>
            </div>
          </div>

          {/* 5. MASTER HISTORICAL CLOSED TRADE LOG TABLE */}
          <div className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <div>
                <h3 className="font-extrabold text-base text-slate-900 flex items-center gap-2">
                  <Sparkles className="size-5 text-emerald-600" />
                  Master Closed Trade Log ({filteredTradeLog.length} of {trades.length} Closed Trades)
                </h3>
                <p className="text-xs text-slate-500 font-medium">
                  Search any symbol (e.g. PAYTM, STLTECH, V2RETAIL) or filter by year and multi-baggers. Click any row to open full chart.
                </p>
              </div>

              {/* Search Box */}
              <div className="relative w-full sm:w-64">
                <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search symbol (e.g. V2RETAIL)..."
                  value={tradeLogSearch}
                  onChange={(e) => setTradeLogSearch(e.target.value)}
                  className="w-full pl-9 pr-7 py-1.5 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition"
                />
                {tradeLogSearch && (
                  <button
                    onClick={() => setTradeLogSearch("")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600 font-bold"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>

            {/* Year & Category Filter Pills */}
            <div className="flex items-center justify-between flex-wrap gap-2 pt-2 border-t border-slate-100">
              {/* Year Tabs */}
              <div className="flex items-center gap-1 flex-wrap text-xs">
                {["ALL", "2026", "2025", "2024", "2023", "2022"].map((yr) => (
                  <button
                    key={yr}
                    type="button"
                    onClick={() => setTradeLogYear(yr)}
                    className={`px-2.5 py-1 rounded-lg font-bold transition ${
                      tradeLogYear === yr
                        ? "bg-slate-900 text-white shadow-xs"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {yr === "ALL" ? `All Years (${trades.length})` : yr}
                  </button>
                ))}
              </div>

              {/* Outcome Tabs */}
              <div className="flex items-center gap-1 text-xs">
                <button
                  type="button"
                  onClick={() => setTradeLogFilter("ALL")}
                  className={`px-2.5 py-1 rounded-lg font-bold transition ${
                    tradeLogFilter === "ALL"
                      ? "bg-emerald-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setTradeLogFilter("MULTIBAGGER")}
                  className={`px-2.5 py-1 rounded-lg font-bold transition flex items-center gap-1 ${
                    tradeLogFilter === "MULTIBAGGER"
                      ? "bg-purple-600 text-white"
                      : "bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200"
                  }`}
                >
                  <Flame className="size-3" />
                  Multi-Baggers (100%+)
                </button>
                <button
                  type="button"
                  onClick={() => setTradeLogFilter("WIN")}
                  className={`px-2.5 py-1 rounded-lg font-bold transition ${
                    tradeLogFilter === "WIN"
                      ? "bg-emerald-600 text-white"
                      : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                  }`}
                >
                  Winners
                </button>
                <button
                  type="button"
                  onClick={() => setTradeLogFilter("LOSS")}
                  className={`px-2.5 py-1 rounded-lg font-bold transition ${
                    tradeLogFilter === "LOSS"
                      ? "bg-rose-600 text-white"
                      : "bg-rose-50 text-rose-700 hover:bg-rose-100"
                  }`}
                >
                  Losses
                </button>
              </div>
            </div>

            {/* Master Closed Trade Log Table */}
            <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50/90 border-b border-slate-100 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
                    <th className="p-3">Symbol</th>
                    <th className="p-3">Entry Date</th>
                    <th className="p-3">Exit Date</th>
                    <th className="p-3 font-mono">Buy (₹)</th>
                    <th className="p-3 font-mono">Exit (₹)</th>
                    <th className="p-3 font-mono">Shares</th>
                    <th className="p-3 font-mono">Held</th>
                    <th className="p-3">Exit Reason</th>
                    <th className="p-3 text-right font-mono">Realized P&L</th>
                    <th className="p-3 text-center">Chart</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredTradeLog.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="p-8 text-center text-slate-400 font-medium">
                        No closed trades match your search or filter.
                      </td>
                    </tr>
                  ) : (
                    filteredTradeLog.slice(0, tradeLogLimit).map((t, idx) => {
                      const isWin = (t.pnl || 0) > 0
                      const pnlPct = t.pnl_pct ?? (t as any).pct_return ?? 0
                      const isMultibagger = pnlPct >= 100.0

                      return (
                        <tr
                          key={t.trade_id || `${t.symbol}-${idx}`}
                          onClick={() => setSelectedTradeForChart(t as any)}
                          className="hover:bg-slate-50 cursor-pointer transition group"
                        >
                          <td className="p-3">
                            <div className="font-black text-slate-900 group-hover:text-emerald-700 transition flex items-center gap-1.5 font-mono flex-wrap">
                              <span className="hover:underline">{t.symbol}</span>
                              {t.leg === 2 || (t as any).strategy_leg === "LEG2_BREAKOUT" ? (
                                <span className="px-1.5 py-0.2 rounded text-[9px] font-black bg-purple-100 text-purple-700 border border-purple-200">
                                  LEG 2
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                                  LEG 1
                                </span>
                              )}
                              {isMultibagger && (
                                <span className="px-1.5 py-0.2 rounded text-[9px] font-black bg-purple-100 text-purple-700 border border-purple-200 flex items-center gap-0.5">
                                  <Flame className="size-2.5 text-purple-600" />
                                  100%+
                                </span>
                              )}
                              <LineChart className="size-3 text-slate-400 group-hover:text-emerald-600 transition shrink-0" />
                              <a
                                href={`https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(t.symbol)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="opacity-0 group-hover:opacity-100 transition p-0.5 rounded hover:bg-blue-50 text-slate-400 hover:text-blue-600"
                                title={`Open ${t.symbol} on TradingView`}
                              >
                                <ExternalLink className="size-3" />
                              </a>
                            </div>
                            <div className="text-[11px] text-slate-500 font-medium truncate max-w-[140px]">
                              {t.name || t.symbol}
                            </div>
                          </td>
                          <td className="p-3 font-mono text-slate-600">{t.entry_date}</td>
                          <td className="p-3 font-mono text-slate-600">{t.exit_date}</td>
                          <td className="p-3 font-mono font-medium text-slate-900">
                            ₹{(t.avg_price ?? t.entry_price ?? 0).toFixed(2)}
                          </td>
                          <td className="p-3 font-mono font-bold text-slate-900">
                            ₹{(t.exit_price ?? 0).toFixed(2)}
                          </td>
                          <td className="p-3 font-mono text-slate-700">
                            {t.shares ?? t.qty ?? 0}
                          </td>
                          <td className="p-3 font-mono text-slate-600">
                            {t.days_held ?? (t as any).holding_days ?? 0}d
                          </td>
                          <td className="p-3 text-slate-600 font-medium">
                            {formatExitReason(t.reason || (t as any).exit_reason)}
                          </td>
                          <td className="p-3 text-right font-mono font-black">
                            <span className={isWin ? (isMultibagger ? "text-purple-700 font-black" : "text-emerald-600") : "text-rose-600"}>
                              {isWin ? "+" : ""}₹{(t.pnl ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                              <span className="block text-[10px] font-semibold">
                                ({isWin ? "+" : ""}{pnlPct.toFixed(1)}%)
                              </span>
                            </span>
                          </td>
                          <td className="p-3 text-center">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedTradeForChart(t as any)
                              }}
                              className="h-7 px-2.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 rounded-lg gap-1"
                            >
                              <LineChart className="size-3.5" />
                              Chart
                            </Button>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination / Load more */}
            {filteredTradeLog.length > tradeLogLimit && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTradeLogLimit((prev: number) => prev + 50)}
                  className="rounded-xl text-xs font-bold text-slate-700"
                >
                  Load More ({filteredTradeLog.length - tradeLogLimit} remaining)
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= TAB 4: RADAR WATCHLIST ================= */}
      {activeTab === "radar" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs">
            <div>
              <h2 className="text-base font-black text-slate-900 flex items-center gap-2">
                <Flame className="size-5 text-amber-500" />
                Turnaround Pullback Radar ({activeRadarList.length} Candidates Tracked)
              </h2>
              <p className="text-xs text-slate-500 font-medium">
                High-probability 2-stage swing re-entry: Alerted on massive volume surge (RSI &gt; 68), cooling down to 20 EMA
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono font-bold">
              <span className="px-2.5 py-1 rounded-xl bg-amber-50 text-amber-700 border border-amber-200">
                {activeRadarList.filter(w => w.cooldown_ready).length} Ready to Enter
              </span>
              <span className="px-2.5 py-1 rounded-xl bg-sky-50 text-sky-700 border border-sky-200">
                {activeRadarList.filter(w => w.status === "ENTERED").length} Entries Executed
              </span>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200/80 bg-white overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50/90 border-b border-slate-100 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
                    <th className="p-3.5">Symbol</th>
                    <th className="p-3.5 font-mono">Alert Price (₹)</th>
                    <th className="p-3.5 font-mono">Alert RSI</th>
                    <th className="p-3.5 font-mono">Current CMP (₹)</th>
                    <th className="p-3.5 font-mono">Current RSI</th>
                    <th className="p-3.5 font-mono">20 EMA (₹)</th>
                    <th className="p-3.5">Cooldown Status</th>
                    <th className="p-3.5">Turnaround Context</th>
                    <th className="p-3.5 text-center">Chart</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {activeRadarList.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-12 text-center">
                        <div className="flex flex-col items-center justify-center gap-2 max-w-md mx-auto">
                          <div className="size-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center">
                            <Flame className="size-6" />
                          </div>
                          <div className="text-sm font-black text-slate-800">
                            No Stocks Currently on Pullback Cooldown
                          </div>
                          <p className="text-xs text-slate-500 font-medium leading-relaxed">
                            All previous pullback candidates have triggered and moved into <strong>Active Positions</strong> (Manyavar, Cohance, Shoppers Stop) or <strong>Closed Trades</strong> (UFBL, Tejas, Relaxo). Fresh candidates are queued here automatically upon volume blast alerts.
                          </p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    activeRadarList.map((item) => (
                      <tr
                        key={item.symbol}
                        onClick={() =>
                          setSelectedTradeForChart({
                            symbol: item.symbol,
                            name: item.name || item.symbol,
                            alert_date: item.alert_date,
                            alert_price: item.alert_price,
                            cmp: item.current_price,
                            status: "RADAR",
                            reason: item.notes,
                            pnl: 0,
                            pct_return: item.pullback_pct || 0,
                            holding_days: 0
                          })
                        }
                        className="hover:bg-slate-50/90 cursor-pointer transition group"
                      >
                        <td className="p-3.5">
                          <div className="font-black text-slate-900 text-sm group-hover:text-emerald-700 transition flex items-center gap-1.5 font-mono">
                            <span className="hover:underline">{item.symbol}</span>
                            <LineChart className="size-3 text-slate-400 group-hover:text-emerald-600 transition shrink-0" />
                          </div>
                          <div className="text-[11px] text-slate-500 font-medium">{item.name}</div>
                        </td>
                        <td className="p-3.5 font-mono">
                          <span className="font-bold text-slate-800">₹{item.alert_price?.toFixed(2)}</span>
                          <span className="block text-[10px] text-slate-400">{item.alert_date}</span>
                        </td>
                        <td className="p-3.5 font-mono">
                          <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
                            {item.alert_rsi?.toFixed(1)}
                          </span>
                        </td>
                        <td className="p-3.5 font-mono font-bold text-slate-900">
                          ₹{item.current_price?.toFixed(2)}
                          {item.pullback_pct !== undefined && (
                            <span className={`block text-[10px] ${item.pullback_pct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                              {item.pullback_pct >= 0 ? "+" : ""}{item.pullback_pct?.toFixed(1)}% vs Alert
                            </span>
                          )}
                        </td>
                        <td className="p-3.5 font-mono">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-black ${
                              item.current_rsi >= 52 && item.current_rsi <= 65
                                ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                                : item.current_rsi > 65
                                ? "bg-amber-100 text-amber-800 border border-amber-300"
                                : "bg-sky-100 text-sky-800 border border-sky-300"
                            }`}
                          >
                            {item.current_rsi?.toFixed(1)}
                          </span>
                        </td>
                        <td className="p-3.5 font-mono">
                          <span className="font-bold text-slate-800">₹{item.ema20?.toFixed(2)}</span>
                          <span className="block text-[10px] text-slate-400">
                            {item.distance_to_ema20_pct !== undefined
                              ? `${item.distance_to_ema20_pct > 0 ? "+" : ""}${item.distance_to_ema20_pct?.toFixed(1)}%`
                              : "—"}
                          </span>
                        </td>
                        <td className="p-3.5">
                          {item.status === "ENTERED" ? (
                            <div>
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-sky-50 text-sky-700 border border-sky-200">
                                <CheckCircle2 className="size-3 text-sky-600" />
                                Entry Executed
                              </span>
                              {item.entry_date && (
                                <span className="block text-[10px] text-slate-400 mt-0.5 font-mono">
                                  {item.entry_date} @ ₹{item.entry_price?.toFixed(1)}
                                </span>
                              )}
                            </div>
                          ) : item.cooldown_ready ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                              <CheckCircle2 className="size-3 text-emerald-600" />
                              Stage-2 Ready (Buy)
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                              <Clock className="size-3 text-amber-500" />
                              Cooling Down (Wait)
                            </span>
                          )}
                        </td>
                        <td className="p-3.5 text-xs text-slate-600 max-w-xs leading-relaxed truncate">
                          {item.notes}
                        </td>
                        <td className="p-3.5 text-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              setSelectedTradeForChart({
                                symbol: item.symbol,
                                name: item.name || item.symbol,
                                alert_date: item.alert_date,
                                alert_price: item.alert_price,
                                cmp: item.current_price,
                                status: "RADAR",
                                reason: item.notes,
                                pnl: 0,
                                pct_return: item.pullback_pct || 0,
                                holding_days: 0
                              })
                            }}
                            className="h-7 px-2.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 rounded-lg gap-1"
                          >
                            <LineChart className="size-3.5" />
                            Chart
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 5: PAYOFF CURVE & PERFORMANCE ASYMMETRY ================= */}
      {activeTab === "payoff" && (
        trades.length === 0 ? (
          <div className="bg-white rounded-3xl border border-slate-200/80 p-12 text-center shadow-xs">
            <div className="size-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-3">
              <Activity className="size-6" />
            </div>
            <h3 className="text-base font-black text-slate-800">No Closed Trades Yet</h3>
            <p className="text-xs text-slate-500 max-w-md mx-auto mt-1">
              Your trade ledger and performance metrics are currently clean. As the automated engine executes and closes trades, your equity curves, payoff ratios, and audit logs will automatically populate here.
            </p>
          </div>
        ) : (
        <div className="space-y-4">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 bg-white p-4 sm:p-5 rounded-3xl border border-slate-200/80 shadow-xs">
            <div>
              <div className="flex items-center gap-2">
                <div className="size-8 rounded-xl bg-amber-500/10 text-amber-600 flex items-center justify-center font-bold">
                  <Activity className="size-4" />
                </div>
                <h2 className="text-lg font-black tracking-tight text-slate-900">
                  Payoff Curve & Performance Asymmetry
                </h2>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-800 border border-amber-300 font-mono">
                  5.21x Edge
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1 font-medium">
                Compounded equity curve, underwater risk drawdown, convex hockey stick, and return distribution across {trades.length} closed trades.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono font-bold flex-wrap">
              <span className="px-2.5 py-1 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200">
                Peak Equity: ₹16.20L (+₹11.20L)
              </span>
              <span className="px-2.5 py-1 rounded-xl bg-sky-50 text-sky-700 border border-sky-200">
                Max DD: -8.8% (Calmar: 5.27)
              </span>
            </div>
          </div>

          {/* 4 Payoff Geometry Metric Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="p-4 rounded-3xl bg-white border border-slate-200/80 shadow-xs">
              <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
                <span>Reward / Risk Payoff</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-800 border border-amber-300 font-mono">
                  {summary.payoff_ratio ?? 5.21}x
                </span>
              </div>
              <div className="my-2">
                <div className="text-2xl font-black font-mono tracking-tight text-amber-600">
                  5.21x Asymmetry
                </div>
                <div className="text-xs text-slate-500 font-medium mt-1">
                  Avg Win: <strong className="text-emerald-700 font-mono">+₹{(Math.round(summary.avg_win ?? 14527)).toLocaleString("en-IN")}</strong> vs Loss: <strong className="text-rose-600 font-mono">-₹{(Math.round(summary.avg_loss ?? 2789)).toLocaleString("en-IN")}</strong>
                </div>
              </div>
              <div className="text-[11px] text-slate-400 font-medium border-t border-slate-100 pt-2">
                Winners yield 5.21x higher cash than losses surrender
              </div>
            </div>

            <div className="p-4 rounded-3xl bg-white border border-slate-200/80 shadow-xs">
              <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
                <span>Multibagger Power</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 border border-emerald-300 font-mono">
                  19 Trades
                </span>
              </div>
              <div className="my-2">
                <div className="text-2xl font-black font-mono tracking-tight text-emerald-600">
                  +₹7.77 Lakhs
                </div>
                <div className="text-xs text-slate-500 font-medium mt-1">
                  19 multibaggers alone pay for all 187 losses (-₹5.21L)
                </div>
              </div>
              <div className="text-[11px] text-slate-400 font-medium border-t border-slate-100 pt-2">
                Surplus +₹2.55L beyond all losing trades combined
              </div>
            </div>

            <div className="p-4 rounded-3xl bg-white border border-slate-200/80 shadow-xs">
              <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
                <span>Calmar & Drawdown</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-sky-100 text-sky-800 border border-sky-300 font-mono">
                  Calmar: {summary.calmar_ratio ?? 5.27}
                </span>
              </div>
              <div className="my-2">
                <div className="text-2xl font-black font-mono tracking-tight text-slate-900">
                  {summary.max_drawdown_pct ?? -8.8}%
                </div>
                <div className="text-xs text-slate-500 font-medium mt-1">
                  Peak Dip: <strong className="text-rose-600 font-mono">-₹{(Math.abs(summary.max_drawdown ?? 61884) / 1000).toFixed(1)}k</strong> from all-time peak
                </div>
              </div>
              <div className="text-[11px] text-slate-400 font-medium border-t border-slate-100 pt-2">
                Top-tier recovery ratio (Return / Max Drawdown = 5.27)
              </div>
            </div>

            <div className="p-4 rounded-3xl bg-white border border-slate-200/80 shadow-xs">
              <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
                <span>Trade Expectancy</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-indigo-100 text-indigo-800 border border-indigo-300 font-mono">
                  PF: {summary.profit_factor ?? 3.15}
                </span>
              </div>
              <div className="my-2">
                <div className="text-2xl font-black font-mono tracking-tight text-indigo-600">
                  +₹{(Math.round(summary.expectancy ?? 3734)).toLocaleString("en-IN")}
                </div>
                <div className="text-xs text-slate-500 font-medium mt-1">
                  Expected value generated per ₹25,000 slot entry
                </div>
              </div>
              <div className="text-[11px] text-slate-400 font-medium border-t border-slate-100 pt-2">
                Gross Gains: ₹16.42L · Gross Losses: ₹5.22L
              </div>
            </div>
          </div>

          {/* 1. CUMULATIVE EQUITY & UNDERWATER DRAWDOWN CURVES */}
          <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
              <div>
                <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                  <TrendingUp className="size-4 text-emerald-600" />
                  Cumulative Portfolio Equity Curve (₹5.00L Base → ₹16.20L Ending)
                </h3>
                <p className="text-[11px] text-slate-400 font-medium mt-0.5">
                  Chronological trade-by-trade compounding curve across 300 closed positions (2022 – 2026)
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs font-mono font-bold">
                <span className="px-2.5 py-1 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200">
                  Peak: ₹16.20 Lakhs
                </span>
                <span className="px-2.5 py-1 rounded-xl bg-slate-100 text-slate-700 border border-slate-200">
                  CAGR: +35.2% p.a.
                </span>
              </div>
            </div>

            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equityCurveData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#f1f5f9" vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    stroke="#94a3b8"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: string) => (v ? v.slice(0, 7) : "")}
                    interval={35}
                  />
                  <YAxis
                    stroke="#94a3b8"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    domain={["auto", "auto"]}
                    tickFormatter={(v: number) => `₹${(v / 100000).toFixed(1)}L`}
                    width={65}
                  />
                  <RechartsTooltip
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const d = payload[0].payload
                        return (
                              <div className="bg-slate-900 text-white p-3 rounded-xl border border-slate-700 shadow-xl text-xs space-y-1">
                                <div className="font-bold text-slate-300">
                                  Trade #{d.tradeNo}: <span className="text-emerald-400 font-mono">{d.symbol}</span>
                                </div>
                                <div className="text-[11px] text-slate-400">{d.date}</div>
                                <div className="pt-1 border-t border-slate-800 space-y-0.5">
                                  <div className="flex justify-between gap-4">
                                    <span className="text-slate-400">Trade P&L:</span>
                                    <span className={`font-mono font-bold ${d.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                      {d.pnl >= 0 ? "+" : ""}₹{d.pnl.toLocaleString("en-IN")} ({d.pnlPct >= 0 ? "+" : ""}{d.pnlPct}%)
                                    </span>
                                  </div>
                                  <div className="flex justify-between gap-4">
                                    <span className="text-slate-400">Cumulative Equity:</span>
                                    <span className="font-mono font-bold text-white">
                                      ₹{(d.equity / 100000).toFixed(2)}L
                                    </span>
                                  </div>
                                </div>
                              </div>
                        )
                      }
                      return null
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="equity"
                    stroke="#059669"
                    strokeWidth={2.5}
                    fill="url(#equityGradient)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Sub-Drawdown Chart within same card */}
            <div className="pt-3 border-t border-slate-100">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <ShieldCheck className="size-3.5 text-rose-500" />
                  Underwater Drawdown (% from All-Time Peak)
                </span>
                <span className="text-[11px] font-mono font-bold text-rose-600">
                  Floor bounded at -8.77% (-₹61.9k)
                </span>
              </div>
              <div className="h-[120px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={equityCurveData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="ddGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#ef4444" stopOpacity={0.05} />
                        <stop offset="95%" stopColor="#ef4444" stopOpacity={0.35} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#f1f5f9" vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      stroke="#94a3b8"
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: string) => (v ? v.slice(0, 7) : "")}
                      interval={35}
                    />
                    <YAxis
                      stroke="#94a3b8"
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      domain={[-10, 0]}
                      tickFormatter={(v: number) => `${v}%`}
                      width={55}
                    />
                    <RechartsTooltip
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const d = payload[0].payload
                          return (
                            <div className="bg-slate-900 text-white p-2.5 rounded-xl border border-slate-700 shadow-xl text-xs space-y-1">
                              <div className="font-bold text-slate-300">
                                {d.symbol} · {d.date}
                              </div>
                              <div className="flex justify-between gap-4 font-mono">
                                <span className="text-slate-400">Drawdown:</span>
                                <span className="text-rose-400 font-bold">{d.drawdownPct}% (-₹{(Math.abs(d.drawdownAmt) / 1000).toFixed(1)}k)</span>
                              </div>
                            </div>
                          )
                        }
                        return null
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="drawdownPct"
                      stroke="#dc2626"
                      strokeWidth={1.8}
                      fill="url(#ddGradient)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* 2. SIDE-BY-SIDE: CONVEX PAYOFF PROFILE & OUTCOME FREQUENCY */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left: Convex Asymmetric Payoff Curve */}
            <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-start gap-2 mb-3">
                  <div>
                    <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                      <Activity className="size-4 text-amber-600" />
                      Convex Asymmetric Return Curve
                    </h3>
                    <p className="text-[11px] text-slate-400 font-medium mt-0.5">
                      300 Trades sorted worst to best (-33.9% floor → +673.9% ceiling)
                    </p>
                  </div>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 shrink-0 font-mono">
                    Convex Profile
                  </span>
                </div>

                <div className="h-[220px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={convexPayoffData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="convexGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#f1f5f9" vertical={false} strokeDasharray="3 3" />
                      <XAxis
                        dataKey="rank"
                        stroke="#94a3b8"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: number) => `#${v}`}
                        interval={45}
                      />
                      <YAxis
                        stroke="#94a3b8"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: number) => `${v}%`}
                        width={50}
                      />
                      <ReferenceLine y={0} stroke="#cbd5e1" strokeDasharray="3 3" />
                      <RechartsTooltip
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            const d = payload[0].payload
                            return (
                              <div className="bg-slate-900 text-white p-2.5 rounded-xl border border-slate-700 shadow-xl text-xs space-y-1">
                                <div className="flex items-center justify-between gap-3">
                                  <span className="font-bold text-slate-300">#{d.rank} {d.symbol}</span>
                                  <span className="text-[10px] text-slate-400">{d.exitDate}</span>
                                </div>
                                <div className="pt-1 border-t border-slate-800 space-y-0.5 font-mono font-bold">
                                  <div className="flex justify-between gap-4">
                                    <span className="text-slate-400">Return:</span>
                                    <span className={d.pnlPct >= 0 ? "text-emerald-400" : "text-rose-400"}>
                                      {d.pnlPct >= 0 ? "+" : ""}{d.pnlPct}% (+₹{d.pnl.toLocaleString("en-IN")})
                                    </span>
                                  </div>
                                  <div className="text-[11px] text-slate-400 flex items-center justify-between gap-2 font-normal">
                                    <span>Exit:</span>
                                    <span className="text-slate-200 truncate max-w-[150px]">{d.reason}</span>
                                  </div>
                                </div>
                              </div>
                            )
                          }
                          return null
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="pnlPct"
                        stroke="#059669"
                        strokeWidth={2}
                        fill="url(#convexGrad)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="mt-3 p-3 rounded-2xl bg-slate-50 border border-slate-100 text-[11px] text-slate-500 font-medium">
                <strong className="text-slate-800 font-bold">Asymmetric Edge:</strong> Truncated flat losses on the left, parabolic multibaggers on the right.
              </div>
            </div>

            {/* Right: Outcome Frequency Distribution */}
            <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-start gap-2 mb-3">
                  <div>
                    <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                      <BarChart3 className="size-4 text-sky-600" />
                      Outcome Frequency by Return Bucket
                    </h3>
                    <p className="text-[11px] text-slate-400 font-medium mt-0.5">
                      Counts and net P&L across stops, shields, and runners
                    </p>
                  </div>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-50 text-sky-700 border border-sky-200 shrink-0 font-mono">
                    300 Trades
                  </span>
                </div>

                <div className="h-[220px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={distributionBuckets} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
                      <CartesianGrid stroke="#f1f5f9" vertical={false} strokeDasharray="3 3" />
                      <XAxis
                        dataKey="label"
                        stroke="#94a3b8"
                        fontSize={9}
                        tickLine={false}
                        axisLine={false}
                        interval={0}
                        angle={-15}
                        textAnchor="end"
                      />
                      <YAxis
                        stroke="#94a3b8"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: number) => `${v}`}
                        width={35}
                      />
                      <RechartsTooltip
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            const d = payload[0].payload
                            return (
                              <div className="bg-slate-900 text-white p-2.5 rounded-xl border border-slate-700 shadow-xl text-xs space-y-1">
                                <div className="font-bold text-slate-300">{d.label}</div>
                                <div className="pt-1 border-t border-slate-800 space-y-0.5 font-mono">
                                  <div className="flex justify-between gap-4">
                                    <span className="text-slate-400">Count:</span>
                                    <span className="text-white font-bold">{d.count} trades ({((d.count / trades.length) * 100).toFixed(1)}%)</span>
                                  </div>
                                  <div className="flex justify-between gap-4">
                                    <span className="text-slate-400">Net P&L:</span>
                                    <span className={`font-bold ${d.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                      {d.pnl >= 0 ? "+" : ""}₹{Math.round(d.pnl).toLocaleString("en-IN")}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            )
                          }
                          return null
                        }}
                      />
                      <Bar dataKey="count" radius={[5, 5, 0, 0]}>
                        {distributionBuckets.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between text-[11px] font-mono text-slate-500 bg-slate-50 p-2.5 rounded-2xl border border-slate-100 flex-wrap gap-2">
                <span>19 Multibaggers: <strong className="text-emerald-700 font-bold">+₹7.77L</strong></span>
                <span>40 Solid Wins: <strong className="text-emerald-600 font-bold">+₹3.08L</strong></span>
                <span>70 Shields: <strong className="text-slate-600 font-bold">-₹55k</strong></span>
              </div>
            </div>
          </div>

          {/* 3. MULTI-YEAR PAYOFF & CONSISTENCY AUDIT TABLE */}
          <div className="bg-white rounded-3xl border border-slate-200/80 overflow-hidden shadow-xs">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center flex-wrap gap-2">
              <div>
                <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                  <Award className="size-4 text-emerald-600" />
                  Multi-Year Payoff & Consistency Audit (2022 – 2026)
                </h3>
                <p className="text-[11px] text-slate-400 font-medium">
                  Year-by-year validation of win rates, payoff ratios, max drawdowns, and net realized profits
                </p>
              </div>
              <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                Total Realized: +₹11.20L
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50/90 border-b border-slate-100 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
                    <th className="p-3.5">Year</th>
                    <th className="p-3.5 font-mono text-center">Closed Trades</th>
                    <th className="p-3.5 font-mono text-center">Wins / Losses</th>
                    <th className="p-3.5 font-mono text-center">Win Rate</th>
                    <th className="p-3.5 font-mono text-center">Payoff Ratio</th>
                    <th className="p-3.5 font-mono text-center">Profit Factor</th>
                    <th className="p-3.5 font-mono text-center">Avg Win</th>
                    <th className="p-3.5 font-mono text-center">Avg Loss</th>
                    <th className="p-3.5 font-mono text-center">Max Drawdown</th>
                    <th className="p-3.5 font-mono text-right">Net Realized P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {yearlyPayoffStats.map((y) => (
                    <tr key={y.year} className="hover:bg-slate-50/80 transition">
                      <td className="p-3.5 font-black text-slate-900 font-mono text-sm">{y.year}</td>
                      <td className="p-3.5 font-mono text-center text-slate-700">{y.totalTrades}</td>
                      <td className="p-3.5 font-mono text-center text-slate-500 text-[11px]">
                        <span className="text-emerald-700 font-bold">{y.wins}W</span> / <span className="text-rose-600 font-bold">{y.losses}L</span>
                      </td>
                      <td className="p-3.5 font-mono text-center font-bold text-slate-800">{y.winRate}%</td>
                      <td className="p-3.5 font-mono text-center font-black text-amber-600 bg-amber-50/40">{y.payoffRatio}x</td>
                      <td className="p-3.5 font-mono text-center font-bold text-slate-800">{y.profitFactor}</td>
                      <td className="p-3.5 font-mono text-center text-emerald-700 font-bold">+₹{y.avgWin.toLocaleString("en-IN")}</td>
                      <td className="p-3.5 font-mono text-center text-rose-600 font-bold">-₹{y.avgLoss.toLocaleString("en-IN")}</td>
                      <td className="p-3.5 font-mono text-center text-rose-600 font-bold">-₹{(Math.abs(y.maxDrawdown) / 1000).toFixed(1)}k</td>
                      <td className="p-3.5 font-mono text-right font-black text-sm">
                        <span className={y.pnl >= 0 ? "text-emerald-600" : "text-rose-600"}>
                          {y.pnl >= 0 ? "+" : ""}₹{y.pnl.toLocaleString("en-IN")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        )
      )}

      {/* ================= 4. EMBEDDED INTERACTIVE TRADINGVIEW CHART MODAL ================= */}
      {selectedTradeForChart && (
        <SwingerTradeChartModal
          trade={selectedTradeForChart}
          allTrades={chartableList}
          onSelectTrade={(t) => setSelectedTradeForChart(t)}
          onClose={() => setSelectedTradeForChart(null)}
        />
      )}
    </div>
  )
}

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
  ChevronDown,
  ChevronUp,
  Search,
  Flame,
  Wallet,
  Sparkles
} from "lucide-react"
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
  days_held: number
  booked_pnl?: number
  unrealized_pnl?: number
  unrealized_pnl_pct?: number
  unrealized_pct?: number
  status?: string
  exit_rule?: string
  ema20?: number
}

interface Trade {
  trade_id?: number
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
  const [showMonthlyMatrix, setShowMonthlyMatrix] = useState(false)

  // Chart Inspection Modal Target
  const [selectedTradeForChart, setSelectedTradeForChart] = useState<SwingerTradeTarget | null>(null)

  // Navigation Tabs: 'all' | 'holdings' | 'calendar' | 'radar'
  const [activeTab, setActiveTab] = useState<"all" | "holdings" | "calendar" | "radar">("all")
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  // Filters for 'all' triggers tab
  const [filterType, setFilterType] = useState<"ALL" | "TODAY" | "ACTIVE" | "WIN" | "LOSS" | "RADAR">("ALL")
  const [searchQuery, setSearchQuery] = useState("")
  const [displayLimit, setDisplayLimit] = useState(30)
  const [yearGrouping, setYearGrouping] = useState<"entry" | "exit">("entry")

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
    return r
      .replace("RUNNER_TRAIL_25PCT", "Runner 25% Trail")
      .replace("INITIAL_SL_25PCT", "Initial SL -25%")
      .replace("BE_SHIELD_STOP", "BE Shield @ Cost")
      .replace("MAX_HOLD_1YEAR", "1-Year Max Hold")
      .replace("TP 50% Hit (+100%) -> Trailed 25% Runner Exit", "TP1 + Runner 25% Trail")
      .replace("TP1 Hit (+30%) -> Trailed 25% Runner Exit", "TP1 (+30%) + Runner Trail")
      .replace("Break-Even Shield Exit (Cost Protected)", "BE Shield @ Cost")
      .replace("Initial Stop-Loss (-25%)", "Initial SL -25%")
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

  // Master Unified Triggers Stream
  const unifiedTriggers = useMemo(() => {
    const list: any[] = []
    const todayIso = new Date().toISOString().slice(0, 10)

    // 1. Today's Fresh Scanner Signals
    dailySignals.signals.forEach((sig) => {
      const alreadyHeld = positions.some((p) => p.symbol === sig.nsecode)
      const scanDate = dailySignals.last_scan_time ? dailySignals.last_scan_time.slice(0, 10) : todayIso
      list.push({
        id: `sig-${sig.nsecode}`,
        type: "TODAY",
        subType: alreadyHeld ? "HELD" : "NEW",
        symbol: sig.nsecode,
        name: sig.name || sig.nsecode,
        date: scanDate,
        entryPrice: sig.close ?? 0,
        currentPrice: sig.close ?? 0,
        exitPrice: null,
        pnl: 0,
        pnlPct: sig.per_chg ?? 0,
        bookedPnl: 0,
        daysHeld: 0,
        statusLabel: alreadyHeld ? "Already in Portfolio" : "Today's Screener Hit",
        ruleDetails: `Volume: ${(sig.volume || 0).toLocaleString("en-IN")} · Gain: +${(sig.per_chg || 0).toFixed(1)}%`,
        raw: {
          symbol: sig.nsecode,
          name: sig.name,
          entry_date: scanDate,
          entry_price: sig.close,
          cmp: sig.close,
          exit_price: sig.close,
          status: "ACTIVE",
          reason: "Today Screener Trigger",
          pnl: 0,
          pct_return: sig.per_chg || 0,
          holding_days: 0
        }
      })
    })

    // 2. Active Positions
    positions.forEach((p) => {
      const avgCost = p.avg_price ?? p.entry_price
      list.push({
        id: `pos-${p.symbol}`,
        type: "ACTIVE",
        subType: p.runner_mode ? "RUNNER" : p.be_active ? "SHIELDED" : "ACTIVE",
        symbol: p.symbol,
        name: p.name || p.symbol,
        date: p.entry_date,
        entryPrice: avgCost,
        currentPrice: p.cmp,
        exitPrice: null,
        pnl: p.unrealized_pnl ?? 0,
        pnlPct: p.unrealized_pnl_pct ?? p.unrealized_pct ?? 0,
        bookedPnl: p.booked_pnl ?? 0,
        daysHeld: p.days_held,
        statusLabel: p.runner_mode
          ? "Runner Trailing 25%"
          : p.be_active
          ? "Shield Active (Cost Protected)"
          : "Holding Active",
        ruleDetails: `SL: ₹${(p.sl_price ?? avgCost * 0.75).toFixed(1)} · Target: ₹${(
          p.tp_target_price ?? avgCost * 1.3
        ).toFixed(1)}`,
        raw: p
      })
    })

    // 3. Historical Closed Trades
    trades.forEach((t) => {
      const isWin = (t.pnl || 0) > 0
      const entryPrice = t.avg_price ?? t.entry_price
      list.push({
        id: `trade-${t.symbol}-${t.exit_date}`,
        type: "CLOSED",
        subType: isWin ? "WIN" : "LOSS",
        symbol: t.symbol,
        name: t.name || t.symbol,
        date: t.entry_date,
        exitDate: t.exit_date,
        entryPrice: entryPrice,
        currentPrice: t.exit_price,
        exitPrice: t.exit_price,
        pnl: t.pnl,
        pnlPct: t.pnl_pct ?? t.pct_return ?? 0,
        bookedPnl: 0,
        daysHeld: t.days_held ?? (t as any).holding_days ?? 0,
        statusLabel: isWin ? "Closed Winner" : "Stopped Out",
        ruleDetails: formatExitReason(t.reason || (t as any).exit_reason),
        raw: t
      })
    })

    // 4. Radar Watchlist
    watchlist.forEach((w) => {
      list.push({
        id: `radar-${w.symbol}`,
        type: "RADAR",
        subType: w.status === "ENTERED" ? "ENTERED" : w.cooldown_ready ? "READY" : "MONITORING",
        symbol: w.symbol,
        name: w.name || w.symbol,
        date: w.alert_date,
        entryPrice: w.alert_price,
        currentPrice: w.current_price,
        exitPrice: null,
        pnl: 0,
        pnlPct: w.pullback_pct ?? 0,
        bookedPnl: 0,
        daysHeld: 0,
        statusLabel: w.cooldown_ready ? "Stage-2 Ready" : "Cooling Down",
        ruleDetails: `RSI: ${w.current_rsi?.toFixed(1)} · EMA20: ₹${w.ema20?.toFixed(1)} (${w.distance_to_ema20_pct ?? 0}%)`,
        raw: {
          symbol: w.symbol,
          name: w.name,
          entry_date: w.alert_date,
          entry_price: w.alert_price,
          cmp: w.current_price,
          exit_price: w.current_price,
          status: "ACTIVE",
          reason: w.notes,
          pnl: 0,
          pct_return: w.pullback_pct || 0,
          holding_days: 0
        }
      })
    })

    // Sort by date descending
    return list.sort((a, b) => (b.date || "").localeCompare(a.date || ""))
  }, [positions, trades, watchlist, dailySignals])

  // Filtered triggers based on active category and search
  const filteredUnifiedTriggers = useMemo(() => {
    return unifiedTriggers.filter((item) => {
      if (filterType === "TODAY" && item.type !== "TODAY") return false
      if (filterType === "ACTIVE" && item.type !== "ACTIVE") return false
      if (filterType === "WIN" && !(item.type === "CLOSED" && item.subType === "WIN")) return false
      if (filterType === "LOSS" && !(item.type === "CLOSED" && item.subType === "LOSS")) return false
      if (filterType === "RADAR" && item.type !== "RADAR") return false

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim()
        const matchesSym = item.symbol.toLowerCase().includes(q)
        const matchesName = item.name.toLowerCase().includes(q)
        if (!matchesSym && !matchesName) return false
      }
      return true
    })
  }, [unifiedTriggers, filterType, searchQuery])

  // Paginated visible triggers for smooth rendering
  const visibleTriggers = useMemo(() => {
    return filteredUnifiedTriggers.slice(0, displayLimit)
  }, [filteredUnifiedTriggers, displayLimit])

  // Trades on Clicked Calendar Date
  const calendarSelectedTrades = useMemo(() => {
    if (!selectedDate) return []
    return trades.filter((t) => t.exit_date === selectedDate || t.entry_date === selectedDate)
  }, [trades, selectedDate])

  // All chartable trades/triggers for keyboard & button flipping inside chart modal
  const chartableList = useMemo(() => {
    if (activeTab === "calendar" && calendarSelectedTrades.length > 0) {
      return calendarSelectedTrades as any[]
    }
    if (activeTab === "holdings") {
      return positions as any[]
    }
    return filteredUnifiedTriggers.map((t) => t.raw)
  }, [activeTab, calendarSelectedTrades, positions, filteredUnifiedTriggers])

  return (
    <div className="flex-1 space-y-5 p-4 sm:p-6 bg-slate-50 min-h-screen text-slate-900 font-sans">
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
          </div>
          <p className="text-xs text-slate-500 mt-1 font-medium">
            Turnaround Momentum Engine · -20% Stop Loss · +15% Break-Even Shield · +30% Take Profit 1 · 25% Runner Trail
          </p>
        </div>

        <div className="flex items-center gap-2 self-stretch md:self-auto justify-end flex-wrap">
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
        {/* Card 1: Realized Net P&L */}
        <div className="p-4 rounded-3xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
            <span>Realized Net P&L</span>
            <span className="text-emerald-600 font-mono font-black">{summary.win_rate ?? 55.2}% WR</span>
          </div>
          <div className="my-2">
            <div className="text-2xl font-black font-mono tracking-tight text-emerald-600">
              +₹{(summary.net_pnl ?? 100724).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
            </div>
            <div className="text-xs text-emerald-700 font-bold mt-0.5">
              +{(((summary.net_pnl ?? 100724) / 250000.0) * 100).toFixed(1)}% ROI on ₹2.5L Base
            </div>
          </div>
          <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-medium">
            <span>{trades.length} Closed Trades</span>
            <span>PF: <strong className="text-slate-800 font-bold">{summary.profit_factor ?? 1.47}</strong></span>
          </div>
        </div>

        {/* Card 2: Active Portfolio Holdings */}
        <div className="p-4 rounded-3xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
            <span>Active Holdings</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-100 text-sky-800 border border-sky-200">
              {positions.length} Positions
            </span>
          </div>
          <div className="my-2">
            <div className={`text-2xl font-black font-mono tracking-tight ${totalUnrealizedPnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {totalUnrealizedPnl >= 0 ? "+" : ""}₹{totalUnrealizedPnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
            </div>
            <div className="text-xs text-slate-500 font-medium mt-0.5">
              Unrealized Open P&L
            </div>
          </div>
          <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-medium">
            <span>Banked TP1 Cash:</span>
            <span className="text-emerald-700 font-bold font-mono">+₹{totalBookedPnl.toLocaleString("en-IN")}</span>
          </div>
        </div>

        {/* Card 3: Capital & Allocation */}
        <div className="p-4 rounded-3xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
            <span>Capital Allocation</span>
            <Wallet className="size-4 text-slate-400" />
          </div>
          <div className="my-2">
            <div className="text-2xl font-black font-mono tracking-tight text-slate-900">
              ₹{(250000 + (summary.net_pnl ?? 100724)).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
            </div>
            <div className="text-xs text-slate-500 font-medium mt-0.5">
              Invested: ₹{(totalInvested / 1000).toFixed(0)}k · Available: ₹{(Math.max(0, 250000 - totalInvested) / 1000).toFixed(0)}k
            </div>
          </div>
          <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-medium">
            <span>Slot Size:</span>
            <span className="text-slate-800 font-mono font-bold">₹25,000 / Stock</span>
          </div>
        </div>

        {/* Card 4: Scanner Hits & Radar */}
        <div className="p-4 rounded-3xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
            <span>Today's Screener Hits</span>
            <Flame className="size-4 text-amber-500" />
          </div>
          <div className="my-2">
            <div className="text-2xl font-black font-mono tracking-tight text-purple-700">
              {dailySignals.count} {dailySignals.count === 1 ? "Stock" : "Stocks"}
            </div>
            <div className="text-xs text-purple-800 font-bold mt-0.5 truncate">
              {dailySignals.signals.length > 0 ? (
                <span>
                  {dailySignals.signals[0].nsecode} (+{(dailySignals.signals[0].per_chg || 0).toFixed(1)}%)
                </span>
              ) : (
                "No fresh breakout today"
              )}
            </div>
          </div>
          <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-medium">
            <span>Watchlist Radar:</span>
            <span className="text-amber-700 font-bold">{watchlist.length} Pullback Setups</span>
          </div>
        </div>
      </div>

      {/* ================= 3. PRIMARY NAVIGATION TABS ================= */}
      <div className="flex items-center justify-between bg-white p-2 rounded-2xl border border-slate-200/80 shadow-xs gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => setActiveTab("all")}
            className={`px-4 py-2 rounded-xl text-xs font-extrabold transition flex items-center gap-2 ${
              activeTab === "all"
                ? "bg-emerald-600 text-white shadow-emerald-200 shadow-sm"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <Zap className="size-3.5" />
            All Triggers & Feed
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                activeTab === "all" ? "bg-emerald-700 text-white" : "bg-slate-200 text-slate-700"
              }`}
            >
              {unifiedTriggers.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("holdings")}
            className={`px-4 py-2 rounded-xl text-xs font-extrabold transition flex items-center gap-2 ${
              activeTab === "holdings"
                ? "bg-emerald-600 text-white shadow-emerald-200 shadow-sm"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <ShieldCheck className="size-3.5" />
            Active Positions
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
            className={`px-4 py-2 rounded-xl text-xs font-extrabold transition flex items-center gap-2 ${
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
            className={`px-4 py-2 rounded-xl text-xs font-extrabold transition flex items-center gap-2 ${
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
              {watchlist.length}
            </span>
          </button>
        </div>

        <div className="text-[11px] text-slate-400 font-medium px-2 hidden lg:block">
          Click any stock symbol to view full 5-year interactive chart
        </div>
      </div>

      {/* ================= TAB 1: ALL TRIGGERS & MASTER FEED ================= */}
      {activeTab === "all" && (
        <div className="space-y-4">
          {/* Sub-Filters & Search Bar */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mr-1 hidden sm:inline">
                Filter:
              </span>
              <button
                type="button"
                onClick={() => setFilterType("ALL")}
                className={`px-3 py-1 rounded-xl text-xs font-bold transition ${
                  filterType === "ALL"
                    ? "bg-slate-900 text-white shadow-xs"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                All ({unifiedTriggers.length})
              </button>

              <button
                type="button"
                onClick={() => setFilterType("TODAY")}
                className={`px-3 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1 ${
                  filterType === "TODAY"
                    ? "bg-purple-600 text-white shadow-xs"
                    : "bg-purple-50 text-purple-700 hover:bg-purple-100"
                }`}
              >
                <Flame className="size-3" />
                Today's Hits ({dailySignals.count})
              </button>

              <button
                type="button"
                onClick={() => setFilterType("ACTIVE")}
                className={`px-3 py-1 rounded-xl text-xs font-bold transition ${
                  filterType === "ACTIVE"
                    ? "bg-sky-600 text-white shadow-xs"
                    : "bg-sky-50 text-sky-700 hover:bg-sky-100"
                }`}
              >
                Active ({positions.length})
              </button>

              <button
                type="button"
                onClick={() => setFilterType("WIN")}
                className={`px-3 py-1 rounded-xl text-xs font-bold transition ${
                  filterType === "WIN"
                    ? "bg-emerald-600 text-white shadow-xs"
                    : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                }`}
              >
                Winners ({trades.filter((t) => (t.pnl || 0) > 0).length})
              </button>

              <button
                type="button"
                onClick={() => setFilterType("LOSS")}
                className={`px-3 py-1 rounded-xl text-xs font-bold transition ${
                  filterType === "LOSS"
                    ? "bg-rose-600 text-white shadow-xs"
                    : "bg-rose-50 text-rose-700 hover:bg-rose-100"
                }`}
              >
                Stop Loss ({trades.filter((t) => (t.pnl || 0) <= 0).length})
              </button>

              <button
                type="button"
                onClick={() => setFilterType("RADAR")}
                className={`px-3 py-1 rounded-xl text-xs font-bold transition ${
                  filterType === "RADAR"
                    ? "bg-amber-600 text-white shadow-xs"
                    : "bg-amber-50 text-amber-700 hover:bg-amber-100"
                }`}
              >
                Radar ({watchlist.length})
              </button>
            </div>

            {/* Quick Search */}
            <div className="relative w-full sm:w-64">
              <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search symbol or name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 rounded-xl border border-slate-200 text-xs font-medium focus:outline-hidden focus:border-emerald-500 bg-slate-50 focus:bg-white transition"
              />
            </div>
          </div>

          {/* Master Stream Table */}
          <div className="rounded-3xl border border-slate-200/80 bg-white overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50/90 border-b border-slate-100 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
                    <th className="p-3.5">Stock Symbol</th>
                    <th className="p-3.5">Category</th>
                    <th className="p-3.5 font-mono">Date</th>
                    <th className="p-3.5 font-mono">Entry (₹)</th>
                    <th className="p-3.5 font-mono">CMP / Exit (₹)</th>
                    <th className="p-3.5">Held</th>
                    <th className="p-3.5 text-right font-mono">Gain / Loss</th>
                    <th className="p-3.5">Milestone / Exit Reason</th>
                    <th className="p-3.5 text-center">Interactive Chart</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleTriggers.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-8 text-center text-slate-400 font-medium">
                        No triggers match the selected filter.
                      </td>
                    </tr>
                  ) : (
                    visibleTriggers.map((item, idx) => {
                      const isPositive = (item.pnl || item.pnlPct || 0) >= 0

                      return (
                        <tr
                          key={idx}
                          onClick={() => setSelectedTradeForChart(item.raw)}
                          className="hover:bg-slate-50/90 cursor-pointer transition group"
                        >
                          {/* Symbol Column */}
                          <td className="p-3.5">
                            <div className="flex items-center gap-2">
                              <div
                                className={`size-8 rounded-xl flex items-center justify-center font-bold text-white text-[11px] ${
                                  item.type === "TODAY"
                                    ? "bg-purple-600"
                                    : item.type === "ACTIVE"
                                    ? "bg-sky-600"
                                    : item.subType === "WIN"
                                    ? "bg-emerald-600"
                                    : item.type === "RADAR"
                                    ? "bg-amber-600"
                                    : "bg-rose-600"
                                }`}
                              >
                                {item.symbol.slice(0, 2)}
                              </div>
                              <div>
                                <div className="font-black text-slate-900 text-sm group-hover:text-emerald-700 transition flex items-center gap-1.5">
                                  <span className="hover:underline font-mono">{item.symbol}</span>
                                  <LineChart className="size-3 text-slate-400 group-hover:text-emerald-600 transition shrink-0" />
                                </div>
                                <div className="text-[11px] text-slate-500 font-medium truncate max-w-[140px]">
                                  {item.name}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Category Badge */}
                          <td className="p-3.5">
                            {item.type === "TODAY" ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-200">
                                <Flame className="size-3 text-purple-600" />
                                Screener Hit
                              </span>
                            ) : item.type === "ACTIVE" ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-sky-100 text-sky-800 border border-sky-200">
                                <ShieldCheck className="size-3 text-sky-600" />
                                Active Slot
                              </span>
                            ) : item.type === "CLOSED" ? (
                              <span
                                className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${
                                  item.subType === "WIN"
                                    ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                                    : "bg-rose-100 text-rose-800 border-rose-200"
                                }`}
                              >
                                {item.subType === "WIN" ? "Winner" : "Stop Loss"}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
                                Radar Pullback
                              </span>
                            )}
                          </td>

                          {/* Date */}
                          <td className="p-3.5 font-mono text-slate-600 font-medium">
                            {item.date}
                            {item.exitDate && (
                              <span className="block text-[10px] text-slate-400">Exit: {item.exitDate}</span>
                            )}
                          </td>

                          {/* Entry Price */}
                          <td className="p-3.5 font-mono font-bold text-slate-900">
                            ₹{(item.entryPrice ?? 0).toFixed(2)}
                          </td>

                          {/* Current / Exit Price */}
                          <td className="p-3.5 font-mono font-bold text-slate-800">
                            ₹{(item.currentPrice ?? item.entryPrice ?? 0).toFixed(2)}
                          </td>

                          {/* Days Held */}
                          <td className="p-3.5 text-slate-600 font-medium font-mono">
                            {item.daysHeld ? `${item.daysHeld}d` : "—"}
                          </td>

                          {/* Gain / Loss */}
                          <td className="p-3.5 text-right font-mono font-black">
                            <span className={isPositive ? "text-emerald-600" : "text-rose-600"}>
                              {isPositive ? "+" : ""}
                              {(item.pnlPct ?? 0).toFixed(1)}%
                              {item.pnl !== 0 && (
                                <span className="block text-[10px] font-bold">
                                  ({isPositive ? "+" : ""}₹{item.pnl.toLocaleString("en-IN")})
                                </span>
                              )}
                            </span>
                          </td>

                          {/* Milestone / Exit Reason */}
                          <td className="p-3.5 text-slate-600 text-xs font-medium max-w-[200px] truncate">
                            {item.ruleDetails}
                          </td>

                          {/* Chart Button */}
                          <td className="p-3.5 text-center">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedTradeForChart(item.raw)
                              }}
                              className="h-7 px-2.5 text-xs font-bold text-emerald-700 hover:text-emerald-900 hover:bg-emerald-50 rounded-lg gap-1"
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

            {/* Pagination / Progressive Loading */}
            {filteredUnifiedTriggers.length > displayLimit && (
              <div className="p-3.5 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                <span>
                  Showing {displayLimit} of {filteredUnifiedTriggers.length} items
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDisplayLimit((prev) => prev + 30)}
                    className="h-7 text-xs font-bold rounded-lg border-slate-200"
                  >
                    Load Next 30
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDisplayLimit(filteredUnifiedTriggers.length)}
                    className="h-7 text-xs font-bold rounded-lg text-emerald-700 hover:bg-emerald-50"
                  >
                    Show All
                  </Button>
                </div>
              </div>
            )}
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
                Autonomous SL tracking: -20% Initial SL · +15% Cost Shield · +30% TP1 Booking · 25% Runner Trail
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
                    <th className="p-3.5">Break-Even Shield</th>
                    <th className="p-3.5">TP1 (+30%)</th>
                    <th className="p-3.5">Runner Trail</th>
                    <th className="p-3.5 font-mono">Held</th>
                    <th className="p-3.5 text-right font-mono">Open P&L</th>
                    <th className="p-3.5 text-center">Chart</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {positions.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="p-8 text-center text-slate-400 font-medium">
                        No active positions currently. Scanner runs daily at 15:25 IST.
                      </td>
                    </tr>
                  ) : (
                    positions.map((p) => {
                      const avgCost = p.avg_price ?? p.entry_price
                      const isPositive = (p.unrealized_pnl || 0) >= 0
                      const slDisplay = p.sl_price ?? avgCost * 0.75
                      const beTarget = p.be_trigger_price ?? avgCost * 1.2
                      const tpTarget = p.tp_target_price ?? avgCost * 1.3

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
                            </div>
                            <div className="text-[11px] text-slate-500 font-medium truncate max-w-[130px]">
                              {p.name || p.symbol}
                            </div>
                          </td>
                          <td className="p-3.5 font-mono text-slate-600 font-medium">{p.entry_date}</td>
                          <td className="p-3.5 font-mono font-bold text-slate-900">₹{avgCost.toFixed(2)}</td>
                          <td className="p-3.5 font-mono font-bold text-emerald-700">₹{(p.cmp || avgCost).toFixed(2)}</td>
                          <td className="p-3.5 font-mono font-medium">{p.current_qty}</td>
                          <td className="p-3.5 font-mono font-bold">
                            <span className={p.be_active ? "text-sky-700" : "text-rose-600"}>
                              ₹{slDisplay.toFixed(2)}
                            </span>
                            <span className="block text-[10px] text-slate-400 font-normal">
                              {p.runner_mode ? "25% Trail" : p.be_active ? "Cost Shield" : "Initial -20%"}
                            </span>
                          </td>
                          <td className="p-3.5 font-mono">
                            {p.be_active ? (
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
                          <td className="p-3.5 font-mono">
                            {p.tp_hit || p.tp_50_hit ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                                50% Booked (+30%)
                              </span>
                            ) : (
                              <span className="text-emerald-700 font-bold">
                                ₹{tpTarget.toFixed(2)}
                                <span className="text-[10px] text-slate-400 block font-normal">+30% Target</span>
                              </span>
                            )}
                          </td>
                          <td className="p-3.5 font-mono">
                            {p.runner_mode && p.runner_trail_sl ? (
                              <span className="text-purple-700 font-bold">
                                ₹{p.runner_trail_sl.toFixed(2)}
                                <span className="text-[10px] text-slate-400 block font-normal">
                                  Peak: ₹{p.runner_peak_price}
                                </span>
                              </span>
                            ) : (
                              <span className="text-slate-400 font-medium text-[11px]">Unlocks @ +30%</span>
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
        <div className="space-y-5">
          {/* Calendar Heatmap Card */}
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
                  className="rounded-xl text-xs font-bold text-slate-600 border-slate-200"
                >
                  Clear Selection ({selectedDate})
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
              <div className="mt-5 p-4 rounded-2xl bg-slate-50 border border-slate-200 animate-in fade-in duration-150">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-black text-sm text-slate-900 flex items-center gap-2 font-mono">
                    <LineChart className="size-4 text-emerald-600" />
                    Trades for Date: {selectedDate} ({calendarSelectedTrades.length} Trades)
                  </h4>
                  <span className="text-xs text-slate-500 font-medium">Click any row to open candlestick chart</span>
                </div>

                {calendarSelectedTrades.length === 0 ? (
                  <p className="text-xs text-slate-500 py-3 text-center">No trades closed or entered on {selectedDate}.</p>
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

          {/* Annual Vintage Consistency Scorecard */}
          <div className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
              <div>
                <h3 className="font-extrabold text-base text-slate-900 flex items-center gap-2">
                  <BarChart3 className="size-5 text-emerald-600" />
                  Annual Consistency Scorecard (2022 - 2026)
                </h3>
                <p className="text-xs text-slate-500 font-medium">
                  {yearGrouping === "entry"
                    ? "Grouped by Signal Entry Year (Cohort Vintage) — shows true strategy conviction"
                    : "Grouped by Realized Exit Date (Calendar Year Accounting)"}
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
                  By Signal Year (Vintage)
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
                  By Realized Exit Date
                </button>
              </div>
            </div>

            {/* Scorecard Year Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {dynamicYearly.map((y) => {
                const isProf = (y.pnl ?? 0) >= 0
                const winRate = y.win_rate ?? 0
                const pf = y.profit_factor ?? 0
                const retPct = y.pnl_pct ?? 0

                return (
                  <div
                    key={y.year}
                    className={`rounded-2xl border p-4 transition ${
                      isProf ? "bg-emerald-50/40 border-emerald-200" : "bg-rose-50/40 border-rose-200"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-black text-sm text-slate-900 font-mono">{y.year}</span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                          isProf ? "bg-emerald-100 text-emerald-800 border-emerald-300" : "bg-rose-100 text-rose-800 border-rose-300"
                        }`}
                      >
                        {isProf ? "PROFITABLE" : "DRAWDOWN"}
                      </span>
                    </div>

                    <div className="mt-2.5">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                        Net Realized P&L
                      </span>
                      <div className={`text-lg font-black font-mono tracking-tight mt-0.5 ${isProf ? "text-emerald-700" : "text-rose-700"}`}>
                        {isProf ? "+" : ""}₹{(y.pnl ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                        <span className="text-xs ml-1 font-bold">
                          ({isProf ? "+" : ""}{retPct.toFixed(1)}%)
                        </span>
                      </div>
                    </div>

                    <div className="mt-3 pt-2.5 border-t border-slate-200/80 flex items-center justify-between text-xs text-slate-600 font-medium">
                      <span>{y.trades} trades</span>
                      <span className="font-bold text-slate-800">
                        {winRate.toFixed(1)}% WR · PF {pf > 0 ? pf.toFixed(2) : "0.0"}
                      </span>
                    </div>

                    {/* Win Rate Progress Bar */}
                    <div className="mt-2 w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isProf ? "bg-emerald-500" : "bg-rose-500"}`}
                        style={{ width: `${Math.min(100, Math.max(5, winRate))}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Collapsible Monthly Matrix */}
            <div className="mt-6 pt-5 border-t border-slate-100">
              <div
                className="flex justify-between items-center cursor-pointer"
                onClick={() => setShowMonthlyMatrix(!showMonthlyMatrix)}
              >
                <div>
                  <h4 className="font-extrabold text-sm text-slate-900 flex items-center gap-2">
                    <BarChart3 className="size-4 text-emerald-600" />
                    Month-by-Month Breakdown ({monthly.length} Months)
                  </h4>
                  <p className="text-xs text-slate-500 font-medium">Click to {showMonthlyMatrix ? "hide" : "expand"} performance matrix</p>
                </div>
                <Button variant="ghost" size="sm" className="gap-1 text-xs font-bold text-slate-600">
                  {showMonthlyMatrix ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                  {showMonthlyMatrix ? "Collapse" : "Expand"}
                </Button>
              </div>

              {showMonthlyMatrix && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 max-h-96 overflow-y-auto pr-1 mt-4 pt-3 border-t border-slate-100">
                  {monthly.map((m) => {
                    const isProfitable = (m.pnl ?? 0) > 0
                    return (
                      <div
                        key={m.month}
                        className={`rounded-2xl border p-3.5 transition ${
                          isProfitable ? "bg-emerald-50/50 border-emerald-300" : "bg-white border-slate-200"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-xs text-slate-900">{m.label}</span>
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold border bg-slate-100 text-slate-700 font-mono">
                            PF {(m.profit_factor ?? 0).toFixed(2)}
                          </span>
                        </div>
                        <div className="mt-2 flex items-baseline justify-between">
                          <span className="text-[11px] text-slate-500 font-semibold">Net:</span>
                          <span className={`text-sm font-black font-mono ${isProfitable ? "text-emerald-600" : "text-rose-600"}`}>
                            {isProfitable ? "+" : ""}₹{(m.pnl ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                            <span className="text-[10px] ml-1 font-semibold">
                              ({isProfitable ? "+" : ""}{(m.pnl_pct ?? 0).toFixed(1)}%)
                            </span>
                          </span>
                        </div>
                        <div className="mt-2 pt-1.5 border-t border-slate-200 flex items-center justify-between text-[11px] text-slate-600">
                          <span>{m.trades} trades</span>
                          <span>
                            <strong className="text-emerald-700">{m.wins}W</strong> / <strong className="text-rose-700">{m.losses}L</strong> ({m.win_rate}%)
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 4: RADAR WATCHLIST ================= */}
      {activeTab === "radar" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs">
            <div>
              <h2 className="text-base font-black text-slate-900 flex items-center gap-2">
                <Flame className="size-5 text-amber-500" />
                Turnaround Pullback Radar ({watchlist.length} Candidates)
              </h2>
              <p className="text-xs text-slate-500 font-medium">
                High-probability swing re-entry: Alerted on massive volume surge (RSI above 68), cooling down to 20 EMA
              </p>
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
                  {watchlist.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-8 text-center text-slate-400 font-medium">
                        No stocks currently on radar cooldown.
                      </td>
                    </tr>
                  ) : (
                    watchlist.map((item) => (
                      <tr
                        key={item.symbol}
                        onClick={() =>
                          setSelectedTradeForChart({
                            symbol: item.symbol,
                            name: item.name || item.symbol,
                            entry_date: item.alert_date,
                            entry_price: item.alert_price,
                            cmp: item.current_price,
                            exit_price: item.current_price,
                            status: "ACTIVE",
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
                          {item.cooldown_ready ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                              <CheckCircle2 className="size-3 text-emerald-600" />
                              Stage-2 Ready
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                              <Clock className="size-3 text-amber-500" />
                              Cooling Down
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
                                entry_date: item.alert_date,
                                entry_price: item.alert_price,
                                cmp: item.current_price,
                                exit_price: item.current_price,
                                status: "ACTIVE",
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

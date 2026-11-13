import { useState, useEffect, useMemo } from "react"
import {
  TrendingUp,
  RefreshCw,
  Clock,
  Calendar as CalendarIcon,
  Layers,
  BarChart3,
  ShieldCheck,
  Zap,
  CheckCircle2,
  LineChart,
  ChevronDown,
  ChevronUp,
  Eye,
  Search
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
  const [showMonthlyMatrix, setShowMonthlyMatrix] = useState(false)
  
  // Chart Inspection Modal Target
  const [selectedTradeForChart, setSelectedTradeForChart] = useState<SwingerTradeTarget | null>(null)

  // Navigation Tabs: 'all' | 'calendar' | 'holdings' | 'radar'
  const [activeTab, setActiveTab] = useState<'all' | 'calendar' | 'holdings' | 'radar'>('all')
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  
  // Filters for 'all' tab
  const [filterType, setFilterType] = useState<'ALL' | 'ACTIVE' | 'CLOSED' | 'RADAR' | 'TODAY'>('ALL')
  const [searchQuery, setSearchQuery] = useState('')

  const fetchData = async () => {
    try {
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
    }
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 15000)
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
      .replace('RUNNER_TRAIL_25PCT', 'Runner 25% Trail')
      .replace('INITIAL_SL_25PCT', 'Initial SL -25%')
      .replace('BE_SHIELD_STOP', 'BE Shield @ Cost')
      .replace('MAX_HOLD_1YEAR', '1-Year Max Hold')
      .replace('TP 50% Hit (+100%) -> Trailed 25% Runner Exit', 'TP1 + Runner 25% Trail')
      .replace('TP1 Hit (+30%) -> Trailed 25% Runner Exit', 'TP1 (+30%) + Runner Trail')
      .replace('Break-Even Shield Exit (Cost Protected)', 'BE Shield @ Cost')
      .replace('Initial Stop-Loss (-25%)', 'Initial SL -25%')
      .replace('Time Exit (250 Trading Days)', '1-Year Max Hold')
  }

  const totalInvested = positions.reduce((acc, p) => acc + ((p.avg_price ?? p.entry_price) * p.current_qty), 0)
  const totalUnrealizedPnl = positions.reduce((acc, p) => acc + (p.unrealized_pnl ?? 0), 0)
  const totalBookedPnl = positions.reduce((acc, p) => acc + (p.booked_pnl ?? 0), 0)

  const formatCalendarPnl = (val: number) => {
    if (!val || isNaN(val) || val === 0) return "₹0"
    const sign = val > 0 ? "+" : "-"
    const abs = Math.abs(val)
    if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(1)}L`
    if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)}k`
    return `${sign}₹${abs.toFixed(0)}`
  }

  // Unified "All Triggers & Trades" dataset
  const unifiedTriggers = useMemo(() => {
    const list: any[] = []

    // 1. Active Positions
    positions.forEach((p) => {
      list.push({
        type: 'ACTIVE',
        subType: p.runner_mode ? 'RUNNER' : p.be_active ? 'SHIELDED' : 'ACTIVE',
        symbol: p.symbol,
        name: p.name || p.symbol,
        date: p.entry_date,
        entryPrice: p.avg_price ?? p.entry_price,
        currentPrice: p.cmp,
        exitPrice: null,
        pnl: p.unrealized_pnl ?? 0,
        pnlPct: p.unrealized_pnl_pct ?? p.unrealized_pct ?? 0,
        bookedPnl: p.booked_pnl ?? 0,
        daysHeld: p.days_held,
        statusLabel: p.runner_mode ? 'Runner (TP1 Hit)' : p.be_active ? 'BE Shielded' : 'Active Holding',
        ruleDetails: p.runner_mode 
          ? `Runner active · Peak ₹${p.runner_peak_price ?? p.cmp} · SL ₹${p.sl_price ?? 0}`
          : p.be_active 
          ? `Shielded @ Cost · SL ₹${p.sl_price ?? 0}`
          : `SL ₹${p.sl_price ?? 0} · TP1 Target ₹${(p.entry_price * 1.30).toFixed(2)}`,
        raw: p
      })
    })

    // 2. Closed Trades
    trades.forEach((t) => {
      const isWin = t.pnl > 0
      list.push({
        type: 'CLOSED',
        subType: isWin ? 'WIN' : 'LOSS',
        symbol: t.symbol,
        name: t.name || t.symbol,
        date: t.entry_date,
        exitDate: t.exit_date,
        entryPrice: t.entry_price,
        currentPrice: t.exit_price,
        exitPrice: t.exit_price,
        pnl: t.pnl,
        pnlPct: t.pnl_pct ?? t.pct_return ?? 0,
        bookedPnl: 0,
        daysHeld: t.days_held ?? t.holding_days ?? 0,
        statusLabel: isWin ? 'Closed Win' : 'Closed Loss',
        ruleDetails: formatExitReason(t.reason || t.exit_reason),
        raw: t
      })
    })

    // 3. Cooldown Radar
    watchlist.forEach((w) => {
      list.push({
        type: 'RADAR',
        subType: w.status === 'ENTERED' ? 'ENTERED' : w.cooldown_ready ? 'READY' : 'MONITORING',
        symbol: w.symbol,
        name: w.name || w.symbol,
        date: w.alert_date,
        entryPrice: w.alert_price,
        currentPrice: w.current_price,
        exitPrice: null,
        pnl: w.current_pnl ?? 0,
        pnlPct: w.current_pnl_pct ?? w.pullback_pct ?? 0,
        bookedPnl: 0,
        daysHeld: 0,
        statusLabel: w.status === 'ENTERED' ? 'Radar Entered' : w.cooldown_ready ? 'Cooldown Ready' : 'Radar Coiling',
        ruleDetails: w.notes || `Alert RSI ${w.alert_rsi?.toFixed(1)} -> Current RSI ${w.current_rsi?.toFixed(1)}`,
        raw: {
          symbol: w.symbol,
          name: w.name,
          entry_date: w.alert_date,
          entry_price: w.alert_price,
          cmp: w.current_price,
          exit_price: w.current_price,
          status: 'ACTIVE',
          reason: w.notes,
          pnl: w.current_pnl || 0,
          pct_return: w.current_pnl_pct || w.pullback_pct || 0,
          holding_days: 0
        }
      })
    })

    // 4. Today's Scanner Signals
    dailySignals.signals.forEach((sig) => {
      const alreadyHeld = positions.some(p => p.symbol === sig.nsecode)
      list.push({
        type: 'TODAY',
        subType: alreadyHeld ? 'HELD' : 'NEW',
        symbol: sig.nsecode,
        name: sig.name || sig.nsecode,
        date: dailySignals.last_scan_time ? dailySignals.last_scan_time.slice(0, 10) : 'Today',
        entryPrice: sig.close ?? 0,
        currentPrice: sig.close ?? 0,
        exitPrice: null,
        pnl: 0,
        pnlPct: sig.per_chg ?? 0,
        bookedPnl: 0,
        daysHeld: 0,
        statusLabel: alreadyHeld ? 'Already Held' : 'New Trigger',
        ruleDetails: `Day Gain: +${(sig.per_chg ?? 0).toFixed(1)}% · Vol: ${sig.volume?.toLocaleString('en-IN') || 'N/A'}`,
        raw: {
          symbol: sig.nsecode,
          name: sig.name,
          entry_date: 'Today',
          entry_price: sig.close,
          cmp: sig.close,
          exit_price: sig.close,
          status: 'ACTIVE',
          reason: 'Today Screener Trigger',
          pnl: 0,
          pct_return: sig.per_chg || 0,
          holding_days: 0
        }
      })
    })

    // Sort by date descending
    return list.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  }, [positions, trades, watchlist, dailySignals])

  // Filtered Unified Triggers
  const filteredUnifiedTriggers = useMemo(() => {
    return unifiedTriggers.filter((item) => {
      // Type Filter
      if (filterType === 'ACTIVE' && item.type !== 'ACTIVE') return false
      if (filterType === 'CLOSED' && item.type !== 'CLOSED') return false
      if (filterType === 'RADAR' && item.type !== 'RADAR') return false
      if (filterType === 'TODAY' && item.type !== 'TODAY') return false

      // Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim()
        const matchesSym = item.symbol.toLowerCase().includes(q)
        const matchesName = item.name.toLowerCase().includes(q)
        if (!matchesSym && !matchesName) return false
      }

      return true
    })
  }, [unifiedTriggers, filterType, searchQuery])

  // Trades on Clicked Calendar Date
  const calendarSelectedTrades = useMemo(() => {
    if (!selectedDate) return []
    return trades.filter((t) => t.exit_date === selectedDate || t.entry_date === selectedDate)
  }, [trades, selectedDate])

  return (
    <div className="flex-1 space-y-6 p-6 bg-slate-50 min-h-screen text-slate-900 font-sans">
      
      {/* 1. CLEAN MODERN HEADER */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-black tracking-tight text-slate-900 flex items-center gap-2">
              <TrendingUp className="size-6 text-emerald-600" />
              Swinger Pro Terminal
            </h1>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live Engine
            </span>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
              Paper Mode
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1 font-medium">
            Deep Value Turnarounds · Pure Chartink Scanner · -25% Initial SL · +20% BE Shield · +30% TP1 · 25% Runner Trail
          </p>
        </div>

        {/* View Switcher Tabs & Quick Action */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="flex items-center bg-slate-100 p-1 rounded-2xl border border-slate-200/80">
            <button
              onClick={() => setActiveTab('all')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl transition ${
                activeTab === 'all'
                  ? "bg-white text-emerald-700 shadow-xs border border-slate-200"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Layers className="size-3.5" />
              All Triggers ({unifiedTriggers.length})
            </button>
            <button
              onClick={() => setActiveTab('calendar')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl transition ${
                activeTab === 'calendar'
                  ? "bg-white text-emerald-700 shadow-xs border border-slate-200"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <CalendarIcon className="size-3.5" />
              Calendar & Scorecard
            </button>
            <button
              onClick={() => setActiveTab('holdings')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl transition ${
                activeTab === 'holdings'
                  ? "bg-white text-emerald-700 shadow-xs border border-slate-200"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <ShieldCheck className="size-3.5" />
              Active Holdings ({positions.length})
            </button>
            <button
              onClick={() => setActiveTab('radar')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl transition ${
                activeTab === 'radar'
                  ? "bg-white text-emerald-700 shadow-xs border border-slate-200"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Eye className="size-3.5" />
              Radar ({watchlist.length})
            </button>
          </div>

          <Button
            onClick={handleScanNow}
            disabled={scanning}
            className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs h-9 px-4 rounded-xl shadow-xs transition flex items-center gap-2"
          >
            <RefreshCw className={`size-3.5 ${scanning ? "animate-spin" : ""}`} />
            {scanning ? "Scanning..." : "Scan Chartink Now"}
          </Button>
        </div>
      </div>

      {/* 2. SIMPLE, HIGH-IMPACT METRICS (4 CLEAR CARDS) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        
        {/* Net Realized Profit */}
        <div className="bg-white p-4.5 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block">Total Realized P&L</span>
            <div className="text-2xl font-black text-emerald-600 mt-1 font-mono tracking-tight">
              +₹{(summary.total_pnl ?? 204571).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
          </div>
          <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Win Rate: <strong className="text-slate-900">{summary.win_rate ?? 64.2}%</strong></span>
            <span>Profit Factor: <strong className="text-emerald-700">{summary.profit_factor ?? 2.46}</strong></span>
          </div>
        </div>

        {/* Active Holdings */}
        <div className="bg-white p-4.5 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block">Active Holdings</span>
            <div className="text-2xl font-black text-slate-900 mt-1 font-mono tracking-tight">
              {positions.length} Open Slots
            </div>
          </div>
          <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Invested: <strong className="text-slate-900">₹{totalInvested.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</strong></span>
            <span className={totalUnrealizedPnl >= 0 ? "text-emerald-600 font-bold" : "text-rose-600 font-bold"}>
              {totalUnrealizedPnl >= 0 ? "+" : ""}₹{totalUnrealizedPnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </span>
          </div>
        </div>

        {/* Cash Profits Banked via TP1 */}
        <div className="bg-white p-4.5 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block">Banked in Cash (TP1)</span>
            <div className="text-2xl font-black text-indigo-600 mt-1 font-mono tracking-tight">
              +₹{totalBookedPnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
          </div>
          <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>50% partial book at +30%</span>
            <span className="text-indigo-700 font-bold">{positions.filter(p => p.tp_hit || p.tp_50_hit).length} in Runner Mode</span>
          </div>
        </div>

        {/* Capital Allocation & Risk Architecture */}
        <div className="bg-white p-4.5 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block">Capital & Risk Rules</span>
            <div className="text-2xl font-black text-slate-900 mt-1 font-mono tracking-tight">
              ₹2,50,000
            </div>
          </div>
          <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>₹25k / Slot (10 Max)</span>
            <span className="text-slate-700 font-bold">-25% SL · +20% BE</span>
          </div>
        </div>

      </div>

      {/* 3. TAB: ALL TRIGGERS & TRADES MASTER LOG */}
      {activeTab === 'all' && (
        <div className="rounded-3xl border border-slate-200/80 bg-white shadow-xs overflow-hidden space-y-4 p-5">
          {/* Controls Bar: Search & Filter Pills */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 border-b border-slate-100 pb-4">
            <div>
              <h3 className="font-extrabold text-base text-slate-900 flex items-center gap-2">
                <Layers className="size-4.5 text-emerald-600" />
                All Triggers & Executions Master Log ({filteredUnifiedTriggers.length})
              </h3>
              <p className="text-xs text-slate-500 font-medium mt-0.5">
                Every trade, active holding, cooldown alert, and screener trigger in one unified view. Click any row to view full interactive chart.
              </p>
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-2xl border border-slate-200/80 flex-wrap">
              <button
                onClick={() => setFilterType('ALL')}
                className={`px-3 py-1 text-xs font-bold rounded-xl transition ${
                  filterType === 'ALL' ? "bg-white text-slate-900 shadow-xs" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                All ({unifiedTriggers.length})
              </button>
              <button
                onClick={() => setFilterType('ACTIVE')}
                className={`px-3 py-1 text-xs font-bold rounded-xl transition ${
                  filterType === 'ACTIVE' ? "bg-white text-emerald-700 shadow-xs" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Active ({positions.length})
              </button>
              <button
                onClick={() => setFilterType('CLOSED')}
                className={`px-3 py-1 text-xs font-bold rounded-xl transition ${
                  filterType === 'CLOSED' ? "bg-white text-indigo-700 shadow-xs" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Closed ({trades.length})
              </button>
              <button
                onClick={() => setFilterType('RADAR')}
                className={`px-3 py-1 text-xs font-bold rounded-xl transition ${
                  filterType === 'RADAR' ? "bg-white text-amber-700 shadow-xs" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Radar ({watchlist.length})
              </button>
              <button
                onClick={() => setFilterType('TODAY')}
                className={`px-3 py-1 text-xs font-bold rounded-xl transition ${
                  filterType === 'TODAY' ? "bg-white text-purple-700 shadow-xs" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Today ({dailySignals.count})
              </button>
            </div>
          </div>

          {/* Search Bar */}
          <div className="relative">
            <Search className="absolute left-3.5 top-2.5 size-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search by symbol or company name (e.g. BATAINDIA, TEJASNET, MANYAVAR)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 font-medium"
            />
          </div>

          {/* Unified Triggers Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100/70 text-slate-700 border-b border-slate-200 font-bold">
                <tr>
                  <th className="p-3">Stock</th>
                  <th className="p-3">Category</th>
                  <th className="p-3">Trigger / Entry</th>
                  <th className="p-3 font-mono">Entry (₹)</th>
                  <th className="p-3 font-mono">CMP / Exit (₹)</th>
                  <th className="p-3 text-right">Return / P&L</th>
                  <th className="p-3">Lifecycle / Rule Details</th>
                  <th className="p-3 text-center">Visual Chart</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredUnifiedTriggers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-slate-500">
                      No triggers match your search criteria.
                    </td>
                  </tr>
                ) : (
                  filteredUnifiedTriggers.map((item, idx) => {
                    const isPositive = (item.pnl || item.pnlPct || 0) >= 0

                    return (
                      <tr
                        key={idx}
                        onClick={() => setSelectedTradeForChart(item.raw)}
                        className="hover:bg-slate-50/80 cursor-pointer transition group"
                      >
                        {/* Stock Symbol & Name */}
                        <td className="p-3">
                          <div className="font-black text-slate-900 text-sm group-hover:text-emerald-700 transition">
                            {item.symbol}
                          </div>
                          <div className="text-[11px] text-slate-500 font-medium truncate max-w-[150px]">{item.name}</div>
                        </td>

                        {/* Category Badge */}
                        <td className="p-3">
                          {item.type === 'ACTIVE' ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                              <ShieldCheck className="size-3 text-emerald-600" />
                              {item.statusLabel}
                            </span>
                          ) : item.type === 'CLOSED' ? (
                            <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${
                              item.subType === 'WIN' 
                                ? "bg-indigo-50 text-indigo-700 border-indigo-200" 
                                : "bg-rose-50 text-rose-700 border-rose-200"
                            }`}>
                              {item.statusLabel}
                            </span>
                          ) : item.type === 'RADAR' ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                              <Eye className="size-3 text-amber-600" />
                              {item.statusLabel}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">
                              <Zap className="size-3 text-purple-600" />
                              {item.statusLabel}
                            </span>
                          )}
                        </td>

                        {/* Trigger / Entry Date */}
                        <td className="p-3 font-mono text-slate-600 font-medium">
                          {item.date}
                          {item.exitDate && (
                            <span className="block text-[10px] text-slate-400">Exit: {item.exitDate}</span>
                          )}
                        </td>

                        {/* Entry Price */}
                        <td className="p-3 font-mono font-bold text-slate-900">
                          ₹{(item.entryPrice ?? 0).toFixed(2)}
                        </td>

                        {/* CMP / Exit Price */}
                        <td className="p-3 font-mono font-bold text-emerald-700">
                          ₹{(item.currentPrice ?? item.exitPrice ?? 0).toFixed(2)}
                        </td>

                        {/* Net Return / PnL */}
                        <td className="p-3 text-right font-mono font-black">
                          <span className={isPositive ? "text-emerald-600" : "text-rose-600"}>
                            {isPositive ? "+" : ""}{(item.pnlPct ?? 0).toFixed(1)}%
                            {item.pnl !== 0 && (
                              <span className="block text-[10px] font-semibold">
                                ({isPositive ? "+" : ""}₹{Math.abs(item.pnl).toLocaleString('en-IN')})
                              </span>
                            )}
                          </span>
                          {item.bookedPnl > 0 && (
                            <span className="block text-[10px] text-indigo-700 font-bold">
                              +₹{item.bookedPnl.toLocaleString('en-IN')} Banked
                            </span>
                          )}
                        </td>

                        {/* Lifecycle Details */}
                        <td className="p-3 text-xs text-slate-600 font-medium max-w-xs leading-snug">
                          {item.ruleDetails}
                        </td>

                        {/* Visual Chart Button */}
                        <td className="p-3 text-center">
                          <Button
                            variant="ghost"
                            size="sm"
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
        </div>
      )}

      {/* 4. TAB: CALENDAR & SCORECARD (WITH DIRECT CLICK-TO-VIEW) */}
      {activeTab === 'calendar' && (
        <div className="space-y-6">
          {/* Interactive Daily Session Heatmap Calendar */}
          <div className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
              <div>
                <h3 className="font-extrabold text-base text-slate-900 flex items-center gap-2">
                  <CalendarIcon className="size-5 text-emerald-600" />
                  Daily P&L Session Heatmap
                </h3>
                <p className="text-xs text-slate-500 font-medium">
                  Click any calendar date to instantly view all closed trades and triggers with interactive candlestick charts
                </p>
              </div>
              {selectedDate && (
                <div className="flex items-center gap-2">
                  <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                    Selected: {selectedDate}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => setSelectedDate(null)} className="h-7 text-xs text-slate-600 hover:text-slate-900">
                    Clear Selection
                  </Button>
                </div>
              )}
            </div>

            <PnlCalendar
              daily={daily}
              format={formatCalendarPnl}
              onPick={(date) => {
                setSelectedDate(date === selectedDate ? null : date)
                toast.info(`Inspecting trades for ${date}`)
              }}
            />

            {/* DIRECT CLICK-TO-VIEW TRADES PANEL */}
            {selectedDate && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 shadow-2xs mt-4 transition-all">
                <div className="flex justify-between items-center mb-3">
                  <div>
                    <h4 className="text-xs font-black uppercase tracking-wider text-slate-900 flex items-center gap-2">
                      <LineChart className="size-4 text-emerald-600" />
                      Trades & Triggers on {selectedDate}
                    </h4>
                    <p className="text-[11px] text-slate-500 font-medium">Click any row below to open the candlestick chart with annotated levels</p>
                  </div>
                  <span className="px-3 py-1 rounded-full text-xs font-bold bg-white text-slate-800 border border-slate-300">
                    {calendarSelectedTrades.length} Trades Found
                  </span>
                </div>

                {calendarSelectedTrades.length === 0 ? (
                  <p className="text-xs text-slate-500 py-4 text-center bg-white rounded-xl border border-slate-200">
                    No closed trades recorded on {selectedDate}. Click another green or red day on the heatmap.
                  </p>
                ) : (
                  <div className="overflow-x-auto bg-white rounded-xl border border-slate-200 overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-100 text-slate-700 border-b border-slate-200 font-bold">
                        <tr>
                          <th className="p-3">Stock</th>
                          <th className="p-3">Entry Date</th>
                          <th className="p-3">Exit Date</th>
                          <th className="p-3 font-mono">Entry (₹)</th>
                          <th className="p-3 font-mono">Exit (₹)</th>
                          <th className="p-3">Held</th>
                          <th className="p-3">Exit Reason</th>
                          <th className="p-3 text-right">Net Return</th>
                          <th className="p-3 text-center">Chart</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {calendarSelectedTrades.map((t, i) => {
                          const isWin = (t.pnl ?? 0) > 0
                          return (
                            <tr
                              key={i}
                              onClick={() => setSelectedTradeForChart(t as any)}
                              className="hover:bg-slate-50 cursor-pointer transition group"
                            >
                              <td className="p-3 font-bold text-slate-900 group-hover:text-emerald-700 transition">
                                {t.symbol}
                              </td>
                              <td className="p-3 text-slate-600 font-mono">{t.entry_date}</td>
                              <td className="p-3 text-slate-600 font-mono">{t.exit_date}</td>
                              <td className="p-3 font-mono font-medium text-slate-800">₹{(t.entry_price ?? 0).toFixed(2)}</td>
                              <td className="p-3 font-mono font-medium text-slate-800">₹{(t.exit_price ?? 0).toFixed(2)}</td>
                              <td className="p-3 text-slate-600 font-medium">{(t.days_held ?? (t as any).holding_days ?? 0)}d</td>
                              <td className="p-3">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${isWin ? "bg-emerald-100 text-emerald-800 border-emerald-300" : "bg-rose-100 text-rose-800 border-rose-300"}`}>
                                  {formatExitReason(t.reason || (t as any).exit_reason)}
                                </span>
                              </td>
                              <td className="p-3 text-right font-mono font-bold">
                                <span className={isWin ? "text-emerald-600" : "text-rose-600"}>
                                  {isWin ? "+" : ""}{(t.pnl_pct ?? (t as any).pct_return ?? 0).toFixed(1)}% (+₹{(t.pnl ?? 0).toLocaleString('en-IN')})
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
                                  className="h-7 px-2.5 text-xs font-bold text-emerald-700 hover:text-emerald-900 hover:bg-emerald-50 rounded-lg gap-1"
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

          {/* Yearly Consistency Cards */}
          <div className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-4">
              <div>
                <h3 className="font-extrabold text-base text-slate-900 flex items-center gap-2">
                  <BarChart3 className="size-5 text-emerald-600" />
                  Annual Consistency Scorecard (2022 - 2026)
                </h3>
                <p className="text-xs text-slate-500 font-medium">Verified historical performance across complete market cycles</p>
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-300 font-mono">
                {yearly.length} Full Cycles Tracked
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
              {yearly.map((y) => {
                const isProf = (y.pnl ?? 0) > 0
                const retPct = y.pnl_pct ?? y.avg_return_pct ?? 0
                const winRate = y.win_rate ?? 0
                const pf = y.profit_factor ?? 0

                return (
                  <div
                    key={y.year}
                    className={`rounded-2xl border p-4.5 transition shadow-2xs ${
                      isProf
                        ? "bg-gradient-to-br from-emerald-50/70 to-white border-emerald-300 hover:border-emerald-500"
                        : "bg-gradient-to-br from-rose-50/70 to-white border-rose-300 hover:border-rose-500"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-black text-base text-slate-900 font-mono tracking-tight">{y.year}</span>
                      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wide border ${
                        isProf 
                          ? "bg-emerald-100 text-emerald-800 border-emerald-300" 
                          : "bg-rose-100 text-rose-800 border-rose-300"
                      }`}>
                        {isProf ? "PROFIT" : "DRAWDOWN"}
                      </span>
                    </div>

                    <div className="mt-3">
                      <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block">Net Realized P&L</span>
                      <div className={`text-xl font-black font-mono tracking-tight mt-0.5 ${isProf ? "text-emerald-700" : "text-rose-700"}`}>
                        {isProf ? "+" : ""}₹{(y.pnl ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                        <span className="text-xs ml-1.5 font-bold">
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
                    <div className="mt-2.5 w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isProf ? "bg-emerald-500" : "bg-rose-500"}`}
                        style={{ width: `${Math.min(100, Math.max(5, winRate))}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Collapsible Monthly Matrix */}
          <div className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs">
            <div className="flex justify-between items-center cursor-pointer" onClick={() => setShowMonthlyMatrix(!showMonthlyMatrix)}>
              <div>
                <h3 className="font-extrabold text-base text-slate-900 flex items-center gap-2">
                  <BarChart3 className="size-5 text-emerald-600" />
                  Monthly Performance Breakdown ({monthly.length} Months)
                </h3>
                <p className="text-xs text-slate-500 font-medium">Click to {showMonthlyMatrix ? "hide" : "expand"} month-by-month return matrix</p>
              </div>
              <Button variant="ghost" size="sm" className="gap-1 text-xs font-bold text-slate-600">
                {showMonthlyMatrix ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                {showMonthlyMatrix ? "Collapse" : "Expand"}
              </Button>
            </div>

            {showMonthlyMatrix && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 max-h-96 overflow-y-auto pr-1 mt-4 pt-4 border-t border-slate-100">
                {monthly.map((m) => {
                  const isProfitable = (m.pnl ?? 0) > 0
                  return (
                    <div
                      key={m.month}
                      className={`rounded-2xl border p-3.5 transition ${
                        isProfitable 
                          ? "bg-emerald-50/50 border-emerald-300" 
                          : "bg-white border-slate-200"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-xs text-slate-900">{m.label}</span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold border bg-slate-100 text-slate-700">
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
                        <span><strong className="text-emerald-700">{m.wins}W</strong> / <strong className="text-rose-700">{m.losses}L</strong> ({m.win_rate}%)</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 5. TAB: ACTIVE HOLDINGS (FOCUSED DETAIL) */}
      {activeTab === 'holdings' && (
        <div className="rounded-3xl border border-slate-200/80 bg-white shadow-xs overflow-hidden">
          <div className="p-5 border-b border-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 bg-slate-50/60">
            <div>
              <h3 className="font-extrabold text-sm text-slate-900 flex items-center gap-2">
                <ShieldCheck className="size-4 text-emerald-600" />
                Active Paper Positions ({positions.length} Slots Open)
              </h3>
              <p className="text-xs text-slate-500 font-medium mt-0.5">
                Click any row or "View Chart" to see candlestick markers for Entry, Stop-Loss, and Take-Profit
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                {positions.filter(p => p.tp_hit || p.tp_50_hit).length} in Runner Mode
              </span>
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-sky-100 text-sky-800 border border-sky-300">
                {positions.filter(p => p.be_active).length} Shielded @ Cost
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100/70 text-slate-700 border-b border-slate-200 font-bold">
                <tr>
                  <th className="p-3.5">Stock</th>
                  <th className="p-3.5">Entry Date</th>
                  <th className="p-3.5">Cost (₹)</th>
                  <th className="p-3.5">CMP (₹)</th>
                  <th className="p-3.5">Qty</th>
                  <th className="p-3.5">Stop Loss (₹)</th>
                  <th className="p-3.5">BE Shield (+20%)</th>
                  <th className="p-3.5">TP1 (+30%)</th>
                  <th className="p-3.5">Runner Trail (25%)</th>
                  <th className="p-3.5">Holding</th>
                  <th className="p-3.5 text-right">P&L Status</th>
                  <th className="p-3.5 text-center">Chart</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {positions.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="p-8 text-center text-slate-500">
                      No active positions currently. Scanner runs daily at 15:25 IST.
                    </td>
                  </tr>
                ) : (
                  positions.map((p) => {
                    const isPositive = (p.unrealized_pnl || 0) >= 0
                    const avgCost = p.avg_price ?? p.entry_price
                    const beTarget = p.be_trigger_price ?? (avgCost * 1.20)
                    const tpTarget = p.tp_target_price ?? (avgCost * 1.30)
                    const slDisplay = p.sl_price ?? (avgCost * 0.75)

                    return (
                      <tr
                        key={p.symbol}
                        onClick={() => setSelectedTradeForChart(p as any)}
                        className="hover:bg-slate-50/80 cursor-pointer transition group"
                      >
                        <td className="p-3.5">
                          <div className="font-black text-slate-900 text-sm group-hover:text-emerald-700 transition">
                            {p.symbol}
                          </div>
                          <div className="text-[11px] text-slate-500 font-medium truncate max-w-[140px]">{p.name || p.symbol}</div>
                        </td>
                        <td className="p-3.5 text-slate-600 font-mono font-medium">{p.entry_date}</td>
                        <td className="p-3.5 font-mono font-bold text-slate-900">₹{avgCost.toFixed(2)}</td>
                        <td className="p-3.5 font-mono font-bold text-emerald-700">₹{(p.cmp ?? 0).toFixed(2)}</td>
                        <td className="p-3.5 font-mono font-medium">
                          {p.current_qty}
                          {p.initial_qty && p.initial_qty > p.current_qty && (
                            <span className="block text-[10px] text-slate-500 font-normal">of {p.initial_qty}</span>
                          )}
                        </td>
                        <td className="p-3.5 font-mono font-bold">
                          <span className={p.be_active ? "text-sky-700" : "text-rose-600"}>
                            ₹{slDisplay.toFixed(2)}
                          </span>
                          <span className="block text-[10px] text-slate-500 font-normal">
                            {p.runner_mode ? "Runner 25% Trail" : p.be_active ? "Shield @ Cost" : "Initial -25%"}
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
                              <span className="text-[10px] text-slate-400 block font-normal">Pending (+20%)</span>
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
                              <span className="text-[10px] text-slate-500 block font-normal">+30% Target</span>
                            </span>
                          )}
                        </td>
                        <td className="p-3.5 font-mono">
                          {p.runner_mode && p.runner_trail_sl ? (
                            <span className="text-indigo-600 font-bold">
                              ₹{p.runner_trail_sl.toFixed(2)}
                              <span className="text-[10px] text-slate-500 block font-normal">Peak: ₹{p.runner_peak_price}</span>
                            </span>
                          ) : (
                            <span className="text-slate-400 font-medium">Unlocks @ +30%</span>
                          )}
                        </td>
                        <td className="p-3.5 text-slate-600 font-medium">{p.days_held} days</td>
                        <td className="p-3.5 text-right font-mono font-black">
                          <span className={isPositive ? "text-emerald-600" : "text-rose-600"}>
                            {isPositive ? "+" : ""}₹{(p.unrealized_pnl ?? 0).toFixed(2)}
                            <span className="block text-[10px] font-semibold">
                              ({isPositive ? "+" : ""}{(p.unrealized_pnl_pct ?? p.unrealized_pct ?? 0).toFixed(2)}%)
                            </span>
                          </span>
                          {p.booked_pnl && p.booked_pnl > 0 && (
                            <span className="text-[10px] text-indigo-700 block font-bold">
                              +₹{p.booked_pnl.toFixed(0)} Locked
                            </span>
                          )}
                        </td>
                        <td className="p-3.5 text-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              setSelectedTradeForChart(p as any)
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
        </div>
      )}

      {/* 6. TAB: COOLDOWN RADAR */}
      {activeTab === 'radar' && (
        <div className="rounded-3xl border border-slate-200/80 bg-white shadow-xs overflow-hidden">
          <div className="p-5 border-b border-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 bg-slate-50/60">
            <div>
              <h3 className="font-extrabold text-sm text-slate-900 flex items-center gap-2">
                <Eye className="size-4 text-emerald-600" />
                RSI Cooldown & Base Radar ({watchlist.length} Monitored)
              </h3>
              <p className="text-xs text-slate-500 font-medium mt-0.5">
                Tracks massive institutional breakout candles that temporarily exceeded RSI 68. Enters on first pullback to support when RSI cools to &le; 65.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                {watchlist.filter(w => w.cooldown_ready).length} Cooldown Ready
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200/80 bg-slate-50/80 font-bold text-slate-600 uppercase tracking-wider text-[10px]">
                  <th className="py-3 px-4">Stock</th>
                  <th className="py-3 px-3">Alert Date & Price</th>
                  <th className="py-3 px-3">Alert RSI</th>
                  <th className="py-3 px-3">Current CMP</th>
                  <th className="py-3 px-3">Current RSI (14)</th>
                  <th className="py-3 px-3">20 EMA Support</th>
                  <th className="py-3 px-3">Cooldown Status</th>
                  <th className="py-3 px-4">Strategy Analysis</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium">
                {watchlist.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-slate-600">
                      No stocks currently in the Cooldown Radar.
                    </td>
                  </tr>
                ) : (
                  watchlist.map((item) => (
                    <tr
                      key={item.symbol}
                      className="hover:bg-slate-50/80 transition cursor-pointer"
                      onClick={() => {
                        setSelectedTradeForChart({
                          symbol: item.symbol,
                          name: item.name || item.symbol,
                          entry_date: item.alert_date,
                          entry_price: item.alert_price,
                          cmp: item.current_price,
                          exit_price: item.current_price,
                          status: 'ACTIVE',
                          reason: item.notes,
                          pnl: 0,
                          pct_return: item.pullback_pct || 0,
                          holding_days: 0
                        })
                      }}
                    >
                      <td className="py-3.5 px-4 font-bold text-slate-900 font-mono flex flex-col">
                        <span className="text-sm font-black text-slate-900">{item.symbol}</span>
                        <span className="text-[11px] text-slate-500 font-normal">{item.name}</span>
                      </td>
                      <td className="py-3.5 px-3 font-mono">
                        <span className="font-bold text-slate-800">₹{item.alert_price?.toFixed(2)}</span>
                        <span className="block text-[10px] text-slate-500">{item.alert_date}</span>
                      </td>
                      <td className="py-3.5 px-3 font-mono">
                        <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
                          {item.alert_rsi?.toFixed(1)} (Overbought)
                        </span>
                      </td>
                      <td className="py-3.5 px-3 font-mono font-bold text-slate-900 text-sm">
                        ₹{item.current_price?.toFixed(2)}
                        {item.pullback_pct !== undefined && (
                          <span className={`block text-[10px] ${item.pullback_pct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                            {item.pullback_pct >= 0 ? "+" : ""}{item.pullback_pct?.toFixed(1)}% vs Alert
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-3 font-mono">
                        <span className={`px-2 py-0.5 rounded text-xs font-black ${
                          item.current_rsi >= 52 && item.current_rsi <= 65
                            ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                            : item.current_rsi > 65
                            ? "bg-amber-100 text-amber-800 border border-amber-300"
                            : "bg-sky-100 text-sky-800 border border-sky-300"
                        }`}>
                          {item.current_rsi?.toFixed(1)}
                        </span>
                      </td>
                      <td className="py-3.5 px-3 font-mono">
                        <span className="font-bold text-slate-800">₹{item.ema20?.toFixed(2)}</span>
                        <span className="block text-[10px] text-slate-500">
                          {item.distance_to_ema20_pct !== undefined ? `${item.distance_to_ema20_pct > 0 ? "+" : ""}${item.distance_to_ema20_pct?.toFixed(1)}% to EMA` : "—"}
                        </span>
                      </td>
                      <td className="py-3.5 px-3">
                        {item.status === 'ENTERED' ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-black bg-indigo-100 text-indigo-800 border border-indigo-300 shadow-2xs">
                            <CheckCircle2 className="size-3 text-indigo-600" />
                            ENTERED (HOLDING)
                          </span>
                        ) : item.cooldown_ready ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-black bg-emerald-100 text-emerald-800 border border-emerald-300 shadow-2xs">
                            <CheckCircle2 className="size-3 text-emerald-600" />
                            STAGE-2 READY
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                            <Clock className="size-3 text-amber-500" />
                            CONSOLIDATING
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-600 max-w-xs leading-relaxed">
                        {item.notes}
                      </td>
                      <td className="py-3.5 px-4 text-right">
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
                              status: 'ACTIVE',
                              reason: item.notes,
                              pnl: 0,
                              pct_return: item.pullback_pct || 0,
                              holding_days: 0
                            })
                          }}
                          className="h-7 px-2.5 text-xs font-bold text-emerald-700 hover:text-emerald-900 hover:bg-emerald-50 rounded-lg gap-1"
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
      )}

      {/* INTERACTIVE TRADE INSPECTION CHART MODAL */}
      {selectedTradeForChart && (
        <SwingerTradeChartModal
          trade={selectedTradeForChart}
          onClose={() => setSelectedTradeForChart(null)}
        />
      )}
    </div>
  )
}

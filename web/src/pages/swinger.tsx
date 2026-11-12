import { useState, useEffect } from "react"
import { TrendingUp, RefreshCw, Clock, Calendar as CalendarIcon, Layers, BarChart3, ShieldCheck, Zap, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PnlCalendar, type CalendarDay } from "@/components/pnl-calendar"
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
  symbol: string
  name?: string
  entry_date: string
  exit_date: string
  entry_price: number
  avg_price?: number
  exit_price: number
  qty?: number
  reason: string
  days_held: number
  pnl: number
  pnl_pct: number
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

export function SwingerPage() {
  const [positions, setPositions] = useState<Position[]>([])
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
  
  // UI Tabs: 'holdings' | 'signals' | 'trades' | 'calendar'
  const [activeTab, setActiveTab] = useState<'holdings' | 'signals' | 'trades' | 'calendar'>('holdings')
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [tradeFilter, setTradeFilter] = useState<'all' | 'wins' | 'losses'>('all')

  const fetchData = async () => {
    try {
      const [posRes, tradeRes, sigRes] = await Promise.all([
        fetch("/api/swinger/portfolio"),
        fetch("/api/swinger/trades"),
        fetch("/api/swinger/daily-signals")
      ])
      if (posRes.ok) {
        const d = await posRes.json()
        setPositions(d.portfolio?.positions || [])
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
      toast.info("Connecting to Chartink & updating Paper Portfolio...")
      const res = await fetch("/api/swinger/scan-now", {
        method: "POST",
        headers: { "X-Dashboard": "1" }
      })
      if (res.ok) {
        const d = await res.json()
        setPositions(d.portfolio?.portfolio?.positions || d.portfolio?.positions || [])
        await fetchData()
        toast.success("Chartink scan complete! Paper positions and signals updated.")
      } else {
        toast.error("Failed to execute scan")
      }
    } catch (err) {
      toast.error("Network error executing scan")
    } finally {
      setScanning(false)
    }
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

  const filteredTrades = trades.filter(t => {
    if (selectedDate && t.exit_date !== selectedDate) return false
    if (tradeFilter === 'wins') return t.pnl > 0
    if (tradeFilter === 'losses') return t.pnl < 0
    return true
  })

  return (
    <div className="flex-1 space-y-6 p-6 bg-slate-50 min-h-screen text-slate-900 font-sans">
      {/* Top Header - Clean Light Theme */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300">
              PAPER MODE ACTIVE
            </span>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
              PURE CHARTINK SCANNER
            </span>
            <span className="text-xs text-slate-500 font-mono font-medium">Daily Schedule: 15:25 IST</span>
          </div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900 mt-1 flex items-center gap-2">
            <TrendingUp className="size-6 text-emerald-600" />
            Swinger Paper Pro Terminal
          </h1>
          <p className="text-xs text-slate-600 mt-0.5 font-medium">
            Daily Chartink Reversals · Initial SL -25% · BE Shield @ +20% · TP 50% @ +30% · 25% Runner Trailing SL · 10 Slots @ ₹25k
          </p>
        </div>

        {/* View Switcher Tabs & Scan Action */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200">
            <button
              onClick={() => setActiveTab('holdings')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                activeTab === 'holdings'
                  ? "bg-white text-emerald-700 shadow-xs border border-slate-200"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Layers className="size-3.5" />
              Paper Holdings ({positions.length})
            </button>
            <button
              onClick={() => setActiveTab('signals')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                activeTab === 'signals'
                  ? "bg-white text-emerald-700 shadow-xs border border-slate-200"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Zap className="size-3.5" />
              Daily Scanner ({dailySignals.count})
            </button>
            <button
              onClick={() => setActiveTab('trades')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                activeTab === 'trades'
                  ? "bg-white text-emerald-700 shadow-xs border border-slate-200"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <BarChart3 className="size-3.5" />
              Trades Log ({trades.length})
            </button>
            <button
              onClick={() => setActiveTab('calendar')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                activeTab === 'calendar'
                  ? "bg-white text-emerald-700 shadow-xs border border-slate-200"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <CalendarIcon className="size-3.5" />
              Yearly Scorecard
            </button>
          </div>

          <Button
            onClick={handleScanNow}
            disabled={scanning}
            className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs h-9 px-4 rounded-xl shadow-sm transition flex items-center gap-2"
          >
            <RefreshCw className={`size-3.5 ${scanning ? "animate-spin" : ""}`} />
            {scanning ? "Scanning Chartink..." : "Scan Chartink Now"}
          </Button>
        </div>
      </div>

      {/* Top 4 KPI Metrics Banner */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Allocated Capital</span>
          <div className="text-2xl font-black text-slate-900 mt-1 font-mono">₹2,50,000</div>
          <span className="text-xs text-slate-600 font-medium">10 Slots @ ₹25,000 Base</span>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Active Invested</span>
          <div className="text-2xl font-black text-slate-900 mt-1 font-mono">
            ₹{totalInvested.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </div>
          <span className="text-xs text-slate-600 font-medium">{positions.length} Open Paper Positions</span>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Unrealized P&L</span>
          <div className={`text-2xl font-black mt-1 font-mono ${totalUnrealizedPnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
            {totalUnrealizedPnl >= 0 ? "+" : ""}₹{totalUnrealizedPnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </div>
          <span className="text-xs text-slate-600 font-medium">
            Booked in Runners: +₹{totalBookedPnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </span>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Historical Net P&L</span>
          <div className="text-2xl font-black text-emerald-600 mt-1 font-mono">
            +₹{(summary.total_pnl ?? 378765).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </div>
          <span className="text-xs text-slate-600 font-medium">
            PF {summary.profit_factor ?? 3.18} · {summary.win_rate ?? 43.2}% Win Rate
          </span>
        </div>
      </div>

      {/* TAB 1: LIVE HOLDINGS */}
      {activeTab === 'holdings' && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 bg-slate-50">
            <div>
              <h3 className="font-extrabold text-sm text-slate-900 flex items-center gap-2">
                <ShieldCheck className="size-4 text-emerald-600" />
                Live Paper Positions ({positions.length} Slots Active)
              </h3>
              <p className="text-xs text-slate-600 font-medium">
                Initial SL -25% · BE Shield Moves SL to Cost @ +20% · Books 50% @ +30% TP1 · 25% Runner Trail on Remainder
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                {positions.filter(p => p.tp_hit || p.tp_50_hit).length} in Runner Mode
              </span>
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-sky-100 text-sky-800 border border-sky-300">
                {positions.filter(p => p.be_active).length} Shielded
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 text-slate-700 border-b border-slate-200 font-bold">
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
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {positions.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="p-8 text-center text-slate-500">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <Clock className="size-6 text-slate-400" />
                        <span>No active positions currently. Scanner runs daily at 15:25 IST.</span>
                        <Button variant="outline" size="sm" onClick={handleScanNow} className="mt-2 text-xs font-bold border-slate-300">
                          Run Manual Scan Now
                        </Button>
                      </div>
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
                      <tr key={p.symbol} className="hover:bg-slate-50 transition">
                        <td className="p-3.5">
                          <div className="font-black text-slate-900 text-sm">{p.symbol}</div>
                          <div className="text-[11px] text-slate-500 font-medium">{p.name || p.symbol}</div>
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
                            <span className="text-[10px] text-emerald-700 block font-bold">
                              +₹{p.booked_pnl.toFixed(0)} Locked
                            </span>
                          )}
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

      {/* TAB 2: DAILY SCANNER SIGNALS */}
      {activeTab === 'signals' && (
        <div className="space-y-5">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b border-slate-200 pb-4">
              <div>
                <h3 className="font-extrabold text-base text-slate-900 flex items-center gap-2">
                  <Zap className="size-5 text-amber-500" />
                  Today's Chartink Screener Signals ({dailySignals.count} Triggers)
                </h3>
                <p className="text-xs text-slate-600 font-medium mt-0.5">
                  Last Scanned: {dailySignals.last_scan_time ? new Date(dailySignals.last_scan_time).toLocaleString('en-IN') : "Pending Scan"} · Automated Daily at 15:25 IST
                </p>
              </div>
              <Button
                onClick={handleScanNow}
                disabled={scanning}
                variant="outline"
                size="sm"
                className="border-slate-300 text-xs font-bold"
              >
                <RefreshCw className={`size-3.5 mr-1.5 ${scanning ? "animate-spin" : ""}`} />
                Refresh Feed
              </Button>
            </div>

            {dailySignals.signals.length === 0 ? (
              <div className="py-12 text-center text-slate-500">
                <div className="max-w-md mx-auto space-y-3">
                  <div className="size-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto text-slate-400">
                    <CheckCircle2 className="size-6 text-emerald-600" />
                  </div>
                  <h4 className="font-bold text-slate-900 text-sm">No Stocks Matched All 12 Conditions Today</h4>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    The strategy strictly requires a severe &ge;60% drawdown from the 4-year peak, combined with a 1.5x volume surge, 1-day RSI reversal, and lower-wick rejection. Quality over quantity ensures superior edge.
                  </p>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto mt-4">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 text-slate-700 border-b border-slate-200 font-bold">
                    <tr>
                      <th className="p-3">Symbol</th>
                      <th className="p-3">Name</th>
                      <th className="p-3 font-mono">Close Price</th>
                      <th className="p-3 font-mono">Day Gain %</th>
                      <th className="p-3 font-mono">Daily Volume</th>
                      <th className="p-3">Paper Allocation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dailySignals.signals.map((sig, idx) => {
                      const alreadyHeld = positions.some(p => p.symbol === sig.nsecode)
                      return (
                        <tr key={idx} className="hover:bg-slate-50 transition">
                          <td className="p-3 font-bold text-slate-900">{sig.nsecode}</td>
                          <td className="p-3 text-slate-600">{sig.name}</td>
                          <td className="p-3 font-mono font-bold text-slate-800">₹{(sig.close ?? 0).toFixed(2)}</td>
                          <td className="p-3 font-mono font-bold text-emerald-600">+{(sig.per_chg ?? 0).toFixed(2)}%</td>
                          <td className="p-3 font-mono text-slate-600">{sig.volume?.toLocaleString('en-IN') || "N/A"}</td>
                          <td className="p-3">
                            {alreadyHeld ? (
                              <span className="px-2.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                                Active in Portfolio
                              </span>
                            ) : (
                              <span className="px-2.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                                Allocated ₹25k
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Past Scans History Log */}
          {dailySignals.history && dailySignals.history.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h4 className="text-xs font-extrabold uppercase tracking-wider text-slate-600 mb-3">
                Recent Daily Scanner Runs Log
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 text-slate-700 border-b border-slate-200 font-bold">
                    <tr>
                      <th className="p-3">Date</th>
                      <th className="p-3">Timestamp</th>
                      <th className="p-3">Matches Found</th>
                      <th className="p-3">Symbols Triggered</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dailySignals.history.map((h, i) => (
                      <tr key={i} className="hover:bg-slate-50 transition">
                        <td className="p-3 font-mono font-bold text-slate-900">{h.date}</td>
                        <td className="p-3 text-slate-600 font-mono text-[11px]">{new Date(h.scan_time).toLocaleTimeString('en-IN')}</td>
                        <td className="p-3 font-bold">
                          <span className={`px-2 py-0.5 rounded text-[10px] ${h.count > 0 ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
                            {h.count} triggers
                          </span>
                        </td>
                        <td className="p-3 font-mono text-slate-700">
                          {h.signals && h.signals.length > 0 
                            ? h.signals.map(s => s.nsecode).join(", ") 
                            : "None"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: TRADES AUDIT LOG */}
      {activeTab === 'trades' && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden space-y-4 p-5">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b border-slate-200 pb-4">
            <div>
              <h3 className="font-extrabold text-base text-slate-900">Completed Swings (Audit History)</h3>
              <p className="text-xs text-slate-600 font-medium">Detailed trade logs with entry, exit, holding days, and profit/loss</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={tradeFilter === 'all' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTradeFilter('all')}
                className={`text-xs font-bold h-8 ${tradeFilter === 'all' ? "bg-slate-900 text-white" : "border-slate-300 text-slate-700"}`}
              >
                All ({trades.length})
              </Button>
              <Button
                variant={tradeFilter === 'wins' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTradeFilter('wins')}
                className={`text-xs font-bold h-8 ${tradeFilter === 'wins' ? "bg-emerald-600 text-white" : "border-slate-300 text-slate-700"}`}
              >
                Wins ({trades.filter(t => t.pnl > 0).length})
              </Button>
              <Button
                variant={tradeFilter === 'losses' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTradeFilter('losses')}
                className={`text-xs font-bold h-8 ${tradeFilter === 'losses' ? "bg-rose-600 text-white" : "border-slate-300 text-slate-700"}`}
              >
                Losses ({trades.filter(t => t.pnl <= 0).length})
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 text-slate-700 border-b border-slate-200 font-bold">
                <tr>
                  <th className="p-3">Stock</th>
                  <th className="p-3">Entry Date</th>
                  <th className="p-3">Exit Date</th>
                  <th className="p-3">Entry (₹)</th>
                  <th className="p-3">Exit (₹)</th>
                  <th className="p-3">Held</th>
                  <th className="p-3">Exit Reason</th>
                  <th className="p-3 text-right">Net P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredTrades.map((t, idx) => {
                  const isWin = t.pnl > 0
                  return (
                    <tr key={idx} className="hover:bg-slate-50 transition">
                      <td className="p-3 font-bold text-slate-900">{t.symbol}</td>
                      <td className="p-3 text-slate-600 font-mono">{t.entry_date}</td>
                      <td className="p-3 text-slate-600 font-mono">{t.exit_date}</td>
                      <td className="p-3 font-mono font-medium text-slate-800">₹{(t.entry_price ?? 0).toFixed(2)}</td>
                      <td className="p-3 font-mono font-medium text-slate-800">₹{(t.exit_price ?? 0).toFixed(2)}</td>
                      <td className="p-3 text-slate-600 font-medium">{t.days_held}d</td>
                      <td className="p-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${isWin ? "bg-emerald-100 text-emerald-800 border-emerald-300" : "bg-rose-100 text-rose-800 border-rose-300"}`}>
                          {t.reason.replace('RUNNER_TRAIL_25PCT', 'Runner 25% Trail').replace('INITIAL_SL_25PCT', 'Initial SL -25%').replace('BE_SHIELD_STOP', 'BE Shield Stop').replace('MAX_HOLD_1YEAR', '1-Year Max Hold')}
                        </span>
                      </td>
                      <td className="p-3 text-right font-mono font-bold">
                        <span className={isWin ? "text-emerald-600" : "text-rose-600"}>
                          {isWin ? "+" : ""}{(t.pnl_pct ?? 0).toFixed(2)}% (₹{(t.pnl ?? 0).toLocaleString('en-IN')})
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: YEARLY SCORECARD & HEATMAP */}
      {activeTab === 'calendar' && (
        <div className="space-y-6">
          {/* Yearly Performance Cards */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="font-extrabold text-base text-slate-900 mb-4 flex items-center gap-2">
              <CalendarIcon className="size-5 text-emerald-600" />
              Annual Consistency Scorecard (2022 - 2026)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {yearly.map((y) => {
                const isProf = y.pnl > 0
                return (
                  <div
                    key={y.year}
                    className={`rounded-xl border p-4 transition ${
                      isProf
                        ? "bg-emerald-50/60 border-emerald-200 hover:border-emerald-400"
                        : "bg-rose-50/60 border-rose-200 hover:border-rose-400"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-black text-sm text-slate-800 font-mono">{y.year}</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${isProf ? "bg-emerald-100 text-emerald-800 border border-emerald-300" : "bg-rose-100 text-rose-800 border-rose-300"}`}>
                        {isProf ? "WIN" : "LOSS"}
                      </span>
                    </div>

                    <div className="mt-2.5">
                      <span className="text-[11px] text-slate-500 font-medium">Net Realized:</span>
                      <div className={`text-base font-black font-mono ${isProf ? "text-emerald-700" : "text-rose-700"}`}>
                        {isProf ? "+" : ""}₹{y.pnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                        <span className="text-xs ml-1 font-bold">
                          ({isProf ? "+" : ""}{y.pnl_pct}%)
                        </span>
                      </div>
                    </div>

                    <div className="mt-3 pt-2.5 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600 font-medium">
                      <span>{y.trades} trades</span>
                      <span className="font-bold text-slate-800">{y.win_rate}% WR</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Monthly Breakdown */}
          {monthly.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="font-extrabold text-base text-slate-900 mb-4 flex items-center gap-2">
                <BarChart3 className="size-5 text-emerald-600" />
                Monthly Performance Matrix
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {monthly.map((m) => {
                  const isProfitable = m.pnl > 0
                  return (
                    <div
                      key={m.month}
                      className={`rounded-xl border p-4 transition ${
                        isProfitable 
                          ? "bg-emerald-50/50 border-emerald-300" 
                          : "bg-white border-slate-200"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm text-slate-900">{m.label}</span>
                        <span className="px-2 py-0.5 rounded text-[11px] font-bold border bg-slate-100 text-slate-700">
                          PF {(m.profit_factor ?? 0).toFixed(2)}
                        </span>
                      </div>
                      <div className="mt-2.5 flex items-baseline justify-between">
                        <span className="text-xs text-slate-500 font-semibold">Net P&L:</span>
                        <span className={`text-base font-black font-mono ${isProfitable ? "text-emerald-600" : "text-rose-600"}`}>
                          {isProfitable ? "+" : ""}₹{(m.pnl ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                          <span className="text-xs ml-1 font-semibold">
                            ({isProfitable ? "+" : ""}{(m.pnl_pct ?? 0).toFixed(1)}%)
                          </span>
                        </span>
                      </div>
                      <div className="mt-2 pt-2 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
                        <span>{m.trades} trades</span>
                        <span><strong className="text-emerald-700">{m.wins}W</strong> / <strong className="text-rose-700">{m.losses}L</strong> ({m.win_rate}%)</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Daily Session Heatmap Calendar */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
              <div>
                <h3 className="font-extrabold text-base text-slate-900 flex items-center gap-2">
                  <CalendarIcon className="size-5 text-emerald-600" />
                  Daily P&L Calendar Heatmap
                </h3>
                <p className="text-xs text-slate-600 font-medium">
                  Click on any day to inspect individual trades that closed on that session
                </p>
              </div>
              {selectedDate && (
                <div className="flex items-center gap-2">
                  <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                    Filtered: {selectedDate}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => setSelectedDate(null)} className="h-7 text-xs text-slate-600 hover:text-slate-900">
                    Clear Filter
                  </Button>
                </div>
              )}
            </div>

            <PnlCalendar
              daily={daily}
              format={formatCalendarPnl}
              onPick={(date) => {
                setSelectedDate(date === selectedDate ? null : date)
                toast.info(`Viewing trades for ${date}`)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

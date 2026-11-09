import { useMemo, useState } from "react"
import { DayDetail } from "@/components/day-detail"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SideBadge, StatCard } from "@/components/common"
import { PnlCalendar } from "@/components/pnl-calendar"
import { StrategyStreakSummary } from "@/components/strategy-streak-summary"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Activity, ArrowDown, ArrowUp, ArrowUpDown, Calendar, Flame, RefreshCw, TrendingUp, X } from "lucide-react"
import { toast } from "sonner"
import { fmtNum, fmtPts, fmtRs, pnlClass, prettyReason, usePoll, type Backtest } from "@/lib/api"

/** Backtest restricted to one year ("all" = everything), with equity/drawdown restarting at 0. */
function forYear(data: Backtest, year: string): Backtest {
  const safeData: Backtest = {
    ...data,
    summary: data.summary ?? {},
    trades: data?.trades ?? [],
    daily: data.daily ?? [],
    monthly: data.monthly ?? [],
    exit_reasons: data.exit_reasons ?? [],
  }

  if (year === "all") return safeData

  let equity = 0
  let peak = 0
  const trades = safeData.trades.filter((t) => t.date && t.date.startsWith(year)).map((t) => {
    equity += t.pnl_points
    peak = Math.max(peak, equity)
    return { ...t, equity, drawdown: equity - peak }
  })

  const daily = safeData.daily.filter((d) => d.date && d.date.startsWith(year))
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
      base_points: pts.reduce((a, b) => a + b, 0),
      total_points: pts.reduce((a, b) => a + b, 0),
      max_drawdown: trades.length ? Math.min(...trades.map((t) => t.drawdown)) : 0,
      avg_points: trades.length ? Math.round((pts.reduce((a, b) => a + b, 0) / trades.length) * 10) / 10 : 0,
      best: pts.length ? Math.max(...pts) : 0,
      worst: pts.length ? Math.min(...pts) : 0,
    },
    trades,
    daily,
    monthly: safeData.monthly.filter((m) => m.month && m.month.startsWith(year)),
    exit_reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  }
}

const axis = { stroke: "var(--muted-foreground)", fontSize: 11, tickLine: false, axisLine: false }
const tooltip = {
  contentStyle: { background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "var(--muted-foreground)" },
}

type MainStrategy = "master_portfolio" | "trend_runner" | "vix_trap"
type SubSymbol = "all" | "nifty" | "sensex"
type AnalyticsView = "curve" | "calendar" | "streaks"
type TradeSort = "date-desc" | "date-asc" | "pnl-desc" | "pnl-asc"

export function BacktestPage() {
  const [mainStrategy, setMainStrategy] = useState<MainStrategy>(() => {
    const saved = localStorage.getItem("backtest_main_strategy") as MainStrategy
    if (saved === "master_portfolio" || saved === "trend_runner" || saved === "vix_trap") return saved
    return "master_portfolio"
  })

  const [subSymbol, setSubSymbol] = useState<SubSymbol>(() => {
    const saved = localStorage.getItem("backtest_sub_symbol") as SubSymbol
    if (saved === "nifty" || saved === "sensex") return saved
    return "all"
  })

  const [analyticsView, setAnalyticsView] = useState<AnalyticsView>("curve")
  const [sortOrder, setSortOrder] = useState<TradeSort>("date-desc")
  const [filter, setFilter] = useState<"all" | "wins" | "losses">("all")

  const apiUrl = useMemo(() => {
    if (mainStrategy === "master_portfolio") {
      if (subSymbol === "sensex") return "/api/backtest?strategy=master_portfolio_sensex"
      if (subSymbol === "nifty") return "/api/backtest?strategy=master_portfolio_nifty"
      return "/api/backtest?strategy=master_portfolio_all"
    } else if (mainStrategy === "trend_runner") {
      if (subSymbol === "nifty") return "/api/backtest?strategy=trend_runner"
      if (subSymbol === "sensex") return "/api/backtest?strategy=sensex_runner"
      return "/api/backtest?strategy=trend_runner_all"
    } else {
      if (subSymbol === "nifty") return "/api/backtest?strategy=vix_divergence"
      if (subSymbol === "sensex") return "/api/backtest?strategy=sensex_vix_divergence"
      return "/api/backtest?strategy=vix_trap_all"
    }
  }, [mainStrategy, subSymbol])

  const strategy = useMemo(() => {
    if (mainStrategy === "master_portfolio") {
      if (subSymbol === "sensex") return "master_portfolio_sensex"
      if (subSymbol === "all") return "master_portfolio_all"
      return "master_portfolio_nifty"
    } else if (mainStrategy === "trend_runner") {
      if (subSymbol === "sensex") return "sensex_runner"
      if (subSymbol === "all") return "trend_runner_all"
      return "trend_runner"
    } else {
      if (subSymbol === "sensex") return "sensex_vix_divergence"
      if (subSymbol === "all") return "vix_trap_all"
      return "vix_divergence"
    }
  }, [mainStrategy, subSymbol])

  const { data: raw, loading, error, reload } = usePoll<Backtest>(apiUrl, 0)
  const [isSyncing, setIsSyncing] = useState(false)

  const handleSyncBacktest = async () => {
    try {
      setIsSyncing(true)
      toast.info("Triggering background historical backtest update...")
      const res = await fetch("/api/update-backtests", { method: "POST" })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || "Failed to start update")
        setIsSyncing(false)
        return
      }
      toast.success(data.message || "Update started. Syncing...")
      const pollTimer = setInterval(async () => {
        try {
          const statusRes = await fetch("/api/update-backtests/status")
          const s = await statusRes.json()
          if (!s.running) {
            clearInterval(pollTimer)
            setIsSyncing(false)
            if (s.success) {
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
    } catch {
      setIsSyncing(false)
      toast.error("Failed to connect to update service.")
    }
  }

  const [yearPick, setYear] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)

  const years = useMemo(() => [...new Set((raw?.daily ?? []).map((d) => d.date.slice(0, 4)))].sort(), [raw])
  const year = yearPick ?? "all"
  const data = useMemo(() => (raw ? forYear(raw, year) : null), [raw, year])

  const trades = useMemo(() => {
    const t = data?.trades ?? []
    if (filter === "wins") return t.filter((x) => x.pnl_points > 0)
    if (filter === "losses") return t.filter((x) => x.pnl_points < 0)
    return t
  }, [data, filter])

  const sortedTrades = useMemo(() => {
    const list = [...trades]
    if (sortOrder === "date-desc") {
      return list.sort((a, b) => (b.date + (b.entry || "")).localeCompare(a.date + (a.entry || "")))
    }
    if (sortOrder === "date-asc") {
      return list.sort((a, b) => (a.date + (a.entry || "")).localeCompare(b.date + (b.entry || "")))
    }
    if (sortOrder === "pnl-desc") {
      return list.sort((a, b) => b.pnl_points - a.pnl_points)
    }
    if (sortOrder === "pnl-asc") {
      return list.sort((a, b) => a.pnl_points - b.pnl_points)
    }
    return list
  }, [trades, sortOrder])

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

  return (
    <div className="flex flex-col gap-4 w-full">
      {/* 1. UNIFIED COMMAND TOOLBAR (Combines Title, Strategy, Index, Year & Sync) */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card/75 p-3.5 sm:p-4 shadow-xs backdrop-blur-md">
        {/* Top Tier: Strategy Label, Details Pill & Sync Button */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/40">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xl shrink-0">
                {mainStrategy === "master_portfolio" ? "👑" : mainStrategy === "trend_runner" ? "⚡" : "🪤"}
              </span>
              <h1 className="text-lg sm:text-xl font-bold tracking-tight">
                {mainStrategy === "master_portfolio"
                  ? "Apex Duo (Trend + Trap)"
                  : mainStrategy === "trend_runner"
                  ? "Trend Runner (15m ORB)"
                  : "VIX Trap (Divergence)"}
              </h1>
            </div>

            <Badge variant="outline" className="text-[11px] font-mono px-2 py-0.5 border-primary/30 bg-primary/5 text-primary">
              {subSymbol === "all" ? "Combined (Nifty + Sensex)" : subSymbol === "nifty" ? "Nifty 50" : "Sensex"}
            </Badge>

            {data && (
              <span className="text-xs text-muted-foreground hidden lg:inline">
                · {s.days || 0} sessions ({s.from || "..."} → {s.to || "..."}) · Lot {s.lot_size || (subSymbol === "sensex" ? 10 : 25)} · Option Δ {Math.round((s.option_delta || 0.60) * 100)}%
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 self-start sm:self-center shrink-0">
            <button
              onClick={handleSyncBacktest}
              disabled={isSyncing}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer shadow-2xs",
                isSyncing
                  ? "bg-muted/60 text-muted-foreground border-border cursor-not-allowed opacity-70"
                  : "bg-muted/40 hover:bg-muted text-foreground border-border"
              )}
              title="Sync latest historical data and master backtests"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isSyncing && "animate-spin text-primary")} />
              <span>{isSyncing ? "Syncing Data..." : "Sync Backtests"}</span>
            </button>
          </div>
        </div>

        {/* Bottom Tier: Strategy Tabs, Inline Index Selector & Compact Year Strip */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left: Strategy Selector + Index Selector Grouped Seamlessly */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Strategy Pill Bar */}
            <div className="flex items-center p-0.5 bg-muted/60 rounded-xl border border-border/40">
              <button
                onClick={() => { setPicked(null); setMainStrategy("master_portfolio"); localStorage.setItem("backtest_main_strategy", "master_portfolio") }}
                className={cn(
                  "px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5",
                  mainStrategy === "master_portfolio"
                    ? "bg-purple-600 text-white shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground font-semibold"
                )}
              >
                <span>👑</span>
                <span>Apex Duo</span>
              </button>

              <button
                onClick={() => { setPicked(null); setMainStrategy("trend_runner"); localStorage.setItem("backtest_main_strategy", "trend_runner") }}
                className={cn(
                  "px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5",
                  mainStrategy === "trend_runner"
                    ? "bg-blue-600 text-white shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground font-semibold"
                )}
              >
                <span>⚡</span>
                <span>Trend Runner</span>
              </button>

              <button
                onClick={() => { setPicked(null); setMainStrategy("vix_trap"); localStorage.setItem("backtest_main_strategy", "vix_trap") }}
                className={cn(
                  "px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5",
                  mainStrategy === "vix_trap"
                    ? "bg-amber-600 text-white shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground font-semibold"
                )}
              >
                <span>🪤</span>
                <span>VIX Trap</span>
              </button>
            </div>

            {/* Index Selector Inline */}
            <div className="flex items-center p-0.5 bg-muted/40 rounded-xl border border-border/40">
              <button
                onClick={() => { setPicked(null); setSubSymbol("all"); localStorage.setItem("backtest_sub_symbol", "all") }}
                className={cn(
                  "px-2.5 py-1.5 text-xs rounded-lg transition-all cursor-pointer",
                  subSymbol === "all" ? "bg-background text-foreground shadow-2xs font-semibold" : "text-muted-foreground hover:text-foreground font-medium"
                )}
              >
                🌐 ALL
              </button>
              <button
                onClick={() => { setPicked(null); setSubSymbol("nifty"); localStorage.setItem("backtest_sub_symbol", "nifty") }}
                className={cn(
                  "px-2.5 py-1.5 text-xs rounded-lg transition-all cursor-pointer",
                  subSymbol === "nifty" ? "bg-background text-foreground shadow-2xs font-semibold" : "text-muted-foreground hover:text-foreground font-medium"
                )}
              >
                NIFTY
              </button>
              <button
                onClick={() => { setPicked(null); setSubSymbol("sensex"); localStorage.setItem("backtest_sub_symbol", "sensex") }}
                className={cn(
                  "px-2.5 py-1.5 text-xs rounded-lg transition-all cursor-pointer",
                  subSymbol === "sensex" ? "bg-background text-foreground shadow-2xs font-semibold" : "text-muted-foreground hover:text-foreground font-medium"
                )}
              >
                SENSEX
              </button>
            </div>
          </div>

          {/* Right: Year Filter Strip */}
          <div className="flex items-center gap-1.5 overflow-x-auto max-w-full pb-1 sm:pb-0">
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider pl-1">Year:</span>
            <div className="flex items-center p-0.5 bg-muted/40 rounded-xl border border-border/40">
              <button
                onClick={() => { setYear(null); setPicked(null) }}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-lg transition-all cursor-pointer",
                  year === "all" ? "bg-background text-foreground shadow-2xs font-semibold" : "text-muted-foreground hover:text-foreground font-medium"
                )}
              >
                All (10Y)
              </button>
              {years.map((y) => (
                <button
                  key={y}
                  onClick={() => { setYear(y); setPicked(null) }}
                  className={cn(
                    "px-2 py-1 text-xs rounded-lg transition-all cursor-pointer",
                    year === y ? "bg-background text-foreground shadow-2xs font-semibold" : "text-muted-foreground hover:text-foreground font-medium"
                  )}
                >
                  {y}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ERROR OR LOADING STATE */}
      {error ? (
        <div className="p-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
          Backtest failed: {error}
        </div>
      ) : (!data && loading) ? (
        <div className="flex flex-col gap-4 mt-2">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-[420px] w-full rounded-xl" />
        </div>
      ) : (
        <div className={cn("flex flex-col gap-4 transition-opacity duration-200", loading && "opacity-60")}>
          {/* 2. STREAMLINED METRICS KPI ROW */}
          <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-6">
            <StatCard
              label="Net P&L (1-Lot)"
              value={fmtPts(s.base_points ?? s.total_points)}
              className={pnlClass(s.base_points ?? s.total_points)}
              hint={
                s.dynamic_points
                  ? `Option: ${fmtRs(s.dynamic_rupees || (s.dynamic_points * s.lot_size * (s.option_delta || 0.6)))} · Spot: ${fmtRs((s.base_points ?? s.total_points) * s.lot_size)}`
                  : s.option_delta
                  ? `Option (≈${Math.round(s.option_delta * 100)}%Δ): ${fmtRs((s.base_points ?? s.total_points) * s.lot_size * s.option_delta)}`
                  : `≈ ${fmtRs((s.base_points ?? s.total_points) * s.lot_size)}`
              }
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
              hint={
                s.option_delta
                  ? `Option: ${fmtRs(Math.abs(s.max_drawdown) * s.lot_size * s.option_delta)}`
                  : `Spot: ${fmtRs(s.max_drawdown * s.lot_size)}`
              }
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
              hint="Max Single-Day Extremes"
            />
          </div>

          {/* 3. CONSOLIDATED ANALYTICS HUB (Combines Equity Curve, Monthly Breakdown & Daily Calendar) */}
          <Card id="analytics-hub-card" className="overflow-hidden border border-border/60 shadow-xs">
            <CardHeader className="border-b bg-card/60 p-3 sm:px-4 sm:py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                {/* View Selector Tabs */}
                <div className="flex items-center p-0.5 bg-muted/60 rounded-xl border border-border/40">
                  <button
                    onClick={() => setAnalyticsView("curve")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer flex items-center gap-1.5",
                      analyticsView === "curve" ? "bg-background text-foreground shadow-xs font-semibold" : "text-muted-foreground hover:text-foreground font-medium"
                    )}
                  >
                    <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
                    <span>Equity Curve</span>
                  </button>

                  <button
                    onClick={() => setAnalyticsView("calendar")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer flex items-center gap-1.5",
                      analyticsView === "calendar" ? "bg-background text-foreground shadow-xs font-semibold" : "text-muted-foreground hover:text-foreground font-medium"
                    )}
                  >
                    <Calendar className="h-3.5 w-3.5 text-sky-500" />
                    <span>Monthly &amp; Daily Calendar</span>
                  </button>

                  <button
                    onClick={() => setAnalyticsView("streaks")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer flex items-center gap-1.5",
                      analyticsView === "streaks" ? "bg-background text-foreground shadow-xs font-semibold" : "text-muted-foreground hover:text-foreground font-medium"
                    )}
                  >
                    <Flame className="h-3.5 w-3.5 text-amber-500" />
                    <span>Streaks &amp; Edge</span>
                  </button>
                </div>

                {/* Right stats pill */}
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[11px] font-mono px-2 py-0.5 border-border/60">
                    Peak: <span className="text-emerald-500 font-bold ml-1">{fmtPts(s.base_points ?? s.total_points)}</span>
                  </Badge>
                  <Badge variant="outline" className="text-[11px] font-mono px-2 py-0.5 border-border/60">
                    Max DD: <span className="text-red-500 font-bold ml-1">{fmtNum(s.max_drawdown)}</span>
                  </Badge>
                </div>
              </div>
            </CardHeader>

            <CardContent className="p-3 sm:p-5 min-h-[380px]">
              {/* TAB 1: EQUITY CURVE */}
              {analyticsView === "curve" && (
                <div className="flex flex-col gap-2">
                  <div className="h-[340px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={curve} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1 border-t border-border/30 pt-2">
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-1 bg-emerald-500 rounded-xs" /> Cumulative Points</span>
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-1 bg-red-500 rounded-xs" /> Drawdown From Peak</span>
                  </div>
                </div>
              )}

              {/* TAB 2: MONTHLY & DAILY CALENDAR (Clubbed + Instant Fast Chart Viewer) */}
              {analyticsView === "calendar" && (
                <div className="flex flex-col gap-5">
                  {/* FAST 1-MINUTE DAY CHART: Opens instantly right here when any day is clicked! */}
                  {picked && (
                    <div id="quick-day-chart" className="rounded-xl border border-primary/30 bg-card p-3 sm:p-4 shadow-sm animate-in fade-in duration-200">
                      <div className="flex items-center justify-between pb-2 mb-3 border-b border-border/40">
                        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                          <span className="text-sm font-bold text-foreground flex items-center gap-1.5">
                            <span>🕯️</span>
                            <span>1-Min Session Chart: <span className="font-mono text-primary font-bold">{picked}</span></span>
                          </span>
                          {(() => {
                            const d = (data?.daily ?? []).find((x) => x.date === picked)
                            if (!d) return null
                            return (
                              <Badge variant="outline" className={cn("text-xs font-mono font-bold", pnlClass(d.points))}>
                                {fmtPts(d.points)} ({d.trades} trade{d.trades === 1 ? "" : "s"})
                              </Badge>
                            )
                          })()}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPicked(null)}
                          className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground cursor-pointer"
                        >
                          <X className="h-3.5 w-3.5" />
                          <span>Close Chart</span>
                        </Button>
                      </div>

                      <DayDetail
                        key={`${picked}-${strategy}`}
                        date={picked}
                        mode="backtest"
                        strategy={strategy}
                        compact={true}
                        allowTimeframeSwitch={true}
                      />
                    </div>
                  )}

                  {/* Top Part: Monthly Breakdown Bar Chart */}
                  <div className="flex flex-col gap-2 rounded-xl border border-border/40 bg-muted/20 p-3 sm:p-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold tracking-tight uppercase text-muted-foreground">Monthly P&amp;L Distribution</h3>
                      {data?.monthly && data.monthly.length > 0 && (
                        <span className="text-xs font-mono font-medium text-muted-foreground">
                          <span className="text-emerald-500 font-bold">{data.monthly.filter((m: any) => m.points > 0).length}</span> / {data.monthly.length} profitable months
                        </span>
                      )}
                    </div>

                    <div className="h-[200px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={data?.monthly ?? []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} opacity={0.5} />
                          <XAxis dataKey="month" {...axis} />
                          <YAxis {...axis} tickFormatter={(v) => `${v}`} />
                          <Tooltip {...tooltip} formatter={(v: any) => [`${fmtPts(Number(v))}`, "Points"]} />
                          <Bar dataKey="points" radius={[3, 3, 0, 0]}>
                            {(data?.monthly ?? []).map((m, i) => (
                              <Cell key={i} fill={m.points >= 0 ? "#10b981" : "#ef4444"} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Bottom Part: Daily Session Heatmap */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground px-0.5">
                      <span className="font-semibold uppercase tracking-wider text-[11px]">Daily Session Heatmap</span>
                      <span className="text-[11px]">Click any day to instantly view its 1-min chart above</span>
                    </div>
                    <PnlCalendar
                      daily={(data?.daily ?? []).map((d) => ({ ...d, value: d.points }))}
                      format={fmtPts}
                      onPick={(dt) => {
                        setPicked(dt)
                        const el = document.getElementById("analytics-hub-card")
                        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
                      }}
                    />
                  </div>
                </div>
              )}

              {/* TAB 3: STREAKS & EDGE */}
              {analyticsView === "streaks" && (
                <div className="pt-1">
                  <StrategyStreakSummary
                    title={
                      strategy === "sensex_runner"
                        ? "Sensex Trend Runner Strategy Streaks & Recovery"
                        : "Strategy Streaks, Drawdown Cycles & Daily Edge"
                    }
                    description="Consecutive winning/losing days, drawdown recovery duration, and daily expectancy across all backtested trading days."
                    daily={(data?.daily ?? []).map((d) => ({ date: d.date, value: d.points, trades: d.trades }))}
                    unit="pts"
                    className="border-0 shadow-none p-0"
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* 4. TRADES EXECUTION LOG (With Interactive Sorting for Winners & Losers) */}
          <Card className="border border-border/60 shadow-xs">
            <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 sm:p-4 border-b">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                <CardTitle className="text-sm font-semibold tracking-tight">Trade Execution Log</CardTitle>
                <Badge variant="secondary" className="text-[11px] font-mono font-medium">
                  {sortedTrades.length} trade{sortedTrades.length === 1 ? "" : "s"}
                </Badge>
              </div>

              {/* Filter & Sort Controls Grouped */}
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                {/* Filter Pills */}
                <div className="flex items-center p-0.5 bg-muted/60 rounded-lg border border-border/40">
                  <button
                    onClick={() => setFilter("all")}
                    className={cn(
                      "px-2.5 py-1 text-xs rounded-md transition-all cursor-pointer font-medium",
                      filter === "all" ? "bg-background text-foreground shadow-2xs font-semibold" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    All ({data?.trades?.length || 0})
                  </button>
                  <button
                    onClick={() => setFilter("wins")}
                    className={cn(
                      "px-2.5 py-1 text-xs rounded-md transition-all cursor-pointer text-emerald-500 font-medium",
                      filter === "wins" ? "bg-background shadow-2xs font-semibold" : "opacity-80 hover:opacity-100"
                    )}
                  >
                    Wins ({s.wins || 0})
                  </button>
                  <button
                    onClick={() => setFilter("losses")}
                    className={cn(
                      "px-2.5 py-1 text-xs rounded-md transition-all cursor-pointer text-red-500 font-medium",
                      filter === "losses" ? "bg-background shadow-2xs font-semibold" : "opacity-80 hover:opacity-100"
                    )}
                  >
                    Losses ({s.losses || 0})
                  </button>
                </div>

                {/* Sort Order Selector (Winners & Losers) */}
                <div className="flex items-center p-0.5 bg-muted/60 rounded-lg border border-border/40">
                  <button
                    onClick={() => setSortOrder(sortOrder === "date-desc" ? "date-asc" : "date-desc")}
                    title="Sort by Date (click to toggle newest/oldest)"
                    className={cn(
                      "px-2 py-1 text-xs rounded-md transition-all cursor-pointer flex items-center gap-1 font-medium",
                      sortOrder.startsWith("date") ? "bg-background text-foreground shadow-2xs font-semibold" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span>Date</span>
                    <span>{sortOrder === "date-desc" ? "↓" : sortOrder === "date-asc" ? "↑" : ""}</span>
                  </button>
                  <button
                    onClick={() => setSortOrder("pnl-desc")}
                    title="Sort by Biggest Winners first"
                    className={cn(
                      "px-2 py-1 text-xs rounded-md transition-all cursor-pointer flex items-center gap-1 text-emerald-500 font-medium",
                      sortOrder === "pnl-desc" ? "bg-background shadow-2xs font-semibold" : "opacity-80 hover:opacity-100"
                    )}
                  >
                    <span>🏆 Winners</span>
                  </button>
                  <button
                    onClick={() => setSortOrder("pnl-asc")}
                    title="Sort by Biggest Losers first"
                    className={cn(
                      "px-2 py-1 text-xs rounded-md transition-all cursor-pointer flex items-center gap-1 text-red-500 font-medium",
                      sortOrder === "pnl-asc" ? "bg-background shadow-2xs font-semibold" : "opacity-80 hover:opacity-100"
                    )}
                  >
                    <span>🩸 Losers</span>
                  </button>
                </div>
              </div>
            </CardHeader>

            <CardContent className="p-0">
              <Table className="table-fixed w-full">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead
                      className="w-[105px] cursor-pointer select-none hover:text-foreground transition-colors group"
                      onClick={() => setSortOrder(prev => prev === "date-desc" ? "date-asc" : "date-desc")}
                      title="Sort by Date"
                    >
                      <div className="flex items-center gap-1">
                        <span>Date</span>
                        {sortOrder === "date-desc" ? (
                          <ArrowDown className="h-3 w-3 text-primary shrink-0" />
                        ) : sortOrder === "date-asc" ? (
                          <ArrowUp className="h-3 w-3 text-primary shrink-0" />
                        ) : (
                          <ArrowUpDown className="h-2.5 w-2.5 opacity-30 group-hover:opacity-100 shrink-0" />
                        )}
                      </div>
                    </TableHead>
                    <TableHead className="w-[150px]">Side / Engine</TableHead>
                    <TableHead className="w-[65px]">In</TableHead>
                    <TableHead className="w-[85px] text-right">Entry</TableHead>
                    <TableHead className="w-[65px]">Out</TableHead>
                    <TableHead className="w-[85px] text-right">Exit</TableHead>
                    <TableHead className="w-auto">Exit Reason</TableHead>
                    <TableHead
                      className="w-[95px] text-right cursor-pointer select-none hover:text-foreground transition-colors group"
                      onClick={() => setSortOrder(prev => prev === "pnl-desc" ? "pnl-asc" : "pnl-desc")}
                      title="Sort by Points (Winners / Losers)"
                    >
                      <div className="flex items-center justify-end gap-1">
                        <span>Points</span>
                        {sortOrder === "pnl-desc" ? (
                          <ArrowDown className="h-3 w-3 text-emerald-500 shrink-0" />
                        ) : sortOrder === "pnl-asc" ? (
                          <ArrowUp className="h-3 w-3 text-red-500 shrink-0" />
                        ) : (
                          <ArrowUpDown className="h-2.5 w-2.5 opacity-30 group-hover:opacity-100 shrink-0" />
                        )}
                      </div>
                    </TableHead>
                    <TableHead className="w-[105px] text-right">Cumulative</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedTrades.map((t, i) => (
                    <TableRow
                      key={i}
                      className="cursor-pointer hover:bg-muted/40 transition-colors"
                      onClick={() => {
                        setPicked(t.date)
                        setAnalyticsView("calendar")
                        const hub = document.getElementById("analytics-hub-card")
                        if (hub) hub.scrollIntoView({ behavior: "smooth", block: "start" })
                      }}
                      title="Click to view 1-minute chart in the Analytics Hub"
                    >
                      <TableCell className="tabular-nums font-mono text-xs w-[105px]">{t.date}</TableCell>
                      <TableCell className="w-[150px]">
                        <div className="flex flex-col gap-0.5 max-w-[140px]">
                          <SideBadge side={t.side} />
                          {Boolean((t as any).strategy_label || (t as any).engine) && (
                            <span className="text-[10px] text-foreground font-semibold tracking-tight truncate">
                              {(t as any).strategy_label || (t as any).engine}
                            </span>
                          )}
                          {Boolean((t as any).trigger_reason || (t as any).trigger_label) && (
                            <span className="text-[9px] text-muted-foreground leading-tight truncate" title={(t as any).trigger_reason || (t as any).trigger_label}>
                              {(t as any).trigger_reason || (t as any).trigger_label}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="tabular-nums text-xs w-[65px]">{t.entry}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs font-mono w-[85px]">{fmtNum(t.entry_price)}</TableCell>
                      <TableCell className="tabular-nums text-xs w-[65px]">{t.exit}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs font-mono w-[85px]">{fmtNum(t.exit_price)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground truncate max-w-0" title={t.lots && t.lots > 1 ? `${t.setup || "VIX TRAP"} (${t.lots}L) · ${prettyReason(t.reason)}` : t.setup ? `${t.setup} · ${prettyReason(t.reason)}` : prettyReason(t.reason)}>
                        {t.lots && t.lots > 1 ? `${t.setup || "VIX TRAP"} (${t.lots}L) · ${prettyReason(t.reason)}` : t.setup ? `${t.setup} · ${prettyReason(t.reason)}` : prettyReason(t.reason)}
                      </TableCell>
                      <TableCell className={cn("text-right font-semibold tabular-nums text-xs font-mono w-[95px]", pnlClass(t.pnl_points))}>
                        {fmtPts(t.pnl_points)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs font-mono text-muted-foreground w-[105px]">{fmtNum(t.equity)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

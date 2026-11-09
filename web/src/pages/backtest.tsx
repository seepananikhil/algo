import { useMemo, useState } from "react"
import { DayPanel } from "@/components/day-detail"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SideBadge, StatCard } from "@/components/common"
import { PnlCalendar } from "@/components/pnl-calendar"
import { StrategyStreakSummary } from "@/components/strategy-streak-summary"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { Activity, BarChart2, Calendar, Flame, RefreshCw, TrendingUp } from "lucide-react"
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
  const basePts = trades.map((t) => (t as any).base_points ?? t.pnl_points)
  const wins = pts.filter((p) => p > 0).length
  const total = Math.round(pts.reduce((a, p) => a + p, 0) * 100) / 100
  const baseTotal = Math.round(basePts.reduce((a, p) => a + p, 0) * 100) / 100

  const lotSize = safeData.summary.lot_size || 25
  const optDelta = safeData.summary.option_delta || 0.60
  const hasRs = trades.some((t) => (t as any).pnl_rupees !== undefined)
  const dynRs = hasRs
    ? Math.round(trades.reduce((a, t) => a + ((t as any).pnl_rupees || 0), 0) * 100) / 100
    : Math.round(total * lotSize * optDelta * 100) / 100
  const futRs = hasRs && trades.some((t) => (t as any).futures_rupees !== undefined)
    ? Math.round(trades.reduce((a, t) => a + ((t as any).futures_rupees || 0), 0) * 100) / 100
    : Math.round(total * lotSize * 100) / 100

  return {
    summary: {
      ...safeData.summary,
      from: daily[0]?.date ?? "",
      to: daily[daily.length - 1]?.date ?? "",
      days: daily.length,
      trades: trades.length,
      wins,
      losses: pts.filter((p) => p < 0).length,
      win_rate_pct: trades.length ? Math.round((10000 * wins) / trades.length) / 100 : 0,
      total_points: total,
      dynamic_points: total,
      base_points: baseTotal,
      dynamic_rupees: dynRs,
      futures_rupees: futRs,
      avg_points: trades.length ? Math.round((total / trades.length) * 100) / 100 : 0,
      max_drawdown: Math.min(0, ...trades.map((t) => t.drawdown)),
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
type AnalyticsView = "curve" | "monthly" | "streaks" | "calendar"

export function BacktestPage() {
  const [mainStrategy, setMainStrategy] = useState<MainStrategy>(() => {
    const saved = localStorage.getItem("backtest_main_strategy")
    if (saved === "trend_runner" || saved === "vix_trap" || saved === "master_portfolio") return saved
    return "master_portfolio"
  })

  const [subSymbol, setSubSymbol] = useState<SubSymbol>(() => {
    const saved = localStorage.getItem("backtest_sub_symbol") as SubSymbol
    if (saved === "nifty" || saved === "sensex") return saved
    return "all"
  })

  const [analyticsView, setAnalyticsView] = useState<AnalyticsView>("curve")

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

  const { data: raw, loading, error, reload } = usePoll<Backtest>(apiUrl)

  const [filter, setFilter] = useState("all")
  const [isSyncing, setIsSyncing] = useState(false)

  const handleSyncBacktest = async () => {
    if (isSyncing) return
    setIsSyncing(true)
    toast.info("Syncing latest market data & master backtests...")
    try {
      const res = await fetch("/api/backtest/sync")
      const d = await res.json()
      if (!d.ok && !d.running) {
        toast.error("Sync error: " + (d.message || "Failed"))
        setIsSyncing(false)
        return
      }

      const pollInterval = setInterval(async () => {
        try {
          const sRes = await fetch("/api/backtest/sync/status")
          const s = await sRes.json()
          if (s.status === "completed") {
            clearInterval(pollInterval)
            setIsSyncing(false)
            if (reload) await reload()
            toast.success("Master backtests updated successfully!")
          } else if (s.status === "failed") {
            clearInterval(pollInterval)
            setIsSyncing(false)
            toast.error(s.message || "Backtest update failed")
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
                    ? "bg-blue-600 text-white shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
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
                    ? "bg-amber-600 text-white shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
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
                  "px-2.5 py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer",
                  subSymbol === "all" ? "bg-background text-foreground shadow-2xs font-semibold" : "text-muted-foreground hover:text-foreground font-medium"
                )}
              >
                🌐 ALL
              </button>
              <button
                onClick={() => { setPicked(null); setSubSymbol("nifty"); localStorage.setItem("backtest_sub_symbol", "nifty") }}
                className={cn(
                  "px-2.5 py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer",
                  subSymbol === "nifty" ? "bg-background text-foreground shadow-2xs font-semibold" : "text-muted-foreground hover:text-foreground font-medium"
                )}
              >
                NIFTY
              </button>
              <button
                onClick={() => { setPicked(null); setSubSymbol("sensex"); localStorage.setItem("backtest_sub_symbol", "sensex") }}
                className={cn(
                  "px-2.5 py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer",
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
                  "px-2.5 py-1 text-xs font-medium rounded-lg transition-all cursor-pointer",
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
                    "px-2 py-1 text-xs font-medium rounded-lg transition-all cursor-pointer",
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
              value={fmtNum(s.max_drawdown)}
              className="text-red-500"
              hint={
                s.option_delta
                  ? `Option: ${fmtRs(s.max_drawdown * s.lot_size * s.option_delta)}`
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

          {/* 3. CONSOLIDATED ANALYTICS HUB (Combines Equity Curve, Monthly, Streaks & Calendar) */}
          <Card className="overflow-hidden border border-border/60 shadow-xs">
            <CardHeader className="border-b bg-card/60 p-3 sm:px-4 sm:py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                {/* View Selector Tabs */}
                <div className="flex items-center p-0.5 bg-muted/60 rounded-xl border border-border/40">
                  <button
                    onClick={() => setAnalyticsView("curve")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5",
                      analyticsView === "curve" ? "bg-background text-foreground shadow-xs font-semibold" : "text-muted-foreground hover:text-foreground font-semibold"
                    )}
                  >
                    <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
                    <span>Equity Curve</span>
                  </button>

                  <button
                    onClick={() => setAnalyticsView("monthly")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5",
                      analyticsView === "monthly" ? "bg-background text-foreground shadow-xs font-semibold" : "text-muted-foreground hover:text-foreground font-semibold"
                    )}
                  >
                    <BarChart2 className="h-3.5 w-3.5 text-sky-500" />
                    <span>Monthly Breakdown</span>
                  </button>

                  <button
                    onClick={() => setAnalyticsView("streaks")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5",
                      analyticsView === "streaks" ? "bg-background text-foreground shadow-xs font-semibold" : "text-muted-foreground hover:text-foreground font-semibold"
                    )}
                  >
                    <Flame className="h-3.5 w-3.5 text-amber-500" />
                    <span>Streaks &amp; Edge</span>
                  </button>

                  <button
                    onClick={() => setAnalyticsView("calendar")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5",
                      analyticsView === "calendar" ? "bg-background text-foreground shadow-xs font-semibold" : "text-muted-foreground hover:text-foreground font-semibold"
                    )}
                  >
                    <Calendar className="h-3.5 w-3.5 text-primary" />
                    <span>Daily Calendar</span>
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

              {/* TAB 2: MONTHLY BREAKDOWN */}
              {analyticsView === "monthly" && (
                <div className="flex flex-col gap-2">
                  <div className="h-[340px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data?.monthly ?? []} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} opacity={0.6} />
                        <XAxis dataKey="month" {...axis} />
                        <YAxis {...axis} tickFormatter={(v) => `${v}`} />
                        <Tooltip {...tooltip} formatter={(v: any) => [`${fmtPts(Number(v))}`, "Points"]} />
                        <Bar dataKey="points" radius={[4, 4, 0, 0]}>
                          {(data?.monthly ?? []).map((m, i) => (
                            <Cell key={i} fill={m.points >= 0 ? "#10b981" : "#ef4444"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1 border-t border-border/30 pt-2">
                    <span>Month-by-Month Net Points</span>
                    <span>Green = Profitable Month · Red = Drawdown Month</span>
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

              {/* TAB 4: CALENDAR HEATMAP */}
              {analyticsView === "calendar" && (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Green = profit day, red = loss day, gray = no trade. Click any day to open its 1-min chart below.</span>
                  </div>
                  <PnlCalendar daily={(data?.daily ?? []).map((d) => ({ ...d, value: d.points }))} format={fmtPts} onPick={setPicked} />
                </div>
              )}
            </CardContent>
          </Card>

          {/* 4. DAY DETAIL PANEL (Expands smoothly when a date is selected) */}
          <DayPanel
            date={picked}
            mode="backtest"
            strategy={strategy}
            days={(data?.daily ?? []).map((d) => d.date)}
            onPick={setPicked}
            onClose={() => setPicked(null)}
            allowTimeframeSwitch={true}
          />

          {/* 5. TRADES EXECUTION LOG */}
          <Card className="border border-border/60 shadow-xs">
            <CardHeader className="flex flex-row items-center justify-between gap-3 p-3.5 sm:p-4 border-b">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                <CardTitle className="text-sm font-semibold tracking-tight">Trade Execution Log</CardTitle>
                <Badge variant="secondary" className="text-[11px] font-mono font-medium">
                  {trades.length} trade{trades.length === 1 ? "" : "s"}
                </Badge>
              </div>

              {/* Filter Tabs */}
              <div className="flex items-center p-0.5 bg-muted/60 rounded-lg border border-border/40">
                <button
                  onClick={() => setFilter("all")}
                  className={cn(
                    "px-2.5 py-1 text-xs font-medium rounded-md transition-all cursor-pointer",
                    filter === "all" ? "bg-background text-foreground shadow-2xs font-semibold" : "text-muted-foreground hover:text-foreground font-medium"
                  )}
                >
                  All ({data?.trades?.length || 0})
                </button>
                <button
                  onClick={() => setFilter("wins")}
                  className={cn(
                    "px-2.5 py-1 text-xs font-medium rounded-md transition-all cursor-pointer text-emerald-500",
                    filter === "wins" ? "bg-background shadow-2xs font-semibold" : "opacity-80 hover:opacity-100 font-medium"
                  )}
                >
                  Wins ({s.wins || 0})
                </button>
                <button
                  onClick={() => setFilter("losses")}
                  className={cn(
                    "px-2.5 py-1 text-xs font-medium rounded-md transition-all cursor-pointer text-red-500",
                    filter === "losses" ? "bg-background shadow-2xs font-semibold" : "opacity-80 hover:opacity-100 font-medium"
                  )}
                >
                  Losses ({s.losses || 0})
                </button>
              </div>
            </CardHeader>

            <CardContent className="p-0">
              <Table className="table-fixed w-full">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[105px]">Date</TableHead>
                    <TableHead className="w-[150px]">Side / Engine</TableHead>
                    <TableHead className="w-[65px]">In</TableHead>
                    <TableHead className="w-[85px] text-right">Entry</TableHead>
                    <TableHead className="w-[65px]">Out</TableHead>
                    <TableHead className="w-[85px] text-right">Exit</TableHead>
                    <TableHead className="w-auto">Exit Reason</TableHead>
                    <TableHead className="w-[95px] text-right">Points</TableHead>
                    <TableHead className="w-[105px] text-right">Cumulative</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trades.slice().reverse().map((t, i) => (
                    <TableRow
                      key={i}
                      className="cursor-pointer hover:bg-muted/40 transition-colors"
                      onClick={() => setPicked(t.date)}
                      title="Click to view 1-minute chart"
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

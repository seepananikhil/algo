import { useMemo, useRef, useState } from "react"
import {
  Calendar as CalendarIcon,
  CheckCircle2,
  CircleDollarSign,
  GitCommit,
  Layers,
  Percent,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "lucide-react"
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { PnlCalendar, type CalendarDay } from "@/components/pnl-calendar"
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

export type PortfolioFilter = "ALL" | "NIFTY" | "SENSEX" | "WIN" | "LOSS"

export function PaperPage() {
  const [portfolioFilter, setPortfolioFilter] = useState<PortfolioFilter>("ALL")
  const [sessionInstrumentTab, setSessionInstrumentTab] = useState<"ALL" | "NIFTY" | "SENSEX">("ALL")
  const [pickedDate, setPickedDate] = useState<string | null>(null)
  const [selectedTradeIndex, setSelectedTradeIndex] = useState<number>(0)
  const [selectedInstrument, setSelectedInstrument] = useState<"NIFTY" | "SENSEX" | null>(null)
  const [syncing, setSyncing] = useState(false)
  const terminalRef = useRef<HTMLDivElement>(null)

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

  // Filtered trades by active tab (All, Nifty, Sensex, Win, Loss)
  const filteredTrades: OptionTrade[] = useMemo(() => {
    return allTrades.filter((t) => {
      const isSensex = t.symbol === "SENSEX" || (t.option && t.option.includes("SENSEX"))
      const isWin = (t.net_rs ?? 0) > 0
      if (portfolioFilter === "NIFTY") return !isSensex
      if (portfolioFilter === "SENSEX") return isSensex
      if (portfolioFilter === "WIN") return isWin
      if (portfolioFilter === "LOSS") return !isWin
      return true
    })
  }, [allTrades, portfolioFilter])

  // Badge count caches
  const niftyCount = useMemo(() => allTrades.filter((t) => t.symbol === "NIFTY" || !t.option?.includes("SENSEX")).length, [allTrades])
  const sensexCount = useMemo(() => allTrades.filter((t) => t.symbol === "SENSEX" || t.option?.includes("SENSEX")).length, [allTrades])
  const winCount = useMemo(() => allTrades.filter((t) => (t.net_rs ?? 0) > 0).length, [allTrades])
  const lossCount = useMemo(() => allTrades.filter((t) => (t.net_rs ?? 0) <= 0).length, [allTrades])

  const handleTabChange = (tab: PortfolioFilter) => {
    setPortfolioFilter(tab)
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
    const baseCapital = portfolioFilter === "ALL" ? (capital.data?.summary?.starting_capital ?? 25000) : 25000
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
  }, [capital.data, filteredTrades, portfolioFilter])

  // Calendar Daily Data
  const calendarDaily: CalendarDay[] = useMemo(() => {
    const map = new Map<string, { date: string; value: number; pnl: number; trades: number }>()
    for (const t of filteredTrades) {
      const cur = map.get(t.date) || { date: t.date, value: 0, pnl: 0, trades: 0 }
      cur.value += t.net_rs ?? 0
      cur.pnl += t.net_rs ?? 0
      cur.trades += 1
      map.set(t.date, cur)
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date))
  }, [filteredTrades])

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
    if (portfolioFilter === "SENSEX") return "SENSEX"
    if (portfolioFilter === "NIFTY") return "NIFTY"
    if (selectedInstrument) return selectedInstrument
    if (activeTrade) {
      const isSensex = activeTrade.symbol === "SENSEX" || (activeTrade.option && activeTrade.option.includes("SENSEX")) || (activeTrade.mode && activeTrade.mode.includes("SENSEX"))
      return isSensex ? "SENSEX" : "NIFTY"
    }
    const hasSensex = activeDayTrades.some((t) => t.symbol === "SENSEX" || t.option?.includes("SENSEX"))
    return hasSensex ? "SENSEX" : "NIFTY"
  }, [sessionInstrumentTab, portfolioFilter, selectedInstrument, activeTrade, activeDayTrades])

  const chartStrategy = activeInstrument === "SENSEX" ? "sensex_runner" : "trend_runner"

  // Day click handler
  const handleDayClick = (date: string) => {
    setPickedDate(date)
    setSessionInstrumentTab("ALL")
    setSelectedTradeIndex(0)
    const dayTrades = filteredTrades.filter((t) => t.date === date)
    if (dayTrades.length > 0) {
      const first = dayTrades[0]
      const isSensex = first.symbol === "SENSEX" || first.option?.includes("SENSEX")
      if (portfolioFilter !== "NIFTY" && portfolioFilter !== "SENSEX") {
        setSelectedInstrument(isSensex ? "SENSEX" : "NIFTY")
      }
    }
    terminalRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col gap-5 pb-20">
      {/* 1. COMPACT TOP BAR: TITLE, FILTER TABS & BACKUP */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2 pb-2 border-b border-border/40">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h1 className="text-lg sm:text-xl font-black tracking-tight text-foreground font-mono">
            PAPER TRADING · {portfolioFilter === "ALL" ? "COMBINED PORTFOLIO" : portfolioFilter === "NIFTY" ? "NIFTY 50" : portfolioFilter === "SENSEX" ? "BSE SENSEX" : portfolioFilter === "WIN" ? "WINNERS" : "LOSSES"}
          </h1>
          <Badge variant="outline" className="font-mono text-[10px] font-bold border-emerald-500/40 bg-emerald-500/10 text-emerald-400 py-0.5">
            FORWARD ENGINE
          </Badge>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Main Portfolio Tabs: All, Nifty, Sensex, Win, Loss */}
          <div className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => handleTabChange("ALL")}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
                portfolioFilter === "ALL" ? "bg-background text-foreground shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span>All</span>
              <span className="text-[10px] font-mono opacity-70">({allTrades.length})</span>
            </button>
            <button
              type="button"
              onClick={() => handleTabChange("NIFTY")}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
                portfolioFilter === "NIFTY" ? "bg-sky-500/20 text-sky-400 shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span>Nifty</span>
              <span className="text-[10px] font-mono opacity-70">({niftyCount})</span>
            </button>
            <button
              type="button"
              onClick={() => handleTabChange("SENSEX")}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
                portfolioFilter === "SENSEX" ? "bg-amber-500/20 text-amber-400 shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span>Sensex</span>
              <span className="text-[10px] font-mono opacity-70">({sensexCount})</span>
            </button>
            <button
              type="button"
              onClick={() => handleTabChange("WIN")}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
                portfolioFilter === "WIN" ? "bg-emerald-500/20 text-emerald-400 shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span>Win</span>
              <span className="text-[10px] font-mono opacity-70">({winCount})</span>
            </button>
            <button
              type="button"
              onClick={() => handleTabChange("LOSS")}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
                portfolioFilter === "LOSS" ? "bg-rose-500/20 text-rose-400 shadow-2xs font-black" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span>Loss</span>
              <span className="text-[10px] font-mono opacity-70">({lossCount})</span>
            </button>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleSyncToGit}
            disabled={syncing}
            className="text-xs font-semibold gap-1.5 h-7.5 cursor-pointer shadow-xs hover:bg-muted/60"
            title="Backup and sync trade records to GitHub"
          >
            {syncing ? <RefreshCw className="size-3 animate-spin text-primary" /> : <GitCommit className="size-3 text-emerald-500" />}
            {syncing ? "Backing up..." : "Sync"}
          </Button>
        </div>
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

      {/* 2. OVERALL SUMMARY STRIP (COMBINED PORTFOLIO) */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
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

      {/* 3. PAYOFF / EQUITY CURVE & SESSION DISTRIBUTION */}
      {equityCurve.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-stretch">
          <Card className="lg:col-span-8 border-border/70 shadow-2xs flex flex-col">
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
            <CardContent className="p-3 flex-1">
              <div className="h-44 w-full">
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
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-4 border-border/70 shadow-2xs flex flex-col">
            <CardHeader className="py-2 px-3.5 border-b border-border/40">
              <CardTitle className="text-xs font-bold font-mono uppercase text-foreground">
                Per-Session Net P&amp;L
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 flex-1 flex flex-col justify-center">
              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={calendarDaily} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="date" stroke="var(--muted-foreground)" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="var(--muted-foreground)" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} />
                    <Tooltip
                      contentStyle={{ background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                      formatter={(v: any) => [`${fmtRs(Number(v))}`, "Session Net"]}
                    />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {calendarDaily.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={(entry.value ?? 0) >= 0 ? "#10b981" : "#ef4444"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 4. CALENDAR (BELOW SUMMARY & PAYOFF) */}
      <Card className="border-border/80 shadow-xs">
        <CardHeader className="py-2 px-3.5 border-b border-border/40 flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarIcon className="size-4 text-primary" />
            <div>
              <CardTitle className="text-xs font-bold font-mono uppercase">
                Trading Sessions Calendar
              </CardTitle>
              <CardDescription className="text-[11px]">
                Click any trading day below to inspect its chart on left and trades on right
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-mono">Active Day:</span>
            <Badge className="font-mono text-xs font-bold bg-primary text-primary-foreground">
              {activeDate}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-3 sm:p-4">
          <PnlCalendar
            daily={calendarDaily}
            format={fmtRs}
            onPick={handleDayClick}
            selectedDate={activeDate}
          />
        </CardContent>
      </Card>

      {/* 5. SESSION TERMINAL: LEFT CHART & RIGHT SCROLLABLE TRADES WITH TABS */}
      <div ref={terminalRef} className="scroll-mt-4">
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-2.5 sm:gap-3 items-start">
          {/* LEFT SIDE: CLEAN CHART (8 COLS) */}
          <div className="xl:col-span-8 flex flex-col min-w-0">
            <DayDetail
              key={`${activeDate}-${activeInstrument}`}
              date={activeDate}
              mode="paper"
              strategy={chartStrategy}
              compact
              chartOnly
              allowTimeframeSwitch
              simpleChart={true}
            />
          </div>

          {/* RIGHT SIDE: SCROLLABLE TRADES WITH NIFTY / SENSEX TABS (4 COLS) */}
          <div className="xl:col-span-4 flex flex-col min-w-0 h-[500px]">
            <Card className="h-full border-border/80 shadow-xs flex flex-col overflow-hidden bg-card/95">
              {/* Header: Tabs for this day's trades + Session Net P&L */}
              <div className="p-2 px-3 border-b border-border/40 bg-muted/20 flex items-center justify-between gap-2 shrink-0">
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

                <div className="text-right shrink-0 flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground font-mono">Net:</span>
                  <span className={cn("text-xs font-black font-mono tabular-nums px-1.5 py-0.5 rounded", (activeDayTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0)) >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400")}>
                    {activeDayTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0) >= 0 ? "+" : ""}
                    {fmtRs(activeDayTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0))}
                  </span>
                </div>
              </div>

              {/* Scrollable Trades List */}
              <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
                {sessionDayTrades.length > 0 ? (
                  sessionDayTrades.map((t, idx) => {
                    const isSelected = activeTrade === t
                    const optPts = t.sell_price > 0 ? t.sell_price - t.buy_price : 0
                    const isCall = t.side === "CALL" || t.side === "LONG" || t.side === "CE"
                    const isSensex = t.symbol === "SENSEX" || t.option?.includes("SENSEX")

                    return (
                      <div
                        key={`${t.date}-${t.entry}-${idx}`}
                        onClick={() => {
                          const realIdx = activeDayTrades.indexOf(t)
                          setSelectedTradeIndex(realIdx >= 0 ? realIdx : idx)
                          setSelectedInstrument(isSensex ? "SENSEX" : "NIFTY")
                        }}
                        className={cn(
                          "p-2.5 rounded-xl border text-xs cursor-pointer transition-all flex flex-col gap-1.5",
                          isSelected
                            ? "bg-primary/10 border-primary shadow-xs ring-1 ring-primary/40"
                            : "bg-muted/20 hover:bg-muted/40 border-border/50"
                        )}
                      >
                        {/* Header: Side, Instrument, Option contract, Net P&L */}
                        <div className="flex items-center justify-between gap-1.5">
                          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                            <Badge className={cn("text-[9px] font-black px-1.5 py-0", isCall ? "bg-emerald-600 text-white" : "bg-red-600 text-white")}>
                              {t.side}
                            </Badge>
                            <Badge variant="outline" className={cn("text-[9px] font-mono font-bold", isSensex ? "border-amber-500/40 text-amber-400 bg-amber-500/10" : "border-sky-500/40 text-sky-400 bg-sky-500/10")}>
                              {isSensex ? "SENSEX" : "NIFTY"}
                            </Badge>
                            <span className="font-extrabold text-xs text-foreground font-mono truncate">{t.option}</span>
                            <span className="text-[10px] text-muted-foreground font-mono">({t.qty} qty)</span>
                          </div>

                          <div className="text-right shrink-0">
                            <span className={cn("text-xs font-black font-mono block", pnlClass(t.net_rs ?? 0))}>
                              {(t.net_rs ?? 0) >= 0 ? "+" : ""}{fmtRs(t.net_rs ?? 0)}
                            </span>
                          </div>
                        </div>

                        {/* Timing, Premium, Points */}
                        <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground pt-1 border-t border-border/30">
                          <div className="flex items-center gap-1">
                            <span>{t.entry} → {t.exit || "Open"}</span>
                            <span>·</span>
                            <span className="text-foreground font-medium">₹{t.buy_price.toFixed(1)} → {t.sell_price > 0 ? `₹${t.sell_price.toFixed(1)}` : "Open"}</span>
                          </div>

                          <div className="flex items-center gap-1.5">
                            {t.sell_price > 0 && (
                              <span className={cn("font-bold", optPts >= 0 ? "text-emerald-400" : "text-red-400")}>
                                {optPts >= 0 ? "+" : ""}{optPts.toFixed(1)} opt pts
                              </span>
                            )}
                            {t.nifty_points != null && (
                              <span className={cn("font-bold", t.nifty_points >= 0 ? "text-emerald-400" : "text-red-400")}>
                                ({t.nifty_points >= 0 ? "+" : ""}{t.nifty_points.toFixed(0)} spot)
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Selected Trade Quick Specs */}
                        {isSelected && (
                          <div className="grid grid-cols-3 gap-1 pt-1.5 text-[9px] font-mono border-t border-border/30 bg-muted/30 p-1.5 rounded-lg mt-0.5">
                            <div>
                              <span className="text-muted-foreground block uppercase text-[8px]">Exit Reason</span>
                              <span className="font-bold text-sky-400 truncate block" title={t.exit_reason}>
                                {t.exit_reason === "RATCHET_LOCK" ? "Ratchet Lock (+80pt)" : (t.exit_reason || "Open")}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block uppercase text-[8px]">Capital / Fees</span>
                              <span className="font-semibold text-foreground block">₹{fmtNum(t.buy_value_rs || 0)} · {fmtRs(t.charges_rs || 0)}</span>
                            </div>
                            <div className="text-right">
                              <span className="text-muted-foreground block uppercase text-[8px]">Stop Loss</span>
                              <span className="font-semibold text-muted-foreground block">{t.sl ? fmtNum(t.sl) : "Fixed"}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })
                ) : (
                  <div className="py-20 text-center text-xs text-muted-foreground">
                    No {sessionInstrumentTab === "ALL" ? "" : sessionInstrumentTab.toLowerCase()} trades for this session.
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
                    Spot Move: <strong className={activeDayTrades.reduce((acc, t) => acc + (t.nifty_points ?? 0), 0) >= 0 ? "text-emerald-400" : "text-red-400"}>
                      {activeDayTrades.reduce((acc, t) => acc + (t.nifty_points ?? 0), 0) >= 0 ? "+" : ""}
                      {activeDayTrades.reduce((acc, t) => acc + (t.nifty_points ?? 0), 0).toFixed(1)} pts
                    </strong>
                  </span>
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

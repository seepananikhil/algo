import { useMemo, useRef, useState } from "react"
import {
  Calendar as CalendarIcon,
  CheckCircle2,
  CircleDollarSign,
  Filter,
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

  // Active Trade on active day
  const activeTrade: OptionTrade | null = useMemo(() => {
    if (!activeDayTrades.length) return null
    const safeIdx = Math.min(selectedTradeIndex, activeDayTrades.length - 1)
    return activeDayTrades[Math.max(0, safeIdx)]
  }, [activeDayTrades, selectedTradeIndex])

  // Determine Instrument & Strategy to display in the Left Chart
  const activeInstrument: "NIFTY" | "SENSEX" = useMemo(() => {
    if (portfolioFilter === "SENSEX") return "SENSEX"
    if (portfolioFilter === "NIFTY") return "NIFTY"
    if (selectedInstrument) return selectedInstrument
    if (activeTrade) {
      const isSensex = activeTrade.symbol === "SENSEX" || (activeTrade.option && activeTrade.option.includes("SENSEX")) || (activeTrade.mode && activeTrade.mode.includes("SENSEX"))
      return isSensex ? "SENSEX" : "NIFTY"
    }
    const hasSensex = activeDayTrades.some((t) => t.symbol === "SENSEX" || t.option?.includes("SENSEX"))
    return hasSensex ? "SENSEX" : "NIFTY"
  }, [portfolioFilter, selectedInstrument, activeTrade, activeDayTrades])

  const chartStrategy = activeInstrument === "SENSEX" ? "sensex_runner" : "trend_runner"

  // Day click handler
  const handleDayClick = (date: string) => {
    setPickedDate(date)
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
    <div className="flex flex-col gap-4 max-w-[1720px] mx-auto w-full pb-16">
      {/* 1. HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-border/40">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl sm:text-2xl font-black tracking-tight text-foreground font-mono">
              PAPER TRADING · {portfolioFilter === "ALL" ? "COMBINED PORTFOLIO" : portfolioFilter === "NIFTY" ? "NIFTY 50" : portfolioFilter === "SENSEX" ? "BSE SENSEX" : portfolioFilter === "WIN" ? "WINNING TRADES" : "LOSS TRADES"}
            </h1>
            <Badge variant="outline" className="font-mono text-[10px] font-bold border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
              LIVE FORWARD ENGINE
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Consolidated Nifty &amp; Sensex trend strategies · Interactive calendar with direct charts &amp; executed option logs.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSyncToGit}
            disabled={syncing}
            className="text-xs font-semibold gap-1.5 h-8 cursor-pointer shadow-xs hover:bg-muted/60"
            title="Backup and sync trade records to GitHub"
          >
            {syncing ? <RefreshCw className="size-3.5 animate-spin text-primary" /> : <GitCommit className="size-3.5 text-emerald-500" />}
            {syncing ? "Backing up..." : "Sync to GitHub"}
          </Button>
        </div>
      </div>

      {/* 2. FILTER TABS: DEFAULT ALL, NIFTY, SENSEX, LOSS, WIN */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-2 px-3 rounded-xl border border-border/70 bg-card/80 shadow-2xs backdrop-blur-xs">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] font-bold font-mono uppercase text-muted-foreground mr-1 flex items-center gap-1">
            <Filter className="size-3.5 text-primary" /> View:
          </span>

          {/* ALL (Default) */}
          <button
            type="button"
            onClick={() => handleTabChange("ALL")}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
              portfolioFilter === "ALL"
                ? "bg-primary text-primary-foreground shadow-xs ring-1 ring-primary/40 font-black"
                : "bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground border border-border/50"
            )}
          >
            <span>All</span>
            <span className={cn("text-[10px] px-1.5 py-0.2 rounded-full font-mono", portfolioFilter === "ALL" ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-foreground")}>
              {allTrades.length}
            </span>
          </button>

          {/* NIFTY */}
          <button
            type="button"
            onClick={() => handleTabChange("NIFTY")}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
              portfolioFilter === "NIFTY"
                ? "bg-sky-600 text-white shadow-xs ring-1 ring-sky-500/40 font-black"
                : "bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground border border-border/50"
            )}
          >
            <span>Nifty</span>
            <span className={cn("text-[10px] px-1.5 py-0.2 rounded-full font-mono", portfolioFilter === "NIFTY" ? "bg-white/20 text-white" : "bg-sky-500/10 text-sky-400")}>
              {niftyCount}
            </span>
          </button>

          {/* SENSEX */}
          <button
            type="button"
            onClick={() => handleTabChange("SENSEX")}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
              portfolioFilter === "SENSEX"
                ? "bg-amber-600 text-white shadow-xs ring-1 ring-amber-500/40 font-black"
                : "bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground border border-border/50"
            )}
          >
            <span>Sensex</span>
            <span className={cn("text-[10px] px-1.5 py-0.2 rounded-full font-mono", portfolioFilter === "SENSEX" ? "bg-white/20 text-white" : "bg-amber-500/10 text-amber-400")}>
              {sensexCount}
            </span>
          </button>

          {/* WIN */}
          <button
            type="button"
            onClick={() => handleTabChange("WIN")}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
              portfolioFilter === "WIN"
                ? "bg-emerald-600 text-white shadow-xs ring-1 ring-emerald-500/40 font-black"
                : "bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground border border-border/50"
            )}
          >
            <span>Winners</span>
            <span className={cn("text-[10px] px-1.5 py-0.2 rounded-full font-mono", portfolioFilter === "WIN" ? "bg-white/20 text-white" : "bg-emerald-500/10 text-emerald-400")}>
              {winCount}
            </span>
          </button>

          {/* LOSS */}
          <button
            type="button"
            onClick={() => handleTabChange("LOSS")}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
              portfolioFilter === "LOSS"
                ? "bg-rose-600 text-white shadow-xs ring-1 ring-rose-500/40 font-black"
                : "bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground border border-border/50"
            )}
          >
            <span>Losses</span>
            <span className={cn("text-[10px] px-1.5 py-0.2 rounded-full font-mono", portfolioFilter === "LOSS" ? "bg-white/20 text-white" : "bg-rose-500/10 text-rose-400")}>
              {lossCount}
            </span>
          </button>
        </div>

        {/* Filter status description */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
          <span>Active Filter:</span>
          <Badge variant="outline" className="font-mono text-[10px] font-bold">
            {portfolioFilter === "ALL" && "All (Combined Portfolio)"}
            {portfolioFilter === "NIFTY" && "Nifty 50 Only"}
            {portfolioFilter === "SENSEX" && "BSE Sensex Only"}
            {portfolioFilter === "WIN" && "Winners (Positive P&L)"}
            {portfolioFilter === "LOSS" && "Losses (Negative P&L)"}
          </Badge>
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

      {/* 5. SESSION TERMINAL: ON CLICK ANY TRADE DAY -> LEFT SIDE CHART & RIGHT SIDE TRADES */}
      <div ref={terminalRef} className="scroll-mt-4">
        <Card className="border-border/80 shadow-md overflow-hidden bg-card/95 backdrop-blur-xs">
          <CardHeader className="py-2 px-4 border-b border-border/40 bg-muted/20">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className="font-black text-sm sm:text-base font-mono tracking-tight text-foreground">
                  SESSION TERMINAL · {activeDate}
                </span>

                {/* Instrument Toggle: SENSEX / NIFTY */}
                <div className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setSelectedInstrument("NIFTY")}
                    className={cn(
                      "rounded px-2.5 py-0.5 text-[11px] font-bold transition-colors cursor-pointer",
                      activeInstrument === "NIFTY" ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    NIFTY 50
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedInstrument("SENSEX")}
                    className={cn(
                      "rounded px-2.5 py-0.5 text-[11px] font-bold transition-colors cursor-pointer",
                      activeInstrument === "SENSEX" ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    BSE SENSEX
                  </button>
                </div>

                <span className="text-xs text-muted-foreground font-mono">
                  · {activeDayTrades.length} trade{activeDayTrades.length === 1 ? "" : "s"}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <div className="text-right">
                  <span className="text-[10px] text-muted-foreground block font-medium uppercase">Session Realized</span>
                  <span className={cn("text-base font-black font-mono tabular-nums", pnlClass(activeDayTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0)))}>
                    {activeDayTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0) >= 0 ? "+" : ""}
                    {fmtRs(activeDayTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0))}
                  </span>
                </div>
                {pickedDate && pickedDate !== latestDate && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDayClick(latestDate)}
                    className="text-xs font-semibold gap-1 h-7"
                    title="Return to latest day"
                  >
                    Today
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-3 sm:p-4">
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-3.5 items-start">
              {/* LEFT SIDE: CLEAN CHART (ENTRY / EXIT ONLY) */}
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

              {/* RIGHT SIDE: DAY'S TRADES & P&L */}
              <div className="xl:col-span-4 flex flex-col gap-2.5 min-w-0">
                {/* 1. Day's P&L Strip */}
                <div className="p-2.5 rounded-xl border border-border/80 bg-card shadow-2xs flex flex-col gap-2">
                  <div className="flex items-center justify-between pb-1.5 border-b border-border/40">
                    <span className="text-xs font-bold font-mono uppercase text-muted-foreground">
                      Session P&amp;L
                    </span>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {activeDate}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    <div className="p-2 rounded-lg bg-muted/20 border border-border/40">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold block">Net Return</span>
                      <span className={cn("text-base font-black font-mono block mt-0.5", pnlClass(activeDayTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0)))}>
                        {activeDayTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0) >= 0 ? "+" : ""}
                        {fmtRs(activeDayTrades.reduce((acc, t) => acc + (t.net_rs ?? 0), 0))}
                      </span>
                    </div>

                    <div className="p-2 rounded-lg bg-muted/20 border border-border/40">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold block">Gross P&amp;L</span>
                      <span className={cn("text-base font-black font-mono block mt-0.5", pnlClass(activeDayTrades.reduce((acc, t) => acc + (t.pnl_rs ?? 0), 0)))}>
                        {activeDayTrades.reduce((acc, t) => acc + (t.pnl_rs ?? 0), 0) >= 0 ? "+" : ""}
                        {fmtRs(activeDayTrades.reduce((acc, t) => acc + (t.pnl_rs ?? 0), 0))}
                      </span>
                    </div>

                    <div className="p-2 rounded-lg bg-muted/20 border border-border/40">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold block">Broker &amp; Taxes</span>
                      <span className="text-sm font-bold font-mono text-muted-foreground block mt-0.5">
                        {fmtRs(activeDayTrades.reduce((acc, t) => acc + (t.charges_rs ?? 0), 0))}
                      </span>
                    </div>

                    <div className="p-2 rounded-lg bg-muted/20 border border-border/40">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold block">Spot Points</span>
                      <span className={cn("text-sm font-bold font-mono block mt-0.5", activeDayTrades.reduce((acc, t) => acc + (t.nifty_points ?? 0), 0) >= 0 ? "text-emerald-400" : "text-red-400")}>
                        {activeDayTrades.reduce((acc, t) => acc + (t.nifty_points ?? 0), 0) >= 0 ? "+" : ""}
                        {activeDayTrades.reduce((acc, t) => acc + (t.nifty_points ?? 0), 0).toFixed(1)} pts
                      </span>
                    </div>
                  </div>
                </div>

                {/* 2. Executed Trade Inspector */}
                {activeTrade ? (
                  <div className="p-3 rounded-xl border border-border/80 bg-card shadow-2xs flex flex-col gap-2.5">
                    <div className="flex items-start justify-between gap-2 pb-2 border-b border-border/40">
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Badge className={cn("text-[10px] font-black px-2 py-0.5", (activeTrade.side === "CALL" || activeTrade.side === "LONG" || activeTrade.side === "CE") ? "bg-emerald-600 text-white" : "bg-red-600 text-white")}>
                            {activeTrade.side}
                          </Badge>
                          <span className="font-extrabold text-xs sm:text-sm text-foreground font-mono truncate">
                            {activeTrade.option}
                          </span>
                        </div>
                        <span className="text-[10px] font-mono text-muted-foreground">
                          {activeTrade.qty} qty · {activeTrade.entry} → {activeTrade.exit || "Active"}
                        </span>
                      </div>

                      <div className="text-right shrink-0">
                        <span className={cn("text-base sm:text-lg font-black font-mono tracking-tight block", pnlClass(activeTrade.net_rs ?? 0))}>
                          {(activeTrade.net_rs ?? 0) >= 0 ? "+" : ""}{fmtRs(activeTrade.net_rs ?? 0)}
                        </span>
                        {activeTrade.buy_price > 0 && activeTrade.sell_price > 0 && (
                          <span className={cn("text-[10px] font-mono font-bold block", activeTrade.sell_price >= activeTrade.buy_price ? "text-emerald-400" : "text-red-400")}>
                            {activeTrade.sell_price >= activeTrade.buy_price ? "+" : ""}
                            {(((activeTrade.sell_price - activeTrade.buy_price) / activeTrade.buy_price) * 100).toFixed(1)}% ROC
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Metric Tiles 2x2 Grid */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {/* Option Premium */}
                      <div className="p-2 rounded-lg bg-muted/30 border border-border/40 flex flex-col justify-between">
                        <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Option Premium
                        </span>
                        <div className="font-mono font-bold text-foreground mt-0.5 text-xs">
                          ₹{activeTrade.buy_price.toFixed(1)} → {activeTrade.sell_price > 0 ? `₹${activeTrade.sell_price.toFixed(1)}` : "Open"}
                        </div>
                        {activeTrade.sell_price > 0 && (
                          <span className={cn("text-[10px] font-mono font-bold mt-0.5", activeTrade.sell_price >= activeTrade.buy_price ? "text-emerald-400" : "text-red-400")}>
                            {activeTrade.sell_price >= activeTrade.buy_price ? "+" : ""}
                            {(activeTrade.sell_price - activeTrade.buy_price).toFixed(1)} opt pts
                          </span>
                        )}
                      </div>

                      {/* Spot Index */}
                      <div className="p-2 rounded-lg bg-muted/30 border border-border/40 flex flex-col justify-between">
                        <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Spot Index
                        </span>
                        <div className="font-mono font-bold text-foreground mt-0.5 text-xs">
                          {activeTrade.nifty_in?.toFixed(1) || "—"} → {activeTrade.nifty_out?.toFixed(1) || "—"}
                        </div>
                        {activeTrade.nifty_points != null && (
                          <span className={cn("text-[10px] font-mono font-bold mt-0.5", activeTrade.nifty_points >= 0 ? "text-emerald-400" : "text-red-400")}>
                            {activeTrade.nifty_points >= 0 ? "+" : ""}{activeTrade.nifty_points.toFixed(1)} spot pts
                          </span>
                        )}
                      </div>

                      {/* Trailing Lock & SL */}
                      <div className="p-2 rounded-lg bg-muted/30 border border-border/40 flex flex-col justify-between">
                        <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Profit Lock &amp; SL
                        </span>
                        <div className="font-mono font-bold text-sky-400 mt-0.5 text-xs">
                          {activeTrade.exit_reason === "RATCHET_LOCK" ? "+80.0 pts Lock" : "Trailing Active"}
                        </div>
                        <span className="text-[10px] text-muted-foreground font-mono mt-0.5">
                          SL: {activeTrade.sl ? fmtNum(activeTrade.sl) : "Fixed"}
                        </span>
                      </div>

                      {/* Exit Reason & Fees */}
                      <div className="p-2 rounded-lg bg-muted/30 border border-border/40 flex flex-col justify-between">
                        <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Exit Trigger
                        </span>
                        <div className="font-mono font-bold text-sky-300 truncate mt-0.5 text-xs" title={activeTrade.exit_reason}>
                          {activeTrade.exit_reason === "RATCHET_LOCK" ? "Ratchet Lock" : (activeTrade.exit_reason || "Holding")}
                        </div>
                        <span className="text-[10px] text-muted-foreground font-mono mt-0.5">
                          Fees: {fmtRs(activeTrade.charges_rs || 0)}
                        </span>
                      </div>
                    </div>

                    {/* Capital & Duration */}
                    <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground pt-1 px-0.5 border-t border-border/40">
                      <span>
                        Capital: ₹{activeTrade.buy_value_rs ? fmtNum(activeTrade.buy_value_rs) : "—"} → ₹{activeTrade.sell_value_rs ? fmtNum(activeTrade.sell_value_rs) : "—"}
                      </span>
                      <span className="font-semibold text-foreground">
                        {activeTrade.mode || "PAPER"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="p-5 text-center text-xs text-muted-foreground bg-muted/20 rounded-xl border border-border/50">
                    No trade recorded for this session.
                  </div>
                )}

                {/* 3. Day's Trades Selector (When multiple trades taken on this day) */}
                {activeDayTrades.length > 1 && (
                  <div className="rounded-xl border border-border/80 bg-card shadow-2xs overflow-hidden flex flex-col">
                    <div className="flex items-center justify-between px-3 py-1.5 bg-muted/20 border-b border-border/40">
                      <span className="text-[11px] font-bold font-mono tracking-tight text-foreground uppercase">
                        All Trades On {activeDate} ({activeDayTrades.length})
                      </span>
                      <span className="text-[10px] font-mono text-muted-foreground">
                        Click trade to switch chart
                      </span>
                    </div>

                    <div className="p-1.5 flex flex-col gap-1 max-h-[140px] overflow-y-auto">
                      {activeDayTrades.map((t, idx) => {
                        const isCurrent = activeTrade === t
                        const optPts = t.sell_price > 0 ? t.sell_price - t.buy_price : 0
                        const isCall = t.side === "CALL" || t.side === "LONG" || t.side === "CE"
                        const isSensex = t.symbol === "SENSEX" || t.option?.includes("SENSEX")

                        return (
                          <div
                            key={idx}
                            onClick={() => {
                              setSelectedTradeIndex(idx)
                              setSelectedInstrument(isSensex ? "SENSEX" : "NIFTY")
                            }}
                            className={cn(
                              "p-2 rounded-lg border text-xs cursor-pointer transition-all flex items-center justify-between gap-2",
                              isCurrent
                                ? "bg-primary/10 border-primary shadow-xs ring-1 ring-primary/30"
                                : "bg-card hover:bg-muted/40 border-border/60"
                            )}
                          >
                            <div className="min-w-0 flex flex-col gap-0.5">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <Badge className={cn("text-[9px] font-black px-1.5 py-0", isCall ? "bg-emerald-600 text-white" : "bg-red-600 text-white")}>
                                  {t.side}
                                </Badge>
                                <Badge variant="outline" className="text-[9px] font-mono font-bold">
                                  {isSensex ? "SENSEX" : "NIFTY"}
                                </Badge>
                                <span className="font-bold text-xs text-foreground font-mono">{t.option}</span>
                              </div>
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {t.entry} → {t.exit || "—"} ({t.qty} qty)
                              </span>
                            </div>

                            <div className="text-right shrink-0">
                              <span className={cn("text-xs font-black font-mono block", pnlClass(t.net_rs ?? 0))}>
                                {(t.net_rs ?? 0) >= 0 ? "+" : ""}{fmtRs(t.net_rs ?? 0)}
                              </span>
                              <span className={cn("text-[10px] font-mono font-bold block", optPts >= 0 ? "text-emerald-400" : "text-red-400")}>
                                {optPts >= 0 ? "+" : ""}{optPts.toFixed(1)} opt pts
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

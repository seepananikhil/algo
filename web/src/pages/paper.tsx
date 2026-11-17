import { useMemo, useRef, useState } from "react"
import {
  Activity,
  Calendar as CalendarIcon,
  CheckCircle2,
  CircleDollarSign,
  GitCommit,
  LineChart,
  Percent,
  RefreshCw,
  Search,
  SlidersHorizontal,
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
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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

export function PaperPage() {
  const [strategy, setStrategy] = useState<"trend_runner" | "sensex_runner" | "all">("trend_runner")
  const [picked, setPicked] = useState<string | null>(null)
  const [selectedTradeIndex, setSelectedTradeIndex] = useState<number>(0)
  const [syncing, setSyncing] = useState(false)
  const [terminalSymbol, setTerminalSymbol] = useState<"NIFTY" | "SENSEX">("NIFTY")
  const [ledgerSearch, setLedgerSearch] = useState("")
  const [ledgerSideFilter, setLedgerSideFilter] = useState<"ALL" | "CALL" | "PUT">("ALL")
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

  // Poll strategy reports and consolidated capital report
  const trendRunner = usePoll<PaperReport>("/api/paper-report?strategy=trend_runner", 15000)
  const sensexRunner = usePoll<PaperReport>("/api/paper-report?strategy=sensex_runner", 15000)
  const capital = usePoll<CapitalReport>("/api/capital-report", 15000)

  const reportLoading = strategy === "all" ? capital.loading : strategy === "sensex_runner" ? sensexRunner.loading : trendRunner.loading
  const reportError = strategy === "all" ? capital.error : strategy === "sensex_runner" ? sensexRunner.error : trendRunner.error

  const niftyTrades = useMemo(() => trendRunner.data?.trades || [], [trendRunner.data])
  const sensexTrades = useMemo(() => sensexRunner.data?.trades || [], [sensexRunner.data])

  // Active trades based on selected strategy
  const activeTrades: OptionTrade[] = useMemo(() => {
    if (strategy === "trend_runner") return niftyTrades
    if (strategy === "sensex_runner") return sensexTrades
    // Combined
    return [...niftyTrades, ...sensexTrades].sort((a, b) => {
      const ta = `${a.date} ${a.entry}`
      const tb = `${b.date} ${b.entry}`
      return ta.localeCompare(tb)
    })
  }, [strategy, niftyTrades, sensexTrades])

  // Summary Metrics
  const summary = useMemo(() => {
    if (strategy === "all" && capital.data?.summary) {
      const s = capital.data.summary
      const winTrades = activeTrades.filter((t) => (t.net_rs ?? 0) > 0).length
      const lossTrades = activeTrades.filter((t) => (t.net_rs ?? 0) <= 0).length
      const totalTrades = activeTrades.length
      const winRatePct = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0
      const winAmounts = activeTrades.map((t) => t.net_rs ?? 0).filter((v) => v > 0)
      const lossAmounts = activeTrades.map((t) => t.net_rs ?? 0).filter((v) => v < 0)
      const avgWin = winAmounts.length ? winAmounts.reduce((a, b) => a + b, 0) / winAmounts.length : 0
      const avgLoss = lossAmounts.length ? lossAmounts.reduce((a, b) => a + b, 0) / lossAmounts.length : 0
      const grossRs = activeTrades.reduce((a, t) => a + (t.pnl_rs ?? 0), 0)
      const chargesRs = activeTrades.reduce((a, t) => a + (t.charges_rs ?? 0), 0)

      return {
        starting_capital: s.starting_capital ?? 25000,
        ending_capital: s.ending_capital ?? 25000 + (s.net_rs ?? 0),
        net_rs: s.net_rs ?? 0,
        return_pct: s.return_pct ?? 0,
        gross_rs: grossRs,
        charges_rs: chargesRs,
        trades: totalTrades,
        wins: winTrades,
        losses: lossTrades,
        win_rate_pct: Math.round(winRatePct * 10) / 10,
        avg_win_rs: Math.round(avgWin * 100) / 100,
        avg_loss_rs: Math.round(avgLoss * 100) / 100,
        payoff_ratio: avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : "—",
        max_drawdown_rs: s.max_drawdown_rs ?? 0,
        winning_days: s.winning_days ?? 2,
        total_days: s.days ?? 2,
        peak_deployed_rs: s.peak_deployed_rs ?? 0,
      }
    }

    const report = strategy === "sensex_runner" ? sensexRunner.data : trendRunner.data
    const s = report?.summary
    const baseCapital = 25000
    const netRs = s?.net_rs ?? 0
    const returnPct = baseCapital > 0 ? (netRs / baseCapital) * 100 : 0
    const avgWin = s?.avg_win_rs ?? 0
    const avgLoss = s?.avg_loss_rs ?? 0

    return {
      starting_capital: baseCapital,
      ending_capital: baseCapital + netRs,
      net_rs: netRs,
      return_pct: Math.round(returnPct * 100) / 100,
      gross_rs: s?.gross_rs ?? 0,
      charges_rs: s?.charges_rs ?? 0,
      trades: s?.trades ?? 0,
      wins: s?.wins ?? 0,
      losses: s?.losses ?? 0,
      win_rate_pct: s?.win_rate_pct ?? 0,
      avg_win_rs: avgWin,
      avg_loss_rs: avgLoss,
      payoff_ratio: avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : "—",
      max_drawdown_rs: s?.max_drawdown_rs ?? 0,
      winning_days: s?.winning_days ?? 0,
      total_days: s?.days ?? 0,
      peak_deployed_rs: activeTrades.reduce((max, t) => Math.max(max, t.buy_value_rs || 0), 0),
    }
  }, [strategy, capital.data, trendRunner.data, sensexRunner.data, activeTrades])

  // Calendar Daily Data
  const calendarDaily: CalendarDay[] = useMemo(() => {
    if (strategy === "all" && capital.data?.daily?.length) {
      return capital.data.daily.map((d) => ({
        date: d.date,
        value: d.net_rs,
        pnl: d.net_rs,
        trades: d.trades,
      }))
    }
    const map = new Map<string, { date: string; value: number; pnl: number; trades: number }>()
    for (const t of activeTrades) {
      const cur = map.get(t.date) || { date: t.date, value: 0, pnl: 0, trades: 0 }
      cur.value += t.net_rs ?? 0
      cur.pnl += t.net_rs ?? 0
      cur.trades += 1
      map.set(t.date, cur)
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date))
  }, [strategy, capital.data, activeTrades])

  // Equity & Payoff Curve
  const equityCurve = useMemo(() => {
    if (!activeTrades.length) return []
    let cum = 0
    let peak = 0
    const curve = [{ label: "Start", equity: 0, drawdown: 0, date: "" }]
    for (const t of activeTrades) {
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
  }, [activeTrades])

  // Active Date Selection
  const latestDate = activeTrades.length ? activeTrades[activeTrades.length - 1].date : "2026-11-17"
  const activeDate = picked || latestDate

  const activeDayTrades = useMemo(() => {
    return activeTrades.filter((t) => t.date === activeDate)
  }, [activeTrades, activeDate])

  const activeTrade: OptionTrade | null = useMemo(() => {
    if (!activeDayTrades.length) return null
    const safeIdx = Math.min(selectedTradeIndex, activeDayTrades.length - 1)
    return activeDayTrades[Math.max(0, safeIdx)]
  }, [activeDayTrades, selectedTradeIndex])

  // Determine which strategy / symbol to render in DayDetail
  const effectiveDayStrategy = useMemo(() => {
    if (strategy === "sensex_runner") return "sensex_runner"
    if (strategy === "trend_runner") return "trend_runner"
    // In "all" mode, use the terminalSymbol toggle or activeTrade symbol
    if (activeTrade?.symbol === "SENSEX" || terminalSymbol === "SENSEX") return "sensex_runner"
    return "trend_runner"
  }, [strategy, activeTrade, terminalSymbol])

  const selectDate = (date: string) => {
    setPicked(date)
    setSelectedTradeIndex(0)
    // If trade on this day belongs to Sensex, auto-set terminal symbol
    const dayTrade = activeTrades.find((t) => t.date === date)
    if (dayTrade?.symbol === "SENSEX") {
      setTerminalSymbol("SENSEX")
    } else if (dayTrade?.symbol === "NIFTY") {
      setTerminalSymbol("NIFTY")
    }
    terminalRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  // Filtered trades for historical ledger
  const filteredLedgerTrades = useMemo(() => {
    return activeTrades.filter((t) => {
      const isCall = t.side === "CALL" || t.side === "LONG" || t.side === "CE"
      if (ledgerSideFilter === "CALL" && !isCall) return false
      if (ledgerSideFilter === "PUT" && isCall) return false
      if (ledgerSearch.trim()) {
        const q = ledgerSearch.toLowerCase()
        const match =
          t.date.toLowerCase().includes(q) ||
          t.option.toLowerCase().includes(q) ||
          (t.exit_reason || "").toLowerCase().includes(q)
        if (!match) return false
      }
      return true
    })
  }, [activeTrades, ledgerSearch, ledgerSideFilter])

  // Annualized XIRR / ROC estimation
  const xirrEstimate = useMemo(() => {
    if (!summary || (summary.starting_capital ?? 25000) <= 0 || summary.net_rs === 0) return 0
    // Total return % on deployed capital
    const roc = summary.return_pct
    // Days elapsed between earliest and latest trade
    if (activeTrades.length < 2) return roc
    const d0 = new Date(activeTrades[0].date).getTime()
    const d1 = new Date(activeTrades[activeTrades.length - 1].date).getTime()
    const days = Math.max(1, Math.round((d1 - d0) / (1000 * 60 * 60 * 24)))
    // Annualized return (using standard 252 trading days)
    const annualized = Math.round(roc * (252 / Math.max(days, 2)))
    return Math.min(999, Math.max(-100, annualized))
  }, [summary, activeTrades])

  return (
    <div className="flex flex-col gap-5 max-w-[1720px] mx-auto w-full pb-16">
      {/* 1. TOP EXECUTIVE BAR */}
      <div className="flex flex-col gap-3 pb-3 border-b border-border/40">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl sm:text-2xl font-black tracking-tight text-foreground font-mono">
                PAPER TRADING PORTFOLIO
              </h1>
              <span className="px-2.5 py-0.5 rounded text-[10px] font-extrabold uppercase bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5 shadow-2xs">
                <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                FORWARD TEST ENGINE
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Automated option trend system · Clean price action candlesticks with entry/exit markers &amp; real option executions.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncToGit}
              disabled={syncing}
              className="text-xs font-semibold gap-1.5 h-8 cursor-pointer shadow-xs hover:bg-muted/60"
              title="Backup and sync all paper trade records to GitHub origin/master"
            >
              {syncing ? <RefreshCw className="size-3.5 animate-spin text-primary" /> : <GitCommit className="size-3.5 text-emerald-500" />}
              {syncing ? "Backing up..." : "Sync to GitHub"}
            </Button>
          </div>
        </div>

        {/* Strategy Switcher Tabs */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
          <Tabs
            value={strategy}
            onValueChange={(val) => {
              setPicked(null)
              setSelectedTradeIndex(0)
              setStrategy(val as "trend_runner" | "sensex_runner" | "all")
            }}
          >
            <TabsList className="bg-muted/60 p-1 rounded-lg">
              <TabsTrigger value="trend_runner" className="font-bold text-xs sm:text-sm px-4 py-1">
                NIFTY 50
              </TabsTrigger>
              <TabsTrigger value="sensex_runner" className="font-bold text-xs sm:text-sm px-4 py-1">
                BSE SENSEX
              </TabsTrigger>
              <TabsTrigger value="all" className="font-bold text-xs sm:text-sm px-4 py-1">
                Combined Portfolio
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
            <span>Active Session:</span>
            <Badge variant="outline" className="font-mono text-xs font-bold border-primary/40 bg-primary/10 text-primary">
              {activeDate} {activeDate === latestDate ? "(Today)" : "(Selected)"}
            </Badge>
          </div>
        </div>
      </div>

      {/* Loading / Error States */}
      {reportLoading && !summary && (
        <Skeleton className="h-[680px] w-full rounded-2xl" />
      )}
      {reportError && (
        <Card className="border-red-500/40 bg-red-500/10">
          <CardContent className="py-8 text-center text-red-400 font-mono text-sm">
            Failed to load paper trading data: {reportError}
          </CardContent>
        </Card>
      )}

      {/* 2. OVERALL SUMMARY STRIP: P&L, XIRR, CAPITAL, WIN RATE, PAYOFF RATIO, DRAWDOWN */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* Card 1: Net P&L */}
          <Card className="p-3.5 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                  Net P&amp;L
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

          {/* Card 2: Return % on Capital & Annualized XIRR */}
          <Card className="p-3.5 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
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
              <span>Ann. Return:</span>
              <span className="font-bold text-foreground font-mono">+{xirrEstimate}%</span>
            </div>
          </Card>

          {/* Card 3: Capital: Starting -> Ending */}
          <Card className="p-3.5 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                  Capital Growth
                </span>
                <TrendingUp className="size-3.5 text-emerald-400" />
              </div>
              <div className="text-xl font-black font-mono tracking-tight mt-1 text-foreground">
                {fmtRs(summary.ending_capital)}
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground font-mono mt-1 pt-1 border-t border-border/40 flex items-center justify-between">
              <span>Base: {fmtRs(summary.starting_capital)}</span>
              <span>Peak: {fmtRs(summary.peak_deployed_rs || 0)}</span>
            </div>
          </Card>

          {/* Card 4: Win Rate & Trades */}
          <Card className="p-3.5 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
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
          <Card className="p-3.5 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                  Payoff Ratio
                </span>
                <Activity className="size-3.5 text-sky-400" />
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
          <Card className="p-3.5 border-border/70 bg-card/90 shadow-2xs flex flex-col justify-between">
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
                {(summary.starting_capital ?? 25000) > 0 ? ((Math.abs(summary.max_drawdown_rs) / (summary.starting_capital ?? 25000)) * 100).toFixed(1) : 0}%
              </span>
            </div>
          </Card>
        </div>
      )}

      {/* 3. PAYOFF CURVE & DAILY RETURN DISTRIBUTION */}
      {equityCurve.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-stretch">
          {/* Equity / Payoff Curve */}
          <Card className="lg:col-span-8 border-border/70 shadow-2xs flex flex-col">
            <CardHeader className="py-2.5 px-4 border-b border-border/40 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-xs font-bold font-mono uppercase text-foreground">
                  Cumulative Payoff Curve
                </CardTitle>
                <CardDescription className="text-[11px]">
                  Cumulative realized portfolio equity growth with drawdown shading
                </CardDescription>
              </div>
              <div className="flex items-center gap-2 font-mono text-xs">
                <span className="text-muted-foreground">Ending Equity:</span>
                <span className={cn("font-bold text-sm", pnlClass(summary?.net_rs))}>
                  {summary?.net_rs && summary.net_rs >= 0 ? "+" : ""}{fmtRs(summary?.net_rs ?? 0)}
                </span>
              </div>
            </CardHeader>
            <CardContent className="p-3 flex-1">
              <div className="h-56 w-full">
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

          {/* Daily Net P&L Bar Chart */}
          <Card className="lg:col-span-4 border-border/70 shadow-2xs flex flex-col">
            <CardHeader className="py-2.5 px-4 border-b border-border/40">
              <CardTitle className="text-xs font-bold font-mono uppercase text-foreground">
                Per-Session Net P&amp;L
              </CardTitle>
              <CardDescription className="text-[11px]">
                Realized rupee returns by trading session
              </CardDescription>
            </CardHeader>
            <CardContent className="p-3 flex-1 flex flex-col justify-center">
              <div className="h-56 w-full">
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

      {/* 4. INTERACTIVE P&L CALENDAR (PROMINENT FULL MONTH VIEW) */}
      <Card className="border-border/80 shadow-xs">
        <CardHeader className="py-3 px-4 border-b border-border/40 flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarIcon className="size-4 text-primary" />
            <div>
              <CardTitle className="text-sm font-bold font-mono uppercase">
                Trading Sessions Calendar
              </CardTitle>
              <CardDescription className="text-xs">
                Click any trading day on the calendar below to open its clean chart on left and trades on right
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-mono">Selected:</span>
            <Badge className="font-mono text-xs font-bold bg-primary text-primary-foreground">
              {activeDate}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          <PnlCalendar
            daily={calendarDaily}
            format={fmtRs}
            onPick={selectDate}
            selectedDate={activeDate}
          />
        </CardContent>
      </Card>

      {/* 5. SESSION TERMINAL: ON DAY CLICK -> SIMPLER CHART (ENTRY/EXIT ONLY) + P&L & TRADES */}
      <div ref={terminalRef} className="scroll-mt-4">
        <Card className="border-border/80 shadow-md overflow-hidden bg-card/95 backdrop-blur-xs">
          <CardHeader className="py-3 px-4 border-b border-border/40 bg-muted/20">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className="font-black text-sm sm:text-base font-mono tracking-tight text-foreground">
                  SESSION TERMINAL · {activeDate}
                </span>
                <Badge variant="outline" className="font-mono text-xs font-bold border-primary/40 bg-primary/10 text-primary">
                  {effectiveDayStrategy === "sensex_runner" ? "BSE SENSEX" : "NIFTY 50"}
                </Badge>
                {strategy === "all" && (
                  <div className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setTerminalSymbol("NIFTY")}
                      className={cn(
                        "rounded px-2.5 py-0.5 text-[11px] font-bold transition-colors cursor-pointer",
                        terminalSymbol === "NIFTY" ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      NIFTY
                    </button>
                    <button
                      type="button"
                      onClick={() => setTerminalSymbol("SENSEX")}
                      className={cn(
                        "rounded px-2.5 py-0.5 text-[11px] font-bold transition-colors cursor-pointer",
                        terminalSymbol === "SENSEX" ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      SENSEX
                    </button>
                  </div>
                )}
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
                {picked && picked !== latestDate && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => selectDate(latestDate)}
                    className="text-xs font-semibold gap-1 h-7"
                    title="Return to latest trading day"
                  >
                    Today
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-3 sm:p-4">
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
              {/* LEFT PANE (xl: 8 cols = 67%): CLEAN SIMPLIFIED CHART (NO CLUTTER, JUST ENTRY/EXIT) */}
              <div className="xl:col-span-8 flex flex-col min-w-0">
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-xs font-bold font-mono uppercase text-muted-foreground flex items-center gap-1.5">
                    <LineChart className="size-3.5 text-primary" />
                    Clean Price Action (Buy Entry &amp; Exit Markers Only)
                  </span>
                  <span className="text-[11px] text-muted-foreground font-mono">
                    Timeframe: 1m / 5m selectable · Zoom &amp; Pan enabled
                  </span>
                </div>
                <DayDetail
                  key={`${activeDate}-${effectiveDayStrategy}`}
                  date={activeDate}
                  mode="paper"
                  strategy={effectiveDayStrategy}
                  compact
                  chartOnly
                  allowTimeframeSwitch
                  simpleChart={true}
                />
              </div>

              {/* RIGHT PANE (xl: 4 cols = 33%): P&L BREAKDOWN & EXECUTED OPTION TRADES */}
              <div className="xl:col-span-4 flex flex-col gap-3 min-w-0">
                {/* 1. SESSION P&L CARD */}
                <div className="p-3.5 rounded-xl border border-border/80 bg-card shadow-2xs flex flex-col gap-2.5">
                  <div className="flex items-center justify-between pb-2 border-b border-border/40">
                    <span className="text-xs font-bold font-mono uppercase text-muted-foreground">
                      Session P&amp;L Summary
                    </span>
                    <Badge variant="outline" className="font-mono text-[11px]">
                      {activeDate}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
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
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold block">Spot Move</span>
                      <span className={cn("text-sm font-bold font-mono block mt-0.5", activeDayTrades.reduce((acc, t) => acc + (t.nifty_points ?? 0), 0) >= 0 ? "text-emerald-400" : "text-red-400")}>
                        {activeDayTrades.reduce((acc, t) => acc + (t.nifty_points ?? 0), 0) >= 0 ? "+" : ""}
                        {activeDayTrades.reduce((acc, t) => acc + (t.nifty_points ?? 0), 0).toFixed(1)} pts
                      </span>
                    </div>
                  </div>
                </div>

                {/* 2. ACTIVE TRADE EXECUTION INSPECTOR */}
                {activeTrade ? (
                  <div className="p-3.5 rounded-xl border border-border/80 bg-card shadow-2xs flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-2 pb-2 border-b border-border/40">
                      <div className="flex flex-col gap-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Badge className={cn("text-[10px] font-black px-2 py-0.5", (activeTrade.side === "CALL" || activeTrade.side === "LONG" || activeTrade.side === "CE") ? "bg-emerald-600 text-white" : "bg-red-600 text-white")}>
                            {activeTrade.side}
                          </Badge>
                          <span className="font-extrabold text-sm text-foreground font-mono truncate">
                            {activeTrade.option}
                          </span>
                        </div>
                        <span className="text-[11px] font-mono text-muted-foreground">
                          {activeTrade.qty} qty · {activeTrade.entry} → {activeTrade.exit || "Active"}
                        </span>
                      </div>

                      <div className="text-right shrink-0">
                        <span className={cn("text-lg font-black font-mono tracking-tight block", pnlClass(activeTrade.net_rs ?? 0))}>
                          {(activeTrade.net_rs ?? 0) >= 0 ? "+" : ""}{fmtRs(activeTrade.net_rs ?? 0)}
                        </span>
                        {activeTrade.buy_price > 0 && activeTrade.sell_price > 0 && (
                          <span className={cn("text-[11px] font-mono font-bold block", activeTrade.sell_price >= activeTrade.buy_price ? "text-emerald-400" : "text-red-400")}>
                            {activeTrade.sell_price >= activeTrade.buy_price ? "+" : ""}
                            {(((activeTrade.sell_price - activeTrade.buy_price) / activeTrade.buy_price) * 100).toFixed(1)}% ROC
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Metric Tiles 2x2 Grid */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {/* Option Premium */}
                      <div className="p-2.5 rounded-lg bg-muted/30 border border-border/40 flex flex-col justify-between">
                        <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Option Premium
                        </span>
                        <div className="font-mono font-bold text-foreground mt-0.5 text-xs sm:text-sm">
                          ₹{activeTrade.buy_price.toFixed(1)} → {activeTrade.sell_price > 0 ? `₹${activeTrade.sell_price.toFixed(1)}` : "Open"}
                        </div>
                        {activeTrade.sell_price > 0 && (
                          <span className={cn("text-[11px] font-mono font-bold mt-0.5", activeTrade.sell_price >= activeTrade.buy_price ? "text-emerald-400" : "text-red-400")}>
                            {activeTrade.sell_price >= activeTrade.buy_price ? "+" : ""}
                            {(activeTrade.sell_price - activeTrade.buy_price).toFixed(1)} opt pts
                          </span>
                        )}
                      </div>

                      {/* Spot Index */}
                      <div className="p-2.5 rounded-lg bg-muted/30 border border-border/40 flex flex-col justify-between">
                        <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Spot Index
                        </span>
                        <div className="font-mono font-bold text-foreground mt-0.5 text-xs sm:text-sm">
                          {activeTrade.nifty_in?.toFixed(1) || "—"} → {activeTrade.nifty_out?.toFixed(1) || "—"}
                        </div>
                        {activeTrade.nifty_points != null && (
                          <span className={cn("text-[11px] font-mono font-bold mt-0.5", activeTrade.nifty_points >= 0 ? "text-emerald-400" : "text-red-400")}>
                            {activeTrade.nifty_points >= 0 ? "+" : ""}{activeTrade.nifty_points.toFixed(1)} spot pts
                          </span>
                        )}
                      </div>

                      {/* Trailing Lock & SL */}
                      <div className="p-2.5 rounded-lg bg-muted/30 border border-border/40 flex flex-col justify-between">
                        <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Profit Lock &amp; SL
                        </span>
                        <div className="font-mono font-bold text-sky-400 mt-0.5 text-xs sm:text-sm">
                          {activeTrade.exit_reason === "RATCHET_LOCK" ? "+80.0 pts Lock" : "Trailing Active"}
                        </div>
                        <span className="text-[10px] text-muted-foreground font-mono mt-0.5">
                          SL: {activeTrade.sl ? fmtNum(activeTrade.sl) : "Fixed"}
                        </span>
                      </div>

                      {/* Exit Reason & Fees */}
                      <div className="p-2.5 rounded-lg bg-muted/30 border border-border/40 flex flex-col justify-between">
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
                    <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground pt-1 px-1 border-t border-border/40">
                      <span>
                        Capital: ₹{activeTrade.buy_value_rs ? fmtNum(activeTrade.buy_value_rs) : "—"} → ₹{activeTrade.sell_value_rs ? fmtNum(activeTrade.sell_value_rs) : "—"}
                      </span>
                      <span className="font-semibold text-foreground">
                        {activeTrade.mode || "PAPER"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="p-6 text-center text-xs text-muted-foreground bg-muted/20 rounded-xl border border-border/50">
                    No trade recorded for this session.
                  </div>
                )}

                {/* 3. SESSION TRADES SWITCHER LIST (IF MULTIPLE OR RECENT) */}
                <div className="rounded-xl border border-border/80 bg-card shadow-2xs overflow-hidden flex flex-col">
                  <div className="flex items-center justify-between px-3 py-2 bg-muted/20 border-b border-border/40">
                    <span className="text-xs font-bold font-mono tracking-tight text-foreground uppercase">
                      Session Trades ({activeDayTrades.length})
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">
                      Click to inspect
                    </span>
                  </div>

                  <div className="p-2 flex flex-col gap-1.5 max-h-[220px] overflow-y-auto">
                    {activeDayTrades.length ? (
                      activeDayTrades.map((t, idx) => {
                        const isCurrent = activeTrade === t
                        const optPts = t.sell_price > 0 ? t.sell_price - t.buy_price : 0
                        const isCall = t.side === "CALL" || t.side === "LONG" || t.side === "CE"

                        return (
                          <div
                            key={idx}
                            onClick={() => setSelectedTradeIndex(idx)}
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
                      })
                    ) : (
                      <p className="py-4 text-center text-xs text-muted-foreground">No trades on this day.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 6. HISTORICAL TRADE LEDGER */}
      <Card className="border-border/80 shadow-xs">
        <CardHeader className="py-3 px-4 border-b border-border/40 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-primary" />
            <div>
              <CardTitle className="text-sm font-bold font-mono uppercase">
                Historical Paper Ledger ({activeTrades.length} Trades)
              </CardTitle>
              <CardDescription className="text-xs">
                Complete audit trail of all executed paper positions
              </CardDescription>
            </div>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2">
            <div className="relative w-48 sm:w-64">
              <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search strike, date, exit..."
                value={ledgerSearch}
                onChange={(e) => setLedgerSearch(e.target.value)}
                className="h-8 pl-8 text-xs bg-muted/30"
              />
            </div>
            <div className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setLedgerSideFilter("ALL")}
                className={cn(
                  "rounded px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer",
                  ledgerSideFilter === "ALL" ? "bg-background text-foreground shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                )}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setLedgerSideFilter("CALL")}
                className={cn(
                  "rounded px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer",
                  ledgerSideFilter === "CALL" ? "bg-emerald-500/20 text-emerald-400 shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Calls
              </button>
              <button
                type="button"
                onClick={() => setLedgerSideFilter("PUT")}
                className={cn(
                  "rounded px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer",
                  ledgerSideFilter === "PUT" ? "bg-rose-500/20 text-rose-400 shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Puts
              </button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {filteredLedgerTrades.length ? (
              <Table>
                <TableHeader className="bg-muted/20">
                  <TableRow>
                    <TableHead>Date &amp; Action</TableHead>
                    <TableHead>Option Contract</TableHead>
                    <TableHead>Option Premium</TableHead>
                    <TableHead>Spot Move</TableHead>
                    <TableHead>Timing &amp; Mode</TableHead>
                    <TableHead>Exit Reason</TableHead>
                    <TableHead className="text-right">Net P&amp;L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLedgerTrades.map((trade, index) => {
                    const optPts = trade.sell_price > 0 ? trade.sell_price - trade.buy_price : 0
                    const optPct = trade.buy_price > 0 && trade.sell_price > 0 ? ((trade.sell_price - trade.buy_price) / trade.buy_price) * 100 : 0
                    const isSelected = activeDate === trade.date
                    return (
                      <TableRow
                        key={`${trade.date}-${trade.entry}-${index}`}
                        className={cn(
                          "cursor-pointer transition-colors",
                          isSelected ? "bg-primary/5 hover:bg-primary/10 border-l-2 border-l-primary" : "hover:bg-muted/30"
                        )}
                        onClick={() => selectDate(trade.date)}
                      >
                        <TableCell className="font-medium tabular-nums">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-foreground font-mono">{trade.date}</span>
                            <span className="text-[10px] font-semibold text-primary underline underline-offset-2 flex items-center">
                              Inspect ↗
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[10px] font-bold text-white", (trade.side === "CALL" || trade.side === "LONG" || trade.side === "CE") ? "bg-emerald-600" : "bg-red-600")}>
                              {trade.side}
                            </span>
                            <span className="font-semibold text-xs text-foreground font-mono">{trade.option}</span>
                            <span className="text-[10px] font-mono text-muted-foreground">({trade.qty} qty)</span>
                          </div>
                        </TableCell>
                        <TableCell className="tabular-nums text-xs">
                          <div className="font-mono font-medium">{fmtRs(trade.buy_price)} → {trade.sell_price > 0 ? fmtRs(trade.sell_price) : "Open"}</div>
                          {trade.sell_price > 0 && (
                            <span className={cn("text-[10px] font-mono font-bold", optPts >= 0 ? "text-emerald-400" : "text-red-400")}>
                              {optPts >= 0 ? "+" : ""}{optPts.toFixed(1)} opt pts ({optPct >= 0 ? "+" : ""}{optPct.toFixed(1)}%)
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums text-xs">
                          <div className="font-mono font-medium">{trade.nifty_in?.toFixed(1) || "—"} → {trade.nifty_out?.toFixed(1) || "—"}</div>
                          {trade.nifty_points != null && (
                            <span className={cn("text-[10px] font-mono font-bold", trade.nifty_points >= 0 ? "text-emerald-400" : "text-red-400")}>
                              {trade.nifty_points >= 0 ? "+" : ""}{trade.nifty_points.toFixed(1)} spot pts
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums text-xs font-mono text-muted-foreground">
                          <div>{trade.entry} → {trade.exit || "—"}</div>
                          <div className="text-[10px] text-muted-foreground">{trade.mode || "PAPER"}</div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground font-mono">
                          <span className="px-1.5 py-0.5 rounded bg-muted/60 text-[11px] font-semibold text-foreground">
                            {trade.exit_reason === "RATCHET_LOCK" ? "Ratchet Lock (+80pt)" : (trade.exit_reason || "Open")}
                          </span>
                        </TableCell>
                        <TableCell className={cn("text-right font-medium tabular-nums", pnlClass(trade.net_rs))}>
                          <div className="font-bold font-mono text-sm">{fmtRs(trade.net_rs)}</div>
                          <div className="text-[10px] font-normal text-muted-foreground">gross {fmtRs(trade.pnl_rs)} · fees {fmtRs(trade.charges_rs)}</div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">No paper trades match the filter.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

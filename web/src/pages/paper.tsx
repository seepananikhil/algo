import { useMemo, useRef, useState } from "react"
import {
  Activity,
  Calendar as CalendarIcon,
  GitCommit,
  LineChart,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
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
import { PnlCalendar } from "@/components/pnl-calendar"
import { StrategyStreakSummary } from "@/components/strategy-streak-summary"
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
  const [bottomTab, setBottomTab] = useState<"equity" | "calendar" | "streaks" | "ledger">("equity")
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

  const trendRunner = usePoll<PaperReport>(
    strategy === "trend_runner" ? "/api/paper-report?strategy=trend_runner" : null,
    30000
  )
  const sensexRunner = usePoll<PaperReport>(
    strategy === "sensex_runner" ? "/api/paper-report?strategy=sensex_runner" : null,
    30000
  )
  const capital = usePoll<CapitalReport>(strategy === "all" ? "/api/capital-report" : null, 30000)

  // Current active report
  const selectedReport = strategy === "sensex_runner" ? sensexRunner : trendRunner
  const reportLoading = strategy === "all" ? capital.loading : selectedReport.loading
  const reportError = strategy === "all" ? capital.error : selectedReport.error
  const reportData = strategy === "all" ? null : selectedReport.data

  const isSensex = strategy === "sensex_runner"
  const isNifty = strategy === "trend_runner"
  const instrumentTitle = isSensex ? "BSE SENSEX" : isNifty ? "NIFTY 50" : "COMBINED PORTFOLIO"

  // Determine active date and trades
  const trades = reportData?.trades || []
  const latestDate = trades.length ? trades[trades.length - 1].date : "2026-11-17"
  const activeDate = picked || latestDate

  const activeDayTrades = useMemo(() => {
    return trades.filter((t) => t.date === activeDate)
  }, [trades, activeDate])

  const activeTrade: (OptionTrade & { charges_rs: number; net_rs: number }) | null = useMemo(() => {
    if (!activeDayTrades.length) return null
    const safeIdx = Math.min(selectedTradeIndex, activeDayTrades.length - 1)
    return activeDayTrades[Math.max(0, safeIdx)]
  }, [activeDayTrades, selectedTradeIndex])

  // Equity curve for selected report
  const equityCurve = useMemo(() => {
    if (!trades.length) return []
    return [
      { label: "Start", equity: 0, drawdown: 0 },
      ...trades.map((t) => ({
        label: `${t.date} ${t.entry}`,
        equity: t.equity,
        drawdown: t.drawdown,
      })),
    ]
  }, [trades])

  // Filtered trades for historical ledger
  const filteredLedgerTrades = useMemo(() => {
    return trades.filter((t) => {
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
  }, [trades, ledgerSearch, ledgerSideFilter])

  const selectDate = (date: string) => {
    setPicked(date)
    setSelectedTradeIndex(0)
    terminalRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="flex flex-col gap-4 max-w-[1720px] mx-auto w-full pb-12">
      {/* 1. TOP EXECUTIVE HEADER & STRATEGY SELECTOR */}
      <div className="flex flex-col gap-3 pb-2 border-b border-border/40">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl sm:text-2xl font-black tracking-tight text-foreground font-mono">
                TRADES &amp; PERFORMANCE
              </h1>
              <span className="px-2 py-0.5 rounded text-[10px] font-extrabold uppercase bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                PAPER FORWARD TEST
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Live automated execution engine · Interactive candlestick chart on left and real option execution on right.
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

        {/* Strategy Tabs + Executive KPI Chips Bar */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pt-1">
          <Tabs
            value={strategy}
            onValueChange={(val) => {
              setPicked(null)
              setSelectedTradeIndex(0)
              setStrategy(val as "trend_runner" | "sensex_runner" | "all")
            }}
          >
            <TabsList className="bg-muted/60 p-1 rounded-lg">
              <TabsTrigger value="trend_runner" className="font-bold text-xs sm:text-sm px-3.5 py-1">
                NIFTY 50
              </TabsTrigger>
              <TabsTrigger value="sensex_runner" className="font-bold text-xs sm:text-sm px-3.5 py-1">
                BSE SENSEX
              </TabsTrigger>
              <TabsTrigger value="all" className="font-bold text-xs sm:text-sm px-3.5 py-1">
                Combined Portfolio
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Quick Metrics Bar */}
          {reportData?.summary && (
            <div className="flex items-center gap-3 sm:gap-4 flex-wrap text-xs bg-card/90 px-3.5 py-2 rounded-xl border border-border/60 shadow-2xs">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground uppercase font-semibold">Active:</span>
                <Badge variant="outline" className="font-mono text-xs font-bold border-primary/40 bg-primary/10 text-primary">
                  {activeDate}
                </Badge>
              </div>
              <div className="h-3 w-px bg-border/60" />
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground uppercase font-semibold">Cumulative Net:</span>
                <span className={cn("font-bold font-mono text-sm", pnlClass(reportData.summary.net_rs))}>
                  {reportData.summary.net_rs >= 0 ? "+" : ""}{fmtRs(reportData.summary.net_rs)}
                </span>
              </div>
              <div className="h-3 w-px bg-border/60" />
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground uppercase font-semibold">Win Rate:</span>
                <span className="font-bold font-mono text-emerald-400">
                  {reportData.summary.win_rate_pct}% ({reportData.summary.wins}W / {reportData.summary.losses}L)
                </span>
              </div>
              <div className="h-3 w-px bg-border/60" />
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground uppercase font-semibold">Total Trades:</span>
                <span className="font-bold font-mono text-foreground">
                  {reportData.summary.trades}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Loading / Error States */}
      {reportLoading && !reportData && !capital.data && (
        <Skeleton className="h-[680px] w-full rounded-2xl" />
      )}
      {reportError && (
        <Card className="border-red-500/40 bg-red-500/10">
          <CardContent className="py-8 text-center text-red-400 font-mono text-sm">
            Failed to load paper trading report: {reportError}
          </CardContent>
        </Card>
      )}

      {/* COMBINED PORTFOLIO VIEW */}
      {strategy === "all" && capital.data && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card className="p-4 border-border/70">
              <span className="text-xs text-muted-foreground font-semibold uppercase">Starting Capital</span>
              <div className="text-xl font-black font-mono mt-1">{fmtRs(capital.data.summary.starting_capital)}</div>
            </Card>
            <Card className="p-4 border-border/70">
              <span className="text-xs text-muted-foreground font-semibold uppercase">Ending Capital</span>
              <div className={cn("text-xl font-black font-mono mt-1", pnlClass(capital.data.summary.net_rs))}>
                {fmtRs(capital.data.summary.ending_capital)}
              </div>
            </Card>
            <Card className="p-4 border-border/70">
              <span className="text-xs text-muted-foreground font-semibold uppercase">Net Rupee Return</span>
              <div className={cn("text-xl font-black font-mono mt-1", pnlClass(capital.data.summary.net_rs))}>
                {capital.data.summary.net_rs >= 0 ? "+" : ""}{fmtRs(capital.data.summary.net_rs)}
              </div>
            </Card>
            <Card className="p-4 border-border/70">
              <span className="text-xs text-muted-foreground font-semibold uppercase">Winning Days</span>
              <div className="text-xl font-black font-mono mt-1 text-emerald-400">
                {capital.data.summary.winning_days} / {capital.data.summary.days}
              </div>
            </Card>
          </div>

          {picked && (
            <div ref={terminalRef} className="scroll-mt-4">
              <Card className="border-border/80 shadow-md">
                <CardHeader className="py-3 px-4 border-b border-border/40 flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-bold font-mono">Session Terminal · {picked}</CardTitle>
                    <CardDescription className="text-xs">Executed trades and candlestick trajectory</CardDescription>
                  </div>
                  <Button variant="ghost" size="icon-xs" onClick={() => setPicked(null)}>
                    <X className="size-4" />
                  </Button>
                </CardHeader>
                <CardContent className="p-3">
                  <DayDetail date={picked} mode="paper" compact chartOnly allowTimeframeSwitch />
                </CardContent>
              </Card>
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-12 items-start">
            <div className="xl:col-span-8">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-bold font-mono">Daily Capital Net P&amp;L</CardTitle>
                  <CardDescription className="text-xs">Consolidated returns across all strategies</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={capital.data.daily}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                        <XAxis dataKey="date" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} />
                        <Tooltip contentStyle={{ background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(v: any) => [`${fmtRs(Number(v))}`, "Daily Net"]} />
                        <Bar dataKey="net_rs" radius={[4, 4, 0, 0]}>
                          {capital.data.daily.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.net_rs >= 0 ? "#10b981" : "#ef4444"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>
            <div className="xl:col-span-4">
              <StrategyStreakSummary
                title="Combined Portfolio Streaks"
                description="Aggregated consecutive winning/losing day streaks and recovery time."
                daily={capital.data.daily.map((day) => ({ date: day.date, value: day.net_rs, trades: day.trades }))}
                unit="rs"
              />
            </div>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold font-mono">Session Calendar</CardTitle>
              <CardDescription className="text-xs">Click any day to inspect executed trades</CardDescription>
            </CardHeader>
            <CardContent>
              <PnlCalendar daily={capital.data.daily.map((day) => ({ ...day, value: day.net_rs }))} format={fmtRs} onPick={selectDate} />
            </CardContent>
          </Card>
        </div>
      )}

      {/* SINGLE INSTRUMENT (NIFTY 50 OR BSE SENSEX) */}
      {(isNifty || isSensex) && reportData && (
        <>
          {/* 2. THE MAIN HERO WORKSPACE: SPLIT SCREEN (CHART ON LEFT, TRADES ON RIGHT) */}
          <div ref={terminalRef} className="scroll-mt-4">
            <Card className="border-border/80 shadow-md overflow-hidden bg-card/95 backdrop-blur-xs">
              <CardHeader className="py-2.5 px-4 border-b border-border/40 bg-muted/20">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="font-black text-sm sm:text-base font-mono tracking-tight text-foreground">
                      {instrumentTitle} INTRADAY TERMINAL
                    </span>
                    <Badge variant="outline" className="font-mono text-xs font-bold border-primary/40 bg-primary/10 text-primary">
                      {activeDate} {activeDate === latestDate ? "(Today)" : "(Selected)"}
                    </Badge>
                    <span className="text-xs text-muted-foreground font-mono">
                      · {activeDayTrades.length} trade{activeDayTrades.length === 1 ? "" : "s"} on session
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <span className="text-[10px] text-muted-foreground block font-medium uppercase">Session P&amp;L</span>
                      <span className={cn("text-base font-black font-mono tabular-nums", pnlClass(activeDayTrades.reduce((acc, t) => acc + t.net_rs, 0)))}>
                        {activeDayTrades.reduce((acc, t) => acc + t.net_rs, 0) >= 0 ? "+" : ""}
                        {fmtRs(activeDayTrades.reduce((acc, t) => acc + t.net_rs, 0))}
                      </span>
                    </div>
                    {picked && (
                      <Button variant="ghost" size="icon-xs" onClick={() => setPicked(null)} title="Reset to today's latest session">
                        <X className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>

              <CardContent className="p-3 sm:p-4">
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-start">
                  {/* LEFT PANE (70%): INTRADAY CANDLESTICK CHART */}
                  <div className="lg:col-span-8 flex flex-col min-w-0">
                    <DayDetail
                      key={`${activeDate}-${strategy}`}
                      date={activeDate}
                      mode="paper"
                      strategy={strategy}
                      compact
                      chartOnly
                      allowTimeframeSwitch
                    />
                  </div>

                  {/* RIGHT PANE (30%): EXECUTION INSPECTOR & QUICK TRADES SWITCHER */}
                  <div className="lg:col-span-4 flex flex-col gap-3 min-w-0">
                    {/* TOP: ACTIVE TRADE EXECUTION INSPECTOR */}
                    {activeTrade ? (
                      <div className="p-3.5 rounded-xl border border-border/80 bg-card shadow-2xs flex flex-col gap-3">
                        {/* Header: Strike & Net Return */}
                        <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-border/40">
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
                              {activeTrade.qty} qty {isSensex ? `(${Math.round(activeTrade.qty / 20)}L)` : `(${Math.round(activeTrade.qty / 65)}L)`} · {activeTrade.entry} → {activeTrade.exit || "Active"}
                            </span>
                          </div>

                          <div className="text-right shrink-0">
                            <span className={cn("text-lg font-black font-mono tracking-tight block", pnlClass(activeTrade.net_rs))}>
                              {activeTrade.net_rs >= 0 ? "+" : ""}{fmtRs(activeTrade.net_rs)}
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
                          {/* 1. Option Premium */}
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

                          {/* 2. Spot Index */}
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

                          {/* 3. Trailing Lock & SL */}
                          <div className="p-2.5 rounded-lg bg-muted/30 border border-border/40 flex flex-col justify-between">
                            <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                              Profit Lock &amp; SL
                            </span>
                            <div className="font-mono font-bold text-sky-400 mt-0.5 text-xs sm:text-sm">
                              +80.0 pts Lock
                            </div>
                            <span className="text-[10px] text-muted-foreground font-mono mt-0.5">
                              SL: {activeTrade.sl ? fmtNum(activeTrade.sl) : "Fixed"}
                            </span>
                          </div>

                          {/* 4. Exit Trigger & Charges */}
                          <div className="p-2.5 rounded-lg bg-muted/30 border border-border/40 flex flex-col justify-between">
                            <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                              Exit Reason
                            </span>
                            <div className="font-mono font-bold text-sky-300 truncate mt-0.5 text-xs" title={activeTrade.exit_reason}>
                              {activeTrade.exit_reason === "RATCHET_LOCK" ? "Ratchet Lock (+80pt)" : (activeTrade.exit_reason || "Holding")}
                            </div>
                            <span className="text-[10px] text-muted-foreground font-mono mt-0.5">
                              Fees: {fmtRs(activeTrade.charges_rs || 0)}
                            </span>
                          </div>
                        </div>

                        {/* Capital & Duration Bar */}
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

                    {/* BOTTOM: INTERACTIVE PAPER TRADES SWITCHER FEED */}
                    <div className="rounded-xl border border-border/80 bg-card shadow-2xs overflow-hidden flex flex-col">
                      <div className="flex items-center justify-between px-3 py-2 bg-muted/20 border-b border-border/40">
                        <span className="text-xs font-bold font-mono tracking-tight text-foreground uppercase">
                          Paper Trades Log
                        </span>
                        <span className="text-[10px] font-mono text-muted-foreground font-semibold">
                          {trades.length} recorded
                        </span>
                      </div>

                      <div className="p-2 flex flex-col gap-1.5 max-h-[350px] overflow-y-auto">
                        {trades.length ? (
                          trades.map((t, idx) => {
                            const isSelectedDate = t.date === activeDate
                            const optPts = t.sell_price > 0 ? t.sell_price - t.buy_price : 0
                            const isCall = t.side === "CALL" || t.side === "LONG" || t.side === "CE"

                            return (
                              <div
                                key={idx}
                                onClick={() => {
                                  setPicked(t.date)
                                  setSelectedTradeIndex(0)
                                }}
                                className={cn(
                                  "p-2.5 rounded-lg border text-xs cursor-pointer transition-all flex items-center justify-between gap-2",
                                  isSelectedDate
                                    ? "bg-primary/10 border-primary shadow-xs ring-1 ring-primary/30"
                                    : "bg-card hover:bg-muted/40 border-border/60"
                                )}
                              >
                                <div className="min-w-0 flex flex-col gap-0.5">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <Badge className={cn("text-[9px] font-black px-1.5 py-0", isCall ? "bg-emerald-600 text-white" : "bg-red-600 text-white")}>
                                      {t.side}
                                    </Badge>
                                    <span className="font-bold text-xs text-foreground font-mono">{t.date}</span>
                                    <span className="text-[10px] text-muted-foreground font-mono">{t.entry}</span>
                                    {isSelectedDate && (
                                      <span className="text-[9px] font-bold bg-primary/20 text-primary px-1.5 py-0 rounded">
                                        Active
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] font-mono text-muted-foreground truncate">
                                    {t.option}
                                  </div>
                                  {t.sell_price > 0 && (
                                    <div className={cn("text-[10px] font-mono font-semibold", optPts >= 0 ? "text-emerald-400" : "text-red-400")}>
                                      {optPts >= 0 ? "+" : ""}{optPts.toFixed(1)} opt pts ({t.nifty_points != null ? `${t.nifty_points >= 0 ? "+" : ""}${t.nifty_points.toFixed(1)} spot` : ""})
                                    </div>
                                  )}
                                </div>

                                <div className="text-right shrink-0">
                                  <span className={cn("text-xs font-black font-mono block", pnlClass(t.net_rs))}>
                                    {t.net_rs >= 0 ? "+" : ""}{fmtRs(t.net_rs)}
                                  </span>
                                  <span className="text-[10px] font-mono text-muted-foreground block truncate max-w-[85px]" title={t.exit_reason}>
                                    {t.exit_reason === "RATCHET_LOCK" ? "Ratchet Lock" : (t.exit_reason || "Exit")}
                                  </span>
                                </div>
                              </div>
                            )
                          })
                        ) : (
                          <p className="py-6 text-center text-xs text-muted-foreground">No paper trades recorded yet.</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* 3. PERFORMANCE KPIS BAR */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Card className="p-3.5 border-border/70 bg-card/80">
              <span className="text-[11px] text-muted-foreground font-semibold uppercase block">Net P&amp;L</span>
              <div className={cn("text-lg font-black font-mono mt-1", pnlClass(reportData.summary.net_rs))}>
                {reportData.summary.net_rs >= 0 ? "+" : ""}{fmtRs(reportData.summary.net_rs)}
              </div>
              <span className="text-[10px] text-muted-foreground font-mono block mt-0.5">
                Gross {fmtRs(reportData.summary.gross_rs)} · Fees {fmtRs(reportData.summary.charges_rs)}
              </span>
            </Card>

            <Card className="p-3.5 border-border/70 bg-card/80">
              <span className="text-[11px] text-muted-foreground font-semibold uppercase block">Trades &amp; Wins</span>
              <div className="text-lg font-black font-mono mt-1 text-foreground">
                {reportData.summary.trades} Trades
              </div>
              <span className="text-[10px] text-muted-foreground font-mono block mt-0.5">
                {reportData.summary.wins} W · {reportData.summary.losses} L · {reportData.summary.winning_days} green days
              </span>
            </Card>

            <Card className="p-3.5 border-border/70 bg-card/80">
              <span className="text-[11px] text-muted-foreground font-semibold uppercase block">Win Rate</span>
              <div className="text-lg font-black font-mono mt-1 text-emerald-400">
                {reportData.summary.win_rate_pct}%
              </div>
              <span className="text-[10px] text-muted-foreground font-mono block mt-0.5">Net profitable trades</span>
            </Card>

            <Card className="p-3.5 border-border/70 bg-card/80">
              <span className="text-[11px] text-muted-foreground font-semibold uppercase block">Avg Win / Loss</span>
              <div className="text-lg font-black font-mono mt-1 text-foreground">
                {fmtRs(reportData.summary.avg_win_rs)} / {fmtRs(reportData.summary.avg_loss_rs)}
              </div>
              <span className="text-[10px] text-muted-foreground font-mono block mt-0.5">Expected payoff ratio</span>
            </Card>

            <Card className="p-3.5 border-border/70 bg-card/80">
              <span className="text-[11px] text-muted-foreground font-semibold uppercase block">Max Drawdown</span>
              <div className="text-lg font-black font-mono mt-1 text-red-500">
                {fmtRs(reportData.summary.max_drawdown_rs)}
              </div>
              <span className="text-[10px] text-muted-foreground font-mono block mt-0.5">Peak-to-valley decline</span>
            </Card>

            <Card className="p-3.5 border-border/70 bg-card/80">
              <span className="text-[11px] text-muted-foreground font-semibold uppercase block">Avg Net / Trade</span>
              <div className={cn("text-lg font-black font-mono mt-1", pnlClass(reportData.summary.net_rs))}>
                {reportData.summary.trades > 0 ? fmtRs(reportData.summary.net_rs / reportData.summary.trades) : "₹0"}
              </div>
              <span className="text-[10px] text-muted-foreground font-mono block mt-0.5">Per-execution expectancy</span>
            </Card>
          </div>

          {/* 4. TABBED DEEP ANALYTICS (NO ENDLESS SCROLLING) */}
          <Card className="border-border/80 shadow-xs">
            <CardHeader className="py-2.5 px-4 border-b border-border/40">
              <Tabs value={bottomTab} onValueChange={(v) => setBottomTab(v as any)}>
                <TabsList className="bg-muted/50 p-1 rounded-lg">
                  <TabsTrigger value="equity" className="text-xs font-semibold gap-1.5">
                    <LineChart className="size-3.5" />
                    Equity Curve &amp; Daily Net
                  </TabsTrigger>
                  <TabsTrigger value="calendar" className="text-xs font-semibold gap-1.5">
                    <CalendarIcon className="size-3.5" />
                    Session Calendar
                  </TabsTrigger>
                  <TabsTrigger value="streaks" className="text-xs font-semibold gap-1.5">
                    <Activity className="size-3.5" />
                    Streaks &amp; Expectancy
                  </TabsTrigger>
                  <TabsTrigger value="ledger" className="text-xs font-semibold gap-1.5">
                    <SlidersHorizontal className="size-3.5" />
                    Historical Ledger ({trades.length})
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </CardHeader>

            <CardContent className="p-4">
              {/* TAB 1: EQUITY CURVE & DAILY DISTRIBUTION */}
              {bottomTab === "equity" && (
                <div className="grid gap-4 sm:grid-cols-2 items-start">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold font-mono uppercase text-muted-foreground">
                      Cumulative Capital Trajectory
                    </span>
                    <div className="h-64 rounded-xl border border-border/60 p-2 bg-muted/10">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={equityCurve}>
                          <defs>
                            <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                              <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="dd" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                              <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                          <XAxis dataKey="label" hide />
                          <YAxis stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} />
                          <Tooltip contentStyle={{ background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(v: any, name: any) => [`${fmtRs(Number(v))}`, name === "equity" ? "Equity" : "Drawdown"]} />
                          <Area type="monotone" dataKey="equity" stroke="#10b981" strokeWidth={2} fill="url(#eq)" />
                          <Area type="monotone" dataKey="drawdown" stroke="#ef4444" strokeWidth={1} fill="url(#dd)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold font-mono uppercase text-muted-foreground">
                      Per-Session Net P&amp;L Distribution
                    </span>
                    <div className="h-64 rounded-xl border border-border/60 p-2 bg-muted/10">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={reportData.daily}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                          <XAxis dataKey="date" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
                          <YAxis stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} />
                          <Tooltip contentStyle={{ background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(v: any) => [`${fmtRs(Number(v))}`, "Net"]} />
                          <Bar dataKey="net_rs" radius={[4, 4, 0, 0]}>
                            {reportData.daily.map((m, i) => (
                              <Cell key={i} fill={m.net_rs >= 0 ? "#10b981" : "#ef4444"} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: SESSION CALENDAR */}
              {bottomTab === "calendar" && (
                <div className="flex flex-col gap-2">
                  <div className="text-xs text-muted-foreground">
                    Click any day on the calendar to load that session into the terminal chart on the left and option execution on the right.
                  </div>
                  <PnlCalendar
                    daily={reportData.daily.map((d) => ({ ...d, value: d.net_rs }))}
                    format={fmtRs}
                    onPick={selectDate}
                  />
                </div>
              )}

              {/* TAB 3: STREAKS & RECOVERY */}
              {bottomTab === "streaks" && (
                <StrategyStreakSummary
                  title={isSensex ? "Sensex Streaks & Expectancy" : "Nifty Streaks & Expectancy"}
                  description="Consecutive winning/losing days, drawdown recovery duration, and daily expectancy."
                  daily={reportData.daily.map((d) => ({ date: d.date, value: d.net_rs, trades: d.trades }))}
                  unit="rs"
                />
              )}

              {/* TAB 4: HISTORICAL TRADE LEDGER */}
              {bottomTab === "ledger" && (
                <div className="flex flex-col gap-3">
                  {/* Ledger Filters */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                    <div className="relative w-full sm:w-72">
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
                          "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                          ledgerSideFilter === "ALL" ? "bg-background text-foreground shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        All ({trades.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setLedgerSideFilter("CALL")}
                        className={cn(
                          "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                          ledgerSideFilter === "CALL" ? "bg-emerald-500/20 text-emerald-400 shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        Calls
                      </button>
                      <button
                        type="button"
                        onClick={() => setLedgerSideFilter("PUT")}
                        className={cn(
                          "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                          ledgerSideFilter === "PUT" ? "bg-rose-500/20 text-rose-400 shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        Puts
                      </button>
                    </div>
                  </div>

                  <div className="overflow-x-auto rounded-lg border border-border/60">
                    {filteredLedgerTrades.length ? (
                      <Table>
                        <TableHeader className="bg-muted/20">
                          <TableRow>
                            <TableHead>Date &amp; Action</TableHead>
                            <TableHead>Option Contract</TableHead>
                            <TableHead>Option Premium</TableHead>
                            <TableHead>Spot Index</TableHead>
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
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

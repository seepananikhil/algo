import { useEffect, useMemo, useRef, useState } from "react"
import { GitCommit, RefreshCw, Search, X } from "lucide-react"
import { toast } from "sonner"
import { DayDetail } from "@/components/day-detail"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatCard } from "@/components/common"
import { PnlCalendar } from "@/components/pnl-calendar"
import { StrategyStreakSummary } from "@/components/strategy-streak-summary"
import { fmtNum, fmtRs, pnlClass, postJSON, usePoll, type CapitalReport, type OptionTrade, type PaperReport } from "@/lib/api"
import { cn } from "@/lib/utils"

function CapitalDayPanel({
  date,
  trades,
  allTrades = [],
  onPick,
  onClose,
  strategy = "all",
  isDefaultSession = false,
}: {
  date: string
  trades: PaperReport["trades"]
  allTrades?: PaperReport["trades"]
  onPick?: (date: string) => void
  onClose: () => void
  strategy?: string
  isDefaultSession?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isDefaultSession) {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }, [date, isDefaultSession])
  const total = trades.reduce((sum, trade) => sum + trade.net_rs, 0)

  return (
    <div ref={ref} className="scroll-mt-20">
      <Card className="border-border/80 shadow-xs">
        <CardHeader className="pb-3 border-b border-border/40">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle className="text-base sm:text-lg">
                  {strategy === "trend_runner"
                    ? "NIFTY 50 Intraday Terminal & Option Execution"
                    : strategy === "sensex_runner"
                    ? "BSE SENSEX Intraday Terminal & Option Execution"
                    : "Intraday Terminal & Option Execution"}
                </CardTitle>
                <Badge variant="outline" className="font-mono text-xs font-bold border-primary/40 bg-primary/10 text-primary">
                  {date} {isDefaultSession ? "(Latest Session)" : "(Selected Date)"}
                </Badge>
              </div>
              <CardDescription className="text-xs mt-0.5">
                Intraday candlestick chart on left, active option strike executions and quick switcher on right.
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <span className="text-[10px] text-muted-foreground block font-medium">Session Net</span>
                <span className={cn("text-base sm:text-lg font-bold tabular-nums font-mono", pnlClass(total))}>
                  {total >= 0 ? "+" : ""}{fmtRs(total)}
                </span>
              </div>
              {!isDefaultSession && (
                <Button variant="ghost" size="icon-sm" aria-label="Close selected day" onClick={onClose}><X className="size-4" /></Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* LEFT SIDE: INTRADAY CANDLESTICK CHART (NIFTY OR SENSEX ONLY) */}
            <div className="lg:col-span-8 flex flex-col gap-3 min-w-0">
              <DayDetail
                key={`${date}-${strategy}`}
                date={date}
                mode="paper"
                strategy={strategy}
                compact
                chartOnly
                allowTimeframeSwitch
              />
            </div>

            {/* RIGHT SIDE: OPTION TRADES & QUICK SWITCHER */}
            <div className="lg:col-span-4 flex flex-col gap-3.5 min-w-0">
              {/* Active Session Trade Cards */}
              <div className="rounded-xl border border-border/80 bg-card/90 shadow-2xs overflow-hidden flex flex-col">
                <div className="flex items-center justify-between px-3.5 py-2.5 bg-muted/20 border-b border-border/40">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold tracking-tight text-foreground">
                      Session Option Execution
                    </span>
                    <Badge variant="outline" className="text-[10px] font-mono border-primary/40 text-primary">
                      {date} ({trades.length} trade{trades.length === 1 ? "" : "s"})
                    </Badge>
                  </div>
                  <span className={cn("text-xs font-bold font-mono", pnlClass(total))}>
                    {total >= 0 ? "+" : ""}{fmtRs(total)}
                  </span>
                </div>

                <div className="p-3 flex flex-col gap-3">
                  {trades.length > 0 ? (
                    trades.map((t, idx) => {
                      const optPts = t.sell_price > 0 ? t.sell_price - t.buy_price : 0
                      const optPct = t.buy_price > 0 && t.sell_price > 0 ? ((t.sell_price - t.buy_price) / t.buy_price) * 100 : 0
                      const isCall = t.side === "CALL" || t.side === "LONG" || t.side === "CE"
                      const lotSize = strategy === "sensex_runner" ? 20 : 65
                      const lots = Math.max(1, Math.round(t.qty / lotSize))
                      return (
                        <div key={idx} className="p-3 rounded-lg border border-border/70 bg-card space-y-2.5">
                          {/* Strike & Return */}
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                              <Badge className={cn("text-[10px] font-black px-2 py-0.5", isCall ? "bg-emerald-600 text-white" : "bg-red-600 text-white")}>
                                {t.side}
                              </Badge>
                              <span className="font-bold text-xs text-foreground font-mono truncate">{t.option}</span>
                            </div>
                            <div className="text-right shrink-0">
                              <span className={cn("text-sm font-black font-mono", pnlClass(t.net_rs))}>
                                {t.net_rs >= 0 ? "+" : ""}{fmtRs(t.net_rs)}
                              </span>
                              {optPct !== 0 && (
                                <span className={cn("text-[10px] font-mono block font-bold", optPct >= 0 ? "text-emerald-400" : "text-red-400")}>
                                  {optPct >= 0 ? "+" : ""}{optPct.toFixed(1)}%
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Quick Info Bar */}
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono bg-muted/40 px-2 py-1 rounded">
                            <span>{t.qty} qty ({lots} lot{lots > 1 ? "s" : ""}) · {t.mode || "PAPER"}</span>
                            <span>{t.entry} → {t.exit || "Active"}</span>
                          </div>

                          {/* 2x2 Metric Grid */}
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="p-2 rounded bg-muted/30 border border-border/40">
                              <span className="text-[10px] text-muted-foreground font-semibold uppercase block">Option Premium</span>
                              <span className="font-mono font-bold text-foreground block mt-0.5">
                                ₹{t.buy_price.toFixed(1)} → {t.sell_price > 0 ? `₹${t.sell_price.toFixed(1)}` : "Open"}
                              </span>
                              {t.sell_price > 0 && (
                                <span className={cn("text-[10px] font-mono font-bold block mt-0.5", optPts >= 0 ? "text-emerald-400" : "text-red-400")}>
                                  {optPts >= 0 ? "+" : ""}{optPts.toFixed(1)} opt pts
                                </span>
                              )}
                            </div>

                            <div className="p-2 rounded bg-muted/30 border border-border/40">
                              <span className="text-[10px] text-muted-foreground font-semibold uppercase block">Spot Index</span>
                              <span className="font-mono font-bold text-foreground block mt-0.5">
                                {t.nifty_in?.toFixed(1) || "—"} → {t.nifty_out?.toFixed(1) || "—"}
                              </span>
                              {t.nifty_points != null && (
                                <span className={cn("text-[10px] font-mono font-bold block mt-0.5", t.nifty_points >= 0 ? "text-emerald-400" : "text-red-400")}>
                                  {t.nifty_points >= 0 ? "+" : ""}{t.nifty_points.toFixed(1)} spot pts
                                </span>
                              )}
                            </div>

                            <div className="p-2 rounded bg-muted/30 border border-border/40">
                              <span className="text-[10px] text-muted-foreground font-semibold uppercase block">Profit Lock</span>
                              <span className="font-mono font-bold text-sky-400 block mt-0.5">+80.0 pts Lock</span>
                              <span className="text-[10px] text-muted-foreground block mt-0.5">
                                SL: {t.sl ? fmtNum(t.sl) : "—"}
                              </span>
                            </div>

                            <div className="p-2 rounded bg-muted/30 border border-border/40">
                              <span className="text-[10px] text-muted-foreground font-semibold uppercase block">Exit Trigger</span>
                              <span className="font-mono font-bold text-sky-300 block truncate mt-0.5" title={t.exit_reason}>
                                {t.exit_reason === "RATCHET_LOCK" ? "Ratchet Lock (+80pt)" : (t.exit_reason || "Holding")}
                              </span>
                              <span className="text-[10px] text-muted-foreground block mt-0.5">
                                Fees: {fmtRs(t.charges_rs || 0)}
                              </span>
                            </div>
                          </div>
                        </div>
                      )
                    })
                  ) : (
                    <div className="p-4 text-center text-xs text-muted-foreground bg-muted/20 rounded-lg">
                      No option trades executed on this date.
                    </div>
                  )}
                </div>
              </div>

              {/* Paper Trades Quick Switcher on the Right */}
              {allTrades.length > 0 && (
                <div className="rounded-xl border border-border/80 bg-card/90 shadow-2xs overflow-hidden flex flex-col">
                  <div className="flex items-center justify-between px-3.5 py-2.5 bg-muted/20 border-b border-border/40">
                    <span className="text-xs font-bold text-foreground">
                      Paper Trades Quick Switcher
                    </span>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {allTrades.length} trades
                    </span>
                  </div>
                  <div className="p-2 flex flex-col gap-1.5 max-h-[380px] overflow-y-auto">
                    {allTrades.map((at, idx) => {
                      const isSel = at.date === date
                      const isCall = at.side === "CALL" || at.side === "LONG" || at.side === "CE"
                      const optPts = at.sell_price > 0 ? at.sell_price - at.buy_price : 0
                      return (
                        <div
                          key={idx}
                          onClick={() => {
                            onPick?.(at.date)
                            ref.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                          }}
                          className={cn(
                            "p-2.5 rounded-lg border text-xs cursor-pointer transition-all flex items-center justify-between gap-2",
                            isSel
                              ? "bg-primary/10 border-primary shadow-xs ring-1 ring-primary/30"
                              : "bg-card hover:bg-muted/40 border-border/60"
                          )}
                        >
                          <div className="min-w-0 flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <Badge className={cn("text-[9px] font-bold px-1.5 py-0", isCall ? "bg-emerald-600 text-white" : "bg-red-600 text-white")}>
                                {at.side}
                              </Badge>
                              <span className="font-bold text-xs text-foreground font-mono">{at.date}</span>
                              <span className="text-[10px] text-muted-foreground font-mono">{at.entry}</span>
                              {isSel && (
                                <span className="text-[9px] font-bold bg-primary/20 text-primary px-1.5 py-0 rounded">
                                  Viewing
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] font-mono text-muted-foreground truncate">
                              {at.option}
                            </div>
                            {at.sell_price > 0 && (
                              <div className={cn("text-[10px] font-mono font-semibold", optPts >= 0 ? "text-emerald-400" : "text-red-400")}>
                                {optPts >= 0 ? "+" : ""}{optPts.toFixed(1)} opt pts ({at.nifty_points != null ? `${at.nifty_points >= 0 ? "+" : ""}${at.nifty_points.toFixed(1)} spot` : ""})
                              </div>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <span className={cn("text-xs font-bold font-mono block", pnlClass(at.net_rs))}>
                              {at.net_rs >= 0 ? "+" : ""}{fmtRs(at.net_rs)}
                            </span>
                            <span className="text-[10px] font-mono text-muted-foreground block truncate max-w-[85px]" title={at.exit_reason}>
                              {at.exit_reason === "RATCHET_LOCK" ? "Ratchet Lock" : (at.exit_reason || "Exit")}
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
  )
}

function StrategyTradesTable({
  title,
  trades,
  onPick,
  activeDate,
}: {
  title: string
  trades: (OptionTrade & { charges_rs: number; net_rs: number })[]
  onPick?: (date: string) => void
  activeDate?: string | null
}) {
  const [search, setSearch] = useState("")
  const [sideFilter, setSideFilter] = useState<"ALL" | "CALL" | "PUT">("ALL")

  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      const isCall = t.side === "CALL" || t.side === "LONG" || t.side === "CE"
      if (sideFilter === "CALL" && !isCall) return false
      if (sideFilter === "PUT" && isCall) return false
      if (search.trim()) {
        const q = search.toLowerCase()
        const match =
          t.date.toLowerCase().includes(q) ||
          t.option.toLowerCase().includes(q) ||
          (t.exit_reason || "").toLowerCase().includes(q)
        if (!match) return false
      }
      return true
    })
  }, [trades, search, sideFilter])

  const totalNet = trades.reduce((acc, t) => acc + (t.net_rs || 0), 0)
  const wins = trades.filter((t) => (t.net_rs || 0) > 0).length
  const winRate = trades.length ? Math.round((wins / trades.length) * 100) : 0

  const handleRowClick = (d: string) => {
    onPick?.(d)
    window.scrollTo({ top: 120, behavior: "smooth" })
  }

  return (
    <Card>
      <CardHeader className="pb-3 border-b border-border/40">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <CardTitle>{title}</CardTitle>
              <Badge variant="outline" className="font-mono text-xs font-semibold">
                {trades.length} recorded
              </Badge>
            </div>
            <CardDescription className="mt-0.5">
              Click any row or "Inspect Chart ↗" to view the intraday candlestick chart on left and execution on right.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <Badge variant="outline" className="font-mono text-xs bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
              {wins}W / {trades.length - wins}L ({winRate}% WR)
            </Badge>
            <div className="text-right">
              <span className="text-[10px] text-muted-foreground block font-medium">Cumulative Net</span>
              <span className={cn("text-base font-bold tabular-nums font-mono", pnlClass(totalNet))}>
                {totalNet >= 0 ? "+" : ""}{fmtRs(totalNet)}
              </span>
            </div>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-2">
          <div className="relative w-full sm:w-64">
            <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search date, strike, exit..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-xs bg-muted/30"
            />
          </div>
          <div className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setSideFilter("ALL")}
              className={cn(
                "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                sideFilter === "ALL" ? "bg-background text-foreground shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
              )}
            >
              All ({trades.length})
            </button>
            <button
              type="button"
              onClick={() => setSideFilter("CALL")}
              className={cn(
                "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                sideFilter === "CALL" ? "bg-emerald-500/20 text-emerald-400 shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Calls
            </button>
            <button
              type="button"
              onClick={() => setSideFilter("PUT")}
              className={cn(
                "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                sideFilter === "PUT" ? "bg-rose-500/20 text-rose-400 shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Puts
            </button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-2">
        {filteredTrades.length ? (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date &amp; Action</TableHead>
              <TableHead>Option Contract</TableHead>
              <TableHead>Option Premium</TableHead>
              <TableHead>Spot Index</TableHead>
              <TableHead>Timing &amp; Mode</TableHead>
              <TableHead>Exit Reason</TableHead>
              <TableHead className="text-right">Net P&amp;L</TableHead>
            </TableRow></TableHeader>
            <TableBody>{filteredTrades.map((trade, index) => {
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
                  onClick={() => handleRowClick(trade.date)}
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
            })}</TableBody>
          </Table>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">No paper trades match the filter.</p>
        )}
      </CardContent>
    </Card>
  )
}

export function PaperPage() {
  const [strategy, setStrategy] = useState<"trend_runner" | "sensex_runner" | "all">("trend_runner")
  const [picked, setPicked] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const handleSyncToGit = async () => {
    setSyncing(true)
    try {
      const res = await postJSON<{ ok: boolean; message?: string }>("/api/sync-trades", {})
      if (res.ok) {
        toast.success("Trade logs synced to GitHub!", {
          description: res.message || "Pushed to origin/master"
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

  const pageHeader = (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl sm:text-2xl font-black tracking-tight text-foreground">Paper Trading &amp; Forward Test</h1>
          <Badge className="bg-emerald-600 text-white font-mono text-[10px] font-bold">
            Automated
          </Badge>
        </div>
        <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
          Real-time broker order simulation · Interactive intraday chart on left and execution on right.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleSyncToGit}
          disabled={syncing}
          className="text-xs font-semibold gap-1.5 h-8 cursor-pointer shadow-xs hover:bg-muted/60"
          title="Commit and push all today's trade records and signal logs to GitHub origin/master"
        >
          {syncing ? <RefreshCw className="size-3.5 animate-spin text-primary" /> : <GitCommit className="size-3.5 text-emerald-500" />}
          {syncing ? "Backing up..." : "Sync to GitHub"}
        </Button>
      </div>
    </div>
  )

  const trendRunner = usePoll<PaperReport>(strategy === "trend_runner" ? "/api/paper-report?strategy=trend_runner" : null, 30000)
  const sensexRunner = usePoll<PaperReport>(strategy === "sensex_runner" ? "/api/paper-report?strategy=sensex_runner" : null, 30000)
  const capital = usePoll<CapitalReport>(strategy === "all" ? "/api/capital-report" : null, 30000)

  const paperTabs = (
    <Tabs
      value={strategy}
      onValueChange={(val) => {
        setPicked(null)
        setStrategy(val as "trend_runner" | "sensex_runner" | "all")
      }}
    >
      <TabsList className="bg-muted/60 p-1 rounded-lg">
        <TabsTrigger value="trend_runner" className="font-semibold text-xs sm:text-sm">
          NIFTY 50
        </TabsTrigger>
        <TabsTrigger value="sensex_runner" className="font-semibold text-xs sm:text-sm">
          SENSEX
        </TabsTrigger>
        <TabsTrigger value="all" className="font-semibold text-xs sm:text-sm">
          Combined Portfolio
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )

  if (strategy === "all") {
    if (capital.error) return <p className="text-sm text-red-500">Capital report failed: {capital.error}</p>
    if (capital.loading || !capital.data) return <Skeleton className="h-150 w-full" />
    const { summary } = capital.data
    const selectedDay = capital.data.daily.find((day) => day.date === picked)
    const selectedTrades = selectedDay
      ? capital.data.trades.filter((trade) => trade.date === selectedDay.date)
      : []

    return (
      <div className="flex flex-col gap-5">
        {pageHeader}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          {paperTabs}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground font-medium">Net P&amp;L:</span>
            <span className={cn("font-bold font-mono", pnlClass(summary.net_rs))}>
              {summary.net_rs >= 0 ? "+" : ""}{fmtRs(summary.net_rs)}
            </span>
          </div>
        </div>

        <div className="grid max-w-lg grid-cols-2 gap-3">
          <StatCard label="Starting capital" value={fmtRs(summary.starting_capital)} />
          <StatCard label="Ending capital" value={fmtRs(summary.ending_capital)} className={pnlClass(summary.net_rs)} />
        </div>

        {selectedDay && (
          <CapitalDayPanel
            date={selectedDay.date}
            trades={selectedTrades as any}
            allTrades={capital.data.trades as any}
            onPick={setPicked}
            onClose={() => setPicked(null)}
            strategy="all"
          />
        )}

        <div className="grid gap-4 xl:grid-cols-12 items-start">
          <div className="xl:col-span-8">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-bold">Daily Capital Net P&amp;L</CardTitle>
                <CardDescription className="text-xs">Consolidated returns across all strategies</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={capital.data.daily}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="date" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(value) => `${value}`} />
                      <Tooltip contentStyle={{ background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(value: any) => [`${fmtRs(Number(value))}`, "Daily Net"]} />
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
            <CardTitle className="text-sm font-bold">Session Calendar</CardTitle>
            <CardDescription className="text-xs">Click any day to load executed trades</CardDescription>
          </CardHeader>
          <CardContent>
            <PnlCalendar daily={capital.data.daily.map((day) => ({ ...day, value: day.net_rs }))} format={fmtRs} onPick={setPicked} />
          </CardContent>
        </Card>
      </div>
    )
  }

  const selectedReport = strategy === "sensex_runner" ? sensexRunner : trendRunner
  const loading = selectedReport.loading
  const error = selectedReport.error
  const data = selectedReport.data

  if (error) return <p className="text-sm text-red-500">Paper report failed: {error}</p>
  if (loading || !data) return <Skeleton className="h-150 w-full" />

  const s = data.summary
  const curve = [
    { label: "start", equity: 0, drawdown: 0 },
    ...data.trades.map((trade) => ({ label: `${trade.date} ${trade.entry} ${trade.side}`, equity: trade.equity, drawdown: trade.drawdown })),
  ]
  const latestTradeDate = data?.trades?.length ? data.trades[data.trades.length - 1].date : "2026-11-17"
  const activeDate = picked || latestTradeDate

  return (
    <div className="flex flex-col gap-5">
      {/* 1. Header Hub */}
      {pageHeader}

      {/* Strategy Switcher with Live Session Summary Chips */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {paperTabs}
        {s.trades > 0 && (
          <div className="flex items-center gap-2 flex-wrap text-xs bg-muted/40 px-3 py-1.5 rounded-lg border border-border/50">
            <span className="text-muted-foreground font-semibold">Active Session:</span>
            <Badge variant="outline" className="font-mono font-bold border-primary/40 text-primary bg-primary/10">
              {activeDate}
            </Badge>
            <span className="text-muted-foreground/30">·</span>
            <span className="text-muted-foreground font-semibold">Cumulative Net:</span>
            <span className={cn("font-bold font-mono text-sm", pnlClass(s.net_rs))}>
              {s.net_rs >= 0 ? "+" : ""}{fmtRs(s.net_rs)}
            </span>
            <span className="text-muted-foreground/30">·</span>
            <span className="text-muted-foreground font-semibold">Win Rate:</span>
            <span className="font-bold font-mono text-emerald-400">{s.win_rate_pct}%</span>
          </div>
        )}
      </div>

      {!s.trades ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            {strategy === "sensex_runner"
              ? "No Sensex Trend Runner paper trades recorded yet for today."
              : "No Nifty Trend Runner paper trades recorded yet for today."}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 2. PRIMARY WORKSPACE: INTRADAY TERMINAL (CHART ON LEFT, TRADES ON RIGHT) */}
          <CapitalDayPanel
            date={activeDate}
            trades={data.trades.filter((t) => t.date === activeDate)}
            allTrades={data.trades}
            onPick={setPicked}
            onClose={() => setPicked(null)}
            strategy={strategy}
            isDefaultSession={!picked}
          />

          {/* 3. PERFORMANCE KPIS */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <StatCard label="Net P&L" value={fmtRs(s.net_rs)} className={pnlClass(s.net_rs)} hint={`gross ${fmtRs(s.gross_rs)} · charges ${fmtRs(s.charges_rs)}`} />
            <StatCard label="Trades" value={s.trades} hint={`${s.wins} W · ${s.losses} L · ${s.winning_days}/${s.days} green days`} />
            <StatCard label="Win rate (net)" value={`${s.win_rate_pct}%`} />
            <StatCard label="Avg win / loss" value={<span className="text-lg">{fmtRs(s.avg_win_rs)} / {fmtRs(s.avg_loss_rs)}</span>} />
            <StatCard label="Max drawdown" value={fmtRs(s.max_drawdown_rs)} className="text-red-500" />
            <StatCard label="Avg net / trade" value={fmtRs(s.net_rs / s.trades)} className={pnlClass(s.net_rs)} />
          </div>

          {/* 4. EQUITY GROWTH & STREAKS */}
          <div className="grid gap-4 xl:grid-cols-12 items-start">
            <div className="xl:col-span-8 flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-bold">Equity Curve</CardTitle>
                    <CardDescription className="text-xs">Cumulative Net P&L (₹) & Drawdown</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="h-60">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={curve}>
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
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-bold">Daily Distribution</CardTitle>
                    <CardDescription className="text-xs">Per-session Net Rupee P&L</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="h-60">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={data.daily}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                          <XAxis dataKey="date" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
                          <YAxis stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} />
                          <Tooltip contentStyle={{ background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(v: any) => [`${fmtRs(Number(v))}`, "Net"]} />
                          <Bar dataKey="net_rs" radius={[4, 4, 0, 0]}>
                            {data.daily.map((m, i) => (
                              <Cell key={i} fill={m.net_rs >= 0 ? "#10b981" : "#ef4444"} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            <div className="xl:col-span-4">
              <StrategyStreakSummary
                title={
                  strategy === "sensex_runner"
                    ? "Sensex Streaks & Recovery"
                    : "Nifty Streaks & Recovery"
                }
                description={
                  strategy === "sensex_runner"
                    ? "Consecutive winning/losing days, recovery time in days, and daily expectancy."
                    : "Consecutive winning/losing days, recovery time in days, and daily expectancy."
                }
                daily={data.daily.map((d) => ({ date: d.date, value: d.net_rs, trades: d.trades }))}
                unit="rs"
              />
            </div>
          </div>

          {/* 5. PNL CALENDAR */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold">Session Calendar</CardTitle>
              <CardDescription className="text-xs">
                Click any day to load that session into the terminal chart on left and trade execution on right.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PnlCalendar daily={data.daily.map((d) => ({ ...d, value: d.net_rs }))} format={fmtRs} onPick={setPicked} />
            </CardContent>
          </Card>

          {/* 6. COMPREHENSIVE HISTORICAL TRADE LEDGER */}
          <StrategyTradesTable
            title={
              strategy === "sensex_runner"
                ? "Sensex Trend Runner Paper Trade Ledger"
                : "Nifty Trend Runner Paper Trade Ledger"
            }
            trades={data.trades}
            onPick={setPicked}
            activeDate={activeDate}
          />
        </>
      )}
    </div>
  )
}

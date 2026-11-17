import { useEffect, useRef, useState } from "react"
import { GitCommit, RefreshCw, ShieldCheck, X, Zap } from "lucide-react"
import { toast } from "sonner"
import { DayDetail, FillsTable } from "@/components/day-detail"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatCard } from "@/components/common"
import { PnlCalendar } from "@/components/pnl-calendar"
import { StrategyStreakSummary } from "@/components/strategy-streak-summary"
import { fmtNum, fmtRs, optionPaperTradeToFill, pnlClass, postJSON, usePoll, type CapitalReport, type KeyLevelReport, type OptionPaperTrade, type OptionTrade, type PaperReport } from "@/lib/api"
import { cn } from "@/lib/utils"

const axis = { stroke: "var(--muted-foreground)", fontSize: 11, tickLine: false, axisLine: false }
const tooltip = {
  contentStyle: { background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "var(--muted-foreground)" },
}


export function _CapitalCurve({ report }: { report: CapitalReport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Equity curve (net ₹)</CardTitle>
        <CardDescription>Account balance from {fmtRs(report.summary.starting_capital)}; lower curve shows drawdown.</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={report.curve} syncId="paper">
            <defs>
              <linearGradient id="peq" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" hide />
            <YAxis {...axis} width={82} domain={["dataMin - 500", "dataMax + 500"]} tickFormatter={(value) => fmtRs(Number(value))} />
            <Tooltip {...tooltip} formatter={(value) => [fmtRs(Number(value)), "Equity"]} />
            <Area type="linear" dataKey="equity" stroke="#10b981" strokeWidth={2} fill="url(#peq)" />
          </AreaChart>
        </ResponsiveContainer>
        <ResponsiveContainer width="100%" height={140}>
          <AreaChart data={report.curve} syncId="paper">
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" {...axis} tickFormatter={(label: string) => label === "Start" ? label : label.slice(5)} />
            <YAxis {...axis} width={82} tickFormatter={(value) => fmtRs(Number(value))} />
            <Tooltip {...tooltip} formatter={(value) => [fmtRs(Number(value)), "Drawdown"]} />
            <Area type="stepAfter" dataKey="drawdown" stroke="#ef4444" fill="#ef4444" fillOpacity={0.25} />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}

function CapitalDayPanel({ date, trades, onClose, strategy = "all" }: {
  date: string
  trades: PaperReport["trades"]
  onClose: () => void
  strategy?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }) }, [date])
  const total = trades.reduce((sum, trade) => sum + trade.net_rs, 0)

  return (
    <div ref={ref} className="scroll-mt-20">
      <Card>
        <CardHeader>
          <CardTitle>
            {strategy === "trend_runner"
              ? "Nifty Trend Runner paper trades"
              : strategy === "sensex_runner"
              ? "Sensex Trend Runner paper trades"
              : strategy === "sensex_key_levels"
              ? "Sensex Key Levels S&R paper trades"
              : strategy === "nifty_key_levels"
              ? "Nifty Key Levels S&R paper trades"
              : strategy === "compression_scalp"
              ? "Micro Scalper paper trades"
              : "Combined paper trades"}
          </CardTitle>
          <CardDescription>Funded entries · net after estimated charges</CardDescription>
          <CardAction className="flex items-center gap-1">
            <span className="min-w-28 text-center text-sm font-medium tabular-nums">{date}</span>
            <Button variant="ghost" size="icon-sm" aria-label="Close selected day" onClick={onClose}><X /></Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className={cn("border-b pb-3 text-lg font-semibold tabular-nums", pnlClass(total))}>Day net: {fmtRs(total)}</p>
          <DayDetail key={`${date}-${strategy}`} date={date} mode="paper" strategy={strategy} compact chartOnly allowTimeframeSwitch />
          <Table>
            <TableHeader><TableRow>
              <TableHead>Option</TableHead>
              <TableHead>In</TableHead>
              <TableHead>Out</TableHead>
              <TableHead>Trigger → exit</TableHead>
              <TableHead className="text-right">Net P&amp;L</TableHead>
            </TableRow></TableHeader>
            <TableBody>{trades.map((trade, index) => (
              <TableRow key={`${trade.mode}-${trade.option}-${trade.entry}-${index}`} className="bg-transparent hover:bg-muted/20">
                <TableCell>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[10px] font-medium text-white", (trade.side === "CALL" || trade.side === "LONG" || trade.side === "CE") ? "bg-emerald-600" : "bg-red-600")}>{trade.side}</span>
                    <span className="font-semibold">{trade.option}</span>
                    {trade.mode && trade.mode.toUpperCase().includes("LIVE") ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                        <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        LIVE
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[9px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                        PAPER
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {(trade.mode || "").includes("SENSEX")
                      ? "Sensex Trend Runner"
                      : (trade.mode || "").includes("TREND") || (trade.mode || "").includes("RUNNER")
                      ? "Nifty Trend Runner"
                      : (trade.mode || "").includes("HEROZERO")
                      ? "HeroZero"
                      : (trade.mode || "").includes("KEYLEVEL")
                      ? "Key Levels"
                      : (trade.mode || "").includes("SCALP")
                      ? "Micro Scalp (Sniper)"
                      : "Midpoint"} · {trade.qty} qty
                  </div>
                </TableCell>
                <TableCell className="tabular-nums">
                  <div>{trade.entry}</div>
                  <div className="text-xs text-muted-foreground">Buy {fmtRs(trade.buy_price)} · {fmtRs(trade.buy_value_rs)}</div>
                </TableCell>
                <TableCell className="tabular-nums">
                  <div>{trade.exit}</div>
                  <div className="text-xs text-muted-foreground">Sell {fmtRs(trade.sell_price)} · {fmtRs(trade.sell_value_rs)}</div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{trade.exit_reason}</TableCell>
                <TableCell className={cn("text-right font-medium tabular-nums", pnlClass(trade.net_rs))}>
                  {fmtRs(trade.net_rs)}
                  <div className="text-[10px] font-normal text-muted-foreground">gross {fmtRs(trade.pnl_rs)} · fees {fmtRs(trade.charges_rs)}</div>
                </TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function StrategyTradesTable({ title, trades, onPick }: { title: string; trades: (OptionTrade & { charges_rs: number; net_rs: number })[]; onPick?: (date: string) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{trades.length} paper trade(s) · net rupee P&amp;L after estimated charges · click row to open chart.</CardDescription>
      </CardHeader>
      <CardContent>
        {trades.length ? (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Option</TableHead>
              <TableHead>In</TableHead>
              <TableHead>Out</TableHead>
              <TableHead>Exit Reason</TableHead>
              <TableHead className="text-right">Net P&amp;L</TableHead>
            </TableRow></TableHeader>
            <TableBody>{trades.map((trade, index) => (
              <TableRow key={`${trade.date}-${trade.entry}-${index}`} className={cn("bg-transparent hover:bg-muted/20", onPick && "cursor-pointer")} onClick={() => onPick?.(trade.date)}>
                <TableCell className={cn("font-medium tabular-nums", onPick && "text-primary underline-offset-4 hover:underline")}>{trade.date}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[10px] font-medium text-white", (trade.side === "CALL" || trade.side === "LONG" || trade.side === "CE") ? "bg-emerald-600" : "bg-red-600")}>{trade.side}</span>
                    <span className="font-semibold">{trade.option}</span>
                    {trade.mode && trade.mode.toUpperCase().includes("LIVE") ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                        <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        LIVE
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[9px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                        PAPER
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{trade.mode} · {trade.qty} qty</div>
                </TableCell>
                <TableCell className="tabular-nums">
                  <div>{trade.entry} @ {trade.nifty_in}</div>
                  <div className="text-xs text-muted-foreground">Buy {fmtRs(trade.buy_price)}</div>
                </TableCell>
                <TableCell className="tabular-nums">
                  <div>{trade.exit} @ {trade.nifty_out}</div>
                  <div className="text-xs text-muted-foreground">Sell {fmtRs(trade.sell_price)}</div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{trade.exit_reason}</TableCell>
                <TableCell className={cn("text-right font-medium tabular-nums", pnlClass(trade.net_rs))}>
                  {fmtRs(trade.net_rs)}
                  <div className="text-[10px] font-normal text-muted-foreground">gross {fmtRs(trade.pnl_rs)} · fees {fmtRs(trade.charges_rs)}</div>
                </TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">No paper trades recorded yet.</p>
        )}
      </CardContent>
    </Card>
  )
}

function PaperTradeLog({ title, trades }: { title: string; trades: OptionPaperTrade[] }) {
  const fills = trades.map(optionPaperTradeToFill)
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{trades.length} option paper trade(s) · net rupee P&amp;L after estimated charges · strategy and source are shown per trade.</CardDescription></CardHeader>
      <CardContent><FillsTable fills={fills} empty="No paper trades recorded yet." /></CardContent>
    </Card>
  )
}

export function _KeyLevelPaperPanel({ report }: { report: KeyLevelReport }) {
  const [picked, setPicked] = useState<string | null>(null)
  const trades = report.option_paper.trades
  const closed = trades.filter((trade: any) => trade.status === "closed")
  const dailyMap = new Map<string, { date: string; trades: number; value: number }>()
  for (const trade of closed) {
    const day = dailyMap.get(trade.date) ?? { date: trade.date, trades: 0, value: 0 }
    day.trades += 1
    day.value += trade.net_pnl_rs ?? trade.pnl_rs
    dailyMap.set(trade.date, day)
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  const selected = picked ? trades.filter((trade: any) => trade.date === picked) : []
  const summary = report.option_paper.summary

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Key Levels paper P&amp;L</h1>
        <p className="text-sm text-muted-foreground">10-point zone · close-through, two 5-minute holds with a zone retest · next-bar entry · stop at the far zone edge and allow a reverse after stop. Paper option exits use +50 NIFTY points or +30% premium return, then session-close exit.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard label="Net P&amp;L" value={fmtRs(summary.net_pnl_rs)} className={pnlClass(summary.net_pnl_rs)} hint={`gross ${fmtRs(summary.gross_pnl_rs)} · charges ${fmtRs(summary.estimated_charges_rs)}`} />
        <StatCard label="Trades" value={summary.trades} hint={`${summary.wins} W · ${summary.losses} L · ${summary.open_trades} open`} />
        <StatCard label="Win rate" value={`${summary.win_rate_pct}%`} />
        <StatCard label="Average net return" value={`${fmtNum(summary.avg_return_pct)}%`} />
        <StatCard label="Max drawdown" value={fmtRs(summary.max_drawdown_rs)} className="text-red-500" />
        <StatCard label="Today" value={report.today_option_paper.summary.trades} hint={report.capture_running ? "capture running" : "capture stopped"} />
      </div>
      <StrategyStreakSummary
        title="Key Levels Paper Streaks & Recovery"
        description="Consecutive winning/losing days, drawdown recovery duration, and daily performance metrics for Key Levels paper trading."
        daily={daily}
        unit="rs"
      />
      <Card>
        <CardHeader><CardTitle>Calendar (daily net P&amp;L)</CardTitle><CardDescription>Historical option replays and captured paper quotes are included and source-labeled.</CardDescription></CardHeader>
        <CardContent><PnlCalendar daily={daily} format={fmtRs} onPick={setPicked} /></CardContent>
      </Card>
      {picked && (
        <Card>
          <CardHeader>
            <CardTitle>NIFTY intraday chart · {picked}</CardTitle>
            <CardDescription>Full saved session with Key Levels paper entries and exits marked; switch between 1-minute and 5-minute candles.</CardDescription>
          </CardHeader>
          <CardContent>
            <DayDetail key={picked} date={picked} mode="paper" compact chartOnly allowTimeframeSwitch />
          </CardContent>
        </Card>
      )}
      <PaperTradeLog
        title={picked ? `Paper trades · ${picked}` : "Paper trade log"}
        trades={picked ? selected : trades}
      />
    </div>
  )
}

function ActivePaperPositionCard({ symbol, state }: { symbol: string; state: any }) {
  if (!state?.in_position || !state?.active_position) return null
  const pos = state.active_position
  const spot = state.spot || pos.entry_price
  const isLong = pos.side === "LONG" || pos.side === "CALL"
  const ptsDiff = isLong ? (spot - pos.entry_price) : (pos.entry_price - spot)
  const isProfit = ptsDiff >= 0
  const lotSize = symbol.toUpperCase() === "SENSEX" ? 20 : 65
  const lots = (pos.base_lots || 1) + (pos.pyramided ? 1 : 0)
  const estOptPnl = ptsDiff * 0.65 * (lots * lotSize)

  return (
    <Card className="border-emerald-500/40 bg-linear-to-r from-emerald-500/10 via-background to-background shadow-md">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            <span className="font-bold text-sm text-emerald-500 tracking-wide uppercase">
              Live Paper Position Active
            </span>
            <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary border border-primary/20">
              {symbol}
            </span>
            <span className="rounded bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
              {pos.stage || "STAGE1_TREND"}
            </span>
            {pos.side && (
              <span className={`rounded px-2 py-0.5 text-xs font-bold ${isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"}`}>
                {pos.side}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Entry: <strong className="text-foreground">{pos.entry_time} IST</strong></span>
            {pos.last_ratchet && (
              <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 text-xs font-semibold">
                <ShieldCheck className="size-3" /> {pos.last_ratchet} Locked
              </span>
            )}
            {pos.pyramided && (
              <span className="inline-flex items-center gap-1 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30 px-2 py-0.5 text-xs font-semibold">
                <Zap className="size-3" /> Pyramided (2x)
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-0">
        <div>
          <div className="text-[11px] text-muted-foreground font-medium">Contract</div>
          <div className="text-sm font-bold text-foreground mt-0.5">{pos.option}</div>
          <div className="text-[10px] text-muted-foreground">{lots} Lot(s) ({lots * lotSize} qty)</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground font-medium">Entry Spot</div>
          <div className="text-sm font-bold font-mono mt-0.5">{pos.entry_price?.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</div>
          <div className="text-[10px] text-muted-foreground">OR High: {state.or_high}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground font-medium">Current Spot</div>
          <div className="text-sm font-bold font-mono mt-0.5">{spot?.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</div>
          <div className="text-[10px] text-muted-foreground">Peak: {pos.peak_high?.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground font-medium">Running Index Pts</div>
          <div className={`text-base font-extrabold font-mono mt-0.5 ${isProfit ? "text-emerald-500" : "text-rose-500"}`}>
            {isProfit ? "+" : ""}{ptsDiff.toFixed(2)} pts
          </div>
          <div className="text-[10px] text-muted-foreground">Max Fav: +{pos.max_fav?.toFixed(1)} pts</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground font-medium">Trailing Stop Loss</div>
          <div className="text-sm font-bold font-mono text-amber-500 mt-0.5">{pos.current_sl?.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</div>
          <div className="text-[10px] text-emerald-400 font-medium">
            {pos.current_sl > pos.entry_price ? `+${(pos.current_sl - pos.entry_price).toFixed(1)} pt locked` : `-${(pos.entry_price - pos.current_sl).toFixed(1)} pt risk`}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground font-medium">Est. Paper P&L</div>
          <div className={`text-base font-extrabold font-mono mt-0.5 ${estOptPnl >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
            {fmtRs(estOptPnl)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {pos.pyramided ? "⚡ 2 Lots Active" : "1 Base Lot"}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function PaperPage() {
  const [strategy, setStrategy] = useState<"trend_runner" | "sensex_runner" | "all">("trend_runner")
  const [picked, setPicked] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const telemetry = usePoll<any>("/api/strategy-telemetry", 2500)

  const hasAutoSwitchedRef = useRef(false)
  useEffect(() => {
    if (!hasAutoSwitchedRef.current && telemetry.data?.state) {
      if (telemetry.data.state.sensex?.in_position && !telemetry.data.state.nifty?.in_position) {
        setStrategy("sensex_runner")
        hasAutoSwitchedRef.current = true
      }
    }
  }, [telemetry.data])

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
          <h1 className="text-xl font-bold tracking-tight">Trades & Performance</h1>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary border border-primary/20">
            Ledger
          </span>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          Consolidated execution ledger · Real-time broker orders & paper forward testing.
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
        <TabsTrigger value="trend_runner" className="font-medium text-xs sm:text-sm flex items-center gap-1.5">
          <span>NIFTY 50</span>
          {telemetry.data?.state?.nifty?.in_position && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="sensex_runner" className="font-medium text-xs sm:text-sm flex items-center gap-1.5">
          <span>SENSEX</span>
          {telemetry.data?.state?.sensex?.in_position && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="all" className="font-medium text-xs sm:text-sm">
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
      <div className="flex flex-col gap-4">
        {pageHeader}
        {telemetry.data?.state?.sensex?.in_position && (
          <ActivePaperPositionCard symbol="SENSEX" state={telemetry.data.state.sensex} />
        )}
        {telemetry.data?.state?.nifty?.in_position && (
          <ActivePaperPositionCard symbol="NIFTY" state={telemetry.data.state.nifty} />
        )}
        {paperTabs}
        <div className="grid max-w-lg grid-cols-2 gap-3">
          <StatCard label="Starting capital" value={fmtRs(summary.starting_capital)} />
          <StatCard label="Ending capital" value={fmtRs(summary.ending_capital)} className={pnlClass(summary.net_rs)} />
        </div>
        <StrategyStreakSummary
          title="Combined Portfolio Streaks & Recovery"
          description="Aggregated consecutive winning/losing day streaks and drawdown recovery time across funded Midpoint and Trend Runner trades."
          daily={capital.data.daily.map((day) => ({ date: day.date, value: day.net_rs, trades: day.trades }))}
          unit="rs"
        />
        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle>Daily capital P&amp;L</CardTitle>
              <CardDescription>Daily net P&amp;L across strategies</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-70">
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
          <Card>
            <CardHeader>
              <CardTitle>Calendar</CardTitle>
              <CardDescription>Click a day to view executed trades</CardDescription>
            </CardHeader>
            <CardContent>
              <PnlCalendar daily={capital.data.daily.map((day) => ({ ...day, value: day.net_rs }))} format={fmtRs} onPick={setPicked} />
            </CardContent>
          </Card>
        </div>
        {selectedDay && <CapitalDayPanel date={selectedDay.date} trades={selectedTrades as any} onClose={() => setPicked(null)} strategy="all" />}
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

  return (
    <div className="flex flex-col gap-4">
      {pageHeader}

      {telemetry.data?.state?.sensex?.in_position && (
        <ActivePaperPositionCard symbol="SENSEX" state={telemetry.data.state.sensex} />
      )}
      {telemetry.data?.state?.nifty?.in_position && (
        <ActivePaperPositionCard symbol="NIFTY" state={telemetry.data.state.nifty} />
      )}

      {paperTabs}

      {!s.trades ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
          {((strategy === "sensex_runner" && telemetry.data?.state?.sensex?.in_position) ||
            (strategy === "trend_runner" && telemetry.data?.state?.nifty?.in_position)) ? (
            <>
              <div className="flex items-center gap-2 text-emerald-500 font-semibold text-base">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                </span>
                Active Paper Trade Running in Live Market
              </div>
              <p className="max-w-md text-xs text-muted-foreground">
                Position is actively managed live via Apex Duo engine (see live tracking card above). Trade details and final net P&amp;L will be permanently recorded in this historical ledger upon position exit.
              </p>
            </>
          ) : (
            <p>
              {strategy === "sensex_runner"
                ? "No Sensex Trend Runner paper trades recorded yet for today."
                : "No Nifty Trend Runner paper trades recorded yet for today."}
            </p>
          )}
        </CardContent></Card>
      ) : <>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard label="Net P&L" value={fmtRs(s.net_rs)} className={pnlClass(s.net_rs)} hint={`gross ${fmtRs(s.gross_rs)} · estimated charges ${fmtRs(s.charges_rs)}`} />
        <StatCard label="Trades" value={s.trades} hint={`${s.wins} W · ${s.losses} L · ${s.winning_days}/${s.days} green days`} />
        <StatCard label="Win rate (net)" value={`${s.win_rate_pct}%`} />
        <StatCard label="Avg win / loss" value={<span className="text-lg">{fmtRs(s.avg_win_rs)} / {fmtRs(s.avg_loss_rs)}</span>} />
        <StatCard label="Max drawdown" value={fmtRs(s.max_drawdown_rs)} className="text-red-500" />
        <StatCard label="Avg net / trade" value={fmtRs(s.net_rs / s.trades)} className={pnlClass(s.net_rs)} />
      </div>

      <StrategyStreakSummary
        title={
          strategy === "sensex_runner"
            ? "Sensex Trend Runner Paper Streaks & Recovery"
            : "Nifty Trend Runner Paper Streaks & Recovery"
        }
        description={
          strategy === "sensex_runner"
            ? "Consecutive winning/losing days, recovery time in days, and daily expectancy for Sensex Trend Runner paper trading."
            : "Consecutive winning/losing days, recovery time in days, and daily expectancy for Nifty Trend Runner paper trading."
        }
        daily={data.daily.map((d) => ({ date: d.date, value: d.net_rs, trades: d.trades }))}
        unit="rs"
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Equity curve</CardTitle>
            <CardDescription>Cumulative net P&L (₹) and drawdown</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-70">
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
          <CardHeader>
            <CardTitle>Daily P&L</CardTitle>
            <CardDescription>Session net results</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-70">
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

      <Card>
        <CardHeader>
          <CardTitle>Calendar</CardTitle>
          <CardDescription>Daily net P&L. Click a day to view trades.</CardDescription>
        </CardHeader>
        <CardContent>
          <PnlCalendar daily={data.daily.map((d) => ({ ...d, value: d.net_rs }))} format={fmtRs} onPick={setPicked} />
        </CardContent>
      </Card>

      {picked ? (
        <CapitalDayPanel date={picked} trades={data.trades.filter((t) => t.date === picked)} onClose={() => setPicked(null)} strategy={strategy} />
      ) : null}

      <StrategyTradesTable
        title={
          strategy === "sensex_runner"
            ? (picked ? `Sensex Trend Runner paper trades · ${picked}` : "Sensex Trend Runner paper trade log")
            : (picked ? `Nifty Trend Runner paper trades · ${picked}` : "Nifty Trend Runner paper trade log")
        }
        trades={picked ? data.trades.filter((t) => t.date === picked) : data.trades}
        onPick={setPicked}
      />
      </>}
    </div>
  )
}

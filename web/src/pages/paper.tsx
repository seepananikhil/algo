import { useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { DayDetail, DayPanel, FillsTable } from "@/components/day-detail"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatCard } from "@/components/common"
import { PnlCalendar } from "@/components/pnl-calendar"
import { StrategyStreakSummary } from "@/components/strategy-streak-summary"
import { fmtNum, fmtRs, optionPaperTradeToFill, pnlClass, usePoll, type CapitalReport, type KeyLevelReport, type OptionPaperTrade, type OptionTrade, type PaperReport } from "@/lib/api"
import { cn } from "@/lib/utils"

const axis = { stroke: "var(--muted-foreground)", fontSize: 11, tickLine: false, axisLine: false }
const tooltip = {
  contentStyle: { background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "var(--muted-foreground)" },
}

function HeroZeroDayPanel({ date, days, data, onPick, onClose }: {
  date: string
  days: string[]
  data: PaperReport
  onPick: (date: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }) }, [date])
  const idx = days.indexOf(date)
  const previous = idx > 0 ? days[idx - 1] : undefined
  const next = idx >= 0 && idx < days.length - 1 ? days[idx + 1] : undefined
  const trades = data.trades.filter((trade) => trade.date === date)
  const total = trades.reduce((sum, trade) => sum + trade.net_rs, 0)

  return (
    <div ref={ref} className="scroll-mt-20">
      <Card>
        <CardHeader>
          <CardTitle>HeroZero paper trades</CardTitle>
          <CardDescription>
            {trades.some((trade) => trade.mode?.includes("UNVERIFIED"))
              ? "Oct 8 is an unfiltered 1-minute replay: its 15:20 spot quote was stale, so the ±strike filter could not be verified. Entry uses the 15:20 candle open; exit uses the 15:29 candle close (15:30)."
              : "One-lot simulated entries at 15:20, exited at 15:30 using the 15:29 candle close."}
          </CardDescription>
          <CardAction className="flex items-center gap-1">
            <Button variant="outline" size="icon-sm" aria-label="Previous expiry day" disabled={!previous} onClick={() => previous && onPick(previous)}><ChevronLeft /></Button>
            <span className="min-w-28 text-center text-sm font-medium tabular-nums">{date}</span>
            <Button variant="outline" size="icon-sm" aria-label="Next expiry day" disabled={!next} onClick={() => next && onPick(next)}><ChevronRight /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Close day" onClick={onClose}><X /></Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className={cn("border-b pb-3 text-lg font-semibold tabular-nums", pnlClass(total))}>Day net: {fmtRs(total)}</p>
          {trades.length ? (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Option</TableHead>
                <TableHead>In</TableHead>
                <TableHead>Out</TableHead>
                <TableHead>Trigger → exit</TableHead>
                <TableHead className="text-right">Net P&L</TableHead>
              </TableRow></TableHeader>
              <TableBody>{trades.map((trade) => (
                <TableRow key={trade.option} className="bg-transparent hover:bg-muted/20">
                  <TableCell>
                    <div className="flex items-center gap-2"><span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[10px] font-medium text-white", (trade.side === "CALL" || trade.side === "LONG" || trade.side === "CE") ? "bg-emerald-600" : "bg-red-600")}>{trade.side}</span> {trade.option}</div>
                    <div className="text-xs text-muted-foreground">{trade.qty} qty · {trade.mode}</div>
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
          ) : <p className="py-6 text-center text-sm text-muted-foreground">No completed HeroZero entries for this expiry.</p>}
        </CardContent>
      </Card>
    </div>
  )
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
                  <div className="flex items-center gap-2">
                    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[10px] font-medium text-white", (trade.side === "CALL" || trade.side === "LONG" || trade.side === "CE") ? "bg-emerald-600" : "bg-red-600")}>{trade.side}</span>
                    {trade.option}
                  </div>
                  <div className="text-xs text-muted-foreground">{(trade.mode || "").includes("TREND") ? "Trend Catcher" : (trade.mode || "").includes("HEROZERO") ? "HeroZero" : (trade.mode || "").includes("KEYLEVEL") ? "Key Levels" : (trade.mode || "").includes("SCALP") ? "Micro Scalp (Sniper)" : "Midpoint"} · {trade.qty} qty</div>
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
                  <div className="flex items-center gap-2">
                    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[10px] font-medium text-white", (trade.side === "CALL" || trade.side === "LONG" || trade.side === "CE") ? "bg-emerald-600" : "bg-red-600")}>{trade.side}</span>
                    {trade.option}
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

export function PaperPage() {
  const [strategy, setStrategy] = useState<"all" | "trend_runner" | "sensex_runner" | "sensex_key_levels" | "nifty_key_levels" | "hero_zero" | "midpoint">("all")
  const [picked, setPicked] = useState<string | null>(null)
  const trendRunner = usePoll<PaperReport>(strategy === "trend_runner" ? "/api/paper-report?strategy=trend_runner" : null, 30000)
  const sensexRunner = usePoll<PaperReport>(strategy === "sensex_runner" ? "/api/paper-report?strategy=sensex_runner" : null, 30000)
  const sensexKeyLevels = usePoll<PaperReport>(strategy === "sensex_key_levels" ? "/api/paper-report?strategy=sensex_key_levels" : null, 30000)
  const niftyKeyLevels = usePoll<PaperReport>(strategy === "nifty_key_levels" ? "/api/paper-report?strategy=nifty_key_levels" : null, 30000)
  const heroZero = usePoll<PaperReport>(strategy === "hero_zero" ? "/api/paper-report?strategy=hero_zero" : null, 30000)
  const midpoint = usePoll<PaperReport>(strategy === "midpoint" ? "/api/paper-report" : null, 30000)
  const capital = usePoll<CapitalReport>(strategy === "all" ? "/api/capital-report" : null, 30000)

  const topStrategy: "all" | "trend_runner" | "key_levels" | "hero_zero" | "midpoint" =
    strategy === "all"
      ? "all"
      : (strategy === "trend_runner" || strategy === "sensex_runner")
      ? "trend_runner"
      : (strategy === "nifty_key_levels" || strategy === "sensex_key_levels")
      ? "key_levels"
      : strategy === "hero_zero"
      ? "hero_zero"
      : "midpoint"

  const symbolChoice: "NIFTY" | "SENSEX" =
    (strategy === "sensex_runner" || strategy === "sensex_key_levels")
      ? "SENSEX"
      : "NIFTY"

  const handleTopStrategyChange = (top: "all" | "trend_runner" | "key_levels" | "hero_zero" | "midpoint") => {
    setPicked(null)
    if (top === "all" || top === "hero_zero" || top === "midpoint") {
      setStrategy(top as any)
    } else if (top === "trend_runner") {
      setStrategy((symbolChoice === "SENSEX" ? "sensex_runner" : "trend_runner") as any)
    } else if (top === "key_levels") {
      setStrategy((symbolChoice === "SENSEX" ? "sensex_key_levels" : "nifty_key_levels") as any)
    }
  }

  const handleSymbolChange = (sym: "NIFTY" | "SENSEX") => {
    setPicked(null)
    if (topStrategy === "trend_runner") {
      setStrategy((sym === "SENSEX" ? "sensex_runner" : "trend_runner") as any)
    } else if (topStrategy === "key_levels") {
      setStrategy((sym === "SENSEX" ? "sensex_key_levels" : "nifty_key_levels") as any)
    }
  }

  const paperTabs = (
    <div className="flex flex-col gap-2.5">
      <Tabs value={topStrategy} onValueChange={(val) => handleTopStrategyChange(val as any)}>
        <TabsList className="flex flex-wrap gap-1 bg-muted/60 p-1 rounded-lg">
          <TabsTrigger value="all" className="font-medium text-xs sm:text-sm">All</TabsTrigger>
          <TabsTrigger value="trend_runner" className="font-medium text-xs sm:text-sm">Trend Runner</TabsTrigger>
          <TabsTrigger value="key_levels" className="font-medium text-xs sm:text-sm">Key Levels S&R</TabsTrigger>
          <TabsTrigger value="hero_zero" className="font-medium text-xs sm:text-sm">HeroZero</TabsTrigger>
          <TabsTrigger value="midpoint" className="font-medium text-xs sm:text-sm">Midpoint</TabsTrigger>
        </TabsList>
      </Tabs>

      {(topStrategy === "trend_runner" || topStrategy === "key_levels") && (
        <div className="flex items-center gap-2 pl-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mr-1">
            Instrument:
          </span>
          <div className="inline-flex items-center rounded-lg bg-muted/50 p-0.5 border border-border/50">
            <button
              type="button"
              onClick={() => handleSymbolChange("NIFTY")}
              className={cn(
                "px-3 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer",
                symbolChoice === "NIFTY"
                  ? "bg-background text-foreground shadow-xs font-bold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              NIFTY 50
            </button>
            <button
              type="button"
              onClick={() => handleSymbolChange("SENSEX")}
              className={cn(
                "px-3 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer",
                symbolChoice === "SENSEX"
                  ? "bg-background text-foreground shadow-xs font-bold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              SENSEX
            </button>
          </div>
        </div>
      )}
    </div>
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
        <div>
          <h1 className="text-xl font-semibold">Paper P&amp;L</h1>
          <p className="text-sm text-muted-foreground">Combined Midpoint and Trend Runner paper account balance.</p>
        </div>
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

  const selectedReport = strategy === "trend_runner" ? trendRunner : strategy === "sensex_runner" ? sensexRunner : strategy === "sensex_key_levels" ? sensexKeyLevels : strategy === "nifty_key_levels" ? niftyKeyLevels : strategy === "hero_zero" ? heroZero : midpoint
  const loading = selectedReport.loading
  const error = selectedReport.error
  const data = selectedReport.data

  if (error) return <p className="text-sm text-red-500">Paper report failed: {error}</p>
  if (loading || !data) return <Skeleton className="h-150 w-full" />

  const s = data.summary
  const dates = data.daily.map((d) => d.date)
  const curve = [
    { label: "start", equity: 0, drawdown: 0 },
    ...data.trades.map((trade) => ({ label: `${trade.date} ${trade.entry} ${trade.side}`, equity: trade.equity, drawdown: trade.drawdown })),
  ]

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Paper P&L</h1>
        <p className="text-sm text-muted-foreground">
          {strategy === "trend_runner"
            ? "Trend Runner (VIX Runner) Live Paper: Forward paper execution capturing 100+ to 300+ point runs with VIX confluence, 28-pt fixed risk, 3-tier ratchet, and Chandelier trailing stop."
            : strategy === "sensex_key_levels"
            ? "Sensex Key Levels S&R (Fade + Reverse) Live Paper: Forward 1-minute execution at 500-pt strikes with 25-pt SL, 120-pt Target, and 180-pt Reverse Retry."
            : strategy === "nifty_key_levels"
            ? "Nifty Key Levels S&R (Fade + Reverse) Live Paper: Forward 1-minute execution at 500-pt strikes with 10-pt SL, 50-pt Target, 80-pt Reverse Retry, and Inside Day Mother Bar filter."
            : strategy === "hero_zero"
            ? "HeroZero Expiry Paper: 1-lot simulated option entries per contract on expiry days capturing large multi-bagger option expansion."
            : "Midpoint Equilibrium: Paper fills; estimated charges included. Paper fills use LTP and exclude spread/slippage."}
        </p>
      </div>

      {paperTabs}

      {!s.trades ? (
        <Card><CardContent className="py-16 text-center text-sm text-muted-foreground">
          {strategy === "trend_runner"
            ? "No Trend Runner paper trades recorded yet. Run `python trend_runner_paper.py` during market hours or in replay mode."
            : strategy === "sensex_runner"
            ? "No Sensex Trend Runner paper trades recorded yet. Run `python sensex_runner_paper.py`."
            : strategy === "sensex_key_levels"
            ? "No Sensex Key Levels paper trades recorded yet. Run `python sensex_key_levels_paper.py`."
            : strategy === "nifty_key_levels"
            ? "No Nifty Key Levels paper trades recorded yet. Run `python nifty_key_levels_paper.py`."
            : strategy === "hero_zero"
            ? "No completed HeroZero expiry paper trades yet."
            : "No midpoint paper option trades yet."}
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
          strategy === "trend_runner"
            ? "Trend Runner Paper Streaks & Recovery"
            : strategy === "sensex_runner"
            ? "Sensex Trend Runner Paper Streaks & Recovery"
            : strategy === "sensex_key_levels"
            ? "Sensex Key Levels Paper Streaks & Recovery"
            : strategy === "nifty_key_levels"
            ? "Nifty Key Levels Paper Streaks & Recovery"
            : strategy === "hero_zero"
            ? "HeroZero Paper Streaks & Recovery"
            : "Midpoint Paper Streaks & Recovery"
        }
        description={
          strategy === "trend_runner"
            ? "Consecutive winning/losing days, recovery time in days, and daily expectancy for Trend Runner paper trading."
            : strategy === "sensex_runner"
            ? "Consecutive winning/losing days, recovery time in days, and daily expectancy for Sensex Trend Runner paper trading."
            : strategy === "sensex_key_levels"
            ? "Consecutive winning/losing days, recovery time in days, and daily expectancy for Sensex Key Levels paper trading."
            : strategy === "nifty_key_levels"
            ? "Consecutive winning/losing days, recovery time in days, and daily expectancy for Nifty Key Levels paper trading."
            : strategy === "hero_zero"
            ? "Consecutive winning/losing expiries, recovery time, and expectancy for HeroZero paper trading."
            : "Consecutive winning/losing days, recovery time in days, and daily expectancy for Midpoint paper trading."
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

      {strategy === "midpoint" ? (
        <DayPanel date={picked} mode="paper" strategy="midpoint" days={dates} onPick={setPicked} onClose={() => setPicked(null)} allowTimeframeSwitch />
      ) : strategy === "hero_zero" && picked ? (
        <HeroZeroDayPanel date={picked} days={dates} data={data} onPick={setPicked} onClose={() => setPicked(null)} />
      ) : (strategy === "trend_runner" || strategy === "sensex_runner" || strategy === "sensex_key_levels" || strategy === "nifty_key_levels") && picked ? (
        <CapitalDayPanel date={picked} trades={data.trades.filter((t) => t.date === picked)} onClose={() => setPicked(null)} strategy={strategy} />
      ) : null}

      <StrategyTradesTable
        title={
          strategy === "hero_zero"
            ? (picked ? `HeroZero paper trades · ${picked}` : "HeroZero paper trade log")
            : strategy === "trend_runner"
            ? (picked ? `Nifty Trend Runner paper trades · ${picked}` : "Nifty Trend Runner paper trade log")
            : strategy === "sensex_runner"
            ? (picked ? `Sensex Trend Runner paper trades · ${picked}` : "Sensex Trend Runner paper trade log")
            : strategy === "sensex_key_levels"
            ? (picked ? `Sensex Key Levels paper trades · ${picked}` : "Sensex Key Levels paper trade log")
            : strategy === "nifty_key_levels"
            ? (picked ? `Nifty Key Levels paper trades · ${picked}` : "Nifty Key Levels paper trade log")
            : (picked ? `Midpoint paper trades · ${picked}` : "Midpoint paper trade log")
        }
        trades={picked ? data.trades.filter((t) => t.date === picked) : data.trades}
        onPick={setPicked}
      />
      </>}
    </div>
  )
}

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
            {trades.some((trade) => trade.mode.includes("UNVERIFIED"))
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
                    <div className="flex items-center gap-2"><span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[10px] font-medium text-white", trade.side === "CALL" ? "bg-emerald-600" : "bg-red-600")}>{trade.side}</span> {trade.option}</div>
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

function CapitalCurve({ report }: { report: CapitalReport }) {
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
              ? "Trend Catcher paper trades"
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
                    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[10px] font-medium text-white", trade.side === "CALL" ? "bg-emerald-600" : "bg-red-600")}>{trade.side}</span>
                    {trade.option}
                  </div>
                  <div className="text-xs text-muted-foreground">{trade.mode.includes("TREND") ? "Trend Catcher" : trade.mode.includes("HEROZERO") ? "HeroZero" : trade.mode.includes("KEYLEVEL") ? "Key Levels" : trade.mode.includes("SCALP") ? "Micro Scalp (Sniper)" : "Midpoint"} · {trade.qty} qty</div>
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

function StrategyTradesTable({ title, trades }: { title: string; trades: (OptionTrade & { charges_rs: number; net_rs: number })[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{trades.length} paper trade(s) · net rupee P&amp;L after estimated charges.</CardDescription>
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
              <TableRow key={`${trade.date}-${trade.entry}-${index}`} className="bg-transparent hover:bg-muted/20">
                <TableCell className="font-medium tabular-nums">{trade.date}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[10px] font-medium text-white", trade.side === "CALL" ? "bg-emerald-600" : "bg-red-600")}>{trade.side}</span>
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

function KeyLevelPaperPanel({ report }: { report: KeyLevelReport }) {
  const [picked, setPicked] = useState<string | null>(null)
  const trades = report.option_paper.trades
  const closed = trades.filter((trade) => trade.status === "closed")
  const dailyMap = new Map<string, { date: string; trades: number; value: number }>()
  for (const trade of closed) {
    const day = dailyMap.get(trade.date) ?? { date: trade.date, trades: 0, value: 0 }
    day.trades += 1
    day.value += trade.net_pnl_rs ?? trade.pnl_rs
    dailyMap.set(trade.date, day)
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  const selected = picked ? trades.filter((trade) => trade.date === picked) : []
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
  const [strategy, setStrategy] = useState<"all" | "trend_runner" | "midpoint" | "hero_zero" | "key_levels" | "compression_scalp">("all")
  const [picked, setPicked] = useState<string | null>(null)
  const trendRunner = usePoll<PaperReport>(strategy === "trend_runner" ? "/api/paper-report?strategy=trend_runner" : null, 30000)
  const midpoint = usePoll<PaperReport>(strategy === "midpoint" ? "/api/paper-report" : null, 30000)
  const heroZero = usePoll<PaperReport>(strategy === "hero_zero" ? "/api/paper-report?strategy=hero_zero" : null, 30000)
  const scalp = usePoll<PaperReport>(strategy === "compression_scalp" ? "/api/paper-report?strategy=compression_scalp" : null, 30000)
  const capital = usePoll<CapitalReport>(strategy === "all" ? "/api/capital-report" : null, 30000)
  const keyLevelPaper = usePoll<KeyLevelReport>(strategy === "key_levels" ? "/api/backtest?strategy=key_levels" : null, 30000)

  if (strategy === "key_levels") {
    if (keyLevelPaper.error) return <p className="text-sm text-red-500">Key Levels paper report failed: {keyLevelPaper.error}</p>
    if (keyLevelPaper.loading || !keyLevelPaper.data) return <Skeleton className="h-150 w-full" />
    return (
      <div className="flex flex-col gap-4">
        <Tabs value={strategy} onValueChange={(value) => { setStrategy(value as any); setPicked(null) }}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="compression_scalp">Micro Scalper</TabsTrigger>
            <TabsTrigger value="midpoint">Midpoint</TabsTrigger>
            <TabsTrigger value="hero_zero">HeroZero</TabsTrigger>
            <TabsTrigger value="key_levels">Key Levels</TabsTrigger>
          </TabsList>
        </Tabs>
        <KeyLevelPaperPanel report={keyLevelPaper.data} />
      </div>
    )
  }

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
          <p className="text-sm text-muted-foreground">Combined Midpoint, Trend Catcher, Micro Scalper, and HeroZero paper account balance.</p>
        </div>
        <Tabs value={strategy} onValueChange={(value) => { setStrategy(value as any); setPicked(null) }}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="trend_runner">Trend Catcher</TabsTrigger>
            <TabsTrigger value="compression_scalp">Micro Scalper</TabsTrigger>
            <TabsTrigger value="midpoint">Midpoint</TabsTrigger>
            <TabsTrigger value="hero_zero">HeroZero</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="grid max-w-lg grid-cols-2 gap-3">
          <StatCard label="Starting capital" value={fmtRs(summary.starting_capital)} />
          <StatCard label="Ending capital" value={fmtRs(summary.ending_capital)} className={pnlClass(summary.net_rs)} />
        </div>
        <StrategyStreakSummary
          title="Combined Portfolio Streaks & Recovery"
          description="Aggregated consecutive winning/losing day streaks and drawdown recovery time across funded Midpoint, HeroZero, Key Levels, and Micro Scalper trades."
          daily={capital.data.daily.map((day) => ({ date: day.date, value: day.net_rs, trades: day.trades }))}
          unit="rs"
        />
        <CapitalCurve report={capital.data} />
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Daily net P&amp;L</CardTitle>
              <CardDescription>Click a bar to open that day’s funded trades.</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={capital.data.daily} onClick={(event) => event?.activeLabel && setPicked(String(event.activeLabel))}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" {...axis} tickFormatter={(date: string) => date.slice(5)} />
                  <YAxis {...axis} width={82} tickFormatter={(value) => fmtRs(Number(value))} />
                  <Tooltip {...tooltip} cursor={{ fill: "var(--muted)" }} formatter={(value) => [fmtRs(Number(value)), "Net"]} />
                  <Bar dataKey="net_rs" radius={[4, 4, 0, 0]} className="cursor-pointer">
                    {capital.data.daily.map((day) => <Cell key={day.date} fill={day.net_rs >= 0 ? "#10b981" : "#ef4444"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Calendar (daily net P&amp;L)</CardTitle>
              <CardDescription>Only trades affordable from the starting capital are included.</CardDescription>
            </CardHeader>
            <CardContent>
              <PnlCalendar
                daily={capital.data.daily.map((day) => ({ date: day.date, trades: day.trades, value: day.net_rs }))}
                format={fmtRs}
                onPick={setPicked}
              />
            </CardContent>
          </Card>
        </div>
        {selectedDay && <CapitalDayPanel date={selectedDay.date} trades={selectedTrades} onClose={() => setPicked(null)} strategy="all" />}
      </div>
    )
  }

  const selectedReport = strategy === "trend_runner" ? trendRunner : strategy === "hero_zero" ? heroZero : strategy === "compression_scalp" ? scalp : midpoint
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
            ? "Trend Catcher (VIX Runner) Live Paper: Forward paper execution capturing 100+ to 300+ point runs with VIX confluence, 28-pt fixed risk, 3-tier ratchet, and Chandelier trailing stop."
            : strategy === "compression_scalp"
            ? "Micro Scalper (Sniper) Live Paper: Forward paper execution during market hours with live prices and entries/exits. Historical backtest is available under Backtest → Sniper Scalp."
            : strategy === "midpoint"
            ? "Paper fills; estimated charges included. Paper fills use LTP and exclude spread/slippage."
            : "One-lot simulated entries per contract; fresh 15:20 spot required, with an unfiltered stale-spot replay on Oct 8."}
        </p>
      </div>

      <Tabs value={strategy} onValueChange={(value) => { setStrategy(value as any); setPicked(null) }}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="trend_runner">Trend Catcher</TabsTrigger>
          <TabsTrigger value="compression_scalp">Micro Scalper</TabsTrigger>
          <TabsTrigger value="midpoint">Midpoint</TabsTrigger>
          <TabsTrigger value="hero_zero">HeroZero</TabsTrigger>
        </TabsList>
      </Tabs>

      {!s.trades ? (
        <Card><CardContent className="py-16 text-center text-sm text-muted-foreground">
          {strategy === "trend_runner"
            ? "No Trend Catcher paper trades recorded yet. Run `python trend_runner_paper.py` during market hours or in replay mode."
            : strategy === "hero_zero"
            ? "No completed HeroZero expiry paper trades yet."
            : strategy === "compression_scalp"
            ? "No live market paper trades recorded yet. Real-time paper entries and exits will log here during tomorrow's live market sessions (09:20–11:30 & 13:15–15:05 IST). Historical performance is available under Backtest → Sniper Scalp."
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
        title={strategy === "trend_runner" ? "Trend Catcher Paper Streaks & Recovery" : strategy === "compression_scalp" ? "Micro Scalper Paper Streaks & Recovery" : strategy === "midpoint" ? "Midpoint Paper Streaks & Recovery" : "HeroZero Paper Streaks & Recovery"}
        description={
          strategy === "trend_runner"
            ? "Consecutive winning/losing days, recovery time in days, and daily expectancy for Trend Catcher (VIX Runner) paper trading."
            : strategy === "compression_scalp"
            ? "Consecutive winning/losing days, recovery time in days, and daily expectancy for Micro Scalper paper trading."
            : strategy === "midpoint"
            ? "Consecutive winning/losing days, recovery time in days, and daily expectancy for Midpoint paper trading."
            : "Consecutive winning/losing expiries and recovery time in days for HeroZero paper trading."
        }
        daily={data.daily.map((d) => ({ date: d.date, value: d.net_rs, trades: d.trades }))}
        unit="rs"
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Equity curve (net ₹)</CardTitle>
            <CardDescription>Cumulative net P&amp;L and drawdown, trade by trade</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={curve} syncId="paper">
                <defs>
                  <linearGradient id="peq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis {...axis} width={60} />
                <Tooltip {...tooltip} formatter={(v) => [fmtRs(Number(v)), "Equity"]} />
                <Area type="linear" dataKey="equity" stroke="#10b981" strokeWidth={2} fill="url(#peq)" />
              </AreaChart>
            </ResponsiveContainer>
            <ResponsiveContainer width="100%" height={110}>
              <AreaChart data={curve} syncId="paper">
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis {...axis} width={60} />
                <Tooltip {...tooltip} formatter={(v) => [fmtRs(Number(v)), "Drawdown"]} />
                <Area type="stepAfter" dataKey="drawdown" stroke="#ef4444" fill="#ef4444" fillOpacity={0.25} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Daily net P&L</CardTitle>
            <CardDescription>Click a bar to open the day</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={360}>
              <BarChart data={data.daily} onClick={(e) => e?.activeLabel && setPicked(String(e.activeLabel))}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" {...axis} tickFormatter={(d: string) => d.slice(5)} />
                <YAxis {...axis} width={55} />
                <Tooltip {...tooltip} cursor={{ fill: "var(--muted)" }} formatter={(v) => [fmtRs(Number(v)), "Net"]} />
                <Bar dataKey="net_rs" radius={[4, 4, 0, 0]} className="cursor-pointer">
                  {data.daily.map((d) => (
                    <Cell key={d.date} fill={d.net_rs >= 0 ? "#10b981" : "#ef4444"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Calendar (daily net P&L)</CardTitle>
          <CardDescription>Green = profit day, red = loss day. Click a day to open it.</CardDescription>
        </CardHeader>
        <CardContent>
          <PnlCalendar daily={data.daily.map((d) => ({ ...d, value: d.net_rs }))} format={fmtRs} onPick={setPicked} />
        </CardContent>
      </Card>

      {strategy === "midpoint" ? (
        <DayPanel date={picked} mode="paper" strategy="midpoint" days={dates} onPick={setPicked} onClose={() => setPicked(null)} allowTimeframeSwitch />
      ) : strategy === "hero_zero" && picked ? (
        <HeroZeroDayPanel date={picked} days={dates} data={data} onPick={setPicked} onClose={() => setPicked(null)} />
      ) : (strategy === "compression_scalp" || strategy === "trend_runner") && picked ? (
        <CapitalDayPanel date={picked} trades={data.trades.filter((t) => t.date === picked)} onClose={() => setPicked(null)} strategy={strategy} />
      ) : null}

      <StrategyTradesTable
        title={
          strategy === "trend_runner"
            ? (picked ? `Trend Catcher paper trades · ${picked}` : "Trend Catcher paper trade log")
            : strategy === "compression_scalp"
            ? (picked ? `Micro Scalper paper trades · ${picked}` : "Micro Scalper paper trade log")
            : (picked ? `Paper trades · ${picked}` : "Paper trade log")
        }
        trades={picked ? data.trades.filter((t) => t.date === picked) : data.trades}
      />
      </>}
    </div>
  )
}

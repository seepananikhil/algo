import { useMemo, useState } from "react"
import { DayPanel } from "@/components/day-detail"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SideBadge, StatCard } from "@/components/common"
import { PnlCalendar } from "@/components/pnl-calendar"
import { cn } from "@/lib/utils"
import { fmtNum, fmtPts, fmtRs, pnlClass, prettyReason, usePoll, type Backtest, type KeyLevelReport, type KeyLevelTrade, type OptionPaperTrade } from "@/lib/api"

/** Backtest restricted to one year ("all" = everything), with equity/drawdown restarting at 0. */
function forYear(data: Backtest, year: string): Backtest {
  if (year === "all") return data
  let equity = 0
  let peak = 0
  const trades = data.trades.filter((t) => t.date.startsWith(year)).map((t) => {
    equity += t.pnl_points
    peak = Math.max(peak, equity)
    return { ...t, equity, drawdown: equity - peak }
  })
  const daily = data.daily.filter((d) => d.date.startsWith(year))
  const reasons = new Map<string, number>()
  trades.forEach((t) => reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1))
  const pts = trades.map((t) => t.pnl_points)
  const wins = pts.filter((p) => p > 0).length
  const total = pts.reduce((a, p) => a + p, 0)
  return {
    summary: {
      ...data.summary,
      from: daily[0]?.date ?? "",
      to: daily[daily.length - 1]?.date ?? "",
      days: daily.length,
      trades: trades.length,
      wins,
      losses: pts.filter((p) => p < 0).length,
      win_rate_pct: trades.length ? Math.round((10000 * wins) / trades.length) / 100 : 0,
      total_points: total,
      avg_points: trades.length ? total / trades.length : 0,
      max_drawdown: Math.min(0, ...trades.map((t) => t.drawdown)),
      best: pts.length ? Math.max(...pts) : 0,
      worst: pts.length ? Math.min(...pts) : 0,
    },
    trades,
    daily,
    monthly: data.monthly.filter((m) => m.month.startsWith(year)),
    exit_reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  }
}

const axis = { stroke: "var(--muted-foreground)", fontSize: 11, tickLine: false, axisLine: false }
const tooltip = {
  contentStyle: { background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "var(--muted-foreground)" },
}

function KeyLevelTradeTable({ title, trades, onPick }: { title: string; trades: KeyLevelTrade[]; onPick?: (date: string) => void }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{trades.length} trades · NIFTY spot points, not option P&amp;L.</CardDescription></CardHeader>
      <CardContent>
        {trades.length ? (
          <div className="max-h-[520px] overflow-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Date</TableHead><TableHead>Side / level</TableHead><TableHead>Break → confirm</TableHead>
                <TableHead>Entry</TableHead><TableHead>SL / target</TableHead><TableHead>Exit</TableHead><TableHead className="text-right">Points</TableHead>
              </TableRow></TableHeader>
              <TableBody>{trades.slice().reverse().map((trade, index) => (
                <TableRow key={`${trade.source ?? "replay"}-${trade.date}-${trade.entry_time}-${trade.level}-${index}`} className={onPick ? "cursor-pointer" : undefined} onClick={() => onPick?.(trade.date)}>
                  <TableCell className="tabular-nums">{trade.date}</TableCell>
                  <TableCell><div><SideBadge side={trade.side} /> <span className="ml-1">{fmtNum(trade.level)}</span></div><div className="text-xs text-muted-foreground">{trade.exit_reason}</div></TableCell>
                  <TableCell className="tabular-nums">{trade.break_time} → {trade.confirm_time}</TableCell>
                  <TableCell className="tabular-nums">{trade.entry_time}<div className="text-xs text-muted-foreground">{fmtNum(trade.entry_price)}</div></TableCell>
                  <TableCell className="tabular-nums"><div>SL {fmtNum(trade.stop)}</div><div className="text-xs text-muted-foreground">TGT {fmtNum(trade.target)}</div></TableCell>
                  <TableCell className="tabular-nums">{trade.exit_time || "—"}<div className="text-xs text-muted-foreground">{trade.exit_price == null ? "—" : fmtNum(trade.exit_price)}</div></TableCell>
                  <TableCell className={cn("text-right font-medium tabular-nums", pnlClass(trade.pnl_points))}>{trade.status === "open" ? "—" : fmtPts(trade.pnl_points)}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
        ) : <p className="py-8 text-center text-sm text-muted-foreground">No Key Levels trades for this view.</p>}
      </CardContent>
    </Card>
  )
}

function OptionPaperTable({ title, trades }: { title: string; trades: OptionPaperTrade[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{trades.length} paper trade(s) · one lot · no broker orders.</CardDescription></CardHeader>
      <CardContent>
        {trades.length ? (
          <div className="max-h-[520px] overflow-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Source / option</TableHead><TableHead>Entry</TableHead><TableHead>Capital</TableHead>
                <TableHead>Exit</TableHead><TableHead className="text-right">Net P&amp;L / ROI</TableHead>
              </TableRow></TableHeader>
              <TableBody>{trades.slice().reverse().map((trade, index) => (
                <TableRow key={`${trade.strategy}-${trade.date}-${trade.entry_time}-${index}`}>
                  <TableCell>
                    <div className="font-medium">{trade.strategy === "midpoint" ? "Midpoint" : "Key Levels"} · {trade.side}</div>
                    <div className="text-xs text-muted-foreground">{trade.source === "historical_option_replay" ? "Historical option replay" : "Captured paper quote"}</div>
                    <div className="text-xs text-muted-foreground">{trade.symbol} · {trade.qty} qty · {trade.expiry}</div>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    <div>{trade.entry_time}</div>
                    <div className="text-xs text-muted-foreground">Spot {fmtNum(trade.spot_entry)} · Option {fmtNum(trade.option_entry)}</div>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    <div>{fmtRs(trade.capital_used)}</div>
                    <div className="text-xs text-muted-foreground">Spot tgt {fmtNum(trade.spot_target)}</div>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    <div>{trade.exit_time || "Open"}</div>
                    <div className="text-xs text-muted-foreground">{trade.exit_option == null ? trade.reason : `Option ${fmtNum(trade.exit_option)} · ${trade.reason}`}</div>
                  </TableCell>
                          <TableCell className={cn("text-right font-medium tabular-nums", pnlClass(trade.net_pnl_rs ?? trade.pnl_rs))}>
                            {trade.status === "open" ? "Open" : fmtRs(trade.net_pnl_rs ?? trade.pnl_rs)}
                            {trade.status === "closed" && <div className="text-xs font-normal">net {fmtNum(trade.net_return_pct ?? trade.return_pct)}% · fees {fmtRs(trade.charges_rs ?? 0)}</div>}
                  </TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
        ) : <p className="py-8 text-center text-sm text-muted-foreground">No one-lot option paper trades recorded yet.</p>}
      </CardContent>
    </Card>
  )
}

function KeyLevelsBacktest({ report, onStrategy }: { report: KeyLevelReport; onStrategy: (value: "midpoint" | "key_levels") => void }) {
  const availableYears = [...new Set(report.backtest.daily.map((day) => day.date.slice(0, 4)))].sort()
  const [yearPick, setYearPick] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const year = yearPick ?? availableYears[availableYears.length - 1] ?? "all"
  const daily = report.backtest.daily.filter((day) => year === "all" || day.date.startsWith(year))
  const trades = report.backtest.trades.filter((trade) => trade.status === "closed" && (year === "all" || trade.date.startsWith(year)))
  const points = trades.map((trade) => trade.pnl_points)
  const wins = points.filter((point) => point > 0).length
  const total = points.reduce((sum, point) => sum + point, 0)
  let equity = 0
  let peak = 0
  let maxDrawdown = 0
  const curve = [{ label: "start", equity: 0, drawdown: 0 }, ...trades.map((trade) => {
    equity += trade.pnl_points
    peak = Math.max(peak, equity)
    maxDrawdown = Math.min(maxDrawdown, equity - peak)
    return { label: `${trade.date} ${trade.entry_time}`, equity, drawdown: equity - peak }
  })]
  const monthlyMap = new Map<string, number>()
  for (const day of daily) {
    const month = day.date.slice(0, 7)
    monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + day.net_points)
  }
  const monthly = [...monthlyMap].map(([month, value]) => ({ month, value }))
  const selected = picked ? trades.filter((trade) => trade.date === picked) : []
  const reasons = new Map<string, number>()
  trades.forEach((trade) => reasons.set(trade.exit_reason, (reasons.get(trade.exit_reason) ?? 0) + 1))
  const todayTrades = report.today_replay.trades.filter((trade) => trade.date === report.today)
  const todayPaper = report.today_paper.trades.filter((trade) => trade.date === report.today)
  const optionPaper = report.option_paper.summary

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Key Levels Backtest</h1>
          <p className="text-sm text-muted-foreground">10-point zone · close-through, 2 five-minute holds with a zone retest · next-bar entry · stop at far zone edge · reverse after stop. +50-point target · 30-minute/session exit. Spot points only.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Tabs value="key_levels" onValueChange={(value) => onStrategy(value as "midpoint" | "key_levels")}>
            <TabsList><TabsTrigger value="midpoint">Midpoint</TabsTrigger><TabsTrigger value="key_levels">Key Levels</TabsTrigger></TabsList>
          </Tabs>
          <Tabs value={year} onValueChange={(value) => { setYearPick(value); setPicked(null) }}>
            <TabsList><TabsTrigger value="all">All</TabsTrigger>{availableYears.map((value) => <TabsTrigger key={value} value={value}>{value}</TabsTrigger>)}</TabsList>
          </Tabs>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard label="Total points" value={fmtPts(total)} className={pnlClass(total)} />
        <StatCard label="Trades" value={trades.length} hint={`${wins} W · ${trades.length - wins} L`} />
        <StatCard label="Win rate" value={`${trades.length ? (wins * 100 / trades.length).toFixed(2) : "0.00"}%`} />
        <StatCard label="Avg / trade" value={fmtPts(trades.length ? total / trades.length : 0)} className={pnlClass(total)} />
        <StatCard label="Max drawdown" value={fmtPts(maxDrawdown)} className="text-red-500" />
        <StatCard label="Today" value={`${todayTrades.length} replay`} hint={report.capture_running ? `${todayPaper.length} captured paper` : "capture stopped"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>One-lot option paper tracker</CardTitle>
          <CardDescription>Midpoint and Key Levels signals are tracked independently. Strike rule: CALL ATM+100 CE / PUT ATM−100 PE (100 points OTM). Exit at +50 NIFTY points or +30% premium return, whichever comes first; 30-minute/session exit remains.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard label="Closed" value={optionPaper.trades} hint={`${optionPaper.wins} W · ${optionPaper.losses} L`} />
          <StatCard label="Open" value={optionPaper.open_trades} />
          <StatCard label="Net paper P&L" value={fmtRs(optionPaper.net_pnl_rs)} className={pnlClass(optionPaper.net_pnl_rs)} />
          <StatCard label="Avg return" value={`${fmtNum(optionPaper.avg_return_pct)}%`} />
          <StatCard label="Max drawdown" value={fmtRs(optionPaper.max_drawdown_rs)} className="text-red-500" />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader><CardTitle>Equity curve</CardTitle><CardDescription>Cumulative NIFTY spot points and drawdown, trade by trade.</CardDescription></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={curve} syncId="key-level-backtest">
                <defs><linearGradient id="key-eq" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#10b981" stopOpacity={0.35} /><stop offset="100%" stopColor="#10b981" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid stroke="var(--border)" vertical={false} /><XAxis dataKey="label" hide /><YAxis {...axis} width={58} />
                <Tooltip {...tooltip} formatter={(value) => [fmtNum(Number(value)), "Points"]} />
                <Area type="linear" dataKey="equity" stroke="#10b981" strokeWidth={2} fill="url(#key-eq)" />
              </AreaChart>
            </ResponsiveContainer>
            <ResponsiveContainer width="100%" height={110}>
              <AreaChart data={curve} syncId="key-level-backtest">
                <CartesianGrid stroke="var(--border)" vertical={false} /><XAxis dataKey="label" hide /><YAxis {...axis} width={58} />
                <Tooltip {...tooltip} formatter={(value) => [fmtNum(Number(value)), "Drawdown"]} />
                <Area type="stepAfter" dataKey="drawdown" stroke="#ef4444" fill="#ef4444" fillOpacity={0.25} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader><CardTitle>Monthly points</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={monthly}><CartesianGrid stroke="var(--border)" vertical={false} /><XAxis dataKey="month" {...axis} tickFormatter={(value: string) => value.slice(5)} /><YAxis {...axis} width={48} />
                  <Tooltip {...tooltip} formatter={(value) => [fmtPts(Number(value)), "Points"]} /><Bar dataKey="value" radius={[4, 4, 0, 0]}>{monthly.map((item) => <Cell key={item.month} fill={item.value >= 0 ? "#10b981" : "#ef4444"} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Exit reasons</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-2">{[...reasons].sort((a, b) => b[1] - a[1]).map(([reason, count]) => (
              <div key={reason} className="flex items-center gap-2 text-sm"><span className="flex-1 truncate text-muted-foreground">{prettyReason(reason)}</span><span className="w-8 text-right tabular-nums">{count}</span></div>
            ))}</CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Calendar (daily points)</CardTitle><CardDescription>Click a day to review its Key Levels trades.</CardDescription></CardHeader>
        <CardContent><PnlCalendar daily={daily.map((day) => ({ date: day.date, trades: day.trades, value: day.net_points }))} format={fmtPts} onPick={setPicked} /></CardContent>
      </Card>

      {picked && <KeyLevelTradeTable title={`Trades on ${picked}`} trades={selected} />}
      <KeyLevelTradeTable title={`Historical trades · ${year}`} trades={trades} onPick={setPicked} />

      <Card>

      <OptionPaperTable title="One-lot option paper history" trades={report.option_paper.trades} />
        <CardHeader><CardTitle>Today’s paper setup · {report.today}</CardTitle><CardDescription>{report.capture_running ? "Capture is running; captured entries use WebSocket ticks." : "Capture is stopped; today's replay uses completed 1-minute candles only."} These are spot-point simulations, not option fills.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-4">
          <KeyLevelTradeTable title="Today replay" trades={todayTrades} />
          <KeyLevelTradeTable title="Today captured paper log" trades={todayPaper} />
          <OptionPaperTable title="Today one-lot option paper trades" trades={report.today_option_paper.trades} />
        </CardContent>
      </Card>
    </div>
  )
}

export function BacktestPage() {
  const [strategy, setStrategy] = useState<"midpoint" | "key_levels">("midpoint")
  const { data: raw, loading, error } = usePoll<Backtest>(strategy === "midpoint" ? "/api/backtest" : null)
  const keyLevels = usePoll<KeyLevelReport>(strategy === "key_levels" ? "/api/backtest?strategy=key_levels" : null, 30000)
  const [filter, setFilter] = useState("all")
  const [yearPick, setYear] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)

  const years = useMemo(() => [...new Set((raw?.daily ?? []).map((d) => d.date.slice(0, 4)))].sort(), [raw])
  const year = yearPick ?? years[years.length - 1] ?? "all"
  const data = useMemo(() => (raw ? forYear(raw, year) : null), [raw, year])

  const trades = useMemo(() => {
    const t = data?.trades ?? []
    if (filter === "wins") return t.filter((x) => x.pnl_points > 0)
    if (filter === "losses") return t.filter((x) => x.pnl_points < 0)
    return t
  }, [data, filter])

  const strategyTabs = (
    <Tabs value={strategy} onValueChange={(value) => setStrategy(value as "midpoint" | "key_levels")}>
      <TabsList><TabsTrigger value="midpoint">Midpoint</TabsTrigger><TabsTrigger value="key_levels">Key Levels</TabsTrigger></TabsList>
    </Tabs>
  )

  if (strategy === "key_levels") {
    if (keyLevels.error) return <p className="text-sm text-red-500">Key Levels backtest failed: {keyLevels.error}</p>
    if (keyLevels.loading || !keyLevels.data) return <Skeleton className="h-[600px] w-full" />
    return <KeyLevelsBacktest report={keyLevels.data} onStrategy={setStrategy} />
  }

  if (error) return <div className="flex flex-col gap-4">{strategyTabs}<p className="text-sm text-red-500">Backtest failed: {error}</p></div>
  if (loading || !data) return <div className="flex flex-col gap-4">{strategyTabs}<Skeleton className="h-[600px] w-full" /></div>

  const s = data.summary
  const curve = [{ label: "start", equity: 0, drawdown: 0 }, ...data.trades.map((t) => ({ label: `${t.date} ${t.entry}`, equity: t.equity, drawdown: t.drawdown }))]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Midpoint Backtest Performance</h1>
          <p className="text-sm text-muted-foreground">
            Current rules on {s.days} days ({s.from} → {s.to}). Points are NIFTY index points; ₹ ≈ points × {s.lot_size} (1 lot, before option premium effects).
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {strategyTabs}
          <Tabs value={year} onValueChange={(v) => { setYear(v as string); setPicked(null) }}>
            <TabsList><TabsTrigger value="all">All</TabsTrigger>{years.map((y) => <TabsTrigger key={y} value={y}>{y}</TabsTrigger>)}</TabsList>
          </Tabs>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard label="Total points" value={fmtPts(s.total_points)} className={pnlClass(s.total_points)} hint={`≈ ${fmtRs(s.total_points * s.lot_size)}`} />
        <StatCard label="Trades" value={s.trades} hint={`${s.wins} W · ${s.losses} L`} />
        <StatCard label="Win rate" value={`${s.win_rate_pct}%`} />
        <StatCard label="Avg / trade" value={fmtPts(s.avg_points)} className={pnlClass(s.avg_points)} />
        <StatCard label="Max drawdown" value={fmtNum(s.max_drawdown)} className="text-red-500" hint={`≈ ${fmtRs(s.max_drawdown * s.lot_size)}`} />
        <StatCard label="Best / worst" value={<span className="text-lg">{fmtPts(s.best)} / {fmtPts(s.worst)}</span>} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Equity curve</CardTitle>
            <CardDescription>Cumulative points and drawdown, trade by trade</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={curve} syncId="bt">
                <defs>
                  <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis {...axis} width={50} />
                <Tooltip {...tooltip} formatter={(v) => [fmtNum(Number(v)), "Equity"]} />
                <Area type="linear" dataKey="equity" stroke="#10b981" strokeWidth={2} fill="url(#eq)" />
              </AreaChart>
            </ResponsiveContainer>
            <ResponsiveContainer width="100%" height={110}>
              <AreaChart data={curve} syncId="bt">
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis {...axis} width={50} />
                <Tooltip {...tooltip} formatter={(v) => [fmtNum(Number(v)), "Drawdown"]} />
                <Area type="stepAfter" dataKey="drawdown" stroke="#ef4444" fill="#ef4444" fillOpacity={0.25} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Monthly points</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={data.monthly}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" {...axis} tickFormatter={(m: string) => m.slice(5)} />
                  <YAxis {...axis} width={40} />
                  <Tooltip {...tooltip} cursor={{ fill: "var(--muted)" }} formatter={(v) => [fmtPts(Number(v)), "Points"]} />
                  <Bar dataKey="points" radius={[4, 4, 0, 0]}>
                    {data.monthly.map((m) => (
                      <Cell key={m.month} fill={m.points >= 0 ? "#10b981" : "#ef4444"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Exit reasons</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {data.exit_reasons.map((r) => (
                <div key={r.reason} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate text-muted-foreground">{prettyReason(r.reason)}</span>
                  <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${(100 * r.count) / s.trades}%` }} />
                  </div>
                  <span className="w-6 text-right tabular-nums">{r.count}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Calendar (daily P&L)</CardTitle>
          <CardDescription>Green = profit day, red = loss day, gray = no trade. Click a day to open it.</CardDescription>
        </CardHeader>
        <CardContent>
          <PnlCalendar daily={data.daily.map((d) => ({ ...d, value: d.points }))} format={fmtPts} onPick={setPicked} />
        </CardContent>
      </Card>

      <DayPanel date={picked} mode="backtest" days={data.daily.map((d) => d.date)} onPick={setPicked} onClose={() => setPicked(null)} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Trades</CardTitle>
            <CardDescription>Click a row to open that day</CardDescription>
          </div>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as string)}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="wins">Wins</TabsTrigger>
              <TabsTrigger value="losses">Losses</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Side</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Exit</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Points</TableHead>
                <TableHead className="text-right">Equity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.slice().reverse().map((t, i) => (
                <TableRow key={i} className="cursor-pointer" onClick={() => setPicked(t.date)}>
                  <TableCell className="tabular-nums">{t.date}</TableCell>
                  <TableCell><SideBadge side={t.side} /></TableCell>
                  <TableCell className="tabular-nums">{t.entry}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(t.entry_price)}</TableCell>
                  <TableCell className="tabular-nums">{t.exit}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(t.exit_price)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{prettyReason(t.reason)}</TableCell>
                  <TableCell className={cn("text-right font-medium tabular-nums", pnlClass(t.pnl_points))}>{fmtPts(t.pnl_points)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(t.equity)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

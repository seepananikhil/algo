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
import { fmtNum, fmtPts, fmtRs, pnlClass, prettyReason, usePoll, type Backtest } from "@/lib/api"

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

export function BacktestPage() {
  const { data: raw, loading, error } = usePoll<Backtest>("/api/backtest")
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

  if (error) return <p className="text-sm text-red-500">Backtest failed: {error}</p>
  if (loading || !data) return <Skeleton className="h-[600px] w-full" />

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
        <Tabs value={year} onValueChange={(v) => { setYear(v as string); setPicked(null) }}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            {years.map((y) => <TabsTrigger key={y} value={y}>{y}</TabsTrigger>)}
          </TabsList>
        </Tabs>
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

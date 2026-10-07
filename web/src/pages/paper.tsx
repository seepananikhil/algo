import { useState } from "react"
import { DayPanel } from "@/components/day-detail"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { StatCard } from "@/components/common"
import { PnlCalendar } from "@/components/pnl-calendar"
import { fmtRs, pnlClass, usePoll, type PaperReport } from "@/lib/api"

const axis = { stroke: "var(--muted-foreground)", fontSize: 11, tickLine: false, axisLine: false }
const tooltip = {
  contentStyle: { background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "var(--muted-foreground)" },
}

export function PaperPage() {
  const { data, loading, error } = usePoll<PaperReport>("/api/paper-report", 30000)
  const [picked, setPicked] = useState<string | null>(null)

  if (error) return <p className="text-sm text-red-500">Paper report failed: {error}</p>
  if (loading || !data) return <Skeleton className="h-[600px] w-full" />

  const s = data.summary
  if (!s.trades) return <p className="py-24 text-center text-sm text-muted-foreground">No paper/live option trades yet.</p>

  const curve = [
    { label: "start", equity: 0, drawdown: 0 },
    ...data.trades.map((t) => ({ label: `${t.date} ${t.entry} ${t.side}`, equity: t.equity, drawdown: t.drawdown })),
  ]

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Paper P&L</h1>
        <p className="text-sm text-muted-foreground">
          Option fills from the live engine (1-second entries, real option prices) over {s.days} day(s). Net = gross − estimated
          brokerage, STT, exchange, SEBI, stamp duty and GST. Paper fills use LTP, so real spread/slippage is not included.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard label="Net P&L" value={fmtRs(s.net_rs)} className={pnlClass(s.net_rs)} hint={`gross ${fmtRs(s.gross_rs)} · charges ${fmtRs(s.charges_rs)}`} />
        <StatCard label="Trades" value={s.trades} hint={`${s.wins} W · ${s.losses} L · ${s.winning_days}/${s.days} green days`} />
        <StatCard label="Win rate (net)" value={`${s.win_rate_pct}%`} />
        <StatCard label="Avg win / loss" value={<span className="text-lg">{fmtRs(s.avg_win_rs)} / {fmtRs(s.avg_loss_rs)}</span>} />
        <StatCard label="Max drawdown" value={fmtRs(s.max_drawdown_rs)} className="text-red-500" />
        <StatCard label="Avg net / trade" value={fmtRs(s.net_rs / s.trades)} className={pnlClass(s.net_rs)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Equity curve (net ₹)</CardTitle>
            <CardDescription>Cumulative net P&L and drawdown, trade by trade</CardDescription>
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

      <DayPanel date={picked} mode="paper" days={data.daily.map((d) => d.date)} onPick={setPicked} onClose={() => setPicked(null)} />
    </div>
  )
}

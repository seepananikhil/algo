import { useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { DayPanel } from "@/components/day-detail"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatCard } from "@/components/common"
import { PnlCalendar } from "@/components/pnl-calendar"
import { fmtNum, fmtRs, pnlClass, usePoll, type PaperReport } from "@/lib/api"
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
          <p className={cn("text-sm font-semibold tabular-nums", pnlClass(total))}>Day net: {fmtRs(total)}</p>
          {trades.length ? (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Option</TableHead><TableHead className="text-right">Spot</TableHead><TableHead className="text-right">Strike Δ</TableHead>
                <TableHead>Entry</TableHead><TableHead className="text-right">Buy</TableHead>
                <TableHead>Exit</TableHead><TableHead className="text-right">Sell</TableHead>
                <TableHead className="text-right">Gross</TableHead><TableHead className="text-right">Charges</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow></TableHeader>
              <TableBody>{trades.map((trade) => (
                <TableRow key={trade.option}>
                  <TableCell>{trade.option}<div className="text-xs text-muted-foreground">{trade.qty} qty · {trade.mode}</div></TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(trade.spot_at_entry)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(trade.distance_from_spot)}</TableCell>
                  <TableCell className="tabular-nums">{trade.entry}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtRs(trade.buy_price)}</TableCell>
                  <TableCell className="tabular-nums">{trade.exit}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtRs(trade.sell_price)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", pnlClass(trade.pnl_rs))}>{fmtRs(trade.pnl_rs)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{fmtRs(trade.charges_rs)}</TableCell>
                  <TableCell className={cn("text-right font-medium tabular-nums", pnlClass(trade.net_rs))}>{fmtRs(trade.net_rs)}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          ) : <p className="py-6 text-center text-sm text-muted-foreground">No completed HeroZero entries for this expiry.</p>}
        </CardContent>
      </Card>
    </div>
  )
}

export function PaperPage() {
  const [strategy, setStrategy] = useState<"midpoint" | "hero_zero">("midpoint")
  const [picked, setPicked] = useState<string | null>(null)
  const reportUrl = strategy === "hero_zero" ? "/api/paper-report?strategy=hero_zero" : "/api/paper-report"
  const { data, loading, error } = usePoll<PaperReport>(reportUrl, 30000)

  if (error) return <p className="text-sm text-red-500">Paper report failed: {error}</p>
  if (loading || !data) return <Skeleton className="h-150 w-full" />

  const s = data.summary
  const dates = data.daily.map((d) => d.date)
  const curve = [
    { label: "start", equity: 0, drawdown: 0 },
    ...data.trades.map((t) => ({ label: `${t.date} ${t.entry} ${t.side}`, equity: t.equity, drawdown: t.drawdown })),
  ]

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Paper P&L</h1>
        <p className="text-sm text-muted-foreground">
          {strategy === "midpoint"
            ? `Midpoint option fills (${s.days} day(s)). Net subtracts estimated charges; paper fills use LTP and do not include spread or slippage.`
            : `HeroZero paper trades: fresh 15:20 spot required; select in-band CE/PE strikes within ±50 NIFTY or ±100 SENSEX, exit at 15:30, no stop. One lot per contract; charges estimated. Oct 8 is an unfiltered 1-min replay with stale spot.`}
        </p>
      </div>

      <Tabs value={strategy} onValueChange={(value) => { setStrategy(value as "midpoint" | "hero_zero"); setPicked(null) }}>
        <TabsList>
          <TabsTrigger value="midpoint">Midpoint</TabsTrigger>
          <TabsTrigger value="hero_zero">HeroZero</TabsTrigger>
        </TabsList>
      </Tabs>

      {!s.trades ? (
        <Card><CardContent className="py-16 text-center text-sm text-muted-foreground">
          {strategy === "hero_zero" ? "No completed HeroZero expiry paper trades yet." : "No midpoint paper option trades yet."}
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

      {strategy === "midpoint" ? (
        <DayPanel date={picked} mode="paper" days={dates} onPick={setPicked} onClose={() => setPicked(null)} />
      ) : strategy === "hero_zero" && picked ? (
        <HeroZeroDayPanel date={picked} days={dates} data={data} onPick={setPicked} onClose={() => setPicked(null)} />
      ) : null}
      </>}
    </div>
  )
}

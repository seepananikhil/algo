import { useSearchParams } from "react-router-dom"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CandleChart } from "@/components/candle-chart"
import { RuleTradesTable, SideBadge, StatCard } from "@/components/common"
import { cn } from "@/lib/utils"
import { fmtNum, fmtPts, fmtRs, pnlClass, prettyReason, tradesFromSignals, usePoll, type DayData, type OptionTrade, type PaperTrade, type Signal } from "@/lib/api"

export function DayPage() {
  const [params, setParams] = useSearchParams()
  const days = usePoll<string[]>("/api/days")
  const date = params.get("date") ?? days.data?.[0] ?? null
  const day = usePoll<DayData>(date && `/api/day?date=${date}`)
  const signals = usePoll<Signal[]>(date && `/api/signals?date=${date}`)
  const paper = usePoll<PaperTrade[]>("/api/paper-trades")
  const options = usePoll<OptionTrade[]>("/api/trades")

  const actual = tradesFromSignals(signals.data ?? [])
  const fills = (options.data ?? []).filter((t) => t.date === date)
  const firstLive = (paper.data ?? []).map((t) => t.date).sort()[0]
  // Days before paper trading started have no real trades, so show the backtest instead.
  const preLive = !actual.length && paper.data != null && date != null && (!firstLive || date < firstLive)
  const trades = actual.length ? actual : preLive ? (day.data?.trades ?? []) : []
  const source = actual.length ? "PAPER / LIVE" : preLive ? "BACKTEST" : null

  const list = days.data ?? []
  const idx = date ? list.indexOf(date) : -1
  const go = (d: string | undefined) => d && setParams({ date: d })
  const total = trades.reduce((a, t) => a + t.pnl_points, 0)
  const s = day.data?.setup
  const dayRange = s?.so_far_high != null && s.so_far_low != null ? s.so_far_high - s.so_far_low : undefined

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Day viewer</h1>
          <p className="text-sm text-muted-foreground">Paper/live trades for any captured day</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Older day" disabled={idx < 0 || idx >= list.length - 1} onClick={() => go(list[idx + 1])}>
            <ChevronLeft />
          </Button>
          <Select value={date ?? ""} onValueChange={(v) => go(v as string)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Pick a day" />
            </SelectTrigger>
            <SelectContent>
              {list.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" aria-label="Newer day" disabled={idx <= 0} onClick={() => go(list[idx - 1])}>
            <ChevronRight />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Day P&L (points)" value={fmtPts(total)} className={pnlClass(total)} hint={`${trades.length} trade(s)`} />
        <StatCard label="Midpoint" value={fmtNum(s?.mid)} hint={s?.range_fixed_at ? `range fixed ${s.range_fixed_at}` : "no setup"} />
        <StatCard label="Range" value={s?.range_high != null ? fmtNum(s.range_high - s.range_low!) : "—"} hint={s?.range_high != null ? `${fmtNum(s.range_low)} – ${fmtNum(s.range_high)}` : undefined} />
        <StatCard label="Day high – low" value={fmtNum(dayRange)} hint={s?.so_far_high != null ? `${fmtNum(s.so_far_low)} – ${fmtNum(s.so_far_high)}` : undefined} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{date ?? "—"}</CardTitle>
          <CardDescription>Blue = range, amber = midpoint, dotted = buffer. Colored arrow = entry, gray arrow = exit.</CardDescription>
        </CardHeader>
        <CardContent>
          {day.loading && !day.data ? (
            <Skeleton className="h-[420px] w-full" />
          ) : day.data?.candles.length ? (
            <CandleChart date={day.data.date} candles={day.data.candles} setup={s} trades={trades} />
          ) : (
            <p className="py-24 text-center text-sm text-muted-foreground">No candles for this day.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trades</CardTitle>
          <CardDescription>NIFTY index points</CardDescription>
          {source && (
            <CardAction>
              <Badge variant={source === "BACKTEST" ? "secondary" : "default"}>{source}</Badge>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          <RuleTradesTable trades={trades} empty="No paper/live trades this day." />
        </CardContent>
      </Card>

      {fills.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Option fills</CardTitle>
            <CardDescription>Actual option P&L</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Option</TableHead>
                  <TableHead>In</TableHead>
                  <TableHead className="text-right">Buy</TableHead>
                  <TableHead>Out</TableHead>
                  <TableHead className="text-right">Sell</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fills.map((f, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <div className="flex items-center gap-2"><SideBadge side={f.side} /> {f.option}</div>
                      <div className="text-xs text-muted-foreground">{f.qty} qty · {f.mode}</div>
                    </TableCell>
                    <TableCell className="tabular-nums">{f.entry}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(f.buy_price)}</TableCell>
                    <TableCell className="tabular-nums">{f.exit}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(f.sell_price)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{prettyReason(f.exit_reason)}</TableCell>
                    <TableCell className={cn("text-right font-medium tabular-nums", pnlClass(f.pnl_rs))}>{fmtRs(f.pnl_rs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

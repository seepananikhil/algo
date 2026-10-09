import { useEffect, useRef } from "react"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CandleChart } from "@/components/candle-chart"
import { RuleTradesTable, SideBadge, StatCard } from "@/components/common"
import { cn } from "@/lib/utils"
import { chartTradesFromOptionFills, fmtNum, fmtPts, fmtRs, pnlClass, prettyReason, tradesFromSignals, usePoll, type DayData, type OptionTrade, type PaperTrade, type Signal } from "@/lib/api"

/** "auto": paper/live trades, or the backtest for days before paper trading started. */
export type DayMode = "auto" | "backtest" | "paper"

export function DayDetail({ date, mode = "auto", compact = false }: { date: string | null; mode?: DayMode; compact?: boolean }) {
  const day = usePoll<DayData>(date && `/api/day?date=${date}`)
  const signals = usePoll<Signal[]>(date && mode !== "backtest" ? `/api/signals?date=${date}` : null)
  const paper = usePoll<PaperTrade[]>(mode === "auto" ? "/api/paper-trades" : null)
  const options = usePoll<OptionTrade[]>(mode !== "backtest" ? "/api/trades" : null)

  const actual = mode === "backtest" ? [] : tradesFromSignals(signals.data ?? [])
  const fills = mode === "backtest" ? [] : (options.data ?? []).filter((t) => t.date === date)
  const firstLive = (paper.data ?? []).map((t) => t.date).sort()[0]
  const preLive = mode === "auto" && !actual.length && paper.data != null && date != null && (!firstLive || date < firstLive)
  const useBacktest = mode === "backtest" || preLive
  const trades = useBacktest ? (day.data?.trades ?? []) : actual
  const chartTrades = useBacktest || !fills.length ? trades : chartTradesFromOptionFills(fills)
  const source = useBacktest ? "BACKTEST" : actual.length ? "PAPER / LIVE" : null

  const total = trades.reduce((a, t) => a + t.pnl_points, 0)
  const fillsPnl = fills.reduce((a, f) => a + f.pnl_rs, 0)
  const pnlText = useBacktest ? `${fmtPts(total)} pts` : fmtRs(fillsPnl)
  const pnlValue = useBacktest ? total : fillsPnl
  const tradeTable = useBacktest
    ? <RuleTradesTable trades={trades} empty="No backtest trades this day." />
    : <FillsTable fills={fills} empty="No paper/live trades this day." />
  const s = day.data?.setup
  const dayRange = s?.so_far_high != null && s.so_far_low != null ? s.so_far_high - s.so_far_low : undefined

  if (compact) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span>Day P&L <b className={cn("tabular-nums", pnlClass(pnlValue))}>{pnlText}</b></span>
          <span>Mid <b className="text-foreground tabular-nums">{fmtNum(s?.mid)}</b></span>
          <span>Range <b className="text-foreground tabular-nums">{s?.range_high != null ? `${fmtNum(s.range_low)} – ${fmtNum(s.range_high)}` : "no setup"}</b></span>
        </div>
        {day.loading && !day.data ? (
          <Skeleton className="h-[420px] w-full" />
        ) : day.data?.candles.length ? (
          <CandleChart date={day.data.date} candles={day.data.candles} setup={s} trades={chartTrades} />
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">No candles for this day.</p>
        )}
        {tradeTable}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Day P&L" value={pnlText} className={pnlClass(pnlValue)} hint={`${useBacktest ? trades.length : fills.length} trade(s)`} />
        <StatCard label="Midpoint" value={fmtNum(s?.mid)} hint={s?.range_fixed_at ? `range fixed ${s.range_fixed_at}` : "no setup"} />
        <StatCard label="Range" value={s?.range_high != null ? fmtNum(s.range_high - s.range_low!) : "—"} hint={s?.range_high != null ? `${fmtNum(s.range_low)} – ${fmtNum(s.range_high)}` : undefined} />
        <StatCard label="Day high – low" value={fmtNum(dayRange)} hint={s?.so_far_high != null ? `${fmtNum(s.so_far_low)} – ${fmtNum(s.so_far_high)}` : undefined} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{date ?? "—"}</CardTitle>
            <CardDescription>Blue = range, amber = midpoint, yellow band = buffer. Paper arrows use actual option fill times; backtest arrows use rule exits.</CardDescription>
        </CardHeader>
        <CardContent>
          {day.loading && !day.data ? (
            <Skeleton className="h-[420px] w-full" />
          ) : day.data?.candles.length ? (
            <CandleChart date={day.data.date} candles={day.data.candles} setup={s} trades={chartTrades} />
          ) : (
            <p className="py-24 text-center text-sm text-muted-foreground">No candles for this day.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trades</CardTitle>
          <CardDescription>{useBacktest ? "NIFTY index points" : "Option fills, ₹"}</CardDescription>
          {source && (
            <CardAction>
              <Badge variant={source === "BACKTEST" ? "secondary" : "default"}>{source}</Badge>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>{tradeTable}</CardContent>
      </Card>
    </div>
  )
}

export function FillsTable({ fills, empty = "No option trades." }: { fills: OptionTrade[]; empty?: string }) {
  if (!fills.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
  return (
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
          <TableRow key={i} className={f.pnl_rs > 0 ? "bg-emerald-500/10" : f.pnl_rs < 0 ? "bg-red-500/10" : undefined}>
            <TableCell>
              <div className="flex items-center gap-2"><SideBadge side={f.side} /> {f.option}</div>
              <div className="text-xs text-muted-foreground">{f.qty} qty · {f.mode}</div>
            </TableCell>
            <TableCell className="tabular-nums">{f.entry}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(f.buy_price)}<div className="text-xs text-muted-foreground">{fmtRs(f.buy_value_rs)}</div></TableCell>
            <TableCell className="tabular-nums">{f.exit}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(f.sell_price)}<div className="text-xs text-muted-foreground">{fmtRs(f.sell_value_rs)}</div></TableCell>
            <TableCell className="text-xs text-muted-foreground">{prettyReason(f.exit_reason)}</TableCell>
            <TableCell className={cn("text-right font-medium tabular-nums", pnlClass(f.pnl_rs))}>{fmtRs(f.pnl_rs)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** Inline day view (chart + trades) shown under the calendar; scrolls into view when a day is picked. */
export function DayPanel({ date, mode, days, onPick, onClose }: {
  date: string | null
  mode: DayMode
  days: string[]
  onPick: (date: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const opened = date != null
  useEffect(() => {
    if (opened) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [opened])
  if (!date) return null
  const sorted = [...days].sort()
  const idx = sorted.indexOf(date)
  const prev = idx > 0 ? sorted[idx - 1] : undefined
  const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : undefined
  return (
    <div ref={ref} className="scroll-mt-20">
      <Card>
        <CardHeader>
          <CardTitle>{mode === "backtest" ? "Backtest day" : "Paper day"}</CardTitle>
          <CardDescription>Arrows on the chart mark entries and exits</CardDescription>
          <CardAction className="flex items-center gap-2">
            <Button variant="outline" size="icon-sm" aria-label="Previous day" disabled={!prev} onClick={() => prev && onPick(prev)}><ChevronLeft /></Button>
            <span className="min-w-28 text-center text-sm font-medium tabular-nums">
              {new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}
            </span>
            <Button variant="outline" size="icon-sm" aria-label="Next day" disabled={!next} onClick={() => next && onPick(next)}><ChevronRight /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Close day" onClick={onClose}><X /></Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DayDetail date={date} mode={mode} compact />
        </CardContent>
      </Card>
    </div>
  )
}

import { useEffect, useRef } from "react"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CandleChart } from "@/components/candle-chart"
import { SideBadge } from "@/components/common"
import { cn } from "@/lib/utils"
import { chartTradesFromOptionFills, fmtNum, fmtPts, fmtRs, pnlClass, prettyReason, tradesFromSignals, usePoll, withoutSupersededExitSignals, type DayData, type OptionTrade, type PaperTrade, type Signal } from "@/lib/api"

/** "auto": paper/live trades, or the backtest for days before paper trading started. */
export type DayMode = "auto" | "backtest" | "paper"

export function DayDetail({ date, mode = "auto", compact = false }: { date: string | null; mode?: DayMode; compact?: boolean }) {
  const day = usePoll<DayData>(date && `/api/day?date=${date}`)
  const signals = usePoll<Signal[]>(date && mode !== "backtest" ? `/api/signals?date=${date}` : null)
  const paper = usePoll<PaperTrade[]>(mode === "auto" ? "/api/paper-trades" : null)
  const options = usePoll<OptionTrade[]>(mode === "auto" || mode === "paper" ? "/api/trades" : null)

  const fills = mode === "auto" || mode === "paper" ? (options.data ?? []).filter((t) => t.date === date) : []
  const visibleSignals = withoutSupersededExitSignals(signals.data ?? [], fills)
  const actual = mode === "backtest" ? [] : tradesFromSignals(visibleSignals)
  const firstLive = (paper.data ?? []).map((t) => t.date).sort()[0]
  const preLive = mode === "auto" && !actual.length && paper.data != null && date != null && (!firstLive || date < firstLive)
  const useBacktest = mode === "backtest" || preLive
  const trades = useBacktest ? (day.data?.trades ?? []) : actual
  const chartTrades = useBacktest || !fills.length ? trades : chartTradesFromOptionFills(fills)
  const chartCandles = day.data?.candles
  const chartLoading = day.loading
  const total = trades.reduce((a, t) => a + t.pnl_points, 0)
  const fillsPnl = fills.reduce((a, f) => a + f.pnl_rs, 0)
  const pnlText = useBacktest ? `${fmtPts(total)} pts` : fmtRs(fillsPnl)
  const pnlValue = useBacktest ? total : fillsPnl
  const pnlOverlay = (
    <div className="flex items-baseline gap-2 rounded-md border bg-background/90 px-2.5 py-1.5 shadow-sm backdrop-blur-sm">
      <span className="text-xs text-muted-foreground">Day P&L</span>
      <strong className={cn("text-sm font-semibold tabular-nums", pnlClass(pnlValue))}>{pnlText}</strong>
    </div>
  )
  const s = day.data?.setup
  const tradeCards = useBacktest
    ? <BacktestTradeCards trades={trades} />
    : <OptionTradeCards fills={fills} signals={visibleSignals} />

  if (compact) {
    return (
      <div className="flex flex-col gap-4">
        {chartLoading && !chartCandles ? (
          <div className="relative">
            <Skeleton className="h-105 w-full" />
            <div className="pointer-events-none absolute left-2 top-2 z-10">{pnlOverlay}</div>
          </div>
        ) : chartCandles?.length ? (
          <CandleChart date={date ?? day.data?.date ?? ""} candles={chartCandles} setup={s} trades={chartTrades} overlay={pnlOverlay} />
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">No candles for this day.</p>
        )}
        {tradeCards}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{date ?? "—"}</CardTitle>
          <CardDescription>Blue = range · amber = midpoint · cyan = nearby key level</CardDescription>
        </CardHeader>
        <CardContent>
          {chartLoading && !chartCandles ? (
            <div className="relative">
              <Skeleton className="h-[clamp(360px,58vh,620px)] w-full" />
              <div className="pointer-events-none absolute left-2 top-2 z-10">{pnlOverlay}</div>
            </div>
          ) : chartCandles?.length ? (
            <CandleChart date={date ?? day.data?.date ?? ""} candles={chartCandles} setup={s} trades={chartTrades} className="h-[clamp(360px,58vh,620px)]" overlay={pnlOverlay} />
          ) : (
            <p className="py-24 text-center text-sm text-muted-foreground">No candles for this day.</p>
          )}
        </CardContent>
      </Card>

      <div className="min-w-0 space-y-2 lg:max-h-[clamp(420px,64vh,680px)] lg:overflow-y-auto lg:pr-1">
        {tradeCards}
      </div>
    </div>
  )
}

function BacktestTradeCards({ trades }: { trades: DayData["trades"] }) {
  if (!trades.length) return <p className="py-6 text-center text-sm text-muted-foreground">No backtest trades this day.</p>
  return trades.map((trade, index) => {
    const pnlBorder = trade.pnl_points > 0 ? "border-l-emerald-500" : trade.pnl_points < 0 ? "border-l-red-500" : "border-l-border"
    return (
      <Card key={`${trade.entry}-${index}`} size="sm" className={cn("border-l-[3px]", pnlBorder)}>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2"><SideBadge side={trade.side} /><span className="truncate text-xs text-muted-foreground">{prettyReason(trade.reason)}</span></div>
            <strong className={cn("shrink-0 text-base font-bold tabular-nums", pnlClass(trade.pnl_points))}>{fmtPts(trade.pnl_points)} <span className="text-xs font-medium">pts</span></strong>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <TradeMoment label="ENTRY" time={trade.entry} price={fmtNum(trade.entry_price)} />
            <TradeMoment label="EXIT" time={trade.exit || "—"} price={fmtNum(trade.exit_price)} />
          </div>
          <div className="grid grid-cols-2 gap-3 border-t pt-2 text-xs">
            <TradeValue label="Stop" value={fmtNum(trade.sl)} />
            <TradeValue label="Target" value={fmtNum(trade.target)} />
          </div>
        </CardContent>
      </Card>
    )
  })
}

function OptionTradeCards({ fills, signals }: { fills: OptionTrade[]; signals: Signal[] }) {
  if (!fills.length) return <p className="py-6 text-center text-sm text-muted-foreground">No paper/live trades this day.</p>
  return fills.map((fill, index) => {
    const entrySignal = signals.find((signal) => signal.event === "ENTRY" && signal.side === fill.side && signal.entry_time.slice(0, 5) === fill.entry)
    const pnlBorder = fill.pnl_rs > 0 ? "border-l-emerald-500" : fill.pnl_rs < 0 ? "border-l-red-500" : "border-l-border"
    return (
      <Card key={`${fill.entry}-${fill.option}-${index}`} size="sm" className={cn("border-l-[3px]", pnlBorder)}>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2"><SideBadge side={fill.side} /><span className="truncate text-sm font-medium">{fill.option}</span></div>
            <strong className={cn("shrink-0 text-base font-bold tabular-nums", pnlClass(fill.pnl_rs))}>{fmtRs(fill.pnl_rs)}</strong>
          </div>
          <div className="text-xs text-muted-foreground">{fill.qty} qty <span className="px-1">·</span> {fill.mode}</div>
          <div className="grid grid-cols-2 gap-2">
            <TradeMoment label="ENTRY" time={fill.entry} price={fmtNum(fill.nifty_in)} />
            <TradeMoment label="EXIT" time={fill.exit || "—"} price={fmtNum(fill.nifty_out)} />
          </div>
          <div className="grid grid-cols-2 gap-3 border-t pt-2 text-xs">
            <TradeValue label="Premium bought" value={fmtRs(fill.buy_price)} />
            <TradeValue label="Premium sold" value={fmtRs(fill.sell_price)} />
          </div>
          <p className="text-xs text-muted-foreground">
            {fill.trigger_label ?? (entrySignal ? prettyReason(entrySignal.reason) : "signal")} → {prettyReason(fill.exit_reason)}
          </p>
        </CardContent>
      </Card>
    )
  })
}

function TradeMoment({ label, time, price }: { label: string; time: string; price: string }) {
  return (
    <div className="min-w-0 rounded-md bg-muted/60 px-2 py-1.5">
      <div className="text-[10px] font-semibold text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{time}</div>
      <div className="truncate text-xs text-muted-foreground tabular-nums" title={price}>{price}</div>
    </div>
  )
}

function TradeValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground">{label}</div>
      <div className="truncate font-medium tabular-nums" title={value}>{value}</div>
    </div>
  )
}

export function FillsTable({ fills, signals = [], empty = "No option trades." }: { fills: OptionTrade[]; signals?: Signal[]; empty?: string }) {
  if (!fills.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Option</TableHead>
          {fills.some((fill) => fill.level != null) && <TableHead className="text-right">Level</TableHead>}
          <TableHead>In</TableHead>
          <TableHead className="text-right">NIFTY in</TableHead>
          <TableHead className="text-right">Buy</TableHead>
          <TableHead>Out</TableHead>
          <TableHead className="text-right">NIFTY out</TableHead>
          <TableHead className="text-right">Sell</TableHead>
          <TableHead>Trigger → exit</TableHead>
          <TableHead className="text-right">P&L</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {fills.map((f, i) => {
          const entrySignal = signals.find((signal) => signal.event === "ENTRY" && signal.side === f.side && signal.entry_time.slice(0, 5) === f.entry)
          return (
          <TableRow key={i} className={f.pnl_rs > 0 ? "bg-emerald-500/10" : f.pnl_rs < 0 ? "bg-red-500/10" : undefined}>
            <TableCell>
              <div className="flex items-center gap-2"><SideBadge side={f.side} /> {f.option}</div>
              <div className="text-xs text-muted-foreground">{f.qty} qty · {f.mode}</div>
            </TableCell>
            {fills.some((fill) => fill.level != null) && <TableCell className="text-right tabular-nums">{fmtNum(f.level)}</TableCell>}
            <TableCell className="tabular-nums">{f.entry}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(f.nifty_in)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(f.buy_price)}<div className="text-xs text-muted-foreground">{fmtRs(f.buy_value_rs)}</div></TableCell>
            <TableCell className="tabular-nums">{f.exit}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(f.nifty_out)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(f.sell_price)}<div className="text-xs text-muted-foreground">{fmtRs(f.sell_value_rs)}</div></TableCell>
            <TableCell className="text-xs text-muted-foreground">{f.trigger_label ?? (entrySignal ? prettyReason(entrySignal.reason) : "signal")} → {prettyReason(f.exit_reason)}</TableCell>
            <TableCell className={cn("text-right font-medium tabular-nums", pnlClass(f.pnl_rs))}>{fmtRs(f.pnl_rs)}</TableCell>
          </TableRow>
          )
        })}
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

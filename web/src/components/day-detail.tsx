import { useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CandleChart } from "@/components/candle-chart"
import { RuleTradesTable, SideBadge } from "@/components/common"
import { cn } from "@/lib/utils"
import { chartTradesFromOptionFills, fmtNum, fmtPts, fmtRs, pnlClass, prettyReason, tradesFromSignals, usePoll, withoutSupersededExitSignals, type DayData, type KeyLevelDay, type OptionTrade, type Signal } from "@/lib/api"

/** "auto": recorded trades, or the backtest for days before paper trading started. */
export type DayMode = "auto" | "backtest" | "paper"

export function DayDetail({ date, mode = "auto", compact = false, chartOnly = false, allowTimeframeSwitch = false }: { date: string | null; mode?: DayMode; compact?: boolean; chartOnly?: boolean; allowTimeframeSwitch?: boolean }) {
  const [timeframe, setTimeframe] = useState<"1m" | "5m">("1m")
  const useFiveMinute = allowTimeframeSwitch && timeframe === "5m"
  const day = usePoll<DayData>(date && `/api/day?date=${date}${allowTimeframeSwitch ? "&full=1" : ""}`)
  const keyLevelDay = usePoll<KeyLevelDay>(date && useFiveMinute ? `/api/key-level-day?date=${date}` : null)
  const signals = day.data?.signals ?? []
  const paperTrades = day.data?.paper_trades ?? []
  const fills = day.data?.option_trades ?? []
  const visibleSignals = withoutSupersededExitSignals(signals, fills)
  const actual = mode === "backtest" ? [] : tradesFromSignals(visibleSignals)
  const hasRecordedTrades = paperTrades.length > 0 || fills.length > 0
  const firstPaperDate = day.data?.first_paper_date
  const preLive = mode === "auto" && !actual.length && !hasRecordedTrades && date != null && (!firstPaperDate || date < firstPaperDate)
  const useBacktest = mode === "backtest" || preLive
  const trades = useBacktest ? (day.data?.trades ?? []) : actual
  const spotTrades = useFiveMinute
    ? (keyLevelDay.data?.trades ?? [])
    : useBacktest
    ? trades
    : fills.length ? chartTradesFromOptionFills(fills) : actual
  const chartTrades = useFiveMinute
    ? (keyLevelDay.data?.trades ?? [])
    : fills.length ? chartTradesFromOptionFills(fills) : spotTrades
  const chartCandles = useFiveMinute ? keyLevelDay.data?.candles : day.data?.candles
  const chartLoading = useFiveMinute ? keyLevelDay.loading : day.loading
  const spotPoints = spotTrades.reduce((sum, trade) => sum + trade.pnl_points, 0)
  const fillsPnl = fills.reduce((sum, fill) => sum + (fill.net_rs ?? fill.pnl_rs), 0)
  const pnlText = fills.length ? fmtRs(fillsPnl) : `${fmtPts(spotPoints)} pts`
  const pnlValue = fills.length ? fillsPnl : spotPoints
  const pnlOverlay = (
    <div className="flex items-baseline gap-2 rounded-md border bg-background/90 px-2.5 py-1.5 shadow-sm backdrop-blur-sm">
      <span className="text-xs text-muted-foreground">Day P&L</span>
      <strong className={cn("text-sm font-semibold tabular-nums", pnlClass(pnlValue))}>{pnlText}</strong>
    </div>
  )
  const s = day.data?.setup
  const tradeList = fills.length
    ? <FillsTable fills={fills} signals={visibleSignals} empty="No paper/live trades this day." />
    : useFiveMinute
    ? <RuleTradesTable trades={chartTrades} empty="No Key Levels trades this day." />
    : useBacktest
    ? <RuleTradesTable trades={trades} empty="No backtest trades this day." />
    : <FillsTable fills={fills} signals={visibleSignals} empty="No paper/live trades this day." />

  if (compact) {
    return (
      <div className="flex flex-col gap-4">
        {allowTimeframeSwitch && (
          <div className={cn("flex items-center justify-between gap-3", chartOnly && "mx-auto w-full max-w-6xl")}>
            <span className="text-sm text-muted-foreground">{useFiveMinute ? "5-minute Key Levels view" : "1-minute full-session view"}</span>
            <Tabs value={timeframe} onValueChange={(value) => setTimeframe(value as "1m" | "5m")}>
              <TabsList><TabsTrigger value="1m">1 min</TabsTrigger><TabsTrigger value="5m">5 min</TabsTrigger></TabsList>
            </Tabs>
          </div>
        )}
        {chartLoading && !chartCandles ? (
          <div className="relative">
            <Skeleton className={chartOnly ? "aspect-video max-h-[620px] min-h-[320px] w-full" : "h-105 w-full"} />
            {!chartOnly && <div className="pointer-events-none absolute left-2 top-2 z-10">{pnlOverlay}</div>}
          </div>
        ) : useFiveMinute && keyLevelDay.error ? (
          <p className="py-16 text-center text-sm text-red-500">5-minute chart failed: {keyLevelDay.error}</p>
        ) : chartCandles?.length ? (
          <div className={chartOnly ? "mx-auto w-full max-w-6xl" : undefined}>
            <CandleChart
              date={date ?? day.data?.date ?? ""}
              candles={chartCandles}
              forming={useFiveMinute ? undefined : day.data?.forming}
              setup={s}
              trades={chartTrades}
              keyLevelZone={useFiveMinute ? keyLevelDay.data?.key_level_zone : undefined}
              showTradeLevels={useFiveMinute}
              className={chartOnly ? "aspect-video max-h-[620px] min-h-[320px]" : undefined}
              overlay={chartOnly ? undefined : pnlOverlay}
            />
          </div>
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">No candles for this day.</p>
        )}
        {!chartOnly && tradeList}
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <Card className="min-w-0">
        {allowTimeframeSwitch && (
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <div><CardTitle>NIFTY intraday chart</CardTitle><CardDescription>{date} · {useFiveMinute ? "5-minute Key Levels view" : "1-minute full-session view"}</CardDescription></div>
            <Tabs value={timeframe} onValueChange={(value) => setTimeframe(value as "1m" | "5m")}>
              <TabsList><TabsTrigger value="1m">1 min</TabsTrigger><TabsTrigger value="5m">5 min</TabsTrigger></TabsList>
            </Tabs>
          </CardHeader>
        )}
        <CardContent>
          {chartLoading && !chartCandles ? (
            <div className="relative">
              <Skeleton className="aspect-video max-h-[620px] min-h-[320px] w-full" />
              <div className="pointer-events-none absolute left-2 top-2 z-10">{pnlOverlay}</div>
            </div>
          ) : useFiveMinute && keyLevelDay.error ? (
            <p className="py-16 text-center text-sm text-red-500">5-minute chart failed: {keyLevelDay.error}</p>
          ) : chartCandles?.length ? (
            <CandleChart date={date ?? day.data?.date ?? keyLevelDay.data?.date ?? ""} candles={chartCandles} forming={useFiveMinute ? undefined : day.data?.forming} setup={useFiveMinute ? undefined : s} trades={chartTrades} keyLevelZone={useFiveMinute ? keyLevelDay.data?.key_level_zone : undefined} showTradeLevels={useFiveMinute} className="aspect-video max-h-[620px] min-h-[320px]" overlay={pnlOverlay} />
          ) : (
            <p className="py-24 text-center text-sm text-muted-foreground">No candles for this day.</p>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{useBacktest ? "Backtest trades" : "Paper/live trades"}</CardTitle>
          <CardDescription>{date ?? "Selected day"}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">{tradeList}</div>
        </CardContent>
      </Card>
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
          <TableHead>Out</TableHead>
          <TableHead>Trigger → exit</TableHead>
          <TableHead className="text-right">Net P&L</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {fills.map((f, i) => {
          const entrySignal = signals.find((signal) => signal.event === "ENTRY" && signal.side === f.side && signal.entry_time.slice(0, 5) === f.entry)
          return (
          <TableRow key={i} className="bg-transparent hover:bg-muted/20">
            <TableCell>
              <div className="flex items-center gap-2"><SideBadge side={f.side} /> {f.option}</div>
              <div className="text-xs text-muted-foreground">{f.qty} qty · {f.mode}</div>
            </TableCell>
            {fills.some((fill) => fill.level != null) && <TableCell className="text-right tabular-nums">{fmtNum(f.level)}</TableCell>}
            <TableCell className="tabular-nums">
              <div>{f.entry}</div>
              <div className="text-xs text-muted-foreground">NIFTY {fmtNum(f.nifty_in)}</div>
            </TableCell>
            <TableCell className="tabular-nums">
              <div>{f.exit}</div>
              <div className="text-xs text-muted-foreground">NIFTY {fmtNum(f.nifty_out)}</div>
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{f.trigger_label ?? (entrySignal ? prettyReason(entrySignal.reason) : "signal")} → {prettyReason(f.exit_reason)}</TableCell>
            <TableCell className={cn("text-right font-medium tabular-nums", pnlClass(f.net_rs ?? f.pnl_rs))}>
              {fmtRs(f.net_rs ?? f.pnl_rs)}
              {f.net_rs != null && <div className="text-[10px] font-normal text-muted-foreground">buy {fmtRs(f.buy_price)} · sell {fmtRs(f.sell_price)} · gross {fmtRs(f.pnl_rs)} · fees {fmtRs(f.charges_rs ?? 0)}</div>}
            </TableCell>
          </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** Inline day view (chart + trades) shown under the calendar; scrolls into view when a day is picked. */
export function DayPanel({ date, mode, days, onPick, onClose, allowTimeframeSwitch = false }: {
  date: string | null
  mode: DayMode
  days: string[]
  onPick: (date: string) => void
  onClose: () => void
  allowTimeframeSwitch?: boolean
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
          <DayDetail date={date} mode={mode} compact allowTimeframeSwitch={allowTimeframeSwitch} />
        </CardContent>
      </Card>
    </div>
  )
}

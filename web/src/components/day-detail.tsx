import { useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, RotateCcw, X } from "lucide-react"
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

export function DayDetail({
  date,
  mode = "auto",
  strategy = "midpoint",
  compact = false,
  chartOnly = false,
  allowTimeframeSwitch = false,
  headerLeading,
}: {
  date: string | null
  mode?: DayMode
  strategy?: string
  compact?: boolean
  chartOnly?: boolean
  allowTimeframeSwitch?: boolean
  headerLeading?: ReactNode
}) {
  const [timeframe, setTimeframe] = useState<"1m" | "5m">("1m")
  const [chartLayout, setChartLayout] = useState<"both" | "nifty" | "sensex">("both")
  const [niftyResetKey, setNiftyResetKey] = useState(0)
  const [sensexResetKey, setSensexResetKey] = useState(0)
  const useFiveMinute = allowTimeframeSwitch && timeframe === "5m"
  const day = usePoll<DayData>(date && `/api/day?date=${date}&symbol=NIFTY${strategy ? `&strategy=${strategy}` : ""}${allowTimeframeSwitch ? "&full=1" : ""}`)
  const sensexDay = usePoll<DayData>(date && `/api/day?date=${date}&symbol=SENSEX${allowTimeframeSwitch ? "&full=1" : ""}`)
  const currentIstDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Kolkata" }).format(new Date())
  const keyLevelDay = usePoll<KeyLevelDay>(date && useFiveMinute ? `/api/key-level-day?date=${date}` : null, useFiveMinute && date === currentIstDate ? 1000 : 0)
  const signals = day.data?.signals ?? []
  const paperTrades = day.data?.paper_trades ?? []
  const allFills = day.data?.option_trades ?? []
  const isStrategyFiltered = strategy && strategy !== "all"
  const fills = isStrategyFiltered
    ? allFills.filter((f) => {
        const m = (f.mode || "").toUpperCase()
        if (strategy === "trend_runner" || strategy === "trend" || strategy === "vix_runner" || strategy === "vix_trend" || strategy === "trend_expansion") {
          return m.includes("TREND")
        }
        if (strategy === "compression_scalp" || strategy === "scalper" || strategy === "sniper" || strategy === "scalp" || strategy === "micro_scalp") {
          return m.includes("SCALP")
        }
        if (strategy === "midpoint") {
          return m.includes("MIDPOINT") || (!m.includes("TREND") && !m.includes("SCALP") && !m.includes("KEYLEVEL") && !m.includes("HEROZERO"))
        }
        if (strategy === "key_levels" || strategy === "key_level") {
          return m.includes("KEYLEVEL")
        }
        if (strategy === "hero_zero") {
          return m.includes("HEROZERO")
        }
        return true
      })
    : allFills
  const visibleSignals = (!isStrategyFiltered || strategy === "midpoint") ? withoutSupersededExitSignals(signals, fills) : []
  const actual = mode === "backtest" ? [] : tradesFromSignals(visibleSignals)
  const hasRecordedTrades = paperTrades.length > 0 || fills.length > 0
  const firstPaperDate = day.data?.first_paper_date
  const preLive = mode === "auto" && !actual.length && !hasRecordedTrades && date != null && (!firstPaperDate || date < firstPaperDate)
  const isBacktest = mode === "backtest" || preLive
  const useBacktest = isBacktest
  const trades = isBacktest ? (day.data?.trades ?? []) : actual
  const spotTrades = useFiveMinute
    ? (keyLevelDay.data?.trades ?? [])
    : isBacktest
    ? trades
    : fills.length ? chartTradesFromOptionFills(fills) : (trades.length ? trades : (day.data?.trades ?? []))
  const chartTrades = useFiveMinute
    ? (keyLevelDay.data?.trades ?? [])
    : isBacktest
    ? trades
    : fills.length ? chartTradesFromOptionFills(fills) : spotTrades
  const chartCandles = useFiveMinute ? keyLevelDay.data?.candles : day.data?.candles
  const chartLoading = useFiveMinute ? keyLevelDay.loading : day.loading

  // Nifty price metrics
  const niftyLastCandle = chartCandles && chartCandles.length > 0 ? chartCandles[chartCandles.length - 1] : undefined
  const niftyPrice = niftyLastCandle?.close
  const niftyFirstCandle = chartCandles && chartCandles.length > 0 ? chartCandles[0] : undefined
  const niftyChangePts = niftyLastCandle && niftyFirstCandle ? niftyLastCandle.close - niftyFirstCandle.open : 0
  const niftyChangePct = niftyFirstCandle && niftyFirstCandle.open ? (niftyChangePts / niftyFirstCandle.open) * 100 : 0

  // Sensex price metrics
  const sensexCandles = sensexDay.data?.candles ?? []
  const sensexSetup = sensexDay.data?.setup
  const hasSensex = sensexCandles.length > 0
  const sensexLastCandle = hasSensex ? sensexCandles[sensexCandles.length - 1] : undefined
  const sensexPrice = sensexLastCandle?.close
  const sensexFirstCandle = hasSensex ? sensexCandles[0] : undefined
  const sensexChangePts = sensexLastCandle && sensexFirstCandle ? sensexLastCandle.close - sensexFirstCandle.open : 0
  const sensexChangePct = sensexFirstCandle && sensexFirstCandle.open ? (sensexChangePts / sensexFirstCandle.open) * 100 : 0

  const spotPoints = spotTrades.reduce((sum, trade) => sum + trade.pnl_points, 0)
  const fillsPnl = fills.reduce((sum, fill) => sum + (fill.net_rs ?? fill.pnl_rs), 0)
  const pnlText = fills.length && !isBacktest ? fmtRs(fillsPnl) : `${fmtPts(spotPoints)} pts`
  const pnlValue = fills.length && !isBacktest ? fillsPnl : spotPoints

  const s = day.data?.setup
  const tradeList = isBacktest
    ? <RuleTradesTable trades={trades} empty="No backtest trades this day." />
    : fills.length
    ? <FillsTable fills={fills} signals={visibleSignals} empty="No paper/live trades this day." />
    : useFiveMinute
    ? <RuleTradesTable trades={chartTrades} empty="No Key Levels trades this day." />
    : <RuleTradesTable trades={trades.length ? trades : chartTrades} empty="No paper/live trades this day." />


  // Render Charts grid block (reusable in compact and regular view)
  const renderCharts = (isCompactView: boolean) => (
    <div className={cn(
      "w-full",
      (chartLayout === "both" && hasSensex) ? "grid grid-cols-1 lg:grid-cols-2 gap-3" : "flex flex-col gap-3"
    )}>
      {/* NIFTY 50 CHART CARD */}
      {(chartLayout === "both" || chartLayout === "nifty" || !hasSensex) && (
        <div className="rounded-xl border border-border/50 bg-card shadow-2xs flex flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-border/40 px-3.5 py-2 shrink-0 bg-muted/15 gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="text-xs font-bold tracking-tight text-foreground whitespace-nowrap">NIFTY 50</span>
              <span className="text-[10px] font-semibold text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                {useFiveMinute ? "5m" : "1m"}
              </span>
              {niftyLastCandle && (
                <div className="flex items-baseline gap-1.5 font-mono">
                  <span className="font-bold text-xs text-foreground">{fmtNum(niftyPrice ?? 0)}</span>
                  <span className={`text-[11px] font-semibold ${pnlClass(niftyChangePts)}`}>
                    {niftyChangePts >= 0 ? "+" : ""}{niftyChangePts.toFixed(1)} ({niftyChangePct >= 0 ? "+" : ""}{niftyChangePct.toFixed(2)}%)
                  </span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {(fills.length > 0 || trades.length > 0) && (
                <span className={cn(
                  "text-[11px] font-mono font-bold px-2 py-0.5 rounded border shadow-2xs whitespace-nowrap",
                  pnlValue >= 0 ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30" : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30"
                )}>
                  P&amp;L {pnlText}
                </span>
              )}
              {!useFiveMinute && (!isStrategyFiltered || strategy === "midpoint") && s?.mid != null && (
                <span className="text-[10px] font-mono text-amber-500 font-bold bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/25">
                  MID {fmtNum(s.mid)}
                </span>
              )}
              <button
                type="button"
                onClick={() => setNiftyResetKey((k) => k + 1)}
                className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/60 transition-colors"
                title="Reset Nifty zoom to full day"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              {hasSensex && (
                <button
                  type="button"
                  onClick={() => setChartLayout(chartLayout === "nifty" ? "both" : "nifty")}
                  className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/60 transition-colors"
                  title={chartLayout === "nifty" ? "Restore side-by-side view" : "Maximize Nifty chart"}
                >
                  {chartLayout === "nifty" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>
          </div>
          <div className="p-1 min-h-[320px] h-[320px] flex-1 flex flex-col">
            {chartLoading && !chartCandles ? (
              <div className="relative w-full h-[320px]">
                <Skeleton className="h-[320px] w-full" />
              </div>
            ) : useFiveMinute && keyLevelDay.error ? (
              <p className="py-16 text-center text-sm text-red-500">5-minute chart failed: {keyLevelDay.error}</p>
            ) : chartCandles?.length ? (
              <CandleChart
                date={date ?? day.data?.date ?? keyLevelDay.data?.date ?? ""}
                candles={chartCandles}
                forming={useFiveMinute ? keyLevelDay.data?.forming ?? undefined : day.data?.forming}
                currentPrice={useFiveMinute ? keyLevelDay.data?.current_price ?? undefined : day.data?.forming?.close}
                setup={useFiveMinute || (isStrategyFiltered && strategy !== "midpoint") ? undefined : s}
                trades={chartTrades}
                keyLevelZone={useFiveMinute ? (keyLevelDay.data?.key_level_zone ?? s?.key_level_zone) : null}
                showKeyLevels={true}
                showTradeLevels={true}
                className={isCompactView ? "h-[310px]" : "h-[clamp(310px,44vh,350px)]"}
                zoomable
                hideToolbar={true}
                fullDay={true}
                resetKey={`${chartLayout}|${niftyResetKey}`}
              />
            ) : (
              <p className="py-24 text-center text-sm text-muted-foreground">No NIFTY candles for this day.</p>
            )}
          </div>
        </div>
      )}

      {/* SENSEX CHART CARD */}
      {hasSensex && (chartLayout === "both" || chartLayout === "sensex") && (
        <div className="rounded-xl border border-border/50 bg-card shadow-2xs flex flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-border/40 px-3.5 py-2 shrink-0 bg-muted/15 gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="text-xs font-bold tracking-tight text-foreground whitespace-nowrap">SENSEX</span>
              <span className="text-[10px] font-semibold text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">1m</span>
              {sensexLastCandle && (
                <div className="flex items-baseline gap-1.5 font-mono">
                  <span className="font-bold text-xs text-foreground">{fmtNum(sensexPrice ?? 0)}</span>
                  <span className={`text-[11px] font-semibold ${pnlClass(sensexChangePts)}`}>
                    {sensexChangePts >= 0 ? "+" : ""}{sensexChangePts.toFixed(1)} ({sensexChangePct >= 0 ? "+" : ""}{sensexChangePct.toFixed(2)}%)
                  </span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {sensexSetup?.mid != null && (
                <span className="text-[10px] font-mono text-amber-500 font-bold bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/25">
                  MID {fmtNum(sensexSetup.mid)}
                </span>
              )}
              <button
                type="button"
                onClick={() => setSensexResetKey((k) => k + 1)}
                className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/60 transition-colors"
                title="Reset Sensex zoom to full day"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setChartLayout(chartLayout === "sensex" ? "both" : "sensex")}
                className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/60 transition-colors"
                title={chartLayout === "sensex" ? "Restore side-by-side view" : "Maximize Sensex chart"}
              >
                {chartLayout === "sensex" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <div className="p-1 min-h-[320px] h-[320px] flex-1 flex flex-col">
            {sensexDay.loading && !sensexCandles.length ? (
              <div className="w-full h-[320px]">
                <Skeleton className="h-[320px] w-full" />
              </div>
            ) : sensexCandles.length ? (
              <CandleChart
                date={date ?? sensexDay.data?.date ?? ""}
                candles={sensexCandles}
                forming={sensexDay.data?.forming}
                currentPrice={sensexPrice}
                setup={sensexSetup}
                trades={[]}
                keyLevelZone={sensexSetup?.key_level_zone ?? null}
                showKeyLevels={true}
                showTradeLevels={false}
                className={isCompactView ? "h-[310px]" : "h-[clamp(310px,44vh,350px)]"}
                zoomable
                hideToolbar={true}
                fullDay={true}
                resetKey={`${chartLayout}|${sensexResetKey}`}
              />
            ) : (
              <p className="py-24 text-center text-sm text-muted-foreground">No Sensex candles for this day.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )

  if (compact) {
    return (
      <div className="flex flex-col gap-4">
        <div className={cn("flex items-center justify-between gap-3 flex-wrap", chartOnly && "mx-auto w-full max-w-6xl")}>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {useFiveMinute ? "5-minute Key Levels view" : "1-minute full-session view"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {hasSensex && (
              <div className="flex items-center rounded-lg border bg-muted/30 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setChartLayout("both")}
                  className={cn(
                    "rounded-md px-2 py-0.5 font-medium transition-colors",
                    chartLayout === "both" ? "bg-background text-foreground shadow-xs font-semibold" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Both
                </button>
                <button
                  type="button"
                  onClick={() => setChartLayout("nifty")}
                  className={cn(
                    "rounded-md px-2 py-0.5 font-medium transition-colors",
                    chartLayout === "nifty" ? "bg-background text-foreground shadow-xs font-semibold" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Nifty
                </button>
                <button
                  type="button"
                  onClick={() => setChartLayout("sensex")}
                  className={cn(
                    "rounded-md px-2 py-0.5 font-medium transition-colors",
                    chartLayout === "sensex" ? "bg-background text-foreground shadow-xs font-semibold" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Sensex
                </button>
              </div>
            )}
            {allowTimeframeSwitch && (
              <Tabs value={timeframe} onValueChange={(value) => setTimeframe(value as "1m" | "5m")}>
                <TabsList><TabsTrigger value="1m">1 min</TabsTrigger><TabsTrigger value="5m">5 min</TabsTrigger></TabsList>
              </Tabs>
            )}
          </div>
        </div>

        {renderCharts(true)}
        {!chartOnly && tradeList}
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-2.5">
      {/* Sleek Action / Header Bar with plenty of breathing space */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-card/80 px-3 py-1.5 text-xs shadow-2xs backdrop-blur shrink-0">
        <div className="flex items-center gap-2.5 flex-wrap min-w-0">
          {headerLeading ? (
            headerLeading
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-bold text-sm tracking-tight text-foreground whitespace-nowrap">Day viewer</span>
              {hasSensex && (
                <span className="hidden sm:inline text-xs text-muted-foreground font-normal">
                  (NIFTY 50 &amp; SENSEX)
                </span>
              )}
            </div>
          )}
          {allowTimeframeSwitch && (
            <Tabs value={timeframe} onValueChange={(value) => setTimeframe(value as "1m" | "5m")}>
              <TabsList className="h-6.5 p-0.5">
                <TabsTrigger value="1m" className="text-xs px-2 py-0.5 h-5.5 font-medium">1m</TabsTrigger>
                <TabsTrigger value="5m" className="text-xs px-2 py-0.5 h-5.5 font-medium">5m</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {hasSensex && (
            <div className="inline-flex rounded-md border border-border/60 bg-muted/40 p-0.5 text-xs font-medium">
              <button
                type="button"
                onClick={() => setChartLayout("both")}
                className={cn(
                  "rounded px-2.5 py-0.5 transition-all",
                  chartLayout === "both" ? "bg-background text-foreground shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Side by Side
              </button>
              <button
                type="button"
                onClick={() => setChartLayout("nifty")}
                className={cn(
                  "rounded px-2.5 py-0.5 transition-all",
                  chartLayout === "nifty" ? "bg-background text-foreground shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Nifty
              </button>
              <button
                type="button"
                onClick={() => setChartLayout("sensex")}
                className={cn(
                  "rounded px-2.5 py-0.5 transition-all",
                  chartLayout === "sensex" ? "bg-background text-foreground shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Sensex
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Side-by-Side Charts placed directly without nested card borders */}
      {renderCharts(false)}

      <Card className="min-w-0">
        <div className="flex items-center justify-between px-3.5 py-2 border-b border-border/40">
          <span className="text-xs font-semibold">{useBacktest ? "Backtest trades" : "Paper/live trades"}</span>
          <span className="text-[11px] text-muted-foreground">{date ?? "Selected day"}</span>
        </div>
        <CardContent className="p-3">
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
export function DayPanel({ date, mode, strategy = "midpoint", days, onPick, onClose, allowTimeframeSwitch = false }: {
  date: string | null
  mode: DayMode
  strategy?: string
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
    <div ref={ref} className="scroll-mt-20 w-full">
      <Card className="w-full">
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
          <DayDetail key={`${date}-${strategy}`} date={date} mode={mode} strategy={strategy} compact allowTimeframeSwitch={allowTimeframeSwitch} />
        </CardContent>
      </Card>
    </div>
  )
}

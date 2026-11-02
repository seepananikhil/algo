import { useState, useRef, useEffect } from "react"
import { useSearchParams } from "react-router-dom"
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  Box,
  Zap,
  ShieldCheck,
  RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { HoldAndRaiseChart } from "@/components/hold-and-raise-chart"
import { usePoll, fmtNum, fmtPts, pnlClass, type HoldAndRaiseData } from "@/lib/api"
import { cn } from "@/lib/utils"

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const TIMEFRAMES = [
  { id: "1m", label: "1 min", desc: "Micro Squeeze Scalp" },
  { id: "5m", label: "5 min", desc: "Sweet Spot Trend" },
  { id: "15m", label: "15 min", desc: "Multi-Hour Impulse" },
  { id: "1h", label: "1 hour", desc: "Multi-Day Accumulation" },
]

export function HoldAndRaisePage() {
  const [params, setParams] = useSearchParams()
  const days = usePoll<string[]>("/api/days")
  const list = days.data ?? []

  const date = params.get("date") ?? (list.length > 0 ? list[0] : "2026-10-26")
  const timeframe = (params.get("tf") as "1m" | "5m" | "15m" | "1h") ?? "1m"
  const [continuous, setContinuous] = useState(false)
  const [pyramiding, setPyramiding] = useState(true)
  const [activeTab, setActiveTab] = useState<"boxes" | "trades">("boxes")

  const idx = list.indexOf(date)
  const goDate = (d: string) => setParams({ date: d, tf: timeframe })
  const setTf = (tf: string) => setParams({ date, tf })

  // Calendar Picker State
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [calendarMonth, setCalendarMonth] = useState(date ? date.slice(0, 7) : "2026-10")
  const calendarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (date) setCalendarMonth(date.slice(0, 7))
  }, [date])

  useEffect(() => {
    if (!calendarOpen) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!calendarRef.current?.contains(event.target as Node)) setCalendarOpen(false)
    }
    document.addEventListener("pointerdown", closeOnOutsideClick)
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick)
  }, [calendarOpen])

  // Fetch Strategy Data
  const apiUrl = date
    ? `/api/hold-and-raise?date=${date}&tf=${timeframe}&continuous=${continuous ? "1" : "0"}&pyramid=${pyramiding ? "1" : "0"}`
    : null
  const { data, loading, reload } = usePoll<HoldAndRaiseData>(apiUrl)

  const boxes = data?.boxes ?? []
  const trades = data?.trades ?? []
  const candles = data?.candles ?? []
  const metrics = data?.metrics ?? {
    total_boxes: 0,
    total_trades: 0,
    win_trades: 0,
    win_rate: 0,
    total_points: 0,
    avg_points_per_trade: 0,
  }

  // Calendar calculations
  const [year, month] = calendarMonth.split("-").map(Number)
  const monthOffset = (new Date(year, month - 1, 1).getDay() + 6) % 7
  const daysInMonth = new Date(year, month, 0).getDate()
  const availableDates = new Set(list)
  const monthLabel = new Date(year, month - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" })
  const shiftMonth = (delta: number) => {
    const shifted = new Date(year, month - 1 + delta, 1)
    setCalendarMonth(`${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`)
  }

  return (
    <div className="flex-1 space-y-4 p-4 md:p-6 pb-12 max-w-[1600px] mx-auto">
      {/* Top Header & Navigation */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 border-b border-border/50 pb-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl md:text-2xl font-black tracking-tight flex items-center gap-2">
              <Zap className="size-5 text-amber-500 fill-amber-500" />
              Hold &amp; Raise
            </h1>
            <Badge variant="outline" className="font-mono text-[11px] border-amber-500/40 text-amber-500 bg-amber-500/10">
              Compression-to-Expansion
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Phase 1: The Hold (Energy Coil) → Phase 2: The Break (Impulse Escape) → Phase 3: The Raise (Trailing Escalation)
          </p>
        </div>

        {/* Date Selector & Timeframe Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Date Picker */}
          <div className="flex items-center gap-1 bg-muted/40 p-1 rounded-lg border border-border/60">
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={idx < 0 || idx >= list.length - 1}
              onClick={() => goDate(list[idx + 1])}
              className="h-7 w-7"
              title="Previous Trading Day"
            >
              <ChevronLeft className="size-4" />
            </Button>

            <div ref={calendarRef} className="relative">
              <Button
                variant="outline"
                size="xs"
                onClick={() => setCalendarOpen((o) => !o)}
                className="h-7 gap-1.5 px-2.5 text-xs font-semibold"
              >
                <CalendarDays className="size-3.5 text-amber-500" />
                {date}
              </Button>

              {calendarOpen && (
                <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border bg-popover p-3 text-popover-foreground shadow-2xl">
                  <div className="mb-2 flex items-center justify-between">
                    <Button variant="ghost" size="icon-sm" onClick={() => shiftMonth(-1)}>
                      <ChevronLeft className="size-4" />
                    </Button>
                    <span className="text-xs font-bold">{monthLabel}</span>
                    <Button variant="ghost" size="icon-sm" onClick={() => shiftMonth(1)}>
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground font-semibold">
                    {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
                  </div>
                  <div className="grid grid-cols-7 gap-1 mt-1">
                    {Array.from({ length: monthOffset }, (_, i) => <span key={`blank-${i}`} />)}
                    {Array.from({ length: daysInMonth }, (_, i) => {
                      const d = `${calendarMonth}-${String(i + 1).padStart(2, "0")}`
                      const hasData = availableDates.has(d)
                      const isSel = d === date
                      return (
                        <button
                          key={d}
                          type="button"
                          disabled={!hasData}
                          onClick={() => { goDate(d); setCalendarOpen(false) }}
                          className={cn(
                            "aspect-square rounded text-xs font-mono tabular-nums transition-colors",
                            isSel ? "bg-amber-500 text-black font-bold" : hasData ? "bg-muted/70 hover:bg-accent" : "text-muted-foreground/30 cursor-not-allowed"
                          )}
                        >
                          {i + 1}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            <Button
              variant="ghost"
              size="icon-xs"
              disabled={idx <= 0}
              onClick={() => goDate(list[idx - 1])}
              className="h-7 w-7"
              title="Next Trading Day"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>

          {/* Timeframe Selector Tabs */}
          <div className="flex items-center rounded-lg border border-border/60 bg-muted/40 p-1">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                type="button"
                onClick={() => setTf(tf.id)}
                className={cn(
                  "px-3 py-1 text-xs font-mono font-bold rounded-md transition-all",
                  timeframe === tf.id
                    ? "bg-amber-500 text-black shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
                title={tf.desc}
              >
                {tf.label}
              </button>
            ))}
          </div>

          <Button variant="outline" size="icon-xs" onClick={() => reload()} className="h-9 w-9">
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* KPI Cards & Strategy Toggles */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {/* Metric 1: Compression Boxes */}
        <Card className="p-3 bg-card/60 backdrop-blur-xs border-border/50">
          <div className="flex items-center justify-between text-muted-foreground text-xs font-medium">
            <span>Coiled Boxes</span>
            <Box className="size-3.5 text-amber-500" />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl md:text-2xl font-black font-mono">{metrics.total_boxes}</span>
            <span className="text-[10px] text-muted-foreground">detected</span>
          </div>
        </Card>

        {/* Metric 2: Trades Triggered */}
        <Card className="p-3 bg-card/60 backdrop-blur-xs border-border/50">
          <div className="flex items-center justify-between text-muted-foreground text-xs font-medium">
            <span>Impulse Trades</span>
            <Zap className="size-3.5 text-emerald-500" />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl md:text-2xl font-black font-mono">{metrics.total_trades}</span>
            <span className="text-[10px] text-muted-foreground">
              {metrics.win_trades} wins ({metrics.win_rate}%)
            </span>
          </div>
        </Card>

        {/* Metric 3: Total P&L Points */}
        <Card className="p-3 bg-card/60 backdrop-blur-xs border-border/50">
          <div className="flex items-center justify-between text-muted-foreground text-xs font-medium">
            <span>Strategy P&amp;L</span>
            <TrendingUp className={cn("size-3.5", metrics.total_points >= 0 ? "text-emerald-500" : "text-red-500")} />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className={cn("text-xl md:text-2xl font-black font-mono", pnlClass(metrics.total_points))}>
              {fmtPts(metrics.total_points)}
            </span>
            <span className="text-[10px] text-muted-foreground">pts</span>
          </div>
        </Card>

        {/* Metric 4: Avg Return per Trade */}
        <Card className="p-3 bg-card/60 backdrop-blur-xs border-border/50">
          <div className="flex items-center justify-between text-muted-foreground text-xs font-medium">
            <span>Avg / Trade</span>
            <ShieldCheck className="size-3.5 text-sky-500" />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className={cn("text-xl md:text-2xl font-black font-mono", pnlClass(metrics.avg_points_per_trade))}>
              {fmtPts(metrics.avg_points_per_trade)}
            </span>
            <span className="text-[10px] text-muted-foreground">pts</span>
          </div>
        </Card>

        {/* Strategy Control Toggles */}
        <Card className="p-3 bg-card/60 backdrop-blur-xs border-border/50 col-span-2 md:col-span-4 lg:col-span-1 flex flex-col justify-center gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="cross-day" className="text-[11px] font-medium cursor-pointer">
              Prior Session Merge
            </Label>
            <Switch id="cross-day" checked={continuous} onCheckedChange={setContinuous} className="scale-75" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="pyramid" className="text-[11px] font-medium cursor-pointer">
              Escalation (Lot 2)
            </Label>
            <Switch id="pyramid" checked={pyramiding} onCheckedChange={setPyramiding} className="scale-75" />
          </div>
        </Card>
      </div>

      {/* Natural Market Structure Range Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-muted/30 p-2.5 rounded-xl border border-border/50 text-xs">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-[11px] border-amber-500/50 text-amber-500 bg-amber-500/10 gap-1.5 py-0.5">
            <Box className="size-3 text-amber-500" />
            Natural Market Structure
          </Badge>
          <span className="text-muted-foreground text-xs">
            Automated Balanced Auction Ranges · Dual Boundary Tests (&ge; 2H / 2L) · Strictly Bounded [Start &rarr; Break]
          </span>
        </div>

        <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-foreground font-mono">
          <span>Range Cap: &le; 48 pts</span>
          <span>&bull;</span>
          <span>Min Hold: &ge; 20m</span>
          <span>&bull;</span>
          <span>Target: 1.5R</span>
        </div>
      </div>

      {/* Main Interactive Chart */}
      <HoldAndRaiseChart
        date={date}
        candles={candles}
        boxes={boxes}
        trades={trades}
        timeframe={timeframe}
        overlay={
          <div className="hidden sm:flex items-center gap-3 text-[10px] font-medium mr-2">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-xs bg-amber-500/80" />
              Compression Box (Ceil / Floor)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-emerald-500" />
              Breakout Long
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-red-500" />
              Breakout Short
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-sky-400" />
              Trailed Stop (The Raise)
            </span>
          </div>
        }
      />

      {/* Data Analysis Tabs: Compression Boxes & Trade History */}
      <div className="w-full mt-4 space-y-2">
        <div className="flex items-center gap-2 border-b border-border/50 pb-2">
          <button
            type="button"
            onClick={() => setActiveTab("boxes")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors",
              activeTab === "boxes"
                ? "bg-amber-500 text-black shadow-xs"
                : "bg-muted/40 text-muted-foreground hover:text-foreground"
            )}
          >
            <Box className="size-3.5" />
            Detected Compression Boxes ({boxes.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("trades")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors",
              activeTab === "trades"
                ? "bg-amber-500 text-black shadow-xs"
                : "bg-muted/40 text-muted-foreground hover:text-foreground"
            )}
          >
            <Zap className="size-3.5" />
            Breakout Trades &amp; Raise Steps ({trades.length})
          </button>
        </div>

        {/* TAB 1: Compression Boxes Table */}
        {activeTab === "boxes" && (
          <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead className="w-[120px] text-xs">Box ID</TableHead>
                  <TableHead className="text-xs">Hold Window</TableHead>
                  <TableHead className="text-xs">Duration</TableHead>
                  <TableHead className="text-right text-xs">Ceiling</TableHead>
                  <TableHead className="text-right text-xs">Floor</TableHead>
                  <TableHead className="text-right text-xs">Range (Pts)</TableHead>
                  <TableHead className="text-center text-xs">Touches</TableHead>
                  <TableHead className="text-center text-xs">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {boxes.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-xs text-muted-foreground py-8">
                      No tight compression boxes formed on this date for {timeframe}.
                    </TableCell>
                  </TableRow>
                ) : (
                  boxes.map((b: any) => (
                    <TableRow key={b.box_id} className="font-mono text-xs">
                      <TableCell className="font-bold text-foreground">{b.box_id}</TableCell>
                      <TableCell>
                        {b.start_time} → {b.end_time}
                      </TableCell>
                      <TableCell>{b.duration_bars} bars</TableCell>
                      <TableCell className="text-right text-amber-500 font-semibold">{fmtNum(b.ceiling)}</TableCell>
                      <TableCell className="text-right text-amber-500 font-semibold">{fmtNum(b.floor)}</TableCell>
                      <TableCell className="text-right font-bold text-foreground">{b.range_pts} pts</TableCell>
                      <TableCell className="text-center">
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] uppercase font-bold",
                            b.status === "breakout_up"
                              ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
                              : b.status === "breakout_down"
                              ? "bg-red-500/10 text-red-500 border-red-500/30"
                              : b.status === "coiling"
                              ? "bg-amber-500/10 text-amber-500 border-amber-500/30 animate-pulse"
                              : "bg-muted text-muted-foreground border-border/40"
                          )}
                        >
                          {b.status.replace("_", " ")}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {/* TAB 2: Breakout Trades Table */}
        {activeTab === "trades" && (
          <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead className="w-[100px] text-xs">Side</TableHead>
                  <TableHead className="text-xs">Entry Time</TableHead>
                  <TableHead className="text-right text-xs">Entry Price</TableHead>
                  <TableHead className="text-right text-xs">Initial SL (Mid)</TableHead>
                  <TableHead className="text-center text-xs">Raise Steps</TableHead>
                  <TableHead className="text-xs">Exit Time</TableHead>
                  <TableHead className="text-right text-xs">Exit Price</TableHead>
                  <TableHead className="text-xs">Exit Reason</TableHead>
                  <TableHead className="text-right text-xs">P&amp;L (Pts)</TableHead>
                  <TableHead className="text-right text-xs">R-Multiple</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trades.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-xs text-muted-foreground py-8">
                      No breakout trades triggered on this date.
                    </TableCell>
                  </TableRow>
                ) : (
                  trades.map((t: any) => (
                    <TableRow key={t.trade_id} className="font-mono text-xs">
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(
                            "font-bold text-[10px]",
                            t.side === "BUY"
                              ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
                              : "bg-red-500/10 text-red-500 border-red-500/30"
                          )}
                        >
                          {t.side}
                        </Badge>
                      </TableCell>
                      <TableCell>{t.entry_time}</TableCell>
                      <TableCell className="text-right font-semibold">{fmtNum(t.entry_price)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{fmtNum(t.initial_sl)}</TableCell>
                      <TableCell className="text-center">
                        <span className="rounded bg-sky-500/10 px-2 py-0.5 text-sky-400 font-bold border border-sky-500/30 text-[10px]">
                          {t.raise_steps.length} raises
                        </span>
                      </TableCell>
                      <TableCell>{t.exit_time ?? "—"}</TableCell>
                      <TableCell className="text-right font-semibold">{fmtNum(t.exit_price)}</TableCell>
                      <TableCell className="text-muted-foreground text-[11px]">{t.exit_reason ?? "OPEN"}</TableCell>
                      <TableCell className={cn("text-right font-bold text-sm", pnlClass(t.pnl_points))}>
                        {fmtPts(t.pnl_points)}
                      </TableCell>
                      <TableCell className={cn("text-right font-bold", pnlClass(t.r_multiple))}>
                        {t.r_multiple > 0 ? "+" : ""}{t.r_multiple}R
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}

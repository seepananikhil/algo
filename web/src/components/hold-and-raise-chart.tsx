import { useEffect, useRef, type ReactNode } from "react"
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react"
import { useTheme } from "next-themes"
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts"
import { Button } from "@/components/ui/button"
import { BoxPrimitive, type TimeBoundedBox } from "@/components/box-primitive"
import type { CompressionBox, HoldAndRaiseTrade } from "@/lib/api"

export type ChartCandle = {
  time: string
  datetime?: string
  date?: string
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

// Convert date + time to UTC epoch timestamp for chart
export const parseBarTime = (date: string, hhmm: string, isoDt?: string): UTCTimestamp => {
  if (isoDt) {
    const s = isoDt.endsWith("Z") ? isoDt : `${isoDt}Z`
    const parsed = Date.parse(s)
    if (!isNaN(parsed)) return (parsed / 1000) as UTCTimestamp
  }
  const d = date || new Date().toISOString().slice(0, 10)
  const parts = (hhmm || "09:15").slice(0, 5).split(":")
  const h = (parts[0] || "09").padStart(2, "0")
  const m = (parts[1] || "15").padStart(2, "0")
  const ts = Date.parse(`${d}T${h}:${m}:00Z`)
  return (isNaN(ts) ? 0 : ts / 1000) as UTCTimestamp
}

type Props = {
  date: string
  candles: ChartCandle[]
  boxes: CompressionBox[]
  trades: HoldAndRaiseTrade[]
  timeframe: string
  className?: string
  overlay?: ReactNode
}

export function HoldAndRaiseChart({
  date,
  candles,
  boxes,
  trades,
  timeframe = "1m",
  className = "h-[clamp(420px,58vh,620px)]",
  overlay,
}: Props) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null)
  const markersPlugin = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const boxPrimitive = useRef<BoxPrimitive | null>(null)
  const { resolvedTheme } = useTheme()

  // Initialize Lightweight Chart
  useEffect(() => {
    if (!el.current) return
    const isLight = resolvedTheme === "light"
    const gridLineColor = isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.04)"
    const borderColor = isLight ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.1)"
    const textColor = isLight ? "#52525b" : "#a1a1aa"

    try {
      const c = createChart(el.current, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: textColor,
          fontSize: 11,
          fontFamily: "Geist Mono, monospace, sans-serif",
        },
        grid: { vertLines: { visible: false }, horzLines: { color: gridLineColor } },
        rightPriceScale: {
          borderColor: borderColor,
          scaleMargins: { top: 0.08, bottom: 0.08 },
          entireTextOnly: true,
        },
        timeScale: {
          borderColor: borderColor,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 6,
          barSpacing: 6,
          tickMarkFormatter: (time: Time) => {
            if (typeof time === "number") {
              const d = new Date(time * 1000)
              const hh = String(d.getUTCHours()).padStart(2, "0")
              const mm = String(d.getUTCMinutes()).padStart(2, "0")
              return `${hh}:${mm}`
            }
            return null
          },
        },
        localization: {
          priceFormatter: (p: number) => Math.round(p).toString(),
          timeFormatter: (time: Time) => {
            if (typeof time === "number") {
              const d = new Date(time * 1000)
              const hh = String(d.getUTCHours()).padStart(2, "0")
              const mm = String(d.getUTCMinutes()).padStart(2, "0")
              return `${hh}:${mm}`
            }
            return String(time)
          },
        },
        crosshair: { mode: 0 },
        handleScroll: true,
        handleScale: true,
      })

      const cs = c.addSeries(CandlestickSeries, {
        upColor: "#10b981",
        downColor: "#ef4444",
        borderUpColor: "#10b981",
        borderDownColor: "#ef4444",
        wickUpColor: "#10b981",
        wickDownColor: "#ef4444",
      })

      const bp = new BoxPrimitive()
      cs.attachPrimitive(bp)

      chart.current = c
      candleSeries.current = cs
      boxPrimitive.current = bp
      markersPlugin.current = createSeriesMarkers(cs, [])
    } catch (e) {
      console.error("Failed to initialize HoldAndRaiseChart:", e)
    }

    return () => {
      try {
        chart.current?.remove()
      } catch {}
      chart.current = null
      candleSeries.current = null
      boxPrimitive.current = null
      markersPlugin.current = null
    }
  }, [timeframe])

  // Theme update
  useEffect(() => {
    const light = resolvedTheme === "light"
    const line = light ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.04)"
    const border = light ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.1)"
    chart.current?.applyOptions({
      layout: { textColor: light ? "#52525b" : "#a1a1aa", fontSize: 11 },
      grid: { horzLines: { color: line } },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border },
    })
  }, [resolvedTheme])

  // Populate Candles, Time-Bounded Boxes & Trade Markers
  useEffect(() => {
    const cs = candleSeries.current
    const c = chart.current
    const bp = boxPrimitive.current
    if (!cs || !c) return

    try {
      // 1. Process Candle Data (Pure Intraday deduplicated & sorted)
      const dataMap = new Map<number, { time: UTCTimestamp; open: number; high: number; low: number; close: number }>()
      for (const k of candles) {
        if (k.open == null || k.high == null || k.low == null || k.close == null) continue
        const t = parseBarTime(date, k.time, k.datetime)
        if (t > 0) {
          dataMap.set(t, { time: t, open: k.open, high: k.high, low: k.low, close: k.close })
        }
      }

      const sortedData = Array.from(dataMap.values()).sort((a, b) => (a.time as number) - (b.time as number))
      cs.setData(sortedData)

      // 2. Set Clean Time-Bounded Rectangular Boxes
      if (bp) {
        const boundedBoxes: TimeBoundedBox[] = []
        for (const box of boxes) {
          const t1 = parseBarTime(date, box.start_time, box.start_dt)
          const t2 = parseBarTime(date, box.end_time, box.end_dt)
          if (t1 > 0 && t2 > 0) {
            boundedBoxes.push({
              id: box.box_id,
              startTime: t1,
              endTime: t2,
              ceiling: box.ceiling,
              floor: box.floor,
              midpoint: box.midpoint,
              rangePts: box.range_pts,
              durationBars: box.duration_bars,
              status: box.status,
            })
          }
        }
        bp.setBoxes(boundedBoxes)
      }

      // 3. Trade Entry, Raise Steps & Exit Markers
      const markers: SeriesMarker<Time>[] = []
      for (const t of trades) {
        const isBuy = t.side === "BUY"
        const entryT = parseBarTime(date, t.entry_time, t.entry_datetime)

        if (entryT > 0) {
          markers.push({
            time: entryT,
            position: isBuy ? "belowBar" : "aboveBar",
            color: isBuy ? "#10b981" : "#ef4444",
            shape: isBuy ? "arrowUp" : "arrowDown",
            text: `BREAK ${t.side} @ ${Math.round(t.entry_price)}`,
            size: 1.5,
          })
        }

        // Draw Raised Trailing Stops as distinct markers
        for (const step of t.raise_steps || []) {
          const stepT = parseBarTime(date, step.time, step.datetime)
          if (stepT > 0) {
            markers.push({
              time: stepT,
              position: isBuy ? "belowBar" : "aboveBar",
              color: "#38bdf8",
              shape: "circle",
              text: `RAISE ${Math.round(step.price)}`,
              size: 1,
            })
          }
        }

        // Exit Marker
        if (t.exit_time && t.exit_price != null) {
          const exitT = parseBarTime(date, t.exit_time, t.exit_datetime || undefined)
          if (exitT > 0) {
            const win = t.pnl_points >= 0
            markers.push({
              time: exitT,
              position: isBuy ? "aboveBar" : "belowBar",
              color: win ? "#10b981" : "#ef4444",
              shape: "circle",
              text: `EXIT ${win ? "+" : ""}${t.pnl_points} pts`,
              size: 1.2,
            })
          }
        }
      }

      const validMarkers = markers.filter((m) => m.time != null && Number(m.time) > 0)
      validMarkers.sort((a, b) => (a.time as number) - (b.time as number))
      markersPlugin.current?.setMarkers(validMarkers)

      // Fit chart bounds to the intraday session
      if (sortedData.length > 0) {
        c.timeScale().fitContent()
      }
    } catch (e) {
      console.error("HoldAndRaiseChart render error:", e)
    }
  }, [date, candles, boxes, trades, timeframe])

  const handleResetZoom = () => {
    chart.current?.timeScale().fitContent()
  }

  const handleZoom = (factor: number) => {
    const c = chart.current
    if (!c) return
    const ts = c.timeScale()
    const r = ts.getVisibleLogicalRange()
    if (!r) return
    const span = r.to - r.from
    const delta = (span * (1 - factor)) / 2
    ts.setVisibleLogicalRange({ from: r.from + delta, to: r.to - delta })
  }

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-border/50 bg-card shadow-sm">
      {/* Chart Toolbar */}
      <div className="flex items-center justify-between border-b border-border/40 px-3.5 py-2 bg-muted/20 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold tracking-tight text-foreground">NIFTY 50 · Pure Intraday</span>
          <span className="rounded bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-500 uppercase">
            {timeframe}
          </span>
          <span className="text-muted-foreground text-[11px]">
            {candles.length} bars
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {overlay}
          <div className="flex items-center rounded-md border border-border/60 bg-background/50 p-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => handleZoom(1.3)}
              className="h-6 w-6"
              title="Zoom In"
            >
              <ZoomIn className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => handleZoom(0.7)}
              className="h-6 w-6"
              title="Zoom Out"
            >
              <ZoomOut className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleResetZoom}
              className="h-6 w-6"
              title="Reset View"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Main Chart Canvas */}
      <div ref={el} className={className} />
    </div>
  )
}

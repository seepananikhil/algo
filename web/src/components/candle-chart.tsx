import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react"
import { useTheme } from "next-themes"
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts"
import type { Candle, RuleTrade, Setup } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { PriceBandPrimitive, type Band } from "@/components/price-band"

// Treat IST wall-clock as UTC so the axis shows market time (09:15 etc.).
const toTime = (date: string, hhmm: string) => (Date.parse(`${date}T${hhmm}:00Z`) / 1000) as UTCTimestamp

// 09:15–09:50 inclusive; reserve this width so a few early candles don't fill the chart.
const SESSION_BARS = 36

function fitSession(c: IChartApi, bars: number) {
  if (bars >= SESSION_BARS) c.timeScale().fitContent()
  else c.timeScale().setVisibleLogicalRange({ from: -0.5, to: SESSION_BARS - 0.5 })
}

type Props = {
  date: string
  candles: Candle[]
  forming?: Partial<Candle>
  setup?: Setup
  trades?: RuleTrade[]
  keyLevelZone?: { level: number; buffer: number } | null
  showTradeLevels?: boolean
  className?: string
  overlay?: ReactNode
  zoomable?: boolean
  /** Changing this (e.g. the timeframe) drops any manual zoom and refits the session. */
  resetKey?: string
}

export function CandleChart({ date, candles, forming, setup, trades = [], keyLevelZone, showTradeLevels = false, className = "h-[clamp(420px,62vh,680px)]", overlay, zoomable = false, resetKey = "" }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null)
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const lines = useRef<IPriceLine[]>([])
  const band = useRef<PriceBandPrimitive | null>(null)
  const dataKey = useRef<string>("")
  const bars = useRef(0)
  const manualRange = useRef(false)
  const viewKey = useRef("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (!el.current) return
    const c = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#a1a1aa",
        fontFamily: "Geist Variable, sans-serif",
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)", scaleMargins: { top: 0.06, bottom: 0.06 } },
      timeScale: { borderColor: "rgba(255,255,255,0.1)", timeVisible: true, secondsVisible: false, rightOffset: 0 },
      crosshair: { mode: 0 },
      handleScroll: zoomable,
      handleScale: zoomable,
    })
    const s = c.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
      priceLineVisible: false,
      lastValueVisible: false,
    })
    chart.current = c
    series.current = s
    markers.current = createSeriesMarkers(s, [])
    band.current = new PriceBandPrimitive()
    s.attachPrimitive(band.current)
    // Keep the whole session in view when the card resizes, unless the user zoomed.
    const ro = new ResizeObserver(() => { if (!manualRange.current) fitSession(c, bars.current) })
    ro.observe(el.current)
    const node = el.current
    const markManual = () => { manualRange.current = true }
    if (zoomable) {
      node.addEventListener("wheel", markManual, { passive: true })
      node.addEventListener("pointerdown", markManual)
    }
    return () => {
      ro.disconnect()
      node.removeEventListener("wheel", markManual)
      node.removeEventListener("pointerdown", markManual)
      c.remove()
      chart.current = null
      series.current = null
      markers.current = null
      band.current = null
      lines.current = []
      dataKey.current = ""
    }
  }, [])

  useEffect(() => {
    const light = resolvedTheme === "light"
    const line = light ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.04)"
    const border = light ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.1)"
    chart.current?.applyOptions({
      layout: { textColor: light ? "#52525b" : "#a1a1aa" },
      grid: { horzLines: { color: line } },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border },
    })
  }, [resolvedTheme])

  useEffect(() => {
    const s = series.current
    if (!s) return
    const data = candles.map((k) => ({ time: toTime(date, k.time), open: k.open, high: k.high, low: k.low, close: k.close }))
    if (forming?.time && forming.open != null) {
      data.push({
        time: toTime(date, forming.time),
        open: forming.open,
        high: forming.high!,
        low: forming.low!,
        close: forming.close!,
      })
    }
    // Polling hands us new arrays every few seconds; skip redraws when nothing changed.
    const frame = `${date}|${resetKey}`
    if (viewKey.current !== frame) {
      viewKey.current = frame
      manualRange.current = false
    }
    const key = JSON.stringify([date, data.length, data.at(-1), setup, trades, keyLevelZone, showTradeLevels])
    if (key === dataKey.current) return
    dataKey.current = key
    s.setData(data)

    lines.current.forEach((l) => s.removePriceLine(l))
    lines.current = []
    const add = (
      price: number | undefined,
      color: string,
      style = LineStyle.Dashed,
      axisLabel = true,
      title = "",
      lineWidth: 1 | 2 | 3 | 4 = 1,
    ) => {
      if (price == null || Number.isNaN(price)) return
      lines.current.push(s.createPriceLine({ price, color, title, lineWidth, lineStyle: style, axisLabelVisible: axisLabel }))
    }
    add(setup?.range_high, "#38bdf8")
    add(setup?.range_low, "#38bdf8")
    add(setup?.mid, "#f59e0b", LineStyle.Solid)
    if (keyLevelZone) add(keyLevelZone.level, "#00e5ff", LineStyle.Solid, true, "KEY", 3)
    for (const level of setup?.key_levels ?? []) {
      if (level.nearby) add(level.price, "#00e5ff", LineStyle.Solid, true, "", 3)
    }
    const bands: Band[] = []
    if (setup?.mid != null && setup.buffer) bands.push({ top: setup.mid + setup.buffer, bottom: setup.mid - setup.buffer })
    if (keyLevelZone) {
      bands.push({
        top: keyLevelZone.level + keyLevelZone.buffer,
        bottom: keyLevelZone.level - keyLevelZone.buffer,
        fill: "rgba(0, 229, 255, 0.12)",
        edge: "rgba(0, 229, 255, 0.85)",
      })
    }
    band.current?.setBands(bands)
    if (setup?.armed) add(setup.armed.level, "#a855f7", LineStyle.Dotted)
    if (showTradeLevels) {
      for (const trade of trades) {
        add(trade.sl, "#ef4444", LineStyle.Dashed, true, "SL")
        add(trade.target, "#10b981", LineStyle.Dashed, true, "TGT")
      }
    }

    const m: SeriesMarker<Time>[] = []
    for (const t of trades) {
      const call = t.side === "CALL"
      m.push({
        time: toTime(date, t.entry),
        position: call ? "belowBar" : "aboveBar",
        color: call ? "#10b981" : "#ef4444",
        shape: call ? "arrowUp" : "arrowDown",
      })
      if (!t.reason.endsWith("open")) {
        m.push({
          time: toTime(date, t.exit),
          position: call ? "aboveBar" : "belowBar",
          color: "#71717a",
          shape: call ? "arrowDown" : "arrowUp",
        })
      }
    }
    m.sort((a, b) => (a.time as number) - (b.time as number))
    markers.current?.setMarkers(m)
    bars.current = data.length
    if (chart.current && !manualRange.current) fitSession(chart.current, data.length)
  }, [date, candles, forming, setup, trades, keyLevelZone, showTradeLevels, resetKey])

  function showWindow(fromTime: string, toTime_: string) {
    const c = chart.current
    if (!c || !candles.length) return
    const first = candles.findIndex((k) => k.time >= fromTime)
    let last = -1
    candles.forEach((k, index) => { if (k.time <= toTime_) last = index })
    if (first < 0 || last < first) return
    manualRange.current = true
    c.timeScale().setVisibleLogicalRange({ from: first - 0.5, to: Math.max(last, first + 4) + 0.5 })
  }

  function zoom(factor: number) {
    const timeScale = chart.current?.timeScale()
    const range = timeScale?.getVisibleLogicalRange()
    if (!timeScale || !range) return
    const mid = (range.from + range.to) / 2
    const half = ((range.to - range.from) / 2) * factor
    manualRange.current = true
    timeScale.setVisibleLogicalRange({ from: mid - half, to: mid + half })
  }

  function reset() {
    manualRange.current = false
    setFrom("")
    setTo("")
    if (chart.current) fitSession(chart.current, bars.current)
  }

  const chartBox = (
    <div className={`relative w-full ${className}`}>
      <div ref={el} className="absolute inset-0" />
      {overlay && <div className="pointer-events-none absolute left-2 top-2 z-10 sm:left-3 sm:top-3">{overlay}</div>}
    </div>
  )
  if (!zoomable) return chartBox

  const applyCustom = (nextFrom: string, nextTo: string) => {
    if (nextFrom && nextTo && nextFrom <= nextTo) showWindow(nextFrom, nextTo)
  }
  const timeInput = "h-6 rounded-md border bg-background px-1.5 text-xs text-foreground"

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="outline" size="icon-xs" aria-label="Zoom in" onClick={() => zoom(0.6)}><ZoomIn /></Button>
        <Button variant="outline" size="icon-xs" aria-label="Zoom out" onClick={() => zoom(1.6)}><ZoomOut /></Button>
        <Button variant="outline" size="xs" onClick={() => showWindow("09:15", "09:50")}>09:15–09:50</Button>
        <Button variant="outline" size="xs" onClick={() => showWindow("09:15", "11:00")}>Morning</Button>
        <Button variant="outline" size="xs" onClick={reset}><RotateCcw /> Full day</Button>
        <span className="ml-1 flex items-center gap-1 text-xs text-muted-foreground">
          <input aria-label="From time" type="time" className={timeInput} value={from} onChange={(event) => { setFrom(event.target.value); applyCustom(event.target.value, to) }} />
          to
          <input aria-label="To time" type="time" className={timeInput} value={to} onChange={(event) => { setTo(event.target.value); applyCustom(from, event.target.value) }} />
        </span>
      </div>
      {chartBox}
    </div>
  )
}

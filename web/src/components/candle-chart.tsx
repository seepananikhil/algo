import { useEffect, useRef } from "react"
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
import { PriceBandPrimitive } from "@/components/price-band"

// Treat IST wall-clock as UTC so the axis shows market time (09:15 etc.).
const toTime = (date: string, hhmm: string) => (Date.parse(`${date}T${hhmm}:00Z`) / 1000) as UTCTimestamp

type Props = {
  date: string
  candles: Candle[]
  forming?: Partial<Candle>
  setup?: Setup
  trades?: RuleTrade[]
  className?: string
}

export function CandleChart({ date, candles, forming, setup, trades = [], className = "h-[clamp(420px,62vh,680px)]" }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null)
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const lines = useRef<IPriceLine[]>([])
  const band = useRef<PriceBandPrimitive | null>(null)
  const dataKey = useRef<string>("")
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
      timeScale: { borderColor: "rgba(255,255,255,0.1)", timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true, rightOffset: 0 },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
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
    // Keep the whole session in view when the card resizes.
    const ro = new ResizeObserver(() => c.timeScale().fitContent())
    ro.observe(el.current)
    return () => {
      ro.disconnect()
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
    const key = JSON.stringify([date, data.length, data.at(-1), setup, trades])
    if (key === dataKey.current) return
    dataKey.current = key
    s.setData(data)

    lines.current.forEach((l) => s.removePriceLine(l))
    lines.current = []
    const add = (price: number | undefined, color: string, style = LineStyle.Dashed, axisLabel = true) => {
      if (price == null) return
      lines.current.push(s.createPriceLine({ price, color, title: "", lineWidth: 1, lineStyle: style, axisLabelVisible: axisLabel }))
    }
    add(setup?.range_high, "#38bdf8")
    add(setup?.range_low, "#38bdf8")
    add(setup?.mid, "#f59e0b", LineStyle.Solid)
    band.current?.setBand(
      setup?.mid != null && setup.buffer ? { top: setup.mid + setup.buffer, bottom: setup.mid - setup.buffer } : null,
    )
    if (setup?.armed) add(setup.armed.level, "#a855f7", LineStyle.Dotted)

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
    chart.current?.timeScale().fitContent()
  }, [date, candles, forming, setup, trades])

  return <div ref={el} className={`w-full ${className}`} />
}

import { useEffect, useRef } from "react"
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

import { cn } from "@/lib/utils"

// Treat IST wall-clock as UTC so the axis shows market time (09:15 etc.).
const toTime = (date: string, hhmm: string) => {
  const d = date || new Date().toISOString().slice(0, 10)
  const parts = (hhmm || "09:15").slice(0, 5).split(":")
  const h = (parts[0] || "09").padStart(2, "0")
  const m = (parts[1] || "15").padStart(2, "0")
  const ts = Date.parse(`${d}T${h}:${m}:00Z`)
  return (isNaN(ts) ? 0 : ts / 1000) as UTCTimestamp
}

function fitSession(c: IChartApi, bars: number, fullDay = false) {
  if (!c || bars <= 0) return
  try {
    const timeScale = c.timeScale()
    // 4 bars of breathing room on the left so 09:15 candle and label are never cut off
    const fromIndex = -4
    const toIndex = fullDay || bars >= 50 ? bars + 3 : Math.max(bars + 2, 38)
    timeScale.setVisibleLogicalRange({ from: fromIndex, to: toIndex })
  } catch {}
}

type Props = {
  date: string
  candles: Candle[]
  forming?: Partial<Candle>
  currentPrice?: number
  setup?: Setup
  trades?: RuleTrade[]
  keyLevelZone?: { level: number; buffer: number } | null
  showKeyLevels?: boolean
  showTradeLevels?: boolean
  className?: string
  overlay?: ReactNode
  zoomable?: boolean
  hideToolbar?: boolean
  fullDay?: boolean
  /** Changing this (e.g. the timeframe) drops any manual zoom and refits the session. */
  resetKey?: string
}

export function CandleChart({ date, candles, forming, currentPrice, setup, trades = [], keyLevelZone, showKeyLevels = false, showTradeLevels = false, className = "h-[clamp(340px,46vh,480px)]", overlay, zoomable = false, hideToolbar = false, fullDay = false, resetKey = "" }: Props) {
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
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (!el.current) return
    const isLight = resolvedTheme === "light"
    const gridLineColor = isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.04)"
    const borderColor = isLight ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.1)"
    const textColor = isLight ? "#52525b" : "#a1a1aa"

    const c = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: textColor,
        fontSize: 11,
        fontFamily: "Geist Mono, monospace, sans-serif",
      },
      grid: { vertLines: { visible: false }, horzLines: { color: gridLineColor } },
      rightPriceScale: { borderColor: borderColor, scaleMargins: { top: 0.04, bottom: 0.04 }, entireTextOnly: true },
      timeScale: {
        borderColor: borderColor,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        barSpacing: 6,
        minBarSpacing: 0.2,
        fixLeftEdge: false,
        fixRightEdge: false,
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
      priceFormat: {
        type: "custom",
        formatter: (p: number) => Math.round(p).toString(),
        minMove: 1,
      },
    })
    chart.current = c
    series.current = s
    markers.current = createSeriesMarkers(s, [])
    band.current = new PriceBandPrimitive()
    s.attachPrimitive(band.current)
    // Keep the whole session in view when the card resizes, unless the user zoomed.
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          c.resize(Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height), true)
          if (!manualRange.current && bars.current > 0) {
            fitSession(c, bars.current, fullDay)
          }
        }
      }
    })
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
      layout: { textColor: light ? "#52525b" : "#a1a1aa", fontSize: 11 },
      grid: { horzLines: { color: line } },
      rightPriceScale: { borderColor: border, scaleMargins: { top: 0.04, bottom: 0.04 }, entireTextOnly: true },
      timeScale: { borderColor: border },
    })
  }, [resolvedTheme])

  useEffect(() => {
    const s = series.current
    if (!s) return
    const dataMap = new Map<number, { time: UTCTimestamp; open: number; high: number; low: number; close: number }>()
    for (const k of candles) {
      if (k.open == null || k.high == null || k.low == null || k.close == null) continue
      const t = toTime(date, k.time)
      if (t > 0) {
        dataMap.set(t, { time: t, open: k.open, high: k.high, low: k.low, close: k.close })
      }
    }
    if (forming?.time && forming.open != null && forming.high != null && forming.low != null && forming.close != null) {
      const t = toTime(date, forming.time)
      if (t > 0) {
        dataMap.set(t, {
          time: t,
          open: forming.open,
          high: forming.high,
          low: forming.low,
          close: forming.close,
        })
      }
    }
    const data = Array.from(dataMap.values()).sort((a, b) => (a.time as number) - (b.time as number))

    // Polling hands us new arrays every few seconds; skip redraws when nothing changed.
    const frame = `${date}|${resetKey}`
    if (viewKey.current !== frame) {
      viewKey.current = frame
      manualRange.current = false
    }
    const key = JSON.stringify([date, data.length, data.at(-1), currentPrice, setup, trades, keyLevelZone, showKeyLevels, showTradeLevels])
    if (key === dataKey.current) return
    dataKey.current = key

    try {
      s.setData(data)
    } catch (err) {
      console.warn("CandleChart setData error:", err)
    }

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

    // Clean subtle reference lines without axis badge clutter
    if (currentPrice != null) {
      add(currentPrice, "rgba(249, 115, 22, 0.7)", LineStyle.Dotted, false, "", 1)
    }
    add(setup?.range_high, "rgba(56, 189, 248, 0.65)", LineStyle.Dashed, false, "HIGH", 1)
    add(setup?.range_low, "rgba(56, 189, 248, 0.65)", LineStyle.Dashed, false, "LOW", 1)
    // Prominent Midpoint line with clean axis badge
    add(setup?.mid, "#fbbf24", LineStyle.Solid, true, "MID", 2)

    let sessionLow = Infinity
    let sessionHigh = -Infinity
    for (const bar of data) {
      if (bar.low < sessionLow) sessionLow = bar.low
      if (bar.high > sessionHigh) sessionHigh = bar.high
    }
    const bands: Band[] = []
    if (setup?.mid != null && setup.buffer) {
      bands.push({
        top: setup.mid + setup.buffer,
        bottom: setup.mid - setup.buffer,
        fill: "rgba(251, 191, 36, 0.08)",
        edge: "rgba(251, 191, 36, 0.3)",
        autoscale: false,
      })
    }

    if (showKeyLevels || showTradeLevels || keyLevelZone) {
      let sessionLow = Infinity
      let sessionHigh = -Infinity
      for (const bar of data) {
        if (bar.low < sessionLow) sessionLow = bar.low
        if (bar.high > sessionHigh) sessionHigh = bar.high
      }
      const step = 500
      const defaultBuffer = keyLevelZone?.buffer ?? setup?.key_level_zone?.buffer ?? 10
      const levelSet = new Set<number>()
      if (Number.isFinite(sessionLow) && Number.isFinite(sessionHigh)) {
        const startLevel = Math.floor((sessionLow - defaultBuffer) / step) * step
        const endLevel = Math.ceil((sessionHigh + defaultBuffer) / step) * step
        for (let lvl = startLevel; lvl <= endLevel; lvl += step) levelSet.add(lvl)
      }
      for (const level of setup?.key_levels ?? []) {
        if (Number.isFinite(level.price)) levelSet.add(level.price)
      }
      const explicitZone = keyLevelZone ?? setup?.key_level_zone ?? null
      if (explicitZone && Number.isFinite(explicitZone.level)) levelSet.add(explicitZone.level)

      const allLevels = [...levelSet].sort((a, b) => a - b)
      const lastClose = data.at(-1)?.close ?? 0
      const distToSession = (lvl: number) =>
        Number.isFinite(sessionLow) && Number.isFinite(sessionHigh)
          ? Math.max(sessionLow - lvl, 0, lvl - sessionHigh)
          : Infinity
      const primaryLevel =
        explicitZone?.level ??
        (allLevels.length
          ? [...allLevels].sort((a, b) => distToSession(a) - distToSession(b) || Math.abs(lastClose - a) - Math.abs(lastClose - b))[0]
          : null)

      for (const lvl of allLevels) {
        const isPrimary = lvl === primaryLevel
        const nearSession = distToSession(lvl) <= 150
        if (!isPrimary && !nearSession) continue

        // Only show axis badge on the primary key level to prevent badge overlap
        add(
          lvl,
          isPrimary ? "#06b6d4" : "rgba(6, 182, 212, 0.45)",
          isPrimary ? LineStyle.Solid : LineStyle.Dashed,
          isPrimary,
          isPrimary ? "KEY" : "",
          isPrimary ? 2 : 1
        )
        bands.push({
          top: lvl + defaultBuffer,
          bottom: lvl - defaultBuffer,
          fill: "rgba(6, 182, 212, 0.06)",
          edge: "rgba(6, 182, 212, 0.25)",
          autoscale: false,
        })
      }
    }
    band.current?.setBands(bands)
    if (setup?.armed) add(setup.armed.level, "#c084fc", LineStyle.Solid, true, "ARMED", 2)
    if (showTradeLevels) {
      for (const trade of trades) {
        add(trade.sl, "#ef4444", LineStyle.Dashed, true, "SL")
        add(trade.target, "#10b981", LineStyle.Dashed, true, "TGT")
      }
    }

    const m: SeriesMarker<Time>[] = []
    for (const t of trades) {
      const call = t.side === "CALL"
      if (t.entry) {
        m.push({
          time: toTime(date, t.entry.slice(0, 5)),
          position: call ? "belowBar" : "aboveBar",
          color: call ? "#10b981" : "#ef4444",
          shape: call ? "arrowUp" : "arrowDown",
          size: 1,
        })
      }
      if (t.exit && !(t.reason && t.reason.endsWith("open"))) {
        m.push({
          time: toTime(date, t.exit.slice(0, 5)),
          position: call ? "aboveBar" : "belowBar",
          color: "#71717a",
          shape: call ? "arrowDown" : "arrowUp",
          size: 1,
        })
      }
    }
    m.sort((a, b) => (a.time as number) - (b.time as number))
    try {
      markers.current?.setMarkers(m)
    } catch (e) {
      console.warn("CandleChart: failed to set markers", e)
    }
    bars.current = data.length
    if (chart.current && !manualRange.current) {
      fitSession(chart.current, data.length, fullDay)
      requestAnimationFrame(() => {
        if (chart.current && !manualRange.current) {
          fitSession(chart.current, data.length, fullDay)
        }
      })
    }
  }, [date, candles, forming, currentPrice, setup, trades, keyLevelZone, showKeyLevels, showTradeLevels, fullDay, resetKey])

  useEffect(() => {
    manualRange.current = false
    if (chart.current) fitSession(chart.current, bars.current, fullDay)
  }, [fullDay])

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
    if (chart.current) fitSession(chart.current, bars.current, fullDay)
  }

  return (
    <div className={cn("relative w-full flex-1 min-h-[300px]", className)} style={{ minHeight: "300px", height: "100%" }}>
      <div ref={el} className="w-full h-full min-h-[300px]" style={{ minHeight: "300px", height: "100%" }} />
      {overlay && <div className="pointer-events-none absolute left-2 top-2 z-10 sm:left-3 sm:top-3">{overlay}</div>}

      {/* Floating Layered Zoom Controls */}
      {zoomable && !hideToolbar && (
        <div className="absolute right-16 top-2 z-10 flex items-center bg-card/85 hover:bg-card backdrop-blur-md border border-border/80 rounded-md shadow-md p-0.5 gap-0.5 transition-all text-xs select-none">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom in"
            onClick={() => zoom(0.7)}
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            title="Zoom In"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom out"
            onClick={() => zoom(1.4)}
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            title="Zoom Out"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <div className="w-[1px] h-3 bg-border mx-0.5" />
          <Button
            variant="ghost"
            size="xs"
            onClick={reset}
            className="h-6 px-1.5 text-[10px] font-semibold text-muted-foreground hover:text-foreground gap-1"
            title="Reset Zoom to Full Day"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            <span>Reset</span>
          </Button>
        </div>
      )}
    </div>
  )
}

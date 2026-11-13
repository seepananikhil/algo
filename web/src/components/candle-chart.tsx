import { useCallback, useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Eraser, Minus, MousePointer2, RotateCcw, Trash2, TrendingUp, ZoomIn, ZoomOut } from "lucide-react"
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
import { BoxPrimitive, type TimeBoundedBox } from "@/components/box-primitive"
import type { CompressionBox } from "@/lib/api"

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

export type DrawingType = "none" | "hline" | "trendline" | "eraser"

type DragInfo =
  | {
      id: string
      type: "hline"
      startY: number
      startPrice: number
    }
  | {
      id: string
      type: "trendline"
      part: "p1" | "p2" | "body"
      startX: number
      startY: number
      startP1: { time?: number; logical?: number; price: number }
      startP2: { time?: number; logical?: number; price: number }
    }

export type ChartDrawing =
  | {
      id: string
      type: "hline"
      price: number
      y?: number
      color?: string
    }
  | {
      id: string
      type: "trendline"
      p1: { time?: number; logical?: number; price: number; x?: number; y?: number }
      p2: { time?: number; logical?: number; price: number; x?: number; y?: number }
      color?: string
    }

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)
  if (l2 === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)))
}

type Props = {
  date: string
  symbol?: string
  candles: Candle[]
  forming?: Partial<Candle>
  currentPrice?: number
  setup?: Setup
  trades?: RuleTrade[]
  keyLevelZone?: { level: number; buffer: number } | null
  showKeyLevels?: boolean
  showTradeLevels?: boolean
  boxes?: CompressionBox[]
  className?: string
  overlay?: ReactNode
  zoomable?: boolean
  hideToolbar?: boolean
  fullDay?: boolean
  /** Changing this (e.g. the timeframe) drops any manual zoom and refits the session. */
  resetKey?: string
}

export function CandleChart({ date, symbol = "NIFTY", candles, forming, currentPrice, setup, trades = [], keyLevelZone, showKeyLevels = false, showTradeLevels = false, boxes = [], className = "h-[clamp(340px,46vh,480px)]", overlay, zoomable = false, hideToolbar = false, fullDay = false, resetKey = "" }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null)
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const lines = useRef<IPriceLine[]>([])
  const band = useRef<PriceBandPrimitive | null>(null)
  const boxPrimitive = useRef<BoxPrimitive | null>(null)
  const dataKey = useRef<string>("")
  const bars = useRef(0)
  const manualRange = useRef(false)
  const viewKey = useRef("")
  const { resolvedTheme } = useTheme()

  // Interactive Drawing Tools state
  const [tool, setTool] = useState<DrawingType>("none")
  const [drawings, setDrawings] = useState<ChartDrawing[]>([])
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef<DragInfo | null>(null)
  const [trendlineStart, setTrendlineStart] = useState<{
    time?: number
    logical?: number
    price: number
    x: number
    y: number
  } | null>(null)
  const [hoverPos, setHoverPos] = useState<{
    x: number
    y: number
    price: number | null
    time: number | null
    logical: number | null
  } | null>(null)
  const [hoveredDrawingId, setHoveredDrawingId] = useState<string | null>(null)
  const [chartDim, setChartDim] = useState<{ width: number; height: number }>({ width: 800, height: 400 })
  const [viewTick, setViewTick] = useState(0)

  // Scoped strictly to today's date & symbol ("valid only for day")
  const storageKey = `chart_drawings_${date}_${symbol || "NIFTY"}`

  // Load drawings from localStorage for this specific day & symbol
  useEffect(() => {
    if (!date) return
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          setDrawings(parsed)
        }
      } else {
        setDrawings([])
      }
    } catch {
      setDrawings([])
    }

    // Prune stale drawings from older dates so they don't persist indefinitely
    try {
      const prefix = "chart_drawings_"
      const keysToRemove: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith(prefix) && !k.includes(date)) {
          keysToRemove.push(k)
        }
      }
      for (const k of keysToRemove) {
        localStorage.removeItem(k)
      }
    } catch {}
  }, [date, symbol, storageKey])

  // Save drawings whenever changed
  useEffect(() => {
    if (!date) return
    try {
      if (drawings.length > 0) {
        localStorage.setItem(storageKey, JSON.stringify(drawings))
      } else {
        localStorage.removeItem(storageKey)
      }
    } catch {}
  }, [drawings, storageKey, date])

  // Window pointer listeners for moving / dragging drawn lines
  useEffect(() => {
    if (!isDragging) return

    const handlePointerMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || !el.current || !series.current || !chart.current) return
      const rect = el.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top

      if (drag.type === "hline") {
        const price = series.current.coordinateToPrice(y)
        if (price != null) {
          const rounded = Math.round(Number(price) * 100) / 100
          setDrawings((prev) =>
            prev.map((item) => (item.id === drag.id && item.type === "hline" ? { ...item, price: rounded } : item))
          )
        }
      } else if (drag.type === "trendline") {
        const price = series.current.coordinateToPrice(y)
        const time = chart.current.timeScale().coordinateToTime(x)
        const logical = chart.current.timeScale().coordinateToLogical(x)
        const roundedPrice = price != null ? Math.round(Number(price) * 100) / 100 : null

        if (drag.part === "p1") {
          if (roundedPrice != null) {
            setDrawings((prev) =>
              prev.map((item) =>
                item.id === drag.id && item.type === "trendline"
                  ? {
                      ...item,
                      p1: {
                        time: time != null ? Number(time) : item.p1.time,
                        logical: logical != null ? Number(logical) : item.p1.logical,
                        price: roundedPrice,
                      },
                    }
                  : item
              )
            )
          }
        } else if (drag.part === "p2") {
          if (roundedPrice != null) {
            setDrawings((prev) =>
              prev.map((item) =>
                item.id === drag.id && item.type === "trendline"
                  ? {
                      ...item,
                      p2: {
                        time: time != null ? Number(time) : item.p2.time,
                        logical: logical != null ? Number(logical) : item.p2.logical,
                        price: roundedPrice,
                      },
                    }
                  : item
              )
            )
          }
        } else if (drag.part === "body") {
          const pStart = series.current.coordinateToPrice(drag.startY)
          const pCurr = series.current.coordinateToPrice(y)
          const deltaPrice = pCurr != null && pStart != null ? Number(pCurr) - Number(pStart) : 0

          const lStart = chart.current.timeScale().coordinateToLogical(drag.startX)
          const lCurr = chart.current.timeScale().coordinateToLogical(x)
          const deltaLogical = lCurr != null && lStart != null ? Math.round(Number(lCurr) - Number(lStart)) : 0

          setDrawings((prev) =>
            prev.map((item) => {
              if (item.id === drag.id && item.type === "trendline") {
                const newP1Price = Math.round((drag.startP1.price + deltaPrice) * 100) / 100
                const newP2Price = Math.round((drag.startP2.price + deltaPrice) * 100) / 100
                const newP1Logical = (drag.startP1.logical ?? 0) + deltaLogical
                const newP2Logical = (drag.startP2.logical ?? 0) + deltaLogical
                return {
                  ...item,
                  p1: {
                    ...item.p1,
                    logical: newP1Logical,
                    price: newP1Price,
                  },
                  p2: {
                    ...item.p2,
                    logical: newP2Logical,
                    price: newP2Price,
                  },
                }
              }
              return item
            })
          )
        }
      }
    }

    const handlePointerUp = () => {
      dragRef.current = null
      setIsDragging(false)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }
  }, [isDragging])

  // Keyboard controls: Delete / Backspace to delete selected drawing, Escape to deselect / cancel
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedDrawingId) {
        e.preventDefault()
        setDrawings((prev) => prev.filter((d) => d.id !== selectedDrawingId))
        setSelectedDrawingId(null)
        setHoveredDrawingId(null)
      } else if (e.key === "Escape") {
        if (trendlineStart) {
          setTrendlineStart(null)
        } else if (selectedDrawingId) {
          setSelectedDrawingId(null)
        } else {
          setTool("none")
          setHoverPos(null)
          setHoveredDrawingId(null)
        }
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [trendlineStart, selectedDrawingId])

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
    boxPrimitive.current = new BoxPrimitive()
    s.attachPrimitive(boxPrimitive.current)
    // Keep the whole session in view when the card resizes, unless the user zoomed.
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          c.resize(Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height), true)
          setChartDim({ width: entry.contentRect.width, height: entry.contentRect.height })
          if (!manualRange.current && bars.current > 0) {
            fitSession(c, bars.current, fullDay)
          }
        }
      }
    })
    ro.observe(el.current)
    const onRangeChange = () => {
      setViewTick((v) => (v + 1) % 100000)
    }
    c.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange)
    const node = el.current
    const markManual = () => { manualRange.current = true }
    if (zoomable) {
      node.addEventListener("wheel", markManual, { passive: true })
      node.addEventListener("pointerdown", markManual)
    }
    return () => {
      ro.disconnect()
      try {
        c.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange)
      } catch {}
      node.removeEventListener("wheel", markManual)
      node.removeEventListener("pointerdown", markManual)
      c.remove()
      chart.current = null
      series.current = null
      markers.current = null
      band.current = null
      boxPrimitive.current = null
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
    const key = JSON.stringify([date, data.length, data.at(-1), currentPrice, setup, trades, keyLevelZone, showKeyLevels, showTradeLevels, boxes])
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
      price: number | string | undefined | null,
      color: string,
      style = LineStyle.Dashed,
      axisLabel = true,
      title = "",
      lineWidth: 1 | 2 | 3 | 4 = 1,
    ) => {
      if (price == null) return
      const p = typeof price === "number" ? price : Number(price)
      if (Number.isNaN(p) || !Number.isFinite(p) || p <= 0) return
      try {
        lines.current.push(s.createPriceLine({ price: p, color, title, lineWidth, lineStyle: style, axisLabelVisible: axisLabel }))
      } catch (err) {
        console.warn("createPriceLine error:", err)
      }
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
        if (!trade) continue
        const slNum = Number(trade.sl)
        const tgtNum = Number(trade.target)
        const ceilNum = Number((trade as any).box_high ?? (trade as any).ceil)
        const floorNum = Number((trade as any).box_low ?? (trade as any).floor)

        if (!Number.isNaN(ceilNum) && Number.isFinite(ceilNum) && ceilNum > 0 && ceilNum >= sessionLow * 0.9 && ceilNum <= sessionHigh * 1.1) {
          add(ceilNum, "rgba(245, 158, 11, 0.85)", LineStyle.Dashed, true, "RES", 1)
        }
        if (!Number.isNaN(floorNum) && Number.isFinite(floorNum) && floorNum > 0 && floorNum >= sessionLow * 0.9 && floorNum <= sessionHigh * 1.1) {
          add(floorNum, "rgba(56, 189, 248, 0.85)", LineStyle.Dashed, true, "SUP", 1)
        }
        if (!Number.isNaN(slNum) && Number.isFinite(slNum) && slNum > 0 && slNum >= sessionLow * 0.9 && slNum <= sessionHigh * 1.1) {
          add(slNum, "#ef4444", LineStyle.Dashed, true, "SL")
        }
        if (!Number.isNaN(tgtNum) && Number.isFinite(tgtNum) && tgtNum > 0 && tgtNum >= sessionLow * 0.9 && tgtNum <= sessionHigh * 1.1) {
          add(tgtNum, "#10b981", LineStyle.Dashed, true, "TGT")
        }
      }
    }

    if (boxes && boxes.length > 0) {
      for (const b of boxes) {
        if (b.ceiling && (!trades || trades.length === 0)) {
          add(b.ceiling, "rgba(245, 158, 11, 0.85)", LineStyle.Dashed, true, "RES", 1)
        }
        if (b.floor && (!trades || trades.length === 0)) {
          add(b.floor, "rgba(56, 189, 248, 0.85)", LineStyle.Dashed, true, "SUP", 1)
        }
      }
    }

    const m: SeriesMarker<Time>[] = []
    const seenTouches = new Set<string>()
    const addTouches = (touchTimes: string[] | undefined, isRes: boolean) => {
      if (!touchTimes || !Array.isArray(touchTimes)) return
      const badges = ["①", "②", "③", "④", "⑤"]
      touchTimes.forEach((tt, idx) => {
        const timeKey = `${tt.slice(0, 5)}_${idx}`
        if (seenTouches.has(timeKey)) return
        seenTouches.add(timeKey)
        const tVal = toTime(date, tt.slice(0, 5))
        if (tVal > 0) {
          m.push({
            time: tVal,
            position: isRes ? "aboveBar" : "belowBar",
            color: isRes ? "#f59e0b" : "#38bdf8",
            shape: "circle",
            text: badges[idx] || `T${idx + 1}`,
            size: 1,
          })
        }
      })
    }

    if (boxes && boxes.length > 0) {
      for (const b of boxes) {
        if (b.touch_times) {
          addTouches(b.touch_times, b.status !== "breakout_down")
        }
      }
    }
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

    if (boxes && boxes.length > 0) {
      const bBoxes: TimeBoundedBox[] = boxes.map((b, idx) => {
        const sTime = toTime(date, b.start_time)
        const eTime = toTime(date, b.end_time || b.break_time || "15:25")
        return {
          id: b.box_id || `box-${idx}`,
          startTime: sTime,
          endTime: eTime,
          ceiling: b.ceiling,
          floor: b.floor,
          midpoint: b.midpoint || (b.ceiling + b.floor) / 2,
          rangePts: b.range_pts || (b.ceiling - b.floor),
          durationBars: b.duration_bars || 14,
          status: b.status || "coiling",
        }
      })
      boxPrimitive.current?.setBoxes(bBoxes)
    } else {
      boxPrimitive.current?.setBoxes([])
    }
    const isFirstBarFit = bars.current === 0 && data.length > 0
    bars.current = data.length
    if (chart.current && !manualRange.current && isFirstBarFit) {
      fitSession(chart.current, data.length, fullDay)
    }
  }, [date, candles, forming, currentPrice, setup, trades, keyLevelZone, showKeyLevels, showTradeLevels, fullDay, resetKey, boxes])

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

  // Coordinate projections for drawn lines with fail-safe fallbacks
  const getHLineY = useCallback(
    (price: number, fallbackY?: number) => {
      if (!series.current) return fallbackY ?? null
      try {
        const y = series.current.priceToCoordinate(price)
        if (y !== null && Number.isFinite(y)) return y
      } catch {}
      return fallbackY ?? null
    },
    [viewTick]
  )

  const getPointCoords = useCallback(
    (p: { time?: number; logical?: number; price: number; x?: number; y?: number }) => {
      if (!chart.current || !series.current) {
        if (p.x != null && p.y != null) return { x: p.x, y: p.y }
        return null
      }
      let x: number | null = null
      let y: number | null = null

      // 1. Try logical index to coordinate first (most accurate continuous index)
      if (p.logical != null) {
        try {
          const lx = chart.current.timeScale().logicalToCoordinate(p.logical as any)
          if (lx !== null && Number.isFinite(lx)) x = lx
        } catch {}
      }

      // 2. Try time to coordinate
      if (x === null && p.time != null) {
        try {
          const tx = chart.current.timeScale().timeToCoordinate(p.time as UTCTimestamp)
          if (tx !== null && Number.isFinite(tx)) x = tx
        } catch {}
      }

      // 3. Fallback to stored pixel X
      if (x === null && p.x != null) {
        x = p.x
      }

      // Convert price to coordinate Y
      try {
        const py = series.current.priceToCoordinate(p.price)
        if (py !== null && Number.isFinite(py)) y = py
      } catch {}

      // Fallback to stored pixel Y
      if (y === null && p.y != null) {
        y = p.y
      }

      if (x === null || y === null) return null
      return { x, y }
    },
    [viewTick]
  )

  // Coordinate extractor for pointer events
  const getEventCoords = (e: React.PointerEvent<SVGRectElement> | React.MouseEvent<SVGRectElement>) => {
    if (!el.current || !series.current || !chart.current) return null
    const rect = el.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const price = series.current.coordinateToPrice(y)
    const time = chart.current.timeScale().coordinateToTime(x)
    const logical = chart.current.timeScale().coordinateToLogical(x)
    return {
      x,
      y,
      price: price != null ? Number(price) : null,
      time: time != null ? Number(time) : null,
      logical: logical != null ? Number(logical) : null,
    }
  }

  // Pointer move handler for active drawing and hover detection
  const handlePointerMoveOnSvg = (e: React.PointerEvent<SVGRectElement>) => {
    const coords = getEventCoords(e)
    if (!coords) return
    setHoverPos(coords)

    // Hover detection for eraser
    if (tool === "eraser") {
      let nearestId: string | null = null
      let minDist = 14
      for (const d of drawings) {
        if (d.type === "hline") {
          const ly = getHLineY(d.price)
          if (ly !== null && Math.abs(coords.y - ly) < minDist) {
            minDist = Math.abs(coords.y - ly)
            nearestId = d.id
          }
        } else if (d.type === "trendline") {
          const c1 = getPointCoords(d.p1)
          const c2 = getPointCoords(d.p2)
          if (c1 && c2) {
            const dist = distToSegment(coords.x, coords.y, c1.x, c1.y, c2.x, c2.y)
            if (dist < minDist) {
              minDist = dist
              nearestId = d.id
            }
          }
        }
      }
      setHoveredDrawingId(nearestId)
    }
  }

  // Pointer down handler for 1-click line creation
  const handlePointerDownOnSvg = (e: React.PointerEvent<SVGRectElement>) => {
    const coords = getEventCoords(e)
    if (!coords || coords.price === null) return
    const { x, y, price, time, logical } = coords

    if (tool === "hline") {
      const newDrawing: ChartDrawing = {
        id: "draw_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
        type: "hline",
        price: Math.round(price * 100) / 100,
        y,
        color: "#38bdf8",
      }
      setDrawings((prev) => [...prev, newDrawing])
      setSelectedDrawingId(newDrawing.id)
      setTool("none")
      setHoverPos(null)
    } else if (tool === "trendline") {
      if (!trendlineStart) {
        // Step 1: Click start point
        setTrendlineStart({
          time: time ?? undefined,
          logical: logical ?? undefined,
          price: Math.round(price * 100) / 100,
          x,
          y,
        })
      } else {
        // Step 2: Click end point -> complete trendline
        const newDrawing: ChartDrawing = {
          id: "draw_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
          type: "trendline",
          p1: {
            time: trendlineStart.time,
            logical: trendlineStart.logical,
            price: trendlineStart.price,
            x: trendlineStart.x,
            y: trendlineStart.y,
          },
          p2: {
            time: time ?? undefined,
            logical: logical ?? undefined,
            price: Math.round(price * 100) / 100,
            x,
            y,
          },
          color: "#f59e0b",
        }
        setDrawings((prev) => [...prev, newDrawing])
        setSelectedDrawingId(newDrawing.id)
        setTrendlineStart(null)
        setTool("none")
        setHoverPos(null)
      }
    } else if (tool === "eraser") {
      if (hoveredDrawingId) {
        setDrawings((prev) => prev.filter((d) => d.id !== hoveredDrawingId))
        setHoveredDrawingId(null)
        if (selectedDrawingId === hoveredDrawingId) setSelectedDrawingId(null)
      }
    }
  }

  const deleteSelected = () => {
    if (!selectedDrawingId) return
    setDrawings((prev) => prev.filter((d) => d.id !== selectedDrawingId))
    setSelectedDrawingId(null)
    setHoveredDrawingId(null)
  }

  const handleStartDragHLine = (e: React.PointerEvent, d: ChartDrawing & { type: "hline" }) => {
    if (tool === "eraser") {
      setDrawings((prev) => prev.filter((item) => item.id !== d.id))
      setSelectedDrawingId(null)
      return
    }
    e.stopPropagation()
    setSelectedDrawingId(d.id)
    if (!el.current) return
    const rect = el.current.getBoundingClientRect()
    const y = e.clientY - rect.top
    dragRef.current = {
      id: d.id,
      type: "hline",
      startY: y,
      startPrice: d.price,
    }
    setIsDragging(true)
  }

  const handleStartDragTrendline = (
    e: React.PointerEvent,
    d: ChartDrawing & { type: "trendline" },
    part: "p1" | "p2" | "body"
  ) => {
    if (tool === "eraser") {
      setDrawings((prev) => prev.filter((item) => item.id !== d.id))
      setSelectedDrawingId(null)
      return
    }
    e.stopPropagation()
    setSelectedDrawingId(d.id)
    if (!el.current) return
    const rect = el.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    dragRef.current = {
      id: d.id,
      type: "trendline",
      part,
      startX: x,
      startY: y,
      startP1: { ...d.p1 },
      startP2: { ...d.p2 },
    }
    setIsDragging(true)
  }

  const clearAllDrawings = () => {
    setDrawings([])
    setSelectedDrawingId(null)
    setTrendlineStart(null)
    setHoveredDrawingId(null)
    try {
      localStorage.removeItem(storageKey)
    } catch {}
  }

  const chartWidth = chartDim.width || 800

  return (
    <div className={cn("relative w-full flex-1 min-h-[300px]", className)} style={{ minHeight: "300px", height: "100%" }}>
      <div ref={el} className="w-full h-full min-h-[300px]" style={{ minHeight: "300px", height: "100%" }} />

      {/* SVG Interactive Drawing Layer */}
      <svg
        className={cn(
          "absolute inset-0 w-full h-full select-none z-10",
          tool !== "none" ? "pointer-events-auto cursor-crosshair" : "pointer-events-none"
        )}
      >
        {/* When a line is selected in pointer mode, an invisible backdrop catches outside clicks to unselect */}
        {tool === "none" && selectedDrawingId !== null && (
          <rect
            width="100%"
            height="100%"
            fill="rgba(0,0,0,0.001)"
            style={{ pointerEvents: "all" }}
            onPointerDown={(e) => {
              e.stopPropagation()
              setSelectedDrawingId(null)
              setHoveredDrawingId(null)
            }}
          />
        )}

        {/* Background event catcher when in active drawing / eraser mode */}
        {tool !== "none" && (
          <rect
            width="100%"
            height="100%"
            fill="rgba(0,0,0,0.001)"
            style={{ pointerEvents: "all" }}
            onPointerMove={handlePointerMoveOnSvg}
            onPointerDown={handlePointerDownOnSvg}
            onPointerLeave={() => {
              setHoverPos(null)
              setHoveredDrawingId(null)
            }}
          />
        )}

        {/* Render Drawn Elements */}
        {drawings.map((d) => {
          const isSelected = d.id === selectedDrawingId
          const isHovered = d.id === hoveredDrawingId

          if (d.type === "hline") {
            const y = getHLineY(d.price, d.y)
            if (y === null || y < 0 || y > chartDim.height) return null
            return (
              <g key={d.id} className="group transition-all">
                {/* Selection / Drag Halo Glow */}
                {isSelected && (
                  <line
                    x1={0}
                    y1={y}
                    x2={chartWidth}
                    y2={y}
                    stroke={isDragging && dragRef.current?.id === d.id ? "#00f0ff" : "#38bdf8"}
                    strokeWidth={isDragging && dragRef.current?.id === d.id ? 7 : 4}
                    opacity={isDragging && dragRef.current?.id === d.id ? 0.7 : 0.35}
                  />
                )}
                {/* Wide invisible hit area for dragging / selection */}
                <line
                  x1={0}
                  y1={y}
                  x2={chartWidth}
                  y2={y}
                  stroke="transparent"
                  strokeWidth={18}
                  className="pointer-events-auto cursor-ns-resize"
                  onPointerDown={(e) => handleStartDragHLine(e, d)}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedDrawingId(d.id)
                  }}
                />
                {/* Visual Line */}
                <line
                  x1={0}
                  y1={y}
                  x2={chartWidth}
                  y2={y}
                  stroke={isHovered ? "#ef4444" : isSelected ? "#38bdf8" : d.color || "#38bdf8"}
                  strokeWidth={isSelected ? 2 : isHovered ? 2.5 : 1.5}
                  strokeDasharray={isSelected ? undefined : "5 3"}
                  opacity={isHovered || isSelected ? 1 : 0.85}
                />
                {/* Selection Drag Handles */}
                {isSelected && (
                  <>
                    <circle
                      cx={chartWidth * 0.25}
                      cy={y}
                      r={4}
                      fill="#38bdf8"
                      stroke="#ffffff"
                      strokeWidth={1.5}
                      className="pointer-events-auto cursor-ns-resize"
                      onPointerDown={(e) => handleStartDragHLine(e, d)}
                    />
                    <circle
                      cx={chartWidth * 0.5}
                      cy={y}
                      r={4.5}
                      fill="#38bdf8"
                      stroke="#ffffff"
                      strokeWidth={1.5}
                      className="pointer-events-auto cursor-ns-resize"
                      onPointerDown={(e) => handleStartDragHLine(e, d)}
                    />
                    <circle
                      cx={chartWidth * 0.75}
                      cy={y}
                      r={4}
                      fill="#38bdf8"
                      stroke="#ffffff"
                      strokeWidth={1.5}
                      className="pointer-events-auto cursor-ns-resize"
                      onPointerDown={(e) => handleStartDragHLine(e, d)}
                    />
                  </>
                )}
                {/* Price Pill Tag on Right Price Scale */}
                <rect
                  x={Math.max(chartWidth - 58, 20)}
                  y={y - 9}
                  width={54}
                  height={18}
                  rx={3}
                  fill={isHovered ? "#ef4444" : isSelected ? "#0284c7" : "#0284c7"}
                  stroke={isSelected ? "#ffffff" : "transparent"}
                  strokeWidth={isSelected ? 1.5 : 0}
                  opacity={0.95}
                  className="pointer-events-auto cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedDrawingId(d.id)
                  }}
                />
                <text
                  x={Math.max(chartWidth - 31, 47)}
                  y={y + 3.5}
                  textAnchor="middle"
                  fill="#ffffff"
                  fontSize={10}
                  fontFamily="monospace"
                  fontWeight="bold"
                  className="pointer-events-none select-none"
                >
                  {isHovered ? "✕ DEL" : Math.round(d.price)}
                </text>
                {/* Floating Contextual Delete Button */}
                {isSelected && (
                  <g
                    transform={`translate(${Math.max(chartWidth - 145, 60)}, ${Math.max(y - 30, 8)})`}
                    className="cursor-pointer pointer-events-auto select-none"
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteSelected()
                    }}
                  >
                    <rect
                      width={74}
                      height={20}
                      rx={4}
                      fill="#ef4444"
                      stroke="#ffffff"
                      strokeWidth={1}
                      filter="drop-shadow(0 2px 4px rgba(0,0,0,0.4))"
                    />
                    <text x={37} y={13.5} textAnchor="middle" fill="#ffffff" fontSize={9.5} fontWeight="bold">
                      ✕ Delete
                    </text>
                  </g>
                )}
              </g>
            )
          }

          if (d.type === "trendline") {
            const c1 = getPointCoords(d.p1)
            const c2 = getPointCoords(d.p2)
            if (!c1 || !c2) return null
            const midX = (c1.x + c2.x) / 2
            const midY = (c1.y + c2.y) / 2
            const deltaPts = Math.round((d.p2.price - d.p1.price) * 10) / 10

            return (
              <g key={d.id} className="group transition-all">
                {/* Selection / Drag Halo Glow */}
                {isSelected && (
                  <line
                    x1={c1.x}
                    y1={c1.y}
                    x2={c2.x}
                    y2={c2.y}
                    stroke={isDragging && dragRef.current?.id === d.id ? "#fbbf24" : "#f59e0b"}
                    strokeWidth={isDragging && dragRef.current?.id === d.id ? 8 : 5}
                    opacity={isDragging && dragRef.current?.id === d.id ? 0.75 : 0.3}
                  />
                )}
                {/* Wide invisible hit area for moving entire line */}
                <line
                  x1={c1.x}
                  y1={c1.y}
                  x2={c2.x}
                  y2={c2.y}
                  stroke="transparent"
                  strokeWidth={20}
                  className="pointer-events-auto cursor-move"
                  onPointerDown={(e) => handleStartDragTrendline(e, d, "body")}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedDrawingId(d.id)
                  }}
                />
                {/* Visual Slant Line */}
                <line
                  x1={c1.x}
                  y1={c1.y}
                  x2={c2.x}
                  y2={c2.y}
                  stroke={isHovered ? "#ef4444" : isSelected ? "#fbbf24" : d.color || "#f59e0b"}
                  strokeWidth={isSelected ? 2.5 : isHovered ? 3 : 2}
                  opacity={isHovered || isSelected ? 1 : 0.9}
                />
                {/* Anchor Endpoint 1 (Start handle) */}
                <circle
                  cx={c1.x}
                  cy={c1.y}
                  r={isSelected ? 6 : 4}
                  fill={isSelected ? "#38bdf8" : isHovered ? "#ef4444" : d.color || "#f59e0b"}
                  stroke="#ffffff"
                  strokeWidth={isSelected ? 2 : 1}
                  className="pointer-events-auto cursor-crosshair"
                  onPointerDown={(e) => handleStartDragTrendline(e, d, "p1")}
                />
                {/* Anchor Endpoint 2 (End handle) */}
                <circle
                  cx={c2.x}
                  cy={c2.y}
                  r={isSelected ? 6 : 4}
                  fill={isSelected ? "#38bdf8" : isHovered ? "#ef4444" : d.color || "#f59e0b"}
                  stroke="#ffffff"
                  strokeWidth={isSelected ? 2 : 1}
                  className="pointer-events-auto cursor-crosshair"
                  onPointerDown={(e) => handleStartDragTrendline(e, d, "p2")}
                />
                {/* Midpoint Info Pill */}
                <rect
                  x={midX - 24}
                  y={midY - 8}
                  width={48}
                  height={16}
                  rx={3}
                  fill={isHovered ? "#ef4444" : isSelected ? "#d97706" : "#b45309"}
                  stroke={isSelected ? "#ffffff" : "transparent"}
                  strokeWidth={isSelected ? 1 : 0}
                  opacity={0.9}
                  className="pointer-events-auto cursor-move"
                  onPointerDown={(e) => handleStartDragTrendline(e, d, "body")}
                />
                <text
                  x={midX}
                  y={midY + 3.5}
                  textAnchor="middle"
                  fill="#ffffff"
                  fontSize={9}
                  fontFamily="monospace"
                  fontWeight="bold"
                  className="pointer-events-none select-none"
                >
                  {isHovered ? "✕ DEL" : `${deltaPts >= 0 ? "+" : ""}${deltaPts}`}
                </text>
                {/* Floating Contextual Delete Button */}
                {isSelected && (
                  <g
                    transform={`translate(${midX - 37}, ${Math.max(midY - 30, 8)})`}
                    className="cursor-pointer pointer-events-auto select-none"
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteSelected()
                    }}
                  >
                    <rect
                      width={74}
                      height={20}
                      rx={4}
                      fill="#ef4444"
                      stroke="#ffffff"
                      strokeWidth={1}
                      filter="drop-shadow(0 2px 4px rgba(0,0,0,0.4))"
                    />
                    <text x={37} y={13.5} textAnchor="middle" fill="#ffffff" fontSize={9.5} fontWeight="bold">
                      ✕ Delete
                    </text>
                  </g>
                )}
              </g>
            )
          }

          return null
        })}

        {/* Live Hover Previews */}
        {tool === "hline" && hoverPos && hoverPos.price !== null && (
          <g>
            {/* Guide line across chart */}
            <line
              x1={0}
              y1={hoverPos.y}
              x2={chartWidth}
              y2={hoverPos.y}
              stroke="#38bdf8"
              strokeWidth={1.5}
              strokeDasharray="3 3"
              opacity={0.8}
            />
            {/* Price badge right scale */}
            <rect
              x={Math.max(chartWidth - 62, 20)}
              y={hoverPos.y - 10}
              width={58}
              height={20}
              rx={4}
              fill="#0284c7"
            />
            <text
              x={Math.max(chartWidth - 33, 49)}
              y={hoverPos.y + 4}
              textAnchor="middle"
              fill="#ffffff"
              fontSize={10}
              fontFamily="monospace"
              fontWeight="bold"
            >
              {hoverPos.price.toFixed(1)}
            </text>
            {/* Floating guidance pill */}
            <g transform={`translate(${Math.min(hoverPos.x + 12, chartWidth - 140)}, ${Math.max(hoverPos.y - 25, 20)})`}>
              <rect width={130} height={20} rx={4} fill="rgba(15, 23, 42, 0.92)" stroke="#38bdf8" strokeWidth={0.8} />
              <text x={65} y={13.5} textAnchor="middle" fill="#38bdf8" fontSize={9.5} fontWeight="500">
                1-Click to place line
              </text>
            </g>
          </g>
        )}

        {tool === "trendline" && hoverPos && (
          <g>
            {!trendlineStart ? (
              /* Step 1 Guide */
              <g transform={`translate(${Math.min(hoverPos.x + 12, chartWidth - 125)}, ${Math.max(hoverPos.y - 25, 20)})`}>
                <rect width={115} height={20} rx={4} fill="rgba(15, 23, 42, 0.92)" stroke="#f59e0b" strokeWidth={0.8} />
                <text x={57.5} y={13.5} textAnchor="middle" fill="#f59e0b" fontSize={9.5} fontWeight="500">
                  Click 1: Start Point
                </text>
              </g>
            ) : (
              /* Step 2 Rubberband Line */
              <>
                <line
                  x1={trendlineStart.x}
                  y1={trendlineStart.y}
                  x2={hoverPos.x}
                  y2={hoverPos.y}
                  stroke="#f59e0b"
                  strokeWidth={2}
                  strokeDasharray="4 2"
                />
                <circle cx={trendlineStart.x} cy={trendlineStart.y} r={4} fill="#f59e0b" stroke="#ffffff" strokeWidth={1} />
                <circle cx={hoverPos.x} cy={hoverPos.y} r={4} fill="#f59e0b" stroke="#ffffff" strokeWidth={1} />
                <g transform={`translate(${Math.min(hoverPos.x + 12, chartWidth - 145)}, ${Math.max(hoverPos.y - 25, 20)})`}>
                  <rect width={140} height={20} rx={4} fill="rgba(15, 23, 42, 0.92)" stroke="#f59e0b" strokeWidth={0.8} />
                  <text x={70} y={13.5} textAnchor="middle" fill="#f59e0b" fontSize={9.5} fontWeight="500">
                    {hoverPos.price != null
                      ? `Click 2: End (${hoverPos.price - trendlineStart.price >= 0 ? "+" : ""}${(hoverPos.price - trendlineStart.price).toFixed(1)} pt)`
                      : "Click 2: End Point"}
                  </text>
                </g>
              </>
            )}
          </g>
        )}

        {tool === "eraser" && hoverPos && (
          <g transform={`translate(${Math.min(hoverPos.x + 12, chartWidth - 110)}, ${Math.max(hoverPos.y - 25, 20)})`}>
            <rect width={105} height={20} rx={4} fill="rgba(15, 23, 42, 0.92)" stroke="#ef4444" strokeWidth={0.8} />
            <text x={52.5} y={13.5} textAnchor="middle" fill="#ef4444" fontSize={9.5} fontWeight="500">
              {hoveredDrawingId ? "Click to Erase" : "Hover over a line"}
            </text>
          </g>
        )}
      </svg>

      {overlay && <div className="pointer-events-none absolute left-2 top-2 z-10 sm:left-3 sm:top-3">{overlay}</div>}

      {/* Floating Drawing & Zoom Toolbar */}
      {zoomable && !hideToolbar && (
        <div className="absolute right-14 top-2 z-20 flex items-center bg-card/90 hover:bg-card backdrop-blur-md border border-border/80 rounded-md shadow-md p-0.5 gap-0.5 transition-all text-xs select-none">
          {/* Pointer / Pan */}
          <Button
            variant={tool === "none" ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={() => {
              setTool("none")
              setTrendlineStart(null)
              setHoverPos(null)
            }}
            className={cn("h-6 w-6", tool === "none" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
            title="Pointer / Pan (Default)"
          >
            <MousePointer2 className="h-3.5 w-3.5" />
          </Button>

          {/* Straight Horizontal Line Tool (One-Click) */}
          <Button
            variant={tool === "hline" ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={() => {
              setTrendlineStart(null)
              setTool(tool === "hline" ? "none" : "hline")
            }}
            className={cn(
              "h-6 w-6",
              tool === "hline"
                ? "bg-sky-500/20 text-sky-400 border border-sky-500/50 shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
            title="Straight Horizontal Line (1-Click on chart)"
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>

          {/* Slant 2-Point Line Tool */}
          <Button
            variant={tool === "trendline" ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={() => {
              setTrendlineStart(null)
              setTool(tool === "trendline" ? "none" : "trendline")
            }}
            className={cn(
              "h-6 w-6",
              tool === "trendline"
                ? "bg-amber-500/20 text-amber-400 border border-amber-500/50 shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
            title="Slant 2-Point Line (Click 2 points)"
          >
            <TrendingUp className="h-3.5 w-3.5" />
          </Button>

          {/* Eraser Tool */}
          <Button
            variant={tool === "eraser" ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={() => {
              setTrendlineStart(null)
              setTool(tool === "eraser" ? "none" : "eraser")
            }}
            className={cn(
              "h-6 w-6",
              tool === "eraser"
                ? "bg-rose-500/20 text-rose-400 border border-rose-500/50 shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
            title="Eraser (Click any line to erase)"
          >
            <Eraser className="h-3.5 w-3.5" />
          </Button>

          {/* Delete Selected Button (Active when a line is selected) */}
          {selectedDrawingId && (
            <Button
              variant="destructive"
              size="xs"
              onClick={deleteSelected}
              className="h-6 px-2 text-[10px] font-semibold gap-1 bg-rose-500 hover:bg-rose-600 text-white shadow-xs animate-in fade-in"
              title="Delete Selected Line (or press Del / Backspace)"
            >
              <Trash2 className="h-3 w-3" />
              <span>Delete (Del)</span>
            </Button>
          )}

          {/* Clear All Drawings (Day) */}
          {drawings.length > 0 && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={clearAllDrawings}
              className="h-6 w-6 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
              title={`Clear All Drawings for Today (${drawings.length})`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}

          <div className="w-[1px] h-3 bg-border mx-0.5" />

          {/* Zoom controls */}
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


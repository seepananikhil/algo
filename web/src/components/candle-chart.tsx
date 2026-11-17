import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import {
  BarChart2,
  Eraser,
  Layers,
  Maximize2,
  Minimize2,
  Minus,
  MousePointer2,
  RotateCcw,
  Trash2,
  TrendingUp,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { useTheme } from "next-themes"
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
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

function fitSession(c: IChartApi, barCount: number, fullDay = false) {
  if (!c || barCount <= 0) return
  try {
    const timeScale = c.timeScale()
    const fromIndex = -4
    const toIndex = fullDay || barCount >= 50 ? barCount + 3 : Math.max(barCount + 2, 38)
    timeScale.setVisibleLogicalRange({ from: fromIndex, to: toIndex })
  } catch {}
}

// Calculate Exponential Moving Average (EMA)
function calculateEMA(data: { time: UTCTimestamp; close: number }[], period: number) {
  if (data.length < period) return []
  const k = 2 / (period + 1)
  let ema = data.slice(0, period).reduce((acc, val) => acc + val.close, 0) / period
  const emaData: { time: UTCTimestamp; value: number }[] = []

  for (let i = period - 1; i < data.length; i++) {
    if (i === period - 1) {
      emaData.push({ time: data[i].time, value: Math.round(ema * 100) / 100 })
    } else {
      ema = data[i].close * k + ema * (1 - k)
      emaData.push({ time: data[i].time, value: Math.round(ema * 100) / 100 })
    }
  }
  return emaData
}

function fmtNum(n?: number | null, decimals = 2): string {
  if (n === null || n === undefined || isNaN(n)) return "0.00"
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtVol(vol?: number | null): string {
  if (!vol || vol <= 0 || isNaN(vol)) return "0"
  if (vol >= 10_000_000) return `${(vol / 10_000_000).toFixed(2)} Cr`
  if (vol >= 100_000) return `${(vol / 100_000).toFixed(2)} L`
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)} K`
  return vol.toLocaleString("en-IN")
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

interface HoveredInfo {
  time: string
  close: number
  volume?: number
  changePts: number
  changePct: number
  ema50?: number
  ema200?: number
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
  /** When true, disables the floating on-hover candle info / OHLC tooltip. */
  hideHoverHUD?: boolean
}

export function CandleChart({
  date,
  symbol = "NIFTY",
  candles,
  forming,
  currentPrice,
  setup,
  trades = [],
  keyLevelZone,
  showKeyLevels = true,
  showTradeLevels = true,
  boxes = [],
  className = "h-[clamp(560px,72vh,750px)]",
  overlay,
  zoomable = false,
  hideToolbar = false,
  fullDay = false,
  resetKey = "",
  hideHoverHUD = true,
}: Props) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null)
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null)
  const ema50Series = useRef<ISeriesApi<"Line"> | null>(null)
  const ema200Series = useRef<ISeriesApi<"Line"> | null>(null)
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const lines = useRef<IPriceLine[]>([])
  const band = useRef<PriceBandPrimitive | null>(null)
  const boxPrimitive = useRef<BoxPrimitive | null>(null)
  const dataKey = useRef<string>("")
  const bars = useRef(0)
  const manualRange = useRef(false)
  const viewKey = useRef("")
  const { resolvedTheme } = useTheme()

  // Feature toggles: Levels, Volume, 50 EMA, 200 EMA, Fullscreen
  const [showVolume, setShowVolume] = useState<boolean>(true)
  const [showLevelsState, setShowLevelsState] = useState<boolean>(true)
  const [showEMA50, setShowEMA50] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("chart_show_ema50")
      return v !== null ? v === "true" : true
    } catch {
      return true
    }
  })
  const [showEMA200, setShowEMA200] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("chart_show_ema200")
      return v !== null ? v === "true" : true
    } catch {
      return true
    }
  })

  const toggleEMA50 = () => {
    setShowEMA50((prev) => {
      const next = !prev
      try {
        localStorage.setItem("chart_show_ema50", String(next))
      } catch {}
      return next
    })
  }

  const toggleEMA200 = () => {
    setShowEMA200((prev) => {
      const next = !prev
      try {
        localStorage.setItem("chart_show_ema200", String(next))
      } catch {}
      return next
    })
  }

  const [isMaximized, setIsMaximized] = useState<boolean>(false)
  const [hovered, setHovered] = useState<HoveredInfo | null>(null)

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

  // Key stats for title bar & HUD
  const stats = useMemo(() => {
    if (!candles || candles.length === 0) return null
    const latest = candles[candles.length - 1]
    const first = candles[0]
    const cmp = currentPrice ?? latest.close
    const base = first.open || cmp
    const dayChangePts = cmp - base
    const dayChangePct = base > 0 ? (dayChangePts / base) * 100 : 0
    let sessionHigh = -Infinity
    let sessionLow = Infinity
    let totalVol = 0
    for (const c of candles) {
      if (c.high > sessionHigh) sessionHigh = c.high
      if (c.low < sessionLow) sessionLow = c.low
      totalVol += c.volume || 0
    }
    return {
      cmp,
      dayChangePts,
      dayChangePct,
      sessionHigh: sessionHigh === -Infinity ? cmp : sessionHigh,
      sessionLow: sessionLow === Infinity ? cmp : sessionLow,
      totalVol,
    }
  }, [candles, currentPrice])

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

    // Prune stale drawings from older dates
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

  // Keyboard controls: Delete / Backspace to delete drawing, Escape to exit fullscreen / deselect
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedDrawingId) {
        e.preventDefault()
        setDrawings((prev) => prev.filter((d) => d.id !== selectedDrawingId))
        setSelectedDrawingId(null)
        setHoveredDrawingId(null)
      } else if (e.key === "Escape") {
        if (isMaximized) {
          setIsMaximized(false)
        } else if (trendlineStart) {
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
  }, [trendlineStart, selectedDrawingId, isMaximized])

  // Build the lightweight chart instance
  useEffect(() => {
    if (!el.current) return
    const isLight = resolvedTheme === "light"
    const gridLineColor = isLight ? "rgba(241, 245, 249, 0.8)" : "rgba(255, 255, 255, 0.04)"
    const borderColor = isLight ? "#e2e8f0" : "rgba(255, 255, 255, 0.1)"
    const textColor = isLight ? "#64748b" : "#94a3b8"

    const c = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: textColor,
        fontSize: 11,
        fontFamily: "Geist Mono, monospace, sans-serif",
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: gridLineColor },
      },
      crosshair: {
        mode: 1, // Magnet crosshair for smooth tracking
      },
      rightPriceScale: {
        borderColor: borderColor,
        scaleMargins: {
          top: 0.06,
          bottom: showVolume ? 0.20 : 0.05,
        },
        entireTextOnly: true,
      },
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
      handleScroll: zoomable,
      handleScale: zoomable,
    })

    // 1. Candlestick Series (TradingView Standard Crisp Colors)
    const s = c.addSeries(CandlestickSeries, {
      upColor: "#10b981", // Crisp mint-emerald
      downColor: "#ef4444", // Modern clean crimson
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

    // 2. Volume Histogram Series at Bottom
    const volSeries = c.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "", // Overlay at bottom
    })
    volSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.82,
        bottom: 0,
      },
    })
    volumeSeries.current = volSeries

    // 3. Technical Indicator Lines (50 EMA & 200 EMA)
    const e50 = c.addSeries(LineSeries, {
      color: "#06b6d4",
      lineWidth: 2,
      title: "50 EMA",
      priceLineVisible: false,
    })
    ema50Series.current = e50

    const e200 = c.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 2,
      title: "200 EMA",
      priceLineVisible: false,
    })
    ema200Series.current = e200

    markers.current = createSeriesMarkers(s, [])
    band.current = new PriceBandPrimitive()
    s.attachPrimitive(band.current)
    boxPrimitive.current = new BoxPrimitive()
    s.attachPrimitive(boxPrimitive.current)

    // Floating Crosshair HUD subscriber (Clean, prominent price + gain + volume + EMAs)
    const onCrosshairMove = (param: any) => {
      if (!param.time || !param.seriesData || !series.current) {
        setHovered(null)
        return
      }
      const barData = param.seriesData.get(series.current) as any
      if (barData) {
        const timeVal = param.time as UTCTimestamp
        const d = new Date(timeVal * 1000)
        const hh = String(d.getUTCHours()).padStart(2, "0")
        const mm = String(d.getUTCMinutes()).padStart(2, "0")
        const timeStr = `${hh}:${mm}`

        const closePrice = typeof barData.close === "number" ? barData.close : barData.value ?? 0
        const openPrice = typeof barData.open === "number" ? barData.open : closePrice
        const pts = closePrice - openPrice
        const pct = openPrice > 0 ? (pts / openPrice) * 100 : 0
        const vData = volumeSeries.current ? (param.seriesData.get(volumeSeries.current) as any) : null
        const e50Data = ema50Series.current ? (param.seriesData.get(ema50Series.current) as any) : null
        const e200Data = ema200Series.current ? (param.seriesData.get(ema200Series.current) as any) : null

        setHovered({
          time: timeStr,
          close: closePrice,
          volume: vData?.value ?? 0,
          changePts: pts,
          changePct: pct,
          ema50: typeof e50Data?.value === "number" ? e50Data.value : undefined,
          ema200: typeof e200Data?.value === "number" ? e200Data.value : undefined,
        })
      } else {
        setHovered(null)
      }
    }
    c.subscribeCrosshairMove(onCrosshairMove)

    // Resize Observer keeps session in view
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
    const markManual = () => {
      manualRange.current = true
    }
    if (zoomable) {
      node.addEventListener("wheel", markManual, { passive: true })
      node.addEventListener("pointerdown", markManual)
    }

    return () => {
      ro.disconnect()
      try {
        c.unsubscribeCrosshairMove(onCrosshairMove)
        c.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange)
      } catch {}
      node.removeEventListener("wheel", markManual)
      node.removeEventListener("pointerdown", markManual)
      c.remove()
      chart.current = null
      series.current = null
      volumeSeries.current = null
      ema50Series.current = null
      ema200Series.current = null
      markers.current = null
      band.current = null
      boxPrimitive.current = null
      lines.current = []
      dataKey.current = ""
    }
  }, [])

  // Update theme colors
  useEffect(() => {
    const light = resolvedTheme === "light"
    const line = light ? "rgba(241, 245, 249, 0.8)" : "rgba(255, 255, 255, 0.04)"
    const border = light ? "#e2e8f0" : "rgba(255, 255, 255, 0.1)"
    chart.current?.applyOptions({
      layout: { textColor: light ? "#64748b" : "#94a3b8", fontSize: 11 },
      grid: { horzLines: { color: line } },
      rightPriceScale: { borderColor: border, scaleMargins: { top: 0.06, bottom: showVolume ? 0.20 : 0.05 }, entireTextOnly: true },
      timeScale: { borderColor: border },
    })
  }, [resolvedTheme, showVolume])

  // Resize when maximizing or restoring
  useEffect(() => {
    const timer = setTimeout(() => {
      if (chart.current && el.current) {
        chart.current.resize(el.current.clientWidth, el.current.clientHeight, true)
        setChartDim({ width: el.current.clientWidth, height: el.current.clientHeight })
        fitSession(chart.current, bars.current, fullDay)
      }
    }, 60)
    return () => clearTimeout(timer)
  }, [isMaximized, fullDay])

  // Data population
  useEffect(() => {
    const s = series.current
    if (!s) return
    const dataMap = new Map<number, { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume?: number }>()
    for (const k of candles) {
      if (k.open == null || k.high == null || k.low == null || k.close == null) continue
      const t = toTime(date, k.time)
      if (t > 0) {
        dataMap.set(t, { time: t, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume || 0 })
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
          volume: forming.volume || 0,
        })
      }
    }
    const data = Array.from(dataMap.values()).sort((a, b) => (a.time as number) - (b.time as number))

    const frame = `${date}|${resetKey}`
    if (viewKey.current !== frame) {
      viewKey.current = frame
      manualRange.current = false
    }
    const key = JSON.stringify([
      date,
      data.length,
      data.at(-1),
      currentPrice,
      setup,
      trades,
      keyLevelZone,
      showKeyLevels,
      showTradeLevels,
      boxes,
      showVolume,
      showLevelsState,
      showEMA50,
      showEMA200,
    ])
    if (key === dataKey.current) return
    dataKey.current = key

    try {
      s.setData(data)
    } catch (err) {
      console.warn("CandleChart setData error:", err)
    }

    // Populate Volume Data
    if (volumeSeries.current) {
      if (showVolume && data.length > 0) {
        const volData = data.map((c) => ({
          time: c.time,
          value: c.volume || 0,
          color: c.close >= c.open ? "rgba(16, 185, 129, 0.30)" : "rgba(239, 68, 68, 0.25)",
        }))
        volumeSeries.current.setData(volData)
      } else {
        volumeSeries.current.setData([])
      }
    }

    // Technical Indicator Lines (50 EMA & 200 EMA)
    const rawEmaData = data.map((d) => ({
      time: d.time as UTCTimestamp,
      close: d.close,
    }))

    if (ema50Series.current) {
      if (showEMA50 && rawEmaData.length >= 50) {
        ema50Series.current.setData(calculateEMA(rawEmaData, 50))
        ema50Series.current.applyOptions({ visible: true })
      } else {
        ema50Series.current.setData([])
        ema50Series.current.applyOptions({ visible: false })
      }
    }

    if (ema200Series.current) {
      if (showEMA200 && rawEmaData.length >= 200) {
        ema200Series.current.setData(calculateEMA(rawEmaData, 200))
        ema200Series.current.applyOptions({ visible: true })
      } else {
        ema200Series.current.setData([])
        ema200Series.current.applyOptions({ visible: false })
      }
    }

    // Populate Price Lines & Key Levels
    lines.current.forEach((l) => s.removePriceLine(l))
    lines.current = []
    const add = (
      price: number | string | undefined | null,
      color: string,
      style = LineStyle.Dashed,
      axisLabel = true,
      title = "",
      lineWidth: 1 | 2 | 3 | 4 = 1
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

    let sessionLow = Infinity
    let sessionHigh = -Infinity
    for (const bar of data) {
      if (bar.low < sessionLow) sessionLow = bar.low
      if (bar.high > sessionHigh) sessionHigh = bar.high
    }

    const bands: Band[] = []

    if (showLevelsState) {
      // Subtle reference lines
      if (currentPrice != null) {
        add(currentPrice, "rgba(249, 115, 22, 0.7)", LineStyle.Dotted, false, "", 1)
      }
      add(setup?.range_high, "rgba(56, 189, 248, 0.65)", LineStyle.Dashed, false, "HIGH", 1)
      add(setup?.range_low, "rgba(56, 189, 248, 0.65)", LineStyle.Dashed, false, "LOW", 1)
      add(setup?.mid, "#fbbf24", LineStyle.Solid, true, "MID", 2)

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

      if (setup?.armed) add(setup.armed.level, "#c084fc", LineStyle.Solid, true, "ARMED", 2)

      if (showTradeLevels) {
        for (const trade of trades) {
          if (!trade) continue
          const slNum = Number(trade.sl)
          const tgtNum = Number(trade.target)
          const entryNum = Number(trade.entry_price)
          const isOpen = trade.reason === "open" || (trade as any).is_open || !trade.exit
          const isCall = trade.side === "CALL" || trade.side === "LONG" || trade.side === "CE"
          const ceilNum = Number((trade as any).box_high ?? (trade as any).ceil)
          const floorNum = Number((trade as any).box_low ?? (trade as any).floor)

          if (!Number.isNaN(ceilNum) && Number.isFinite(ceilNum) && ceilNum > 0 && ceilNum >= sessionLow * 0.9 && ceilNum <= sessionHigh * 1.1) {
            add(ceilNum, "rgba(245, 158, 11, 0.85)", LineStyle.Dashed, true, "RES", 1)
          }
          if (!Number.isNaN(floorNum) && Number.isFinite(floorNum) && floorNum > 0 && floorNum >= sessionLow * 0.9 && floorNum <= sessionHigh * 1.1) {
            add(floorNum, "rgba(56, 189, 248, 0.85)", LineStyle.Dashed, true, "SUP", 1)
          }

          // 1. Entry Level Line for Active / Open Position
          if (isOpen && !Number.isNaN(entryNum) && Number.isFinite(entryNum) && entryNum > 0 && entryNum >= sessionLow * 0.9 && entryNum <= sessionHigh * 1.1) {
            add(
              entryNum,
              isCall ? "rgba(16, 185, 129, 0.95)" : "rgba(244, 63, 94, 0.95)",
              LineStyle.Solid,
              true,
              `ENTRY: ${fmtNum(entryNum, 1)} (${trade.side || "BUY"})`,
              2
            )
          }

          // 2. Stop Loss / Trailing Stop Loss Line
          if (!Number.isNaN(slNum) && Number.isFinite(slNum) && slNum > 0 && slNum >= sessionLow * 0.9 && slNum <= sessionHigh * 1.1) {
            const isProfitLock = isOpen && ((isCall && slNum > entryNum) || (!isCall && slNum < entryNum))
            add(
              slNum,
              isProfitLock ? "#f59e0b" : "#ef4444",
              LineStyle.Dashed,
              true,
              isOpen ? (isProfitLock ? `TRAILING SL: ${fmtNum(slNum, 1)} (LOCK)` : `STOP LOSS: ${fmtNum(slNum, 1)}`) : "SL",
              isOpen ? 2 : 1
            )
          }

          // 3. Target Level Line
          if (!Number.isNaN(tgtNum) && Number.isFinite(tgtNum) && tgtNum > 0 && tgtNum >= sessionLow * 0.9 && tgtNum <= sessionHigh * 1.1) {
            add(
              tgtNum,
              "#10b981",
              LineStyle.Dashed,
              true,
              isOpen ? `TARGET: ${fmtNum(tgtNum, 1)}` : "TGT",
              isOpen ? 2 : 1
            )
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
    }

    band.current?.setBands(bands)

    // Markers
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

    if (boxes && boxes.length > 0 && showLevelsState) {
      for (const b of boxes) {
        if (b.touch_times) {
          addTouches(b.touch_times, b.status !== "breakout_down")
        }
      }
    }
    for (const t of trades) {
      const call = t.side === "CALL" || t.side === "LONG" || t.side === "CE"
      if (t.entry) {
        m.push({
          time: toTime(date, t.entry.slice(0, 5)),
          position: call ? "belowBar" : "aboveBar",
          color: call ? "#10b981" : "#ef4444",
          shape: call ? "arrowUp" : "arrowDown",
          size: 1.5,
          text: `BUY @ ${t.entry_price ? fmtNum(t.entry_price, 1) : ""}`,
        })
      }
      if (t.exit && !(t.reason && t.reason.endsWith("open"))) {
        m.push({
          time: toTime(date, t.exit.slice(0, 5)),
          position: call ? "aboveBar" : "belowBar",
          color: "#71717a",
          shape: call ? "arrowDown" : "arrowUp",
          size: 1.5,
          text: `EXIT ${t.pnl_points ? `(${t.pnl_points > 0 ? "+" : ""}${fmtNum(t.pnl_points, 1)} pts)` : ""}`,
        })
      }
    }
    m.sort((a, b) => (a.time as number) - (b.time as number))
    try {
      markers.current?.setMarkers(m)
    } catch (e) {
      console.warn("CandleChart: failed to set markers", e)
    }

    if (boxes && boxes.length > 0 && showLevelsState) {
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
  }, [
    date,
    candles,
    forming,
    currentPrice,
    setup,
    trades,
    keyLevelZone,
    showKeyLevels,
    showTradeLevels,
    fullDay,
    resetKey,
    boxes,
    showVolume,
    showLevelsState,
    showEMA50,
    showEMA200,
  ])

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

  // Coordinate projections for drawn lines
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

      if (p.logical != null) {
        try {
          const lx = chart.current.timeScale().logicalToCoordinate(p.logical as any)
          if (lx !== null && Number.isFinite(lx)) x = lx
        } catch {}
      }

      if (x === null && p.time != null) {
        try {
          const tx = chart.current.timeScale().timeToCoordinate(p.time as UTCTimestamp)
          if (tx !== null && Number.isFinite(tx)) x = tx
        } catch {}
      }

      if (x === null && p.x != null) {
        x = p.x
      }

      try {
        const py = series.current.priceToCoordinate(p.price)
        if (py !== null && Number.isFinite(py)) y = py
      } catch {}

      if (y === null && p.y != null) {
        y = p.y
      }

      if (x === null || y === null) return null
      return { x, y }
    },
    [viewTick]
  )

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

  const handlePointerMoveOnSvg = (e: React.PointerEvent<SVGRectElement>) => {
    const coords = getEventCoords(e)
    if (!coords) return
    setHoverPos(coords)

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
        setTrendlineStart({
          time: time ?? undefined,
          logical: logical ?? undefined,
          price: Math.round(price * 100) / 100,
          x,
          y,
        })
      } else {
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

  // The controls toolbar: Prominent Drawing Tools, Levels, Volume & Fullscreen (no EMA clutter)
  const renderToolbar = (isHeaderLayout = false) => (
    <div
      className={cn(
        "flex items-center gap-1.5 flex-wrap select-none text-xs",
        isHeaderLayout
          ? "bg-transparent p-0"
          : "absolute right-3 top-2.5 z-20 bg-background/90 dark:bg-slate-900/90 hover:bg-background dark:hover:bg-slate-900 backdrop-blur-md border border-border/80 rounded-lg shadow-md p-1 gap-1"
      )}
    >
      {/* 1. Drawing Tools (Primary Focus) */}
      <div className="flex items-center gap-0.5">
        <Button
          variant={tool === "none" ? "secondary" : "ghost"}
          size="icon-xs"
          onClick={() => {
            setTool("none")
            setTrendlineStart(null)
            setHoverPos(null)
          }}
          className={cn(
            "h-6 w-6 rounded cursor-pointer",
            tool === "none" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
          )}
          title="Pointer / Pan (Default)"
        >
          <MousePointer2 className="h-3 w-3" />
        </Button>

        <Button
          variant={tool === "hline" ? "secondary" : "ghost"}
          size="icon-xs"
          onClick={() => {
            setTrendlineStart(null)
            setTool(tool === "hline" ? "none" : "hline")
          }}
          className={cn(
            "h-6 w-6 rounded cursor-pointer",
            tool === "hline"
              ? "bg-sky-500/20 text-sky-400 border border-sky-500/50 shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          )}
          title="Straight Horizontal Line (1-Click on chart)"
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>

        <Button
          variant={tool === "trendline" ? "secondary" : "ghost"}
          size="icon-xs"
          onClick={() => {
            setTrendlineStart(null)
            setTool(tool === "trendline" ? "none" : "trendline")
          }}
          className={cn(
            "h-6 w-6 rounded cursor-pointer",
            tool === "trendline"
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/50 shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          )}
          title="Slant 2-Point Line (Click 2 points)"
        >
          <TrendingUp className="h-3.5 w-3.5" />
        </Button>

        <Button
          variant={tool === "eraser" ? "secondary" : "ghost"}
          size="icon-xs"
          onClick={() => {
            setTrendlineStart(null)
            setTool(tool === "eraser" ? "none" : "eraser")
          }}
          className={cn(
            "h-6 w-6 rounded cursor-pointer",
            tool === "eraser"
              ? "bg-rose-500/20 text-rose-400 border border-rose-500/50 shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          )}
          title="Eraser (Click any line to erase)"
        >
          <Eraser className="h-3.5 w-3.5" />
        </Button>

        {selectedDrawingId && (
          <Button
            variant="destructive"
            size="xs"
            onClick={deleteSelected}
            className="h-6 px-1.5 text-[10px] font-semibold gap-1 bg-rose-500 hover:bg-rose-600 text-white shadow-xs animate-in fade-in cursor-pointer"
            title="Delete Selected Line (Del / Backspace)"
          >
            <Trash2 className="h-3 w-3" />
            <span>Del</span>
          </Button>
        )}

        {drawings.length > 0 && !selectedDrawingId && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={clearAllDrawings}
            className="h-6 w-6 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer"
            title={`Clear All Drawings for Today (${drawings.length})`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="w-[1px] h-3.5 bg-border mx-0.5" />

      {/* 2. Layer Toggles (Levels & Volume) */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setShowLevelsState(!showLevelsState)}
          className={cn(
            "h-6 px-2 rounded text-[11px] font-bold border transition-all flex items-center gap-1 cursor-pointer",
            showLevelsState
              ? "bg-sky-500/15 text-sky-500 dark:text-sky-400 border-sky-500/40 shadow-2xs"
              : "bg-muted/40 text-muted-foreground border-transparent hover:text-foreground"
          )}
          title="Toggle S&R Key Levels & Trade Targets"
        >
          <Layers className="h-3 w-3" />
          <span>Levels</span>
        </button>

        <button
          type="button"
          onClick={() => setShowVolume(!showVolume)}
          className={cn(
            "h-6 px-2 rounded text-[11px] font-bold border transition-all flex items-center gap-1 cursor-pointer",
            showVolume
              ? "bg-emerald-500/15 text-emerald-500 dark:text-emerald-400 border-emerald-500/40 shadow-2xs"
              : "bg-muted/40 text-muted-foreground border-transparent hover:text-foreground"
          )}
          title="Toggle Volume Histogram"
        >
          <BarChart2 className="h-3 w-3" />
          <span>Vol</span>
        </button>

        <button
          type="button"
          onClick={toggleEMA50}
          className={cn(
            "h-6 px-2 rounded text-[11px] font-bold border transition-all flex items-center gap-1 cursor-pointer",
            showEMA50
              ? "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/40 shadow-2xs"
              : "bg-muted/40 text-muted-foreground border-transparent hover:text-foreground"
          )}
          title="Toggle 50 EMA Line"
        >
          <span className="w-2 h-0.5 bg-cyan-500 rounded-full inline-block" />
          <span>50 EMA</span>
        </button>

        <button
          type="button"
          onClick={toggleEMA200}
          className={cn(
            "h-6 px-2 rounded text-[11px] font-bold border transition-all flex items-center gap-1 cursor-pointer",
            showEMA200
              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/40 shadow-2xs"
              : "bg-muted/40 text-muted-foreground border-transparent hover:text-foreground"
          )}
          title="Toggle 200 EMA Line"
        >
          <span className="w-2 h-0.5 bg-amber-500 rounded-full inline-block" />
          <span>200 EMA</span>
        </button>
      </div>

      <div className="w-[1px] h-3.5 bg-border mx-0.5" />

      {/* 3. Navigation & Fullscreen */}
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => zoom(0.7)}
          className="h-6 w-6 text-muted-foreground hover:text-foreground cursor-pointer"
          title="Zoom In"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => zoom(1.4)}
          className="h-6 w-6 text-muted-foreground hover:text-foreground cursor-pointer"
          title="Zoom Out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={reset}
          className="h-6 px-1.5 text-[10px] font-semibold text-muted-foreground hover:text-foreground gap-1 cursor-pointer"
          title="Reset View to Full Session"
        >
          <RotateCcw className="h-2.5 w-2.5" />
          <span>Reset</span>
        </Button>

        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setIsMaximized(!isMaximized)}
          className="h-6 w-6 text-muted-foreground hover:text-foreground cursor-pointer"
          title={isMaximized ? "Restore Normal View (Esc)" : "Maximize Fullscreen View"}
        >
          {isMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )

  // Floating In-Chart Live Crosshair HUD (Clean, prominent price + gain + volume, no raw OHLC clutter)
  const renderFloatingHUD = () => {
    if (hideHoverHUD) return null
    return (
    <>
      {hovered ? (
        <div className="absolute top-3 left-3 sm:top-4 sm:left-4 z-20 pointer-events-none flex items-center gap-2.5 font-mono bg-background/95 dark:bg-slate-900/95 backdrop-blur-md px-3.5 py-2 rounded-xl border border-border shadow-lg animate-in fade-in duration-100">
          <span className="text-xs sm:text-sm font-semibold text-muted-foreground">{hovered.time}</span>
          <span className="text-muted-foreground/30 text-sm">·</span>
          <span className="text-sm sm:text-base font-black text-foreground tracking-tight">₹{fmtNum(hovered.close, 1)}</span>
          <span
            className={cn(
              "font-black px-2 py-0.5 rounded-md text-xs sm:text-sm tracking-tight",
              hovered.changePts >= 0
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25"
                : "bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/25"
            )}
          >
            {hovered.changePts >= 0 ? "+" : ""}
            {fmtNum(hovered.changePts, 1)} ({hovered.changePct >= 0 ? "+" : ""}
            {hovered.changePct.toFixed(2)}%)
          </span>
          {hovered.volume ? (
            <>
              <span className="text-muted-foreground/30 text-sm">·</span>
              <span className="text-xs font-semibold text-muted-foreground">Vol: {fmtVol(hovered.volume)}</span>
            </>
          ) : null}
          {showEMA50 && hovered.ema50 ? (
            <>
              <span className="text-muted-foreground/30 text-sm">·</span>
              <span className="text-xs font-semibold text-cyan-500">50 EMA: ₹{fmtNum(hovered.ema50, 1)}</span>
            </>
          ) : null}
          {showEMA200 && hovered.ema200 ? (
            <>
              <span className="text-muted-foreground/30 text-sm">·</span>
              <span className="text-xs font-semibold text-amber-500">200 EMA: ₹{fmtNum(hovered.ema200, 1)}</span>
            </>
          ) : null}
        </div>
      ) : null}
    </>
    )
  }

  // Slim interactive footer with legend & shortcuts
  const renderFooter = () => (
    <div className="px-3.5 py-1.5 border-t border-border/40 bg-muted/20 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground select-none shrink-0">
      <div className="flex items-center gap-3.5 flex-wrap">
        {showEMA50 && (
          <span className="flex items-center gap-1.5 font-medium text-cyan-600 dark:text-cyan-400">
            <span className="w-2.5 h-0.5 bg-cyan-500 inline-block" />
            50 EMA
          </span>
        )}
        {showEMA200 && (
          <span className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
            <span className="w-2.5 h-0.5 bg-amber-500 inline-block" />
            200 EMA
          </span>
        )}
        {showLevelsState && (
          <span className="flex items-center gap-1.5 font-medium text-sky-600 dark:text-sky-400">
            <span className="w-2.5 h-0.5 bg-sky-500 border-b border-dashed inline-block" />
            Key Levels &amp; S&amp;R
          </span>
        )}
        {drawings.length > 0 && (
          <span className="flex items-center gap-1 font-semibold text-primary">
            <span>✏️ {drawings.length} drawing{drawings.length > 1 ? "s" : ""}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
        <span>Scroll to Zoom · Drag to Pan · Click to Draw</span>
        <span>
          <kbd className="px-1 py-0.2 bg-muted border border-border rounded text-foreground font-semibold">
            ESC
          </kbd>{" "}
          {isMaximized ? "restore" : "unselect"}
        </span>
      </div>
    </div>
  )

  // SVG Drawing Overlay
  const renderSvgOverlay = () => (
    <svg
      className={cn(
        "absolute inset-0 w-full h-full select-none z-10",
        tool !== "none" ? "pointer-events-auto cursor-crosshair" : "pointer-events-none"
      )}
    >
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

      {drawings.map((d) => {
        const isSelected = d.id === selectedDrawingId
        const isHovered = d.id === hoveredDrawingId

        if (d.type === "hline") {
          const y = getHLineY(d.price, d.y)
          if (y === null || y < 0 || y > chartDim.height) return null
          return (
            <g key={d.id} className="group transition-all">
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
            </g>
          )
        } else if (d.type === "trendline") {
          const c1 = getPointCoords(d.p1)
          const c2 = getPointCoords(d.p2)
          if (!c1 || !c2) return null
          return (
            <g key={d.id} className="group transition-all">
              {isSelected && (
                <line
                  x1={c1.x}
                  y1={c1.y}
                  x2={c2.x}
                  y2={c2.y}
                  stroke={isDragging && dragRef.current?.id === d.id ? "#00f0ff" : "#f59e0b"}
                  strokeWidth={isDragging && dragRef.current?.id === d.id ? 7 : 4}
                  opacity={isDragging && dragRef.current?.id === d.id ? 0.7 : 0.35}
                />
              )}
              <line
                x1={c1.x}
                y1={c1.y}
                x2={c2.x}
                y2={c2.y}
                stroke="transparent"
                strokeWidth={18}
                className="pointer-events-auto cursor-move"
                onPointerDown={(e) => handleStartDragTrendline(e, d, "body")}
                onClick={(e) => {
                  e.stopPropagation()
                  setSelectedDrawingId(d.id)
                }}
              />
              <line
                x1={c1.x}
                y1={c1.y}
                x2={c2.x}
                y2={c2.y}
                stroke={isHovered ? "#ef4444" : isSelected ? "#f59e0b" : d.color || "#f59e0b"}
                strokeWidth={isSelected ? 2.5 : isHovered ? 2.5 : 1.8}
                strokeDasharray={isSelected ? undefined : "5 3"}
                opacity={isHovered || isSelected ? 1 : 0.85}
              />
              {isSelected && (
                <>
                  <circle
                    cx={c1.x}
                    cy={c1.y}
                    r={5}
                    fill="#f59e0b"
                    stroke="#ffffff"
                    strokeWidth={1.5}
                    className="pointer-events-auto cursor-grab active:cursor-grabbing"
                    onPointerDown={(e) => handleStartDragTrendline(e, d, "p1")}
                  />
                  <circle
                    cx={(c1.x + c2.x) / 2}
                    cy={(c1.y + c2.y) / 2}
                    r={4}
                    fill="#f59e0b"
                    stroke="#ffffff"
                    strokeWidth={1.5}
                    className="pointer-events-auto cursor-move"
                    onPointerDown={(e) => handleStartDragTrendline(e, d, "body")}
                  />
                  <circle
                    cx={c2.x}
                    cy={c2.y}
                    r={5}
                    fill="#f59e0b"
                    stroke="#ffffff"
                    strokeWidth={1.5}
                    className="pointer-events-auto cursor-grab active:cursor-grabbing"
                    onPointerDown={(e) => handleStartDragTrendline(e, d, "p2")}
                  />
                </>
              )}
            </g>
          )
        }
        return null
      })}

      {tool === "trendline" && trendlineStart && hoverPos && (
        <line
          x1={trendlineStart.x}
          y1={trendlineStart.y}
          x2={hoverPos.x}
          y2={hoverPos.y}
          stroke="#f59e0b"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          opacity={0.8}
        />
      )}
    </svg>
  )

  // 1. FULLSCREEN / MAXIMIZED MODAL OVERLAY (Swinger Executive Experience)
  if (isMaximized) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in duration-150">
        <div className="bg-card rounded-2xl border border-border shadow-2xl flex flex-col w-[98vw] h-[96vh] max-w-none max-h-none overflow-hidden transition-all duration-200">
          {/* Executive Title Bar */}
          <div className="px-5 py-3.5 border-b border-border bg-card flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-3">
              <div className="size-9 rounded-xl bg-slate-900 dark:bg-slate-800 flex items-center justify-center font-bold text-white text-xs font-mono shadow-xs">
                {(symbol || "NIF").slice(0, 3)}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-black tracking-tight text-foreground font-mono">
                    {symbol === "SENSEX" ? "BSE SENSEX" : "NSE NIFTY 50"}
                  </h2>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-muted text-muted-foreground font-mono font-bold">
                    {date}
                  </span>
                </div>
                {stats && (
                  <div className="flex items-center gap-2 text-xs mt-0.5">
                    <span className="font-extrabold font-mono text-foreground">₹{fmtNum(stats.cmp, 1)}</span>
                    <span
                      className={cn(
                        "font-mono font-bold px-1.5 py-0.2 rounded text-[11px]",
                        stats.dayChangePts >= 0
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                      )}
                    >
                      {stats.dayChangePts >= 0 ? "+" : ""}
                      {fmtNum(stats.dayChangePts, 1)} ({stats.dayChangePct >= 0 ? "+" : ""}
                      {stats.dayChangePct.toFixed(2)}%)
                    </span>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="text-muted-foreground text-[11px]">
                      Range: ₹{fmtNum(stats.sessionLow, 0)} - ₹{fmtNum(stats.sessionHigh, 0)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Right: Controls & Restore/Close */}
            <div className="flex items-center gap-2">
              {renderToolbar(true)}
              <div className="border-l border-border pl-2 flex items-center">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsMaximized(false)}
                  className="size-8 rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Close Fullscreen (Esc)"
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* Chart Canvas Area */}
          <div className="flex-1 relative w-full h-full min-h-[400px] overflow-hidden bg-background">
            {renderFloatingHUD()}
            {renderSvgOverlay()}
            <div ref={el} className="w-full h-full" />
          </div>

          {/* Footer */}
          {renderFooter()}
        </div>
      </div>
    )
  }

  // 2. NORMAL EMBEDDED CHART VIEW
  return (
    <div className={cn("relative w-full flex-1 flex flex-col rounded-lg overflow-hidden border border-border/40 bg-card shadow-2xs", className)}>
      {/* Chart Canvas */}
      <div className="flex-1 relative w-full h-full min-h-[340px]">
        {/* Floating Controls Toolbar */}
        {!hideToolbar && renderToolbar(false)}

        {/* Floating Crosshair HUD */}
        {renderFloatingHUD()}

        {/* SVG Drawing Layer */}
        {renderSvgOverlay()}

        {/* Lightweight Charts Canvas */}
        <div ref={el} className="absolute inset-0 w-full h-full" />

        {overlay && <div className="pointer-events-none absolute left-3 top-3 z-10">{overlay}</div>}
      </div>

      {/* Slim interactive footer with legend */}
      {renderFooter()}
    </div>
  )
}

import { useEffect, useRef, useState, useMemo } from "react"
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time
} from "lightweight-charts"
import {
  X,
  RefreshCw,
  Maximize2,
  Minimize2,
  BarChart2,
  ChevronLeft,
  ChevronRight,
  Layers
} from "lucide-react"
import { Button } from "@/components/ui/button"

export interface SwingerTradeTarget {
  symbol: string
  name?: string
  entry_date?: string
  exit_date?: string
  entry_price?: number
  avg_price?: number
  exit_price?: number
  cmp?: number
  pnl?: number
  pnl_pct?: number
  pct_return?: number
  reason?: string
  exit_reason?: string
  days_held?: number
  holding_days?: number
  qty?: number
  shares?: number
  status?: string
}

interface CandleData {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

interface HoveredInfo {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume?: number
  changePct: number
  changePts: number
  ema200?: number
}

// Sanitize any arbitrary date string into a guaranteed valid candle time
function sanitizeDateToCandleTime(dateStr?: string, candles: CandleData[] = []): string | null {
  if (!dateStr || candles.length === 0) return null
  let normalized = dateStr.trim()
  if (normalized.toLowerCase() === "today") {
    normalized = new Date().toISOString().slice(0, 10)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const d = new Date(normalized)
    if (!isNaN(d.getTime())) {
      normalized = d.toISOString().slice(0, 10)
    } else {
      return null
    }
  }

  // Exact match in candles
  if (candles.some((c) => c.time === normalized)) {
    return normalized
  }

  // If date is before first candle, clamp to first candle
  if (normalized < candles[0].time) {
    return candles[0].time
  }

  // If date is after latest candle (e.g. today during live market), clamp to latest candle
  if (normalized >= candles[candles.length - 1].time) {
    return candles[candles.length - 1].time
  }

  // Find closest earlier candle
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time <= normalized) {
      return candles[i].time
    }
  }

  return candles[0].time
}

// Calculate Exponential Moving Average (EMA)
function calculateEMA(data: CandleData[], period: number = 200) {
  if (data.length < period) return []
  const k = 2 / (period + 1)
  let ema = data.slice(0, period).reduce((acc, val) => acc + val.close, 0) / period
  const emaData: { time: string; value: number }[] = []

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

// Format numbers nicely
function fmtNum(n: number, decimals: number = 2): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}

function fmtVol(vol: number): string {
  if (!vol || vol <= 0) return "0"
  if (vol >= 10_000_000) return `${(vol / 10_000_000).toFixed(2)} Cr`
  if (vol >= 100_000) return `${(vol / 100_000).toFixed(2)} L`
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)} K`
  return vol.toLocaleString("en-IN")
}

export function SwingerTradeChartModal({
  trade,
  allTrades,
  onSelectTrade,
  onClose
}: {
  trade: SwingerTradeTarget | null
  allTrades?: SwingerTradeTarget[]
  onSelectTrade?: (trade: SwingerTradeTarget) => void
  onClose: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null)
  const emaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null)

  const [loading, setLoading] = useState(false)
  const [candles, setCandles] = useState<CandleData[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)

  // Chart feature toggles (Cleaner defaults: 1 Year view, EMA on, Levels on)
  const [showVolume, setShowVolume] = useState(true)
  const [showEMA200, setShowEMA200] = useState(true)
  const [showLevels, setShowLevels] = useState(true)
  const [activeRange, setActiveRange] = useState<"3m" | "6m" | "1y" | "2y" | "all">("1y")

  // Live Crosshair Hover Information
  const [hovered, setHovered] = useState<HoveredInfo | null>(null)

  // Keyboard navigation & ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
      if (allTrades && onSelectTrade && trade) {
        const curIdx = allTrades.findIndex((t) => t.symbol === trade.symbol)
        if (e.key === "ArrowLeft" && curIdx > 0) {
          onSelectTrade(allTrades[curIdx - 1])
        } else if (e.key === "ArrowRight" && curIdx < allTrades.length - 1) {
          onSelectTrade(allTrades[curIdx + 1])
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose, allTrades, onSelectTrade, trade])

  // Fetch Full Candlestick History for Symbol
  useEffect(() => {
    if (!trade || !trade.symbol) return
    let active = true
    setLoading(true)
    setError(null)
    setHovered(null)

    // Request full historical candles with live fresh delta
    fetch(`/api/swinger/candles?symbol=${encodeURIComponent(trade.symbol)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!active) return
        if (d.ok && Array.isArray(d.candles) && d.candles.length > 0) {
          // Sort candles chronologically
          const sorted = [...d.candles].sort((a, b) => a.time.localeCompare(b.time))
          setCandles(sorted)
        } else {
          setError(`No candlestick data available for ${trade.symbol}`)
        }
      })
      .catch((err) => {
        if (!active) return
        setError(err.message || "Failed to load candles")
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [trade?.symbol])

  // Key Technical Stats Derived from Full Candle Data
  const stats = useMemo(() => {
    if (candles.length === 0) return null
    const latest = candles[candles.length - 1]
    const prev = candles.length > 1 ? candles[candles.length - 2] : latest

    // All-time / 1000-day peak
    let peakHigh = 0
    let peakDate = ""
    for (const c of candles) {
      if (c.high > peakHigh) {
        peakHigh = c.high
        peakDate = c.time
      }
    }

    // 52-week (last 252 bars) high/low
    const last252 = candles.slice(-252)
    const high52 = Math.max(...last252.map((c) => c.high))
    const low52 = Math.min(...last252.map((c) => c.low))

    // 60-day volume average
    const last60 = candles.slice(-60)
    const avgVol60 = last60.reduce((acc, c) => acc + (c.volume || 0), 0) / Math.max(1, last60.length)
    const volSurge = avgVol60 > 0 ? (latest.volume || 0) / avgVol60 : 1.0

    // Depth from peak
    const depthPct = peakHigh > 0 ? ((latest.close - peakHigh) / peakHigh) * 100 : 0
    const crashFloor60 = peakHigh * 0.40

    // Today's change vs previous close
    const dayChangePts = latest.close - prev.close
    const dayChangePct = prev.close > 0 ? (dayChangePts / prev.close) * 100 : 0

    return {
      cmp: latest.close,
      latestDate: latest.time,
      dayChangePts,
      dayChangePct,
      peakHigh,
      peakDate,
      depthPct,
      crashFloor60,
      high52,
      low52,
      avgVol60,
      volSurge,
      latestVol: latest.volume || 0,
      totalBars: candles.length
    }
  }, [candles])

  // Build and render Clean Lightweight Chart
  useEffect(() => {
    if (!containerRef.current || candles.length === 0 || !trade) return

    // Clean up previous chart
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
    }

    const container = containerRef.current
    const chartHeight = container.clientHeight || (isMaximized ? 660 : 500)

    // Clean, modern, distraction-free chart setup
    const chart = createChart(container, {
      width: container.clientWidth,
      height: chartHeight,
      layout: {
        background: { color: "#ffffff" },
        textColor: "#64748b"
      },
      grid: {
        vertLines: { visible: false }, // Cleaner: No vertical grid lines
        horzLines: { color: "rgba(241, 245, 249, 0.8)" } // Soft, subtle horizontal lines
      },
      crosshair: {
        mode: 1
      },
      timeScale: {
        borderColor: "#e2e8f0",
        timeVisible: true,
        secondsVisible: false
      },
      rightPriceScale: {
        borderColor: "#e2e8f0",
        scaleMargins: {
          top: 0.08,
          bottom: showVolume ? 0.20 : 0.05
        }
      }
    })

    // 1. Candlestick Series (TradingView Standard Crisp Colors)
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981", // Crisp mint-emerald
      downColor: "#ef4444", // Modern clean crimson (soft, not harsh neon)
      borderVisible: false,
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.05
      }
    })
    candleSeries.setData(candles as any)
    candleSeriesRef.current = candleSeries

    // 2. Subtle Volume Histogram at Bottom (Subdued opacity so it never overpowers)
    let volumeSeries: ISeriesApi<"Histogram"> | null = null
    if (showVolume) {
      volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "" // Overlay
      })
      volumeSeries.priceScale().applyOptions({
        scaleMargins: {
          top: 0.82,
          bottom: 0
        }
      })
      const volData = candles.map((c) => ({
        time: c.time as any,
        value: c.volume || 0,
        color: c.close >= c.open ? "rgba(16, 185, 129, 0.30)" : "rgba(239, 68, 68, 0.25)"
      }))
      volumeSeries.setData(volData)
      volumeSeriesRef.current = volumeSeries
    }

    // 3. 200 EMA Line (Clean amber/gold curve)
    let emaSeries: ISeriesApi<"Line"> | null = null
    const emaValues = calculateEMA(candles, 200)
    if (showEMA200 && emaValues.length > 0) {
      emaSeries = chart.addSeries(LineSeries, {
        color: "#f59e0b",
        lineWidth: 2,
        title: "200 EMA",
        priceLineVisible: false
      })
      emaSeries.setData(emaValues as any)
      emaSeriesRef.current = emaSeries
    }

    // 4. Clean Milestone Price Lines (Only for active/historical trades)
    // NOTE: Removed PEAK HIGH and CRASH FLOOR from price series to prevent squishing candles vertically!
    if (showLevels) {
      const entryPrice = trade.avg_price ?? trade.entry_price
      if (entryPrice && entryPrice > 0) {
        const slPrice = entryPrice * 0.80 // -20% SL
        const bePrice = entryPrice * 1.15 // +15% BE Shield
        const tpPrice = entryPrice * 1.30 // +30% TP1

        // Entry Line (Clean Emerald Dashed)
        candleSeries.createPriceLine({
          price: entryPrice,
          color: "#059669",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `BUY ₹${entryPrice.toFixed(1)}`
        })

        // Stop Loss Line (Clean, thin slate-rose dotted)
        candleSeries.createPriceLine({
          price: slPrice,
          color: "#f43f5e",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `SL ₹${slPrice.toFixed(1)}`
        })

        // Break-Even Shield Line (Sky Blue Dotted)
        candleSeries.createPriceLine({
          price: bePrice,
          color: "#0284c7",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `BE ₹${bePrice.toFixed(1)}`
        })

        // TP1 Line (Emerald Dashed)
        candleSeries.createPriceLine({
          price: tpPrice,
          color: "#16a34a",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `TP1 ₹${tpPrice.toFixed(1)}`
        })

        // Exit Line (if closed)
        if (trade.exit_price && trade.exit_price > 0) {
          candleSeries.createPriceLine({
            price: trade.exit_price,
            color: (trade.pnl ?? 0) >= 0 ? "#10b981" : "#e11d48",
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: `EXIT ₹${trade.exit_price.toFixed(1)}`
          })
        }
      }
    }

    // 5. Series Markers (Buy & Exit Arrows)
    const markers: SeriesMarker<Time>[] = []
    const entryPrice = trade.avg_price ?? trade.entry_price

    const validEntryTime = sanitizeDateToCandleTime(trade.entry_date, candles)
    if (validEntryTime && entryPrice) {
      markers.push({
        time: validEntryTime as any,
        position: "belowBar",
        color: "#10b981",
        shape: "arrowUp",
        text: `BUY @ ₹${entryPrice.toFixed(1)}`,
        size: 1.5
      })
    }

    const validExitTime = sanitizeDateToCandleTime(trade.exit_date, candles)
    if (validExitTime && trade.exit_price) {
      const isWin = (trade.pnl ?? 0) >= 0
      const ret = trade.pnl_pct ?? trade.pct_return ?? 0
      markers.push({
        time: validExitTime as any,
        position: "aboveBar",
        color: isWin ? "#10b981" : "#ef4444",
        shape: "arrowDown",
        text: `EXIT (${isWin ? "+" : ""}${ret.toFixed(1)}%)`,
        size: 1.5
      })
    }

    if (markers.length > 0) {
      markers.sort((a, b) => (a.time as string).localeCompare(b.time as string))
      createSeriesMarkers(candleSeries, markers)
    }

    // 6. Crosshair Movement HUD listener
    const emaMap = new Map<string, number>()
    for (const e of emaValues) emaMap.set(e.time, e.value)

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        setHovered(null)
        return
      }
      const barData = param.seriesData.get(candleSeries) as any
      if (barData && typeof barData.close === "number") {
        const timeStr = param.time as string
        const pts = barData.close - barData.open
        const pct = barData.open > 0 ? (pts / barData.open) * 100 : 0
        const volData = volumeSeries ? (param.seriesData.get(volumeSeries) as any) : null
        const emaVal = emaMap.get(timeStr)

        setHovered({
          time: timeStr,
          open: barData.open,
          high: barData.high,
          low: barData.low,
          close: barData.close,
          volume: volData?.value,
          changePts: pts,
          changePct: pct,
          ema200: emaVal
        })
      } else {
        setHovered(null)
      }
    })

    // 7. Viewport Range (Defaulting to 1Y for breathable, non-squished candles)
    if (activeRange === "3m") {
      const fromIdx = Math.max(0, candles.length - 63)
      chart.timeScale().setVisibleRange({
        from: candles[fromIdx].time as any,
        to: candles[candles.length - 1].time as any
      })
    } else if (activeRange === "6m") {
      const fromIdx = Math.max(0, candles.length - 126)
      chart.timeScale().setVisibleRange({
        from: candles[fromIdx].time as any,
        to: candles[candles.length - 1].time as any
      })
    } else if (activeRange === "1y") {
      const fromIdx = Math.max(0, candles.length - 252)
      chart.timeScale().setVisibleRange({
        from: candles[fromIdx].time as any,
        to: candles[candles.length - 1].time as any
      })
    } else if (activeRange === "2y") {
      const fromIdx = Math.max(0, candles.length - 504)
      chart.timeScale().setVisibleRange({
        from: candles[fromIdx].time as any,
        to: candles[candles.length - 1].time as any
      })
    } else {
      chart.timeScale().fitContent()
    }

    // Window Resize Observer
    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight
        })
      }
    }
    window.addEventListener("resize", handleResize)

    chartRef.current = chart

    return () => {
      window.removeEventListener("resize", handleResize)
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      emaSeriesRef.current = null
    }
  }, [candles, trade, showVolume, showEMA200, showLevels, activeRange, isMaximized, stats])

  // Range switch handlers
  const handleRangeChange = (range: "3m" | "6m" | "1y" | "2y" | "all") => {
    setActiveRange(range)
    if (!chartRef.current || candles.length === 0) return

    if (range === "3m") {
      const fromIdx = Math.max(0, candles.length - 63)
      chartRef.current.timeScale().setVisibleRange({
        from: candles[fromIdx].time as any,
        to: candles[candles.length - 1].time as any
      })
    } else if (range === "6m") {
      const fromIdx = Math.max(0, candles.length - 126)
      chartRef.current.timeScale().setVisibleRange({
        from: candles[fromIdx].time as any,
        to: candles[candles.length - 1].time as any
      })
    } else if (range === "1y") {
      const fromIdx = Math.max(0, candles.length - 252)
      chartRef.current.timeScale().setVisibleRange({
        from: candles[fromIdx].time as any,
        to: candles[candles.length - 1].time as any
      })
    } else if (range === "2y") {
      const fromIdx = Math.max(0, candles.length - 504)
      chartRef.current.timeScale().setVisibleRange({
        from: candles[fromIdx].time as any,
        to: candles[candles.length - 1].time as any
      })
    } else {
      chartRef.current.timeScale().fitContent()
    }
  }

  if (!trade) return null

  const pnl = trade.pnl ?? 0
  const pnlPct = trade.pnl_pct ?? trade.pct_return ?? 0
  const isWin = pnl >= 0
  const entryPrice = trade.avg_price ?? trade.entry_price
  const hasTradeDetails = Boolean(trade.entry_date && entryPrice)
  const isOpen = hasTradeDetails && !trade.exit_date

  // Prev / Next trade in sequence
  const curIdx = allTrades ? allTrades.findIndex((t) => t.symbol === trade.symbol) : -1
  const prevTrade = allTrades && curIdx > 0 ? allTrades[curIdx - 1] : null
  const nextTrade = allTrades && curIdx >= 0 && curIdx < allTrades.length - 1 ? allTrades[curIdx + 1] : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in duration-150">
      <div
        className={`bg-white rounded-3xl border border-slate-200/90 shadow-2xl flex flex-col transition-all duration-200 overflow-hidden ${
          isMaximized ? "w-[98vw] h-[96vh] max-w-none max-h-none" : "w-full max-w-5xl max-h-[92vh] h-[820px]"
        }`}
      >
        {/* ================= 1. CLEAN EXECUTIVE TITLE BAR ================= */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-white gap-3">
          {/* Symbol, Name & Live Price */}
          <div className="flex items-center gap-3.5">
            <div className="size-10 rounded-xl bg-slate-900 flex items-center justify-center font-bold text-white text-sm font-mono shadow-xs">
              {trade.symbol.slice(0, 3)}
            </div>

            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight font-mono">
                  {trade.symbol}
                </h2>
                <span className="text-xs text-slate-500 font-medium hidden sm:inline">
                  {trade.name || trade.symbol}
                </span>

                {hasTradeDetails ? (
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                      isOpen
                        ? "bg-sky-50 text-sky-700 border-sky-200"
                        : isWin
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-slate-100 text-slate-700 border-slate-200"
                    }`}
                  >
                    {isOpen ? "Active Position" : isWin ? "Winner" : "Stopped Out"}
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold border bg-purple-50 text-purple-700 border-purple-200">
                    Screener Trigger
                  </span>
                )}

                {/* Prev / Next Trade Flipper */}
                {allTrades && onSelectTrade && (
                  <div className="flex items-center gap-1 ml-1">
                    <Button
                      variant="outline"
                      size="icon"
                      disabled={!prevTrade}
                      onClick={() => prevTrade && onSelectTrade(prevTrade)}
                      title={prevTrade ? `Previous: ${prevTrade.symbol}` : "No previous"}
                      className="size-6 rounded-md text-slate-500 hover:text-slate-900"
                    >
                      <ChevronLeft className="size-3.5" />
                    </Button>
                    <span className="text-[10px] font-mono text-slate-400 px-0.5">
                      {curIdx + 1}/{allTrades.length}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      disabled={!nextTrade}
                      onClick={() => nextTrade && onSelectTrade(nextTrade)}
                      title={nextTrade ? `Next: ${nextTrade.symbol}` : "No next"}
                      className="size-6 rounded-md text-slate-500 hover:text-slate-900"
                    >
                      <ChevronRight className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>

              {/* Price & Day's Gain */}
              <div className="flex items-center gap-2.5 mt-0.5 text-xs">
                {stats && (
                  <>
                    <span className="text-base font-extrabold font-mono text-slate-900">
                      ₹{fmtNum(stats.cmp)}
                    </span>
                    <span
                      className={`font-mono font-bold px-1.5 py-0.5 rounded text-[11px] ${
                        stats.dayChangePts >= 0
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-rose-50 text-rose-700"
                      }`}
                    >
                      {stats.dayChangePts >= 0 ? "+" : ""}
                      {fmtNum(stats.dayChangePts)} ({stats.dayChangePct >= 0 ? "+" : ""}
                      {stats.dayChangePct.toFixed(2)}%)
                    </span>
                    <span className="text-slate-300">·</span>
                    <span className="text-slate-500 text-[11px]">
                      52W: ₹{fmtNum(stats.low52, 0)} - ₹{fmtNum(stats.high52, 0)}
                    </span>
                    <span className="text-slate-300">·</span>
                    <span className="text-slate-500 text-[11px]">
                      Crash Depth: <strong className="text-amber-600 font-mono">{stats.depthPct.toFixed(1)}%</strong>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right Header: Trade Performance & Modal Buttons */}
          <div className="flex items-center gap-3">
            {hasTradeDetails && (
              <div className="text-right hidden sm:block">
                <div
                  className={`text-xl font-black font-mono tracking-tight ${
                    isWin ? "text-emerald-600" : "text-rose-600"
                  }`}
                >
                  {isWin ? "+" : ""}₹{pnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                </div>
                <div className={`text-[11px] font-bold font-mono ${isWin ? "text-emerald-700" : "text-rose-700"}`}>
                  {isWin ? "+" : ""}
                  {pnlPct.toFixed(2)}% Return
                </div>
              </div>
            )}

            <div className="flex items-center gap-1 border-l border-slate-100 pl-2.5">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsMaximized(!isMaximized)}
                title={isMaximized ? "Restore" : "Fullscreen"}
                className="size-8 rounded-lg text-slate-400 hover:text-slate-800"
              >
                {isMaximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </Button>

              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                title="Close (Esc)"
                className="size-8 rounded-lg text-slate-400 hover:text-slate-800"
              >
                <X className="size-4.5" />
              </Button>
            </div>
          </div>
        </div>

        {/* ================= 2. CLEAN CONTROLS & HUD TOOLBAR ================= */}
        <div className="px-5 py-2 bg-slate-50/70 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
          {/* Left: Range Switcher (Clean minimalist buttons) */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => handleRangeChange("3m")}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                activeRange === "3m"
                  ? "bg-slate-900 text-white shadow-xs"
                  : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
              }`}
            >
              3M
            </button>
            <button
              type="button"
              onClick={() => handleRangeChange("6m")}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                activeRange === "6m"
                  ? "bg-slate-900 text-white shadow-xs"
                  : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
              }`}
            >
              6M
            </button>
            <button
              type="button"
              onClick={() => handleRangeChange("1y")}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                activeRange === "1y"
                  ? "bg-slate-900 text-white shadow-xs"
                  : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
              }`}
            >
              1Y
            </button>
            <button
              type="button"
              onClick={() => handleRangeChange("2y")}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                activeRange === "2y"
                  ? "bg-slate-900 text-white shadow-xs"
                  : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
              }`}
            >
              2Y
            </button>
            <button
              type="button"
              onClick={() => handleRangeChange("all")}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                activeRange === "all"
                  ? "bg-slate-900 text-white shadow-xs"
                  : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
              }`}
            >
              All Data
            </button>
          </div>

          {/* Center: Live Hover Candlestick HUD */}
          {hovered ? (
            <div className="flex items-center gap-2.5 font-mono text-[11px] bg-white px-3 py-1 rounded-lg border border-slate-200 shadow-2xs">
              <span className="font-bold text-slate-900">{hovered.time}</span>
              <span>
                O: <strong className="text-slate-800">₹{fmtNum(hovered.open)}</strong>
              </span>
              <span>
                H: <strong className="text-slate-800">₹{fmtNum(hovered.high)}</strong>
              </span>
              <span>
                L: <strong className="text-slate-800">₹{fmtNum(hovered.low)}</strong>
              </span>
              <span>
                C: <strong className="text-slate-800">₹{fmtNum(hovered.close)}</strong>
              </span>
              <span
                className={`font-bold ${
                  hovered.changePct >= 0 ? "text-emerald-600" : "text-rose-600"
                }`}
              >
                {hovered.changePct >= 0 ? "+" : ""}
                {hovered.changePct.toFixed(2)}%
              </span>
              {hovered.volume ? (
                <span className="text-slate-400 hidden md:inline">Vol: {fmtVol(hovered.volume)}</span>
              ) : null}
            </div>
          ) : stats ? (
            <div className="text-[11px] text-slate-500 font-medium hidden md:flex items-center gap-3">
              <span>
                Vol Surge:{" "}
                <strong
                  className={
                    stats.volSurge >= 2.0 ? "text-emerald-600 font-bold" : "text-slate-700 font-bold"
                  }
                >
                  {stats.volSurge.toFixed(1)}x SMA60
                </strong>
              </span>
              <span className="text-slate-300">·</span>
              <span>
                200 EMA: <strong className="text-amber-600 font-mono font-bold">₹{fmtNum(stats.cmp * 0.95, 0)}</strong>
              </span>
            </div>
          ) : null}

          {/* Right: Technical Layer Toggles */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowEMA200(!showEMA200)}
              className={`px-2 py-0.5 rounded-md text-[11px] font-bold border transition flex items-center gap-1 ${
                showEMA200
                  ? "bg-amber-50 text-amber-800 border-amber-300"
                  : "bg-white text-slate-400 border-slate-200"
              }`}
            >
              <span className="size-1.5 rounded-full bg-amber-500 inline-block" />
              200 EMA
            </button>

            <button
              type="button"
              onClick={() => setShowVolume(!showVolume)}
              className={`px-2 py-0.5 rounded-md text-[11px] font-bold border transition flex items-center gap-1 ${
                showVolume
                  ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                  : "bg-white text-slate-400 border-slate-200"
              }`}
            >
              <BarChart2 className="size-3" />
              Volume
            </button>

            {hasTradeDetails && (
              <button
                type="button"
                onClick={() => setShowLevels(!showLevels)}
                className={`px-2 py-0.5 rounded-md text-[11px] font-bold border transition flex items-center gap-1 ${
                  showLevels
                    ? "bg-sky-50 text-sky-800 border-sky-300"
                    : "bg-white text-slate-400 border-slate-200"
                }`}
              >
                <Layers className="size-3" />
                Levels
              </button>
            )}
          </div>
        </div>

        {/* ================= 3. CHART CANVAS ================= */}
        <div className="p-3 sm:p-5 flex-1 relative bg-white min-h-[400px] overflow-hidden">
          {loading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/85 backdrop-blur-xs gap-2">
              <RefreshCw className="size-6 text-slate-600 animate-spin" />
              <span className="text-xs font-bold text-slate-700">Loading {trade.symbol} candlesticks...</span>
            </div>
          )}

          {error && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white gap-3 p-6 text-center">
              <p className="text-sm font-bold text-slate-600">{error}</p>
              <Button variant="outline" size="sm" onClick={onClose} className="text-xs">
                Close
              </Button>
            </div>
          )}

          <div ref={containerRef} className="w-full h-full" />
        </div>

        {/* ================= 4. SLIM FOOTER ================= */}
        <div className="px-5 py-2.5 border-t border-slate-100 bg-white flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 text-xs text-slate-400">
          <div className="flex items-center gap-4 text-[11px]">
            <span className="flex items-center gap-1.5 font-medium text-slate-600">
              <span className="size-2 rounded-full bg-emerald-500" />
              Green: Up Day
            </span>
            <span className="flex items-center gap-1.5 font-medium text-slate-600">
              <span className="size-2 rounded-full bg-rose-500" />
              Red: Down Day
            </span>
            <span className="flex items-center gap-1.5 font-medium text-slate-600">
              <span className="w-3 h-0.5 bg-amber-500 inline-block" />
              200 EMA
            </span>
            {hasTradeDetails && (
              <span className="flex items-center gap-1.5 font-medium text-slate-600">
                <span className="w-3 h-0.5 bg-emerald-600 inline-block" />
                Entry / Target
              </span>
            )}
          </div>

          <div className="text-[11px] text-slate-400 font-mono flex items-center gap-3">
            <span>Scroll wheel to Zoom · Drag to Pan</span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-slate-100 border border-slate-200 rounded text-slate-600 font-semibold shadow-2xs">
                ESC
              </kbd>{" "}
              to close
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

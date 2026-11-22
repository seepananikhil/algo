import { useEffect, useRef, useState, useMemo } from "react"
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time
} from "lightweight-charts"
import {
  X,
  Maximize2,
  Minimize2,
  BarChart2,
  ChevronLeft,
  ChevronRight,
  Layers,
  ExternalLink,
  Ruler,
  Table,
  RefreshCw
} from "lucide-react"
import { Button } from "@/components/ui/button"

export interface SwingerTradeTarget {
  trade_id?: string
  symbol: string
  name?: string
  type?: string
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
  leg?: number
  strategy_leg?: string
  base_high?: number
  base_low?: number
  surge_date?: string
  alert_date?: string
  alert_price?: number
  first_radar_date?: string
  radar_triggers?: string[]
  stockTrades?: SwingerTradeTarget[]
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
function fmtNum(n?: number | null, decimals: number = 2): string {
  if (n === null || n === undefined || isNaN(n)) return "0.00"
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}

function fmtVol(vol?: number | null): string {
  if (!vol || vol <= 0 || isNaN(vol)) return "0"
  if (vol >= 10_000_000) return `${(vol / 10_000_000).toFixed(2)} Cr`
  if (vol >= 100_000) return `${(vol / 100_000).toFixed(2)} L`
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)} K`
  return vol.toLocaleString("en-IN")
}

function findInitialTradeIndex(trades: SwingerTradeTarget[], target?: SwingerTradeTarget | null): number {
  if (!trades || trades.length === 0) return 0
  if (target) {
    if (target.trade_id) {
      const idx = trades.findIndex((t) => t.trade_id === target.trade_id)
      if (idx !== -1) return idx
    }
    if (target.entry_date) {
      const targetDate = target.entry_date.slice(0, 10)
      const idx = trades.findIndex((t) => t.entry_date && t.entry_date.slice(0, 10) === targetDate)
      if (idx !== -1) return idx
    }
    const isTargetOpen = target.status === "ACTIVE" || target.status === "SHIELDED" || target.status === "RUNNER" || target.type === "OPEN" || !target.exit_date
    if (isTargetOpen) {
      const openIdx = trades.findIndex((t) => t.type === "OPEN" || t.status === "ACTIVE" || t.status === "SHIELDED" || t.status === "RUNNER" || !t.exit_date)
      if (openIdx !== -1) return openIdx
    }
  }
  // Default to active open position if one exists
  const activeIdx = trades.findIndex((t) => t.type === "OPEN" || t.status === "ACTIVE" || t.status === "SHIELDED" || t.status === "RUNNER" || !t.exit_date)
  if (activeIdx !== -1) return activeIdx

  // Otherwise default to the most recent trade (last chronological)
  return trades.length - 1
}

export function SwingerTradeChartModal({
  trade,
  allTrades,
  onSelectTrade,
  onClose,
  embedded = false,
}: {
  trade: SwingerTradeTarget | null
  allTrades?: SwingerTradeTarget[]
  onSelectTrade?: (trade: SwingerTradeTarget) => void
  onClose?: () => void
  embedded?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const mainSeriesRef = useRef<ISeriesApi<any> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null)
  const emaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null)

  const [loading, setLoading] = useState(false)
  const [candles, setCandles] = useState<CandleData[]>([])
  const [radarTriggers, setRadarTriggers] = useState<string[]>([])
  const [firstRadarDate, setFirstRadarDate] = useState<string | null>(null)
  const [serverTrades, setServerTrades] = useState<SwingerTradeTarget[]>([])
  const [isOnRadar, setIsOnRadar] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)

  // Chart feature toggles (Clean defaults: 50 EMA on, 200 EMA on, Levels on, Volume on)
  const [showVolume, setShowVolume] = useState(true)
  const [showEMA50, setShowEMA50] = useState(true)
  const [showEMA200, setShowEMA200] = useState(true)
  const [showLevels, setShowLevels] = useState(true)
  const [activeTradeIndex, setActiveTradeIndex] = useState<number>(0)

  // Live Crosshair Hover Information
  const [hovered, setHovered] = useState<HoveredInfo | null>(null)

  // Measure / Scale Tool State
  const [isMeasureActive, setIsMeasureActive] = useState(false)
  const [isShiftPressed, setIsShiftPressed] = useState(false)
  const [isLogScale, setIsLogScale] = useState(false)
  const [measureData, setMeasureData] = useState<{
    x1: number
    y1: number
    x2: number
    y2: number
    price1: number
    price2: number
    time1: string
    time2: string
    bars: number
    isLocked: boolean
  } | null>(null)

  const isDrawingMeasureRef = useRef(false)
  const measureStartPointRef = useRef<{
    x: number
    y: number
    price: number
    time: string
    logical: number
  } | null>(null)

  const [currentSymbol, setCurrentSymbol] = useState(trade?.symbol || "")
  const [backtestSummary, setBacktestSummary] = useState<any | null>((trade as any)?.backtestSummary || null)
  const [isBacktestMode, setIsBacktestMode] = useState(Boolean((trade as any)?.isBacktest))
  const [showLedger, setShowLedger] = useState(false)
  const [marketCapCr, setMarketCapCr] = useState<number | null>((trade as any)?.market_cap_cr || null)

  // Sync state when trade prop changes
  useEffect(() => {
    if (trade?.symbol) {
      setCurrentSymbol(trade.symbol)
      setBacktestSummary((trade as any)?.backtestSummary || null)
      setIsBacktestMode(Boolean((trade as any)?.isBacktest))
      setMarketCapCr((trade as any)?.market_cap_cr || null)
      const initialList = (trade as any).stockTrades || (trade as any).trades || []
      setActiveTradeIndex(findInitialTradeIndex(initialList, trade))
    }
  }, [trade?.symbol, (trade as any)?.isBacktest])

  // Derive all trades for this stock (authoritative from server, or fallback to props)
  const symbolTrades: SwingerTradeTarget[] = useMemo(() => {
    // 1. Authoritative server-loaded trades for this stock (both closed and open holdings)
    if (serverTrades && serverTrades.length > 0) {
      return serverTrades
    }
    // 2. If it is purely on cooldown radar (unbought), there are NO trades yet!
    if (isOnRadar || trade?.status === "RADAR") {
      return []
    }
    // 3. Fallback to passed props
    if (trade?.stockTrades && trade.stockTrades.length > 0) {
      return trade.stockTrades
    }
    if (allTrades && trade) {
      const matching = allTrades.filter((t) => t.symbol === trade.symbol && t.status !== "RADAR" && (t.entry_date || t.avg_price))
      if (matching.length > 0) return matching
    }
    if (trade && trade.entry_date && trade.status !== "RADAR") {
      return [trade]
    }
    return []
  }, [serverTrades, isOnRadar, trade, allTrades])

  const currentTrade = symbolTrades[activeTradeIndex] || symbolTrades[0] || (trade?.status !== "RADAR" ? trade : null)

  // All radar/screener triggers for this symbol (server has already filtered out triggers during active holdings)
  const effectiveRadarTriggers = useMemo(() => {
    const list = [...radarTriggers]
    if (list.length === 0 && firstRadarDate) {
      list.push(firstRadarDate)
    }
    if (list.length === 0 && trade?.alert_date) {
      list.push(trade.alert_date.slice(0, 10))
    }
    return Array.from(new Set(list)).sort()
  }, [radarTriggers, firstRadarDate, trade])

  // Keyboard navigation, ESC & Shift measure shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (measureData) {
          setMeasureData(null)
          setIsMeasureActive(false)
          return
        }
        onClose?.()
      }
      if (e.key === "Shift") {
        setIsShiftPressed(true)
      }
      if (allTrades && onSelectTrade && trade) {
        const curIdx = allTrades.findIndex((t) => t.symbol === trade.symbol)
        if (e.key === "ArrowLeft" && curIdx > 0) {
          onSelectTrade(allTrades[curIdx - 1])
        } else if (e.key === "ArrowRight" && curIdx < allTrades.length - 1) {
          onSelectTrade(allTrades[curIdx + 1])
        }
      }
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        setIsShiftPressed(false)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
    }
  }, [onClose, allTrades, onSelectTrade, trade, measureData])

  // Fetch Full Candlestick History and Trade Context for Symbol
  useEffect(() => {
    if (!trade || !trade.symbol) return
    let active = true
    setLoading(true)
    setError(null)
    setHovered(null)

    const isBacktest = Boolean((trade as any)?.isBacktest)

    // If pre-loaded backtest candles and trades were passed, hydrate instantly!
    if (isBacktest && (trade as any)?.candles && (trade as any).candles.length > 0) {
      const sorted = [...(trade as any).candles].sort((a: any, b: any) => a.time.localeCompare(b.time))
      setCandles(sorted)
      setRadarTriggers((trade as any).radar_triggers || [])
      setFirstRadarDate(null)
      setServerTrades((trade as any).stockTrades || (trade as any).trades || [])
      setIsOnRadar(false)
      if ((trade as any)?.market_cap_cr) {
        setMarketCapCr((trade as any).market_cap_cr)
      }
      setLoading(false)
      return
    }

    const endpoint = isBacktest
      ? `/api/swinger/backtest-stock?symbol=${encodeURIComponent(trade.symbol)}`
      : `/api/swinger/candles?symbol=${encodeURIComponent(trade.symbol)}`

    const abortController = new AbortController()
    const timeoutId = setTimeout(() => {
      abortController.abort()
    }, 25000)

    // Request full historical candles with live fresh delta and trade context
    fetch(endpoint, { signal: abortController.signal })
      .then((r) => r.json())
      .then((d) => {
        if (!active) return
        if (d.ok && Array.isArray(d.candles) && d.candles.length > 0) {
          // Sort candles chronologically
          const sorted = [...d.candles].sort((a, b) => a.time.localeCompare(b.time))
          setCandles(sorted)
          setRadarTriggers(Array.isArray(d.radar_triggers) ? d.radar_triggers : [])
          setFirstRadarDate(d.first_radar_date || null)
          const sTrades = Array.isArray(d.trades) ? d.trades : []
          setServerTrades(sTrades)
          if (sTrades.length > 0) {
            setActiveTradeIndex(findInitialTradeIndex(sTrades, trade))
          }
          if (d.summary) {
            setBacktestSummary(d.summary)
          }
          setIsOnRadar(Boolean(d.is_on_radar))
          if (d.market_cap_cr) {
            setMarketCapCr(d.market_cap_cr)
          }
        } else {
          setError(d.error || `No candlestick data available for ${trade.symbol}`)
        }
      })
      .catch((err) => {
        if (!active) return
        if (err.name === "AbortError") {
          setError(`Request timed out while loading chart data for ${trade.symbol}. Click retry or check connection.`)
        } else {
          setError(err.message || "Failed to load candles")
        }
      })
      .finally(() => {
        clearTimeout(timeoutId)
        if (active) setLoading(false)
      })

    return () => {
      active = false
      clearTimeout(timeoutId)
      abortController.abort()
    }
  }, [trade?.symbol, (trade as any)?.isBacktest])

  // Key Technical Stats Derived from Full Candle Data
  const stats = useMemo(() => {
    const validCandles = candles.filter(
      (c) => c && typeof c.close === "number" && !isNaN(c.close) && c.close > 0
    )
    if (validCandles.length === 0) return null
    const latest = validCandles[validCandles.length - 1]
    const prev = validCandles.length > 1 ? validCandles[validCandles.length - 2] : latest

    // All-time / 1000-day peak
    let peakHigh = 0
    let peakDate = ""
    for (const c of validCandles) {
      if ((c.high ?? 0) > peakHigh) {
        peakHigh = c.high
        peakDate = c.time
      }
    }

    // 52-week (last 252 bars) high/low
    const last252 = validCandles.slice(-252)
    const high52 = last252.length > 0 ? Math.max(...last252.map((c) => c.high || c.close || 0)) : (latest.high ?? latest.close)
    const low52 = last252.length > 0 ? Math.min(...last252.map((c) => c.low || c.close || 0)) : (latest.low ?? latest.close)

    // 60-day volume average
    const last60 = validCandles.slice(-60)
    const avgVol60 = last60.reduce((acc, c) => acc + (c.volume || 0), 0) / Math.max(1, last60.length)
    const volSurge = avgVol60 > 0 ? (latest.volume || 0) / avgVol60 : 1.0

    // Depth from peak
    const depthPct = peakHigh > 0 ? (((latest.close || 0) - peakHigh) / peakHigh) * 100 : 0
    const crashFloor60 = peakHigh * 0.40

    // Today's change vs previous close
    const prevClose = prev?.close || latest.close || 1
    const dayChangePts = (latest.close || 0) - prevClose
    const dayChangePct = prevClose > 0 ? (dayChangePts / prevClose) * 100 : 0

    return {
      cmp: latest.close || 0,
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
      totalBars: validCandles.length
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
        mode: isLogScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
        scaleMargins: {
          top: 0.08,
          bottom: showVolume ? 0.20 : 0.05
        }
      }
    })

    // 1. Candlestick Bar Series (TradingView Standard Crisp Colors)
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981", // Crisp mint-emerald
      downColor: "#ef4444", // Modern clean crimson
      borderVisible: false,
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.05
      }
    })

    const cleanCandles = candles
      .filter((c) => c && typeof c.close === "number" && !isNaN(c.close) && c.close > 0)
      .map((c) => ({
        time: c.time,
        open: typeof c.open === "number" && !isNaN(c.open) ? c.open : c.close,
        high: typeof c.high === "number" && !isNaN(c.high) ? Math.max(c.high, c.close) : c.close,
        low: typeof c.low === "number" && !isNaN(c.low) ? Math.min(c.low, c.close) : c.close,
        close: c.close,
        volume: typeof c.volume === "number" && !isNaN(c.volume) ? c.volume : 0
      }))

    candleSeries.setData(cleanCandles as any)
    mainSeriesRef.current = candleSeries
    const mainSeries = candleSeries

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

    // 3A. 50 EMA Line (Clean cyan curve)
    let ema50Series: ISeriesApi<"Line"> | null = null
    const ema50Values = calculateEMA(candles, 50)
    if (showEMA50 && ema50Values.length > 0) {
      ema50Series = chart.addSeries(LineSeries, {
        color: "#06b6d4",
        lineWidth: 2,
        title: "50 EMA",
        priceLineVisible: false
      })
      ema50Series.setData(ema50Values as any)
    }

    // 3B. 200 EMA Line (Clean amber/gold curve)
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

    // 4. Clean Milestone Price Lines (Only for active/historical trades of Swinger strategy)
    if (showLevels && symbolTrades.length > 0) {
      const activeTargetTrade = currentTrade || symbolTrades[symbolTrades.length - 1]
      const entryPrice = activeTargetTrade?.avg_price ?? activeTargetTrade?.entry_price
      if (entryPrice && entryPrice > 0) {
        // Strategy Rules: Initial SL -15%, Break-Even Shield @ +15%
        const initialSlPrice = entryPrice * 0.85
        const currentSl = (activeTargetTrade as any).sl && (activeTargetTrade as any).sl > 0
          ? (activeTargetTrade as any).sl
          : initialSlPrice
        const bePrice = entryPrice * 1.25

        const isLeg2 = activeTargetTrade.leg === 2 || String(activeTargetTrade.strategy_leg || "").toUpperCase().includes("LEG2")
        // Entry Line (Vibrant Purple Dashed for Leg 2, Emerald Dashed for Leg 1)
        mainSeries.createPriceLine({
          price: entryPrice,
          color: isLeg2 ? "#8b5cf6" : "#059669",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${isLeg2 ? "BUY [LEG 2]" : "BUY [LEG 1]"} ₹${entryPrice.toFixed(1)}`
        })

        // Stop Loss Line (Clean Rose Dotted: shows active trail SL if raised, else initial -15% SL)
        mainSeries.createPriceLine({
          price: currentSl,
          color: "#f43f5e",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: currentSl > entryPrice
            ? `TRAIL SL ₹${currentSl.toFixed(1)}`
            : `SL -15% ₹${currentSl.toFixed(1)}`
        })

        // Break-Even Shield Target Line (+25% milestone)
        mainSeries.createPriceLine({
          price: bePrice,
          color: "#0284c7",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `BE +25% ₹${bePrice.toFixed(1)}`
        })

        // Exit Line (ONLY if truly closed - NOT active/open)
        const isTradeActive =
          activeTargetTrade.status === "OPEN" ||
          activeTargetTrade.status === "ACTIVE" ||
          activeTargetTrade.status === "SHIELDED" ||
          activeTargetTrade.status === "RUNNER" ||
          activeTargetTrade.reason === "Active Position" ||
          activeTargetTrade.reason === "Marked to Market / Active" ||
          !activeTargetTrade.exit_date

        if (!isTradeActive && activeTargetTrade.exit_price && activeTargetTrade.exit_price > 0) {
          mainSeries.createPriceLine({
            price: activeTargetTrade.exit_price,
            color: (activeTargetTrade.pnl ?? 0) >= 0 ? "#10b981" : "#e11d48",
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: `EXIT ₹${activeTargetTrade.exit_price.toFixed(1)}`
          })
        }
      }
    }

    // 5. Crisp, Non-Cluttered Series Markers (Radar Trigger Flags, Buy & Exit Arrows)
    const markers: SeriesMarker<Time>[] = []

    // Collect all entry dates and intervals of actual trades to avoid duplicate/redundant radar markers
    const tradeEntryDates = new Set(symbolTrades.map((st) => (st.entry_date || "").slice(0, 10)))
    const activeTradeIntervals = symbolTrades.map((st) => [
      (st.entry_date || "").slice(0, 10),
      (st.exit_date || "9999-12-31").slice(0, 10)
    ])

    // A. Add Radar / Screener Trigger Flags (excluding duplicate triggers and triggers when active position already exists)
    const seenRadarTimes = new Set<string>()
    effectiveRadarTriggers.forEach((rtDate) => {
      const cleanDate = rtDate.slice(0, 10)
      if (tradeEntryDates.has(cleanDate)) return
      const isDuringActive = activeTradeIntervals.some(
        ([start, end]) => cleanDate >= start && cleanDate <= end
      )
      if (isDuringActive) return

      const validRtTime = sanitizeDateToCandleTime(rtDate, candles)
      const timeKey = String(validRtTime)
      if (validRtTime && !seenRadarTimes.has(timeKey)) {
        seenRadarTimes.add(timeKey)
        markers.push({
          time: validRtTime as any,
          position: "aboveBar",
          color: "#9333ea",
          shape: "arrowDown",
          text: "⚡ Trigger",
          size: 1.5
        })
      }
    })

    // B. Buy & Exit Arrows for ALL actual trades of this stock (distinct Leg 1 vs Leg 2 styling)
    symbolTrades.forEach((st, idx) => {
      const tradeNum = idx + 1
      const stEntryPrice = st.avg_price ?? st.entry_price
      const validEntryTime = sanitizeDateToCandleTime(st.entry_date, candles)
      const isLeg2 = st.leg === 2 || String(st.strategy_leg || "").toUpperCase().includes("LEG2")
      const legLabel = isLeg2 ? "LEG 2" : "LEG 1"
      const legShort = isLeg2 ? "L2" : "L1"
      const buyColor = isLeg2 ? "#8b5cf6" : "#10b981" // Purple for Leg 2, Emerald for Leg 1

      if (validEntryTime && stEntryPrice && stEntryPrice > 0) {
        markers.push({
          time: validEntryTime as any,
          position: "belowBar",
          color: buyColor,
          shape: "arrowUp",
          text: symbolTrades.length > 1
            ? `BUY #${tradeNum} [${legShort}] ₹${stEntryPrice.toFixed(0)}`
            : `BUY [${legLabel}] ₹${stEntryPrice.toFixed(0)}`,
          size: 2
        })
      }

      const validExitTime = sanitizeDateToCandleTime(st.exit_date, candles)
      const isTradeActiveForMarker = 
        st.status === "OPEN" || 
        st.status === "ACTIVE" || 
        st.status === "SHIELDED" || 
        st.status === "RUNNER" || 
        st.reason === "Active Position" || 
        st.reason === "Marked to Market / Active" || 
        !st.exit_date

      if (!isTradeActiveForMarker && validExitTime && st.exit_price && st.exit_price > 0) {
        const isWin = (st.pnl ?? 0) >= 0
        const ret = st.pnl_pct ?? st.pct_return ?? 0
        markers.push({
          time: validExitTime as any,
          position: "aboveBar",
          color: isWin ? "#10b981" : "#ef4444",
          shape: "arrowDown",
          text: symbolTrades.length > 1
            ? `EXIT #${tradeNum} [${legShort}] (${isWin ? "+" : ""}${ret.toFixed(0)}%)`
            : `EXIT [${legShort}] (${isWin ? "+" : ""}${ret.toFixed(0)}%)`,
          size: 2
        })
      }
    })

    if (markers.length > 0) {
      markers.sort((a, b) => (a.time as string).localeCompare(b.time as string))
      createSeriesMarkers(mainSeries, markers)
    }

    // 6. Crosshair Movement HUD listener
    const emaMap = new Map<string, number>()
    for (const e of emaValues) emaMap.set(e.time, e.value)

    const candleMap = new Map<string, CandleData>()
    for (const c of cleanCandles) {
      if (c && c.time) candleMap.set(c.time, c)
    }

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        setHovered(null)
        return
      }
      const barData = param.seriesData.get(mainSeries) as any
      if (barData) {
        const timeStr = param.time as string
        const c = candleMap.get(timeStr)
        const closePrice =
          typeof barData.close === "number"
            ? barData.close
            : typeof barData.value === "number"
            ? barData.value
            : c?.close ?? 0
        const openPrice = typeof barData.open === "number" ? barData.open : c?.open ?? closePrice
        const pts = closePrice - openPrice
        const pct = openPrice > 0 ? (pts / openPrice) * 100 : 0
        const volData = volumeSeries ? (param.seriesData.get(volumeSeries) as any) : null
        const emaVal = emaMap.get(timeStr)

        setHovered({
          time: timeStr,
          open: openPrice,
          high: typeof barData.high === "number" ? barData.high : c?.high ?? closePrice,
          low: typeof barData.low === "number" ? barData.low : c?.low ?? closePrice,
          close: closePrice,
          volume: volData?.value ?? c?.volume ?? 0,
          changePts: pts,
          changePct: pct,
          ema200: emaVal
        })
      } else {
        setHovered(null)
      }
    })

    // 7. Viewport Range: Auto-center on selected trade (or recent 1Y if no specific trade)
    if (candles.length > 0) {
      let fromTime: string | null = null
      let toTime: string | null = null

      if (currentTrade?.entry_date) {
        const eDate = currentTrade.entry_date.slice(0, 10)
        const xDate = currentTrade.exit_date ? currentTrade.exit_date.slice(0, 10) : candles[candles.length - 1].time

        const eIdx = candles.findIndex((c) => c.time >= eDate)
        const xIdx = candles.findIndex((c) => c.time >= xDate)

        if (eIdx !== -1) {
          const startIdx = Math.max(0, eIdx - 25)
          const endIdx = xIdx !== -1
            ? Math.min(candles.length - 1, xIdx + 30)
            : Math.min(candles.length - 1, eIdx + 60)

          const minBars = 65
          const barSpan = endIdx - startIdx
          let adjustedStart = startIdx
          let adjustedEnd = endIdx
          if (barSpan < minBars) {
            const extra = minBars - barSpan
            adjustedStart = Math.max(0, startIdx - Math.floor(extra / 2))
            adjustedEnd = Math.min(candles.length - 1, endIdx + Math.ceil(extra / 2))
          }
          fromTime = candles[adjustedStart]?.time || null
          toTime = candles[adjustedEnd]?.time || null
        }
      }

      if (fromTime && toTime) {
        chart.timeScale().setVisibleRange({
          from: fromTime as any,
          to: toTime as any
        })
      } else {
        const fromIdx = Math.max(0, candles.length - 252)
        chart.timeScale().setVisibleRange({
          from: candles[fromIdx].time as any,
          to: candles[candles.length - 1].time as any
        })
      }
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
      mainSeriesRef.current = null
      volumeSeriesRef.current = null
      emaSeriesRef.current = null
    }
  }, [
    candles,
    trade,
    currentTrade,
    symbolTrades,
    activeTradeIndex,
    showVolume,
    showEMA50,
    showEMA200,
    showLevels,
    isMaximized,
    stats
  ])

  // Update Price Scale Mode when user toggles Log / Linear scale
  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.priceScale("right").applyOptions({
        mode: isLogScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal
      })
    }
  }, [isLogScale])

  const handleFitContent = () => {
    if (chartRef.current) {
      chartRef.current.timeScale().fitContent()
    }
  }

  // Handle Pointer Events for Measure Scale Tool
  const handleMeasurePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const chart = chartRef.current
    const series = mainSeriesRef.current
    if (!chart || !series) return

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const price = series.coordinateToPrice(y)
    const time = chart.timeScale().coordinateToTime(x)
    const logical = chart.timeScale().coordinateToLogical(x)
    if (price === null) return

    const timeStr = time
      ? typeof time === "string"
        ? time
        : typeof time === "object" && "year" in time
        ? `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`
        : String(time)
      : ""

    isDrawingMeasureRef.current = true
    measureStartPointRef.current = { x, y, price, time: timeStr, logical: logical ?? 0 }

    setMeasureData({
      x1: x,
      y1: y,
      x2: x,
      y2: y,
      price1: price,
      price2: price,
      time1: timeStr,
      time2: timeStr,
      bars: 0,
      isLocked: false
    })
  }

  const handleMeasurePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDrawingMeasureRef.current || !measureStartPointRef.current) return
    const chart = chartRef.current
    const series = mainSeriesRef.current
    if (!chart || !series) return

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const price = series.coordinateToPrice(y)
    const time = chart.timeScale().coordinateToTime(x)
    const logical = chart.timeScale().coordinateToLogical(x)
    if (price === null) return

    const timeStr = time
      ? typeof time === "string"
        ? time
        : typeof time === "object" && "year" in time
        ? `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`
        : String(time)
      : ""

    const sp = measureStartPointRef.current
    const bars = Math.abs(Math.round((logical ?? 0) - sp.logical))

    setMeasureData({
      x1: sp.x,
      y1: sp.y,
      x2: x,
      y2: y,
      price1: sp.price,
      price2: price,
      time1: sp.time,
      time2: timeStr,
      bars,
      isLocked: false
    })
  }

  const handleMeasurePointerUp = () => {
    if (isDrawingMeasureRef.current && measureData) {
      isDrawingMeasureRef.current = false
      const dist = Math.hypot(measureData.x2 - measureData.x1, measureData.y2 - measureData.y1)
      if (dist < 4) {
        setMeasureData(null)
      } else {
        setMeasureData((prev) => (prev ? { ...prev, isLocked: true } : null))
      }
    }
  }

  // Precompute clean measurement metrics
  const measureStats = useMemo(() => {
    if (!measureData) return null
    const priceDiff = measureData.price2 - measureData.price1
    const pctDiff = measureData.price1 !== 0 ? (priceDiff / measureData.price1) * 100 : 0
    let days = 0
    if (measureData.time1 && measureData.time2) {
      const d1 = new Date(measureData.time1).getTime()
      const d2 = new Date(measureData.time2).getTime()
      if (!isNaN(d1) && !isNaN(d2)) {
        days = Math.abs(Math.round((d2 - d1) / (1000 * 60 * 60 * 24)))
      }
    }
    const isPositive = priceDiff >= 0
    const left = Math.min(measureData.x1, measureData.x2)
    const top = Math.min(measureData.y1, measureData.y2)
    const width = Math.max(Math.abs(measureData.x2 - measureData.x1), 2)
    const height = Math.max(Math.abs(measureData.y2 - measureData.y1), 2)

    return {
      priceDiff,
      pctDiff,
      days,
      isPositive,
      left,
      top,
      width,
      height
    }
  }, [measureData])

  if (!trade) return null

  const targetTradeForHeader = currentTrade || trade
  const pnl = targetTradeForHeader.pnl ?? 0
  const pnlPct = targetTradeForHeader.pnl_pct ?? targetTradeForHeader.pct_return ?? 0
  const isWin = pnl >= 0
  const entryPrice = targetTradeForHeader.avg_price ?? targetTradeForHeader.entry_price
  const hasTradeDetails = Boolean(targetTradeForHeader.entry_date && entryPrice)
  const isOpen = 
    hasTradeDetails && (
      !targetTradeForHeader.exit_date || 
      targetTradeForHeader.status === "OPEN" || 
      targetTradeForHeader.status === "ACTIVE" || 
      targetTradeForHeader.status === "SHIELDED" || 
      targetTradeForHeader.status === "RUNNER" || 
      targetTradeForHeader.reason === "Active Position" || 
      targetTradeForHeader.reason === "Marked to Market / Active"
    )

  // Prev / Next trade in sequence
  const curIdx = allTrades ? allTrades.findIndex((t) => t.symbol === trade.symbol) : -1
  const prevTrade = allTrades && curIdx > 0 ? allTrades[curIdx - 1] : null
  const nextTrade = allTrades && curIdx >= 0 && curIdx < allTrades.length - 1 ? allTrades[curIdx + 1] : null

  const content = (
    <div
      className={`bg-white rounded-2xl border border-slate-200/90 flex flex-col transition-all duration-200 overflow-hidden ${
        embedded && !isMaximized
          ? "w-full h-full min-h-0 flex-1 shadow-2xs"
          : isMaximized
          ? "w-[98vw] h-[96vh] max-w-none max-h-none rounded-3xl shadow-2xl"
          : "w-full max-w-5xl max-h-[92vh] h-[820px] rounded-3xl shadow-2xl"
      }`}
    >
        {/* ================= 1. CLEAN EXECUTIVE TITLE BAR ================= */}
        {embedded && !isMaximized ? (
          /* SINGLE CLEAN EXECUTIVE ROW WHEN EMBEDDED IN HOLDINGS */
          <div className="px-3.5 py-2 border-b border-slate-100 flex items-center justify-between bg-white gap-2 shrink-0">
            {/* Left: Symbol, Leg, TV Link, CMP, Multi-Trade tabs */}
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <h2 className="text-base font-black text-slate-900 tracking-tight font-mono">
                {currentSymbol || trade.symbol}
              </h2>

              {loading && (
                <span title="Loading candles...">
                  <RefreshCw className="size-3 animate-spin text-emerald-500 shrink-0" />
                </span>
              )}

              {(() => {
                const legVal = targetTradeForHeader.leg
                const stratLeg = String(targetTradeForHeader.strategy_leg || "").toUpperCase()
                const isLeg2 = legVal === 2 || stratLeg.includes("LEG2")
                const isLeg1 = legVal === 1 || stratLeg.includes("LEG1") || (!isLeg2 && hasTradeDetails)
                if (isLeg2) {
                  return (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-black bg-purple-100 text-purple-700 border border-purple-200 shrink-0">
                      LEG 2
                    </span>
                  )
                }
                if (isLeg1) {
                  return (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-black bg-blue-100 text-blue-700 border border-blue-200 shrink-0">
                      LEG 1
                    </span>
                  )
                }
                return null
              })()}

              <a
                href={`https://in.tradingview.com/chart/?symbol=NSE:${encodeURIComponent(currentSymbol || trade.symbol)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="size-6 inline-flex items-center justify-center rounded-md bg-blue-50 text-blue-600 hover:bg-blue-100 hover:text-blue-800 border border-blue-200/80 transition shadow-2xs shrink-0"
                title={`Open ${currentSymbol || trade.symbol} on TradingView (NSE)`}
              >
                <ExternalLink className="size-3.5" />
              </a>

              {stats && (
                <div className="flex items-center gap-1.5 text-xs font-mono shrink-0 pl-1">
                  <span className="font-black text-slate-900">₹{fmtNum(stats.cmp)}</span>
                  <span
                    className={`font-bold text-[11px] ${
                      stats.dayChangePts >= 0 ? "text-emerald-600" : "text-rose-600"
                    }`}
                  >
                    {stats.dayChangePts >= 0 ? "+" : ""}{stats.dayChangePct.toFixed(2)}%
                  </span>
                </div>
              )}

              {/* Multi-Trade Switcher Tabs (if multiple trades exist for this symbol) */}
              {symbolTrades.length > 1 && (
                <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200 shrink-0 ml-1">
                  {symbolTrades.map((st, idx) => {
                    const isSel = idx === activeTradeIndex
                    const isLeg2 = st.leg === 2 || String(st.strategy_leg || "").toUpperCase().includes("LEG2")
                    const ret = st.pnl_pct ?? st.pct_return ?? 0
                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setActiveTradeIndex(idx)}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition flex items-center gap-1 ${
                          isSel
                            ? "bg-white text-slate-900 shadow-2xs font-extrabold border border-slate-200"
                            : "text-slate-500 hover:text-slate-800"
                        }`}
                        title={`Trade #${idx + 1} (${isLeg2 ? "LEG 2" : "LEG 1"}): ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%`}
                      >
                        <span>T{idx + 1}</span>
                        <span className={`text-[9px] font-black ${ret >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {ret >= 0 ? "+" : ""}{ret.toFixed(0)}%
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Right: Technical Toggles & Action Icons */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setShowEMA50(!showEMA50)}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition border ${
                  showEMA50
                    ? "bg-cyan-50 text-cyan-800 border-cyan-300 font-extrabold"
                    : "bg-white text-slate-400 border-slate-200 hover:text-slate-700"
                }`}
                title="50 Exponential Moving Average"
              >
                50 EMA
              </button>

              <button
                type="button"
                onClick={() => setShowEMA200(!showEMA200)}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition border ${
                  showEMA200
                    ? "bg-amber-50 text-amber-800 border-amber-300 font-extrabold"
                    : "bg-white text-slate-400 border-slate-200 hover:text-slate-700"
                }`}
                title="200 Exponential Moving Average"
              >
                200 EMA
              </button>

              <button
                type="button"
                onClick={() => setShowVolume(!showVolume)}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition border ${
                  showVolume
                    ? "bg-emerald-50 text-emerald-800 border-emerald-300 font-extrabold"
                    : "bg-white text-slate-400 border-slate-200 hover:text-slate-700"
                }`}
                title="Volume Bars"
              >
                Vol
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsMeasureActive(!isMeasureActive)
                  if (isMeasureActive) setMeasureData(null)
                }}
                className={`size-6.5 inline-flex items-center justify-center rounded text-[11px] font-bold transition border ${
                  isMeasureActive
                    ? "bg-purple-600 text-white border-purple-700 shadow-2xs"
                    : "bg-white text-slate-500 hover:text-slate-900 border-slate-200"
                }`}
                title="Measure Tool (or hold Shift on chart)"
              >
                <Ruler className="size-3.5" />
              </button>

              <button
                type="button"
                onClick={() => setIsLogScale(!isLogScale)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold font-mono transition border ${
                  isLogScale
                    ? "bg-indigo-50 text-indigo-700 border-indigo-300 font-extrabold"
                    : "bg-white text-slate-400 border-slate-200 hover:text-slate-700"
                }`}
                title="Toggle Log / Linear Price Scale"
              >
                {isLogScale ? "Log" : "Lin"}
              </button>

              <button
                type="button"
                onClick={handleFitContent}
                className="size-6.5 inline-flex items-center justify-center rounded text-[11px] font-bold border bg-white text-slate-500 hover:text-slate-900 border-slate-200 transition"
                title="Fit all candles"
              >
                <Maximize2 className="size-3.5" />
              </button>

              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsMaximized(true)}
                title="Open Fullscreen Chart Modal"
                className="size-7 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100"
              >
                <Maximize2 className="size-4" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between bg-white gap-4">
            {/* Left: Symbol (shown once), Company Name, Status Pill & Market Price in ONE clean row */}
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-xl font-black text-slate-900 tracking-tight font-mono">
                {currentSymbol || trade.symbol}
              </h2>

              {/* Show company name ONLY if present and different from ticker */}
              {trade.name && trade.name.trim().toUpperCase() !== (currentSymbol || trade.symbol).trim().toUpperCase() && (
                <span className="text-xs text-slate-400 font-medium hidden sm:inline">
                  {trade.name}
                </span>
              )}

              {/* Direct TradingView Link (Icon only) */}
              <a
                href={`https://in.tradingview.com/chart/?symbol=NSE:${encodeURIComponent(currentSymbol || trade.symbol)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="size-6 inline-flex items-center justify-center rounded-md bg-blue-50 text-blue-600 hover:bg-blue-100 hover:text-blue-800 border border-blue-200/80 transition shadow-2xs shrink-0"
                title={`Open ${currentSymbol || trade.symbol} on TradingView (NSE)`}
              >
                <ExternalLink className="size-3.5" />
              </a>

              {/* Single Unified Status / Backtest Badge */}
              {isBacktestMode ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold border bg-amber-50 text-amber-900 border-amber-200 font-mono shadow-2xs">
                  <span className="font-black text-amber-700">⚡ Backtest Sim:</span>
                  {backtestSummary ? (
                    <span>
                      {backtestSummary.total_trades} Trades · {backtestSummary.win_rate}% WR · PF {backtestSummary.profit_factor} · {backtestSummary.realized_pnl >= 0 ? "+" : ""}₹{Math.round(backtestSummary.realized_pnl).toLocaleString("en-IN")}
                    </span>
                  ) : (
                    <span>Simulating...</span>
                  )}
                </span>
              ) : hasTradeDetails ? (
                <span
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border flex items-center gap-1.5 ${
                    isOpen
                      ? "bg-sky-50 text-sky-700 border-sky-200"
                      : isWin
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : "bg-rose-50 text-rose-700 border-rose-200"
                  }`}
                >
                  {isOpen && <span className="size-1.5 rounded-full bg-sky-500 animate-pulse" />}
                  <span>
                    {targetTradeForHeader.trade_id ? (
                      <strong className="font-mono mr-1 text-[10px] opacity-75">{targetTradeForHeader.trade_id} ·</strong>
                    ) : null}
                    {isOpen
                      ? "Active Position"
                      : isWin
                      ? "Closed Winner"
                      : "Closed Trade"}
                  </span>
                  <span className="font-mono font-black">
                    ({isWin ? "+" : ""}{pnlPct.toFixed(1)}% · {isWin ? "+" : ""}₹{Math.abs(pnl).toLocaleString("en-IN", { maximumFractionDigits: 0 })})
                  </span>
                </span>
              ) : null}

              {/* Strategy Leg Badge (LEG 1 Turnaround vs LEG 2 Base Breakout) */}
              {(() => {
                const legVal = targetTradeForHeader.leg
                const stratLeg = String(targetTradeForHeader.strategy_leg || "").toUpperCase()
                const isLeg2 = legVal === 2 || stratLeg.includes("LEG2")
                const isLeg1 = legVal === 1 || stratLeg.includes("LEG1") || (!isLeg2 && hasTradeDetails)
                if (isLeg2) {
                  return (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-black bg-purple-100 text-purple-900 border border-purple-300 shadow-2xs">
                      <span className="size-1.5 rounded-full bg-purple-600" />
                      LEG 2 · Base Breakout / Pullback
                    </span>
                  )
                }
                if (isLeg1) {
                  return (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-black bg-blue-100 text-blue-900 border border-blue-300 shadow-2xs">
                      <span className="size-1.5 rounded-full bg-blue-600" />
                      LEG 1 · Turnaround Breakout
                    </span>
                  )
                }
                return null
              })()}

              {/* Market CMP, Day Gain, 52W, Market Cap & Volume inline */}
              {stats && (
                <div className="flex items-center gap-2 text-xs pl-2 border-l border-slate-200 hidden md:flex">
                  <span className="font-extrabold font-mono text-slate-900">
                    ₹{fmtNum(stats.cmp)}
                  </span>
                  <span
                    className={`font-mono font-bold text-[11px] ${
                      stats.dayChangePts >= 0 ? "text-emerald-600" : "text-rose-600"
                    }`}
                  >
                    {stats.dayChangePts >= 0 ? "+" : ""}
                    {fmtNum(stats.dayChangePts)} ({stats.dayChangePct >= 0 ? "+" : ""}{stats.dayChangePct.toFixed(2)}%)
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500 text-[11px]">
                    52W: ₹{fmtNum(stats.low52, 0)} - ₹{fmtNum(stats.high52, 0)}
                  </span>
                  {marketCapCr != null && marketCapCr > 0 && (
                    <>
                      <span className="text-slate-300">·</span>
                      <span className="text-slate-500 text-[11px]">
                        MCap: <strong className="font-mono text-slate-700">₹{marketCapCr >= 100000 ? (marketCapCr / 100000).toFixed(2) + " L Cr" : Math.round(marketCapCr).toLocaleString("en-IN") + " Cr"}</strong>
                      </span>
                    </>
                  )}
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500 text-[11px]">
                    Vol: <strong className="font-mono text-slate-700">{fmtVol(stats.latestVol)}</strong>
                  </span>
                </div>
              )}
            </div>

            {/* Right: Pagination Flipper & Window Actions */}
            <div className="flex items-center gap-2 shrink-0">
              {!isBacktestMode && allTrades && onSelectTrade && (
                <div className="flex items-center gap-1 bg-slate-50 px-1.5 py-0.5 rounded-lg border border-slate-200">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={!prevTrade}
                    onClick={() => prevTrade && onSelectTrade(prevTrade)}
                    title={prevTrade ? `Previous: ${prevTrade.symbol}` : "No previous"}
                    className="size-5 rounded text-slate-500 hover:text-slate-900"
                  >
                    <ChevronLeft className="size-3.5" />
                  </Button>
                  <span className="text-[11px] font-mono text-slate-500 px-1 font-semibold">
                    {curIdx + 1}/{allTrades.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={!nextTrade}
                    onClick={() => nextTrade && onSelectTrade(nextTrade)}
                    title={nextTrade ? `Next: ${nextTrade.symbol}` : "No next"}
                    className="size-5 rounded text-slate-500 hover:text-slate-900"
                  >
                    <ChevronRight className="size-3.5" />
                  </Button>
                </div>
              )}

              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsMaximized(!isMaximized)}
                title={isMaximized ? "Restore" : "Fullscreen"}
                className="size-7 rounded-lg text-slate-400 hover:text-slate-800"
              >
                {isMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </Button>

              {onClose && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  title="Close (Esc)"
                  className="size-7 rounded-lg text-slate-400 hover:text-slate-800"
                >
                  <X className="size-4" />
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ================= 2. FIXED SLIM CONTROLS TOOLBAR (ONLY FOR POPUP / MAXIMIZED) ================= */}
        {(!embedded || isMaximized) && (
        <div className="px-5 py-1.5 bg-slate-50/70 border-b border-slate-100 flex items-center justify-between gap-3 text-xs">
          {/* Left: Ledger Toggle & Multi-Trade Switcher */}
          <div className="flex items-center gap-2 flex-wrap">
            {symbolTrades.length > 0 && (
              <button
                type="button"
                onClick={() => setShowLedger(!showLedger)}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition flex items-center gap-1 border ${
                  showLedger
                    ? "bg-slate-900 text-white border-slate-950 shadow-2xs"
                    : "bg-white text-slate-600 hover:text-slate-900 border-slate-200"
                }`}
                title="Toggle Trades Ledger table"
              >
                <Table className="size-3" />
                <span>Ledger ({symbolTrades.length})</span>
              </button>
            )}

            {symbolTrades.length > 1 && (
              <div className="flex items-center gap-1 bg-slate-200/70 p-0.5 rounded-lg border border-slate-200">
                {symbolTrades.map((st, idx) => {
                  const isSel = idx === activeTradeIndex
                  const isLeg2 = st.leg === 2 || String(st.strategy_leg || "").toUpperCase().includes("LEG2")
                  const isOpenTrade = !st.exit_date || st.status === "ACTIVE" || st.status === "SHIELDED" || st.status === "RUNNER"
                  const isWin = (st.pnl ?? 0) >= 0
                  const ret = st.pnl_pct ?? st.pct_return ?? 0
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setActiveTradeIndex(idx)}
                      className={`px-2 py-0.5 rounded text-[10px] font-bold transition flex items-center gap-1.5 ${
                        isSel
                          ? "bg-white text-slate-900 shadow-2xs font-extrabold border border-slate-200/80"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                      title={isOpenTrade ? `Trade #${idx + 1} (${isLeg2 ? "LEG 2" : "LEG 1"}): Currently Holding (${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%)` : `Trade #${idx + 1} (${isLeg2 ? "LEG 2" : "LEG 1"}): Closed (${isWin ? "+" : ""}${ret.toFixed(1)}%)`}
                    >
                      <span>Trade #{idx + 1}</span>
                      <span className={`px-1 rounded text-[9px] font-black ${isLeg2 ? "bg-purple-100 text-purple-700 border border-purple-200" : "bg-blue-100 text-blue-700 border border-blue-200"}`}>
                        {isLeg2 ? "LEG 2" : "LEG 1"}
                      </span>
                      {isOpenTrade ? (
                        <span className="px-1.5 py-0.2 rounded text-[9px] bg-sky-100 text-sky-800 font-black">
                          Active {ret >= 0 ? "+" : ""}{ret.toFixed(0)}%
                        </span>
                      ) : (
                        <span className={`text-[9px] font-black ${isWin ? "text-emerald-600" : "text-rose-600"}`}>
                          {isWin ? "+" : ""}{ret.toFixed(0)}%
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Right: Technical Layer Toggles */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowEMA50(!showEMA50)}
              className={`px-2 py-0.5 rounded text-[11px] font-bold transition flex items-center gap-1 border ${
                showEMA50
                  ? "bg-cyan-50 text-cyan-800 border-cyan-300"
                  : "bg-white text-slate-400 border-slate-200"
              }`}
            >
              <span className="size-1.5 rounded-full bg-cyan-500 inline-block" />
              50 EMA
            </button>

            <button
              type="button"
              onClick={() => setShowEMA200(!showEMA200)}
              className={`px-2 py-0.5 rounded text-[11px] font-bold transition flex items-center gap-1 border ${
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
              className={`px-2 py-0.5 rounded text-[11px] font-bold transition flex items-center gap-1 border ${
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
                className={`px-2 py-0.5 rounded text-[11px] font-bold transition flex items-center gap-1 border ${
                  showLevels
                    ? "bg-sky-50 text-sky-800 border-sky-300"
                    : "bg-white text-slate-400 border-slate-200"
                }`}
              >
                <Layers className="size-3" />
                Levels
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                setIsMeasureActive(!isMeasureActive)
                if (isMeasureActive) setMeasureData(null)
              }}
              className={`px-2 py-0.5 rounded text-[11px] font-bold transition flex items-center gap-1 border ${
                isMeasureActive
                  ? "bg-purple-600 text-white border-purple-700 shadow-2xs"
                  : "bg-white text-slate-600 hover:text-slate-900 border-slate-200"
              }`}
              title="Measure Tool (or hold Shift on chart)"
            >
              <Ruler className="size-3" />
              Measure
            </button>

            <button
              type="button"
              onClick={() => setIsLogScale(!isLogScale)}
              className={`px-1.5 py-0.5 rounded text-[11px] font-bold font-mono transition border ${
                isLogScale
                  ? "bg-indigo-50 text-indigo-700 border-indigo-300"
                  : "bg-white text-slate-400 border-slate-200 hover:text-slate-700"
              }`}
              title="Toggle Log / Linear Price Scale"
            >
              {isLogScale ? "Log" : "Lin"}
            </button>

            <button
              type="button"
              onClick={handleFitContent}
              className="px-2 py-0.5 rounded text-[11px] font-bold border bg-white text-slate-600 hover:text-slate-900 border-slate-200 transition flex items-center gap-1"
              title="Fit all candles"
            >
              <Maximize2 className="size-3" />
              Fit
            </button>
          </div>
        </div>
        )}

        {/* ================= 3. CHART CANVAS ================= */}
        <div className="p-3 sm:p-5 flex-1 relative bg-white min-h-[420px] overflow-hidden">
          {/* Floating In-Chart OHLCV Legend: Clean, sleek, non-intrusive */}
          {hovered && (
            <div className="absolute top-3 left-4 z-10 pointer-events-none flex items-center gap-2 font-mono text-[11px] bg-white/90 backdrop-blur-xs px-2.5 py-1 rounded-md border border-slate-200/80 shadow-2xs">
              <span className="font-bold text-slate-700">{hovered.time}</span>
              <span className="text-slate-300">·</span>
              <span className="text-slate-500">O <strong className="text-slate-800">₹{fmtNum(hovered.open)}</strong></span>
              <span className="text-slate-500">H <strong className="text-slate-800">₹{fmtNum(hovered.high)}</strong></span>
              <span className="text-slate-500">L <strong className="text-slate-800">₹{fmtNum(hovered.low)}</strong></span>
              <span className="text-slate-500">C <strong className="text-slate-900">₹{fmtNum(hovered.close)}</strong></span>
              <span
                className={`font-black ${
                  hovered.changePct >= 0 ? "text-emerald-600" : "text-rose-600"
                }`}
              >
                ({hovered.changePct >= 0 ? "+" : ""}{hovered.changePct.toFixed(2)}%)
              </span>
              {hovered.volume ? (
                <>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500">Vol <strong className="text-slate-700">{fmtVol(hovered.volume)}</strong></span>
                </>
              ) : null}
            </div>
          )}

          {/* Measure / Scale Tool Interactive Canvas Overlay */}
          {(isMeasureActive || isShiftPressed) && (
            <div
              className="absolute inset-0 z-20 cursor-crosshair select-none"
              onPointerDown={handleMeasurePointerDown}
              onPointerMove={handleMeasurePointerMove}
              onPointerUp={handleMeasurePointerUp}
            >
              {!measureData && (
                <div className="absolute top-4 right-6 z-20 bg-slate-900/90 text-white text-[11px] px-3 py-1.5 rounded-lg shadow-lg font-sans flex items-center gap-2 pointer-events-none">
                  <Ruler className="size-3.5 text-purple-400" />
                  <span>Click and drag across candles to measure % return & bars</span>
                </div>
              )}
            </div>
          )}

          {/* Render Active Measure Box & Floating Badge Card */}
          {measureData && measureStats && (
            <>
              <svg className="absolute inset-0 pointer-events-none w-full h-full z-20">
                {/* Shaded box */}
                <rect
                  x={measureStats.left}
                  y={measureStats.top}
                  width={measureStats.width}
                  height={measureStats.height}
                  fill={measureStats.isPositive ? "rgba(16, 185, 129, 0.16)" : "rgba(244, 63, 94, 0.16)"}
                  stroke={measureStats.isPositive ? "#10b981" : "#f43f5e"}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  rx={4}
                />
                {/* Diagonal connection line */}
                <line
                  x1={measureData.x1}
                  y1={measureData.y1}
                  x2={measureData.x2}
                  y2={measureData.y2}
                  stroke={measureStats.isPositive ? "#059669" : "#e11d48"}
                  strokeWidth={2}
                />
                <circle cx={measureData.x1} cy={measureData.y1} r={3.5} fill={measureStats.isPositive ? "#059669" : "#e11d48"} />
                <circle cx={measureData.x2} cy={measureData.y2} r={3.5} fill={measureStats.isPositive ? "#059669" : "#e11d48"} />
              </svg>

              {/* Floating Pill / Tooltip Card */}
              <div
                className={`absolute z-30 pointer-events-auto rounded-xl p-2.5 shadow-xl border text-xs font-mono select-none flex flex-col gap-1 transition-all ${
                  measureStats.isPositive
                    ? "bg-slate-900 text-white border-emerald-500/60 shadow-emerald-950/20"
                    : "bg-slate-900 text-white border-rose-500/60 shadow-rose-950/20"
                }`}
                style={{
                  left: `${Math.min(Math.max(measureData.x2 + 10, 20), (containerRef.current?.clientWidth ?? 800) - 200)}px`,
                  top: `${Math.min(Math.max(measureData.y2 - 60, 20), (containerRef.current?.clientHeight ?? 450) - 90)}px`
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5 font-bold text-sm">
                    <span className={measureStats.isPositive ? "text-emerald-400" : "text-rose-400"}>
                      {measureStats.isPositive ? "▲" : "▼"}
                    </span>
                    <span>{measureStats.isPositive ? "+" : ""}₹{fmtNum(measureStats.priceDiff)}</span>
                    <span
                      className={`font-black ${
                        measureStats.isPositive ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      ({measureStats.isPositive ? "+" : ""}{measureStats.pctDiff.toFixed(2)}%)
                    </span>
                  </div>
                  {measureData.isLocked && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMeasureData(null)
                        setIsMeasureActive(false)
                      }}
                      className="size-5 rounded hover:bg-white/20 flex items-center justify-center text-white/70 hover:text-white transition"
                      title="Clear measurement"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
                <div className="text-[11px] text-slate-300 flex items-center gap-1.5">
                  <span className="font-semibold">{measureData.bars} bars</span>
                  {measureStats.days > 0 && <span>· {measureStats.days} days</span>}
                </div>
                <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-700/60 flex items-center justify-between gap-2">
                  <span>₹{fmtNum(measureData.price1)}</span>
                  <span>→</span>
                  <span>₹{fmtNum(measureData.price2)}</span>
                </div>
              </div>
            </>
          )}

          {/* Subtle top loading pulse bar if chart already has candles (ZERO flickering) */}
          {loading && candles.length > 0 && (
            <div className="absolute top-0 left-0 right-0 h-0.5 bg-emerald-500 animate-pulse z-30 pointer-events-none" />
          )}

          {/* Centered loader ONLY on initial blank load when no candles exist yet */}
          {loading && candles.length === 0 && (
            <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-white/95 backdrop-blur-xs gap-3">
              <div className="size-10 rounded-2xl bg-emerald-500/10 border border-emerald-300 flex items-center justify-center text-emerald-600 shadow-sm animate-pulse">
                <RefreshCw className="size-5 text-emerald-600 animate-spin" />
              </div>
              <div className="text-center">
                <span className="text-sm font-black text-slate-800 tracking-tight font-mono">
                  Loading {currentSymbol || trade.symbol}...
                </span>
              </div>
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

          {/* Collapsible Trade Ledger Drawer at Bottom of Chart */}
          {showLedger && symbolTrades.length > 0 && (
            <div className="border-t border-slate-200 bg-white/95 backdrop-blur-md max-h-56 overflow-y-auto animate-in slide-in-from-bottom-2 duration-150 z-20 shrink-0">
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between sticky top-0 z-10 text-xs">
                <span className="font-bold text-slate-700 flex items-center gap-1.5 font-mono">
                  <Table className="size-3.5 text-slate-500" />
                  <span>
                    {isBacktestMode ? "Simulated Trades Ledger" : "Trade Execution Ledger"} ({symbolTrades.length} {symbolTrades.length === 1 ? "Trade" : "Trades"})
                  </span>
                </span>
                <span className="text-[11px] text-slate-400">
                  Click any trade row to zoom chart directly to that entry & exit
                </span>
              </div>
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-white border-b border-slate-100 text-slate-400 font-bold uppercase tracking-wider text-[10px] sticky top-8">
                    <th className="p-2 pl-4">#</th>
                    <th className="p-2">Strategy Leg</th>
                    <th className="p-2">Entry Date</th>
                    <th className="p-2 font-mono text-right">Entry Price</th>
                    <th className="p-2">Exit Date</th>
                    <th className="p-2 font-mono text-right">Exit Price</th>
                    <th className="p-2 font-mono text-center">Days</th>
                    <th className="p-2">Exit Reason</th>
                    <th className="p-2 pr-4 font-mono text-right">Return & P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {symbolTrades.map((st, i) => {
                    const isSel = i === activeTradeIndex
                    const isTradeWin = (st.pnl ?? 0) >= 0
                    const isOpenTrade = !st.exit_date || st.status === "ACTIVE" || st.status === "SHIELDED" || st.status === "RUNNER"
                    const tradeNum = i + 1
                    const isLeg2 = st.leg === 2 || String(st.strategy_leg || "").toUpperCase().includes("LEG2")
                    return (
                      <tr
                        key={i}
                        onClick={() => setActiveTradeIndex(i)}
                        className={`cursor-pointer transition group ${
                          isSel
                            ? "bg-amber-100/70 font-semibold text-amber-950"
                            : "hover:bg-slate-50/80 text-slate-700"
                        }`}
                      >
                        <td className="p-2 pl-4 font-mono font-bold">
                          <span className={isSel ? "text-amber-800" : "text-slate-400"}>
                            #{tradeNum}
                          </span>
                        </td>
                        <td className="p-2">
                          {isLeg2 ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">
                              <span className="size-1 rounded-full bg-purple-500" />
                              LEG 2
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                              <span className="size-1 rounded-full bg-blue-500" />
                              LEG 1
                            </span>
                          )}
                        </td>
                        <td className="p-2 font-mono text-slate-600">{st.entry_date}</td>
                        <td className="p-2 font-mono text-right font-bold text-slate-800">
                          ₹{st.entry_price?.toFixed(2)}
                        </td>
                        <td className="p-2 font-mono text-slate-600">
                          {isOpenTrade ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-sky-100 text-sky-800">
                              Holding
                            </span>
                          ) : (
                            st.exit_date
                          )}
                        </td>
                        <td className="p-2 font-mono text-right font-bold text-slate-800">
                          ₹{isOpenTrade ? st.cmp?.toFixed(2) : st.exit_price?.toFixed(2)}
                        </td>
                        <td className="p-2 font-mono text-center text-slate-500">
                          {st.days_held}d
                        </td>
                        <td className="p-2 text-slate-500 text-[11px]">
                          {isOpenTrade ? st.status : st.exit_reason || st.reason}
                        </td>
                        <td className="p-2 pr-4 font-mono text-right font-black">
                          <span className={isTradeWin ? "text-emerald-600" : "text-rose-600"}>
                            {isTradeWin ? "+" : ""}
                            {(st.pnl_pct ?? st.pct_return ?? 0).toFixed(1)}% (
                            {isTradeWin ? "+" : ""}₹
                            {Math.abs(st.pnl ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })})
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
  )

  if (embedded && !isMaximized) {
    return content
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in duration-150">
      {content}
    </div>
  )
}

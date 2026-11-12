import { useEffect, useRef, useState } from "react"
import {
  createChart,
  CandlestickSeries,
  LineStyle,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time
} from "lightweight-charts"
import { X, TrendingUp, TrendingDown, Clock, ShieldCheck, Target, ArrowUpRight, ArrowDownRight, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

export interface SwingerTradeTarget {
  symbol: string
  name?: string
  entry_date: string
  exit_date?: string
  entry_price: number
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

export function SwingerTradeChartModal({
  trade,
  onClose
}: {
  trade: SwingerTradeTarget | null
  onClose: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null)
  const [loading, setLoading] = useState(false)
  const [candles, setCandles] = useState<CandleData[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  useEffect(() => {
    if (!trade) return
    let active = true
    setLoading(true)
    setError(null)

    // Calculate sensible time range (e.g. 60 days before entry to 30 days after exit or today)
    const entryDate = new Date(trade.entry_date)
    const fromDate = new Date(entryDate)
    fromDate.setDate(fromDate.getDate() - 75)

    const exitDateStr = trade.exit_date || new Date().toISOString().slice(0, 10)
    const exitDate = new Date(exitDateStr)
    const toDate = new Date(exitDate)
    toDate.setDate(toDate.getDate() + 30)

    const fromStr = fromDate.toISOString().slice(0, 10)
    const toStr = toDate.toISOString().slice(0, 10)

    fetch(`/api/swinger/candles?symbol=${encodeURIComponent(trade.symbol)}&from=${fromStr}&to=${toStr}`)
      .then((r) => r.json())
      .then((d) => {
        if (!active) return
        if (d.ok && Array.isArray(d.candles) && d.candles.length > 0) {
          setCandles(d.candles)
        } else {
          setError(`No candle data available for ${trade.symbol}`)
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
  }, [trade])

  // Initialize and draw Lightweight Chart
  useEffect(() => {
    if (!containerRef.current || candles.length === 0 || !trade) return

    // Clean up previous chart instance
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
    }

    const container = containerRef.current
    const chart = createChart(container, {
      width: container.clientWidth,
      height: 440,
      layout: {
        background: { color: "#ffffff" },
        textColor: "#475569"
      },
      grid: {
        vertLines: { color: "#f1f5f9" },
        horzLines: { color: "#f1f5f9" }
      },
      crosshair: {
        mode: 1
      },
      timeScale: {
        borderColor: "#cbd5e1",
        timeVisible: true,
        secondsVisible: false
      },
      rightPriceScale: {
        borderColor: "#cbd5e1"
      }
    })

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#f43f5e",
      borderVisible: false,
      wickUpColor: "#10b981",
      wickDownColor: "#f43f5e",
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.05
      }
    })

    // Prepare candles for lightweight-charts
    const sorted = [...candles].sort((a, b) => a.time.localeCompare(b.time))
    series.setData(sorted as any)

    const entryPrice = trade.avg_price ?? trade.entry_price
    const slPrice = entryPrice * 0.75
    const bePrice = entryPrice * 1.20
    const tpPrice = entryPrice * 1.30

    // Add Horizontal Price Levels
    series.createPriceLine({
      price: entryPrice,
      color: "#059669",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `ENTRY: ₹${entryPrice.toFixed(1)}`
    })

    series.createPriceLine({
      price: slPrice,
      color: "#e11d48",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: `INITIAL SL (-25%): ₹${slPrice.toFixed(1)}`
    })

    series.createPriceLine({
      price: bePrice,
      color: "#0284c7",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: `BE SHIELD (+20%): ₹${bePrice.toFixed(1)}`
    })

    series.createPriceLine({
      price: tpPrice,
      color: "#16a34a",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `TP1 (+30%): ₹${tpPrice.toFixed(1)}`
    })

    if (trade.exit_price) {
      series.createPriceLine({
        price: trade.exit_price,
        color: (trade.pnl ?? 0) >= 0 ? "#10b981" : "#e11d48",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `EXIT: ₹${trade.exit_price.toFixed(1)}`
      })
    }

    // Build Series Markers for Entry and Exit
    const markers: SeriesMarker<Time>[] = []

    // 1. BUY Marker
    markers.push({
      time: trade.entry_date as any,
      position: "belowBar",
      color: "#10b981",
      shape: "arrowUp",
      text: `BUY @ ₹${entryPrice.toFixed(1)}`,
      size: 2
    })

    // 2. EXIT Marker (if closed)
    if (trade.exit_date && trade.exit_price) {
      const isWin = (trade.pnl ?? 0) >= 0
      const ret = trade.pnl_pct ?? trade.pct_return ?? 0
      markers.push({
        time: trade.exit_date as any,
        position: "aboveBar",
        color: isWin ? "#10b981" : "#f43f5e",
        shape: "arrowDown",
        text: `EXIT @ ₹${trade.exit_price.toFixed(1)} (${isWin ? "+" : ""}${ret.toFixed(1)}%)`,
        size: 2
      })
    }

    markers.sort((a, b) => (a.time as string).localeCompare(b.time as string))
    createSeriesMarkers(series, markers)

    // Fit chart viewport nicely
    chart.timeScale().fitContent()

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    }
    window.addEventListener("resize", handleResize)

    chartRef.current = chart
    seriesRef.current = series

    return () => {
      window.removeEventListener("resize", handleResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [candles, trade])

  if (!trade) return null

  const pnl = trade.pnl ?? 0
  const pnlPct = trade.pnl_pct ?? trade.pct_return ?? 0
  const isWin = pnl >= 0
  const entryPrice = trade.avg_price ?? trade.entry_price
  const exitPrice = trade.exit_price ?? trade.cmp ?? entryPrice
  const daysHeld = trade.days_held ?? trade.holding_days ?? 0
  const isOpen = !trade.exit_date

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 sm:p-6 animate-in fade-in duration-150">
      <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-5xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
          <div className="flex items-center gap-3">
            <div className={`size-11 rounded-2xl flex items-center justify-center font-black text-white text-base ${isWin ? "bg-emerald-600 shadow-emerald-200 shadow-md" : "bg-rose-600 shadow-rose-200 shadow-md"}`}>
              {trade.symbol.slice(0, 3)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-black text-slate-900 tracking-tight">{trade.symbol}</h2>
                <span className="text-xs text-slate-500 font-medium">{trade.name || trade.symbol}</span>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${isOpen ? "bg-sky-100 text-sky-800 border-sky-300" : isWin ? "bg-emerald-100 text-emerald-800 border-emerald-300" : "bg-rose-100 text-rose-800 border-rose-300"}`}>
                  {isOpen ? "ACTIVE PAPER POSITION" : isWin ? "WINNER" : "STOP LOSS"}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5 font-medium">
                Entry: <strong className="text-slate-800">{trade.entry_date}</strong> @ <strong className="text-slate-800 font-mono">₹{entryPrice.toFixed(2)}</strong> · 
                {isOpen ? " Current CMP: " : " Exit: "}
                <strong className="text-slate-800">{trade.exit_date || "Holding"}</strong> @ <strong className="text-slate-800 font-mono">₹{exitPrice.toFixed(2)}</strong> · 
                Held: <strong className="text-slate-800">{daysHeld} days</strong>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className={`text-2xl font-black font-mono tracking-tight ${isWin ? "text-emerald-600" : "text-rose-600"}`}>
                {isWin ? "+" : ""}₹{pnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
              </div>
              <div className={`text-xs font-bold font-mono ${isWin ? "text-emerald-700" : "text-rose-700"}`}>
                {isWin ? "+" : ""}{pnlPct.toFixed(2)}% Net Gain
              </div>
            </div>

            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="size-9 rounded-full text-slate-400 hover:text-slate-800 hover:bg-slate-200/60"
            >
              <X className="size-5" />
            </Button>
          </div>
        </div>

        {/* 4 Trade Milestone Badges */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-4 bg-white border-b border-slate-100 text-xs">
          <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Entry Breakout</span>
            <span className="font-mono font-bold text-slate-900 text-sm">₹{entryPrice.toFixed(2)}</span>
            <span className="text-[11px] text-slate-500 block">{trade.entry_date}</span>
          </div>

          <div className="p-2.5 rounded-xl bg-rose-50/50 border border-rose-200/70">
            <span className="text-[10px] font-bold uppercase tracking-wider text-rose-500 block">Initial SL (-25%)</span>
            <span className="font-mono font-bold text-rose-700 text-sm">₹{(entryPrice * 0.75).toFixed(2)}</span>
            <span className="text-[11px] text-rose-600/80 block">Max Risk Capped</span>
          </div>

          <div className="p-2.5 rounded-xl bg-sky-50/50 border border-sky-200/70">
            <span className="text-[10px] font-bold uppercase tracking-wider text-sky-600 block">BE Shield (+20%)</span>
            <span className="font-mono font-bold text-sky-800 text-sm">₹{(entryPrice * 1.20).toFixed(2)}</span>
            <span className="text-[11px] text-sky-600/80 block">Snaps SL to Cost</span>
          </div>

          <div className="p-2.5 rounded-xl bg-emerald-50/50 border border-emerald-200/70">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 block">TP1 Target (+30%)</span>
            <span className="font-mono font-bold text-emerald-800 text-sm">₹{(entryPrice * 1.30).toFixed(2)}</span>
            <span className="text-[11px] text-emerald-600/80 block">Books 50% Shares</span>
          </div>
        </div>

        {/* Chart Canvas Area */}
        <div className="p-5 flex-1 relative min-h-[440px] bg-white">
          {loading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/80 backdrop-blur-xs gap-2">
              <RefreshCw className="size-6 text-emerald-600 animate-spin" />
              <span className="text-xs font-bold text-slate-600">Loading {trade.symbol} candlestick history...</span>
            </div>
          )}

          {error && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white gap-2 p-6 text-center">
              <p className="text-sm font-bold text-rose-600">{error}</p>
              <Button variant="outline" size="sm" onClick={onClose} className="text-xs">
                Close
              </Button>
            </div>
          )}

          <div ref={containerRef} className="w-full h-[440px]" />
        </div>

        {/* Modal Footer / Navigation Guide */}
        <div className="p-4 border-t border-slate-100 bg-slate-50/60 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 text-xs text-slate-500">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="flex items-center gap-1.5 font-medium">
              <span className="size-2 rounded-full bg-emerald-500" />
              Green Arrow: Buy Entry
            </span>
            <span className="flex items-center gap-1.5 font-medium">
              <span className="size-2 rounded-full bg-rose-500" />
              Red/Emerald Arrow: Exit
            </span>
            <span className="flex items-center gap-1.5 font-medium">
              <span className="w-3 h-0.5 bg-emerald-600 inline-block" />
              Entry / Target Lines
            </span>
            <span className="flex items-center gap-1.5 font-medium">
              <span className="w-3 h-0.5 bg-rose-500 inline-block" />
              Stop Loss Line
            </span>
          </div>

          <div className="text-[11px] text-slate-400 font-mono">
            Press <kbd className="px-1.5 py-0.5 bg-white border border-slate-200 rounded text-slate-600 font-semibold shadow-2xs">ESC</kbd> to close
          </div>
        </div>
      </div>
    </div>
  )
}

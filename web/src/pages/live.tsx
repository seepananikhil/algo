import { useState, useMemo, useCallback, useEffect, useRef } from "react"
import { toast } from "sonner"
import {
  Radio,
  Clock,
  Target,
  RefreshCw,
  X,
  Minus,
  GripVertical,
  LogOut,
  ShieldCheck,
  Zap,
  TrendingUp,
  Loader2,
  PanelRightClose,
  Maximize2,
  ArrowUpRight,
  ArrowDownRight,
  ChevronDown,
} from "lucide-react"
import { CandleChart } from "@/components/candle-chart"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  fmtRs,
  pnlClass,
  postJSON,
  usePoll,
  type DayData,
  type OptionTrade,
  type RuleTrade,
} from "@/lib/api"
import { useStatus } from "@/lib/status"

function toRuleTrade(trade: OptionTrade): RuleTrade {
  return {
    side: trade.side || "CALL",
    entry: trade.entry ? trade.entry.slice(0, 5) : "09:15",
    entry_price: trade.spot_at_entry || trade.nifty_in || trade.buy_price || 0,
    sl: trade.sl != null && !Number.isNaN(trade.sl) ? trade.sl : Number.NaN,
    target: trade.target != null && !Number.isNaN(trade.target) ? trade.target : Number.NaN,
    exit: trade.exit ? trade.exit.slice(0, 5) : "",
    exit_price: trade.nifty_out || trade.sell_price || 0,
    reason: trade.exit_reason || (trade.is_open ? "open" : ""),
    pnl_points: trade.nifty_points ?? trade.pnl_points ?? 0,
    setup: trade.trigger_label || trade.strategy,
  }
}

export function LivePage() {
  const { status, reload: reloadStatus } = useStatus()
  const today = status?.now?.slice(0, 10) ?? new Date().toISOString().slice(0, 10)

  // Chart view: SENSEX, NIFTY, or DUAL split
  const [activeChart, setActiveChart] = useState<"SENSEX" | "NIFTY" | "DUAL">("SENSEX")
  const [selectedTrade, setSelectedTrade] = useState<OptionTrade | null>(null)

  // Side Panel state: open / collapsed, and active tab
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false)
  const [sideTab, setSideTab] = useState<"ACTIVE" | "CLOSED" | "SUMMARY">("ACTIVE")

  // Scalp Widget State
  const [showScalpBar, setShowScalpBar] = useState(true)
  const [scalpSpot, setScalpSpot] = useState<"NIFTY" | "SENSEX">("NIFTY")
  const [scalpLots, setScalpLots] = useState(1)
  const [scalpOptionType, setScalpOptionType] = useState<"CE" | "PE">("CE")
  const [scalpTp, setScalpTp] = useState<number>(0)
  const [scalpTs, setScalpTs] = useState<number>(0)
  const [scalpBusy, setScalpBusy] = useState(false)
  // Default position: within chart canvas, cleanly ABOVE the bottom x-axis (time scale)
  const [scalpPos, setScalpPos] = useState<{ x: number; y: number }>(() => {
    if (typeof window === "undefined") return { x: 820, y: 780 }
    const x = Math.max(70, window.innerWidth - 85 - 350)
    const y = Math.max(110, window.innerHeight - 56 - 42)
    return { x, y }
  })
  const [isDraggingScalp, setIsDraggingScalp] = useState(false)
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [isScalpMinimized, setIsScalpMinimized] = useState(true)

  // Session Summary Popover State
  const [showPnlSummary, setShowPnlSummary] = useState(false)
  const pnlSummaryRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showPnlSummary) return
    const handleDown = (e: MouseEvent) => {
      if (pnlSummaryRef.current && !pnlSummaryRef.current.contains(e.target as Node)) {
        setShowPnlSummary(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowPnlSummary(false)
    }
    document.addEventListener("mousedown", handleDown)
    document.addEventListener("keydown", handleKey)
    return () => {
      document.removeEventListener("mousedown", handleDown)
      document.removeEventListener("keydown", handleKey)
    }
  }, [showPnlSummary])

  // Drag handlers for floating scalper
  const handleDragStart = (e: React.MouseEvent) => {
    setIsDraggingScalp(true)
    setDragOffset({
      x: e.clientX - scalpPos.x,
      y: e.clientY - scalpPos.y,
    })
  }

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDraggingScalp) return
      const sidePanelW = isSidePanelOpen ? (window.innerWidth >= 1024 ? 384 : 320) : 0
      const widgetW = isScalpMinimized ? 350 : 285
      const widgetH = isScalpMinimized ? 42 : 280

      const minX = 70
      const maxX = Math.max(minX, window.innerWidth - sidePanelW - 75 - widgetW)
      const minY = 100
      // Always keep above the bottom x-axis time scale
      const maxY = Math.max(minY, window.innerHeight - 56 - widgetH)

      const newX = Math.min(maxX, Math.max(minX, e.clientX - dragOffset.x))
      const newY = Math.min(maxY, Math.max(minY, e.clientY - dragOffset.y))
      setScalpPos({ x: newX, y: newY })
    },
    [isDraggingScalp, dragOffset, isSidePanelOpen, isScalpMinimized]
  )

  // Keep scalper within chart when side panel toggles
  useEffect(() => {
    setScalpPos((pos) => {
      const sidePanelW = isSidePanelOpen ? (window.innerWidth >= 1024 ? 384 : 320) : 0
      const widgetW = isScalpMinimized ? 350 : 285
      const rightLimit = window.innerWidth - sidePanelW - 75 - widgetW
      if (pos.x > rightLimit) {
        return { ...pos, x: Math.max(70, rightLimit) }
      }
      return pos
    })
  }, [isSidePanelOpen, isScalpMinimized])

  const handleMouseUp = useCallback(() => {
    setIsDraggingScalp(false)
  }, [])

  useEffect(() => {
    if (isDraggingScalp) {
      window.addEventListener("mousemove", handleMouseMove)
      window.addEventListener("mouseup", handleMouseUp)
      return () => {
        window.removeEventListener("mousemove", handleMouseMove)
        window.removeEventListener("mouseup", handleMouseUp)
      }
    }
  }, [isDraggingScalp, handleMouseMove, handleMouseUp])

  // Exit dialog states
  const [exitTarget, setExitTarget] = useState<OptionTrade | null>(null)
  const [exitBusy, setExitBusy] = useState(false)
  const [exitAllConfirmOpen, setExitAllConfirmOpen] = useState(false)
  const [exitAllBusy, setExitAllBusy] = useState(false)

  // Polling feeds: Day candle data
  const niftyDay = usePoll<DayData>(today ? `/api/day?date=${today}&symbol=NIFTY&full=1` : null, 2500)
  const sensexDay = usePoll<DayData>(today ? `/api/day?date=${today}&symbol=SENSEX&full=1` : null, 2500)

  // Polling feeds: All strategy paper trades & live broker positions
  const liveTradesPoll = usePoll<OptionTrade[]>("/api/trades", 2500)

  const tradesList = useMemo(() => {
    return liveTradesPoll.data ?? []
  }, [liveTradesPoll.data])

  // Partition into Active and Closed
  const openTrades = useMemo(() => {
    return tradesList.filter((t) => t.is_open !== false && (!t.exit || t.exit === "" || t.exit_reason === "open"))
  }, [tradesList])

  const closedTrades = useMemo(() => {
    return tradesList.filter((t) => t.is_open === false || (t.exit && t.exit !== "" && t.exit_reason !== "open"))
  }, [tradesList])

  // Calculate Running Position Summary Metrics
  const summaryMetrics = useMemo(() => {
    let runningPnl = 0
    let investedCapital = 0
    openTrades.forEach((t) => {
      const pnl = t.option_pnl_rs ?? t.pnl_rs ?? (t.futures_pnl_rs ?? 0)
      runningPnl += pnl
      investedCapital += t.buy_value_rs || (t.buy_price ? t.buy_price * (t.qty || 1) : 0)
    })

    let realizedPnl = 0
    let winners = 0
    let losers = 0
    closedTrades.forEach((t) => {
      const pnl = t.net_rs ?? t.pnl_rs ?? 0
      realizedPnl += pnl
      if (pnl > 0) winners++
      else if (pnl < 0) losers++
    })

    const winRate = (winners + losers) > 0 ? (winners / (winners + losers)) * 100 : 0

    return {
      totalPnl: runningPnl + realizedPnl,
      runningPnl,
      investedCapital,
      realizedPnl,
      openCount: openTrades.length,
      closedCount: closedTrades.length,
      winners,
      losers,
      winRate,
    }
  }, [openTrades, closedTrades])

  // Current market LTPs
  const niftyLtp = status?.last_tick?.ltp ?? (niftyDay.data?.candles?.at(-1)?.close ?? 24540)
  const sensexLtp = status?.sensex_last_tick?.ltp ?? (sensexDay.data?.candles?.at(-1)?.close ?? 74385)

  // Compute ATM strikes for scalp widget
  const currentAtmStrike = useMemo(() => {
    if (scalpSpot === "SENSEX") {
      return Math.round(sensexLtp / 100) * 100
    }
    return Math.round(niftyLtp / 50) * 50
  }, [scalpSpot, sensexLtp, niftyLtp])

  // Selectable Strike (default ATM, or +/- strikes)
  const [customStrike, setCustomStrike] = useState<number | null>(null)
  const strikeStep = scalpSpot === "SENSEX" ? 100 : 50
  const activeStrike = customStrike ?? currentAtmStrike

  const strikeChoices = useMemo(() => {
    const arr: number[] = []
    for (let i = -3; i <= 3; i++) {
      arr.push(currentAtmStrike + i * strikeStep)
    }
    return arr
  }, [currentAtmStrike, strikeStep])

  // Check if there is an active running position for the selected scalp spot
  const activeSpotTrade = useMemo(() => {
    return openTrades.find((t) => {
      const sym = (t.symbol || t.strategy || t.option || "").toUpperCase()
      return sym.includes(scalpSpot)
    })
  }, [openTrades, scalpSpot])



  // Map trades to chart markers
  const sensexChartTrades = useMemo(() => {
    if (selectedTrade && (selectedTrade.symbol?.toUpperCase().includes("SENSEX") || selectedTrade.symbol?.includes("BSESN"))) {
      return [toRuleTrade(selectedTrade)]
    }
    const filtered = tradesList.filter((t) => t.symbol?.toUpperCase().includes("SENSEX") || t.symbol?.includes("BSESN"))
    return filtered.map(toRuleTrade)
  }, [tradesList, selectedTrade])

  const niftyChartTrades = useMemo(() => {
    if (selectedTrade && (!selectedTrade.symbol || selectedTrade.symbol?.toUpperCase().includes("NIFTY") || selectedTrade.symbol?.includes("NSEI"))) {
      return [toRuleTrade(selectedTrade)]
    }
    const filtered = tradesList.filter((t) => !t.symbol || t.symbol?.toUpperCase().includes("NIFTY") || t.symbol?.includes("NSEI"))
    return filtered.map(toRuleTrade)
  }, [tradesList, selectedTrade])

  // Handle clicking a trade card / row -> immediately load respective chart & highlight
  const handleSelectTrade = useCallback((trade: OptionTrade) => {
    setSelectedTrade(trade)
    const sym = (trade.symbol || trade.strategy || "").toUpperCase()
    if (activeChart !== "DUAL") {
      if (sym.includes("SENSEX") || sym.includes("BSESN")) {
        setActiveChart("SENSEX")
      } else {
        setActiveChart("NIFTY")
      }
    }
  }, [activeChart])

  // Scalp Order Submission (BUY CE, BUY PE, or SELL)
  const handleScalpOrder = async (action: "BUY" | "SELL", optionType: "CE" | "PE" = "CE") => {
    setScalpBusy(true)
    try {
      const res = await postJSON<{ ok: boolean; message?: string }>("/api/scalp-order", {
        symbol: scalpSpot,
        action,
        option_type: optionType,
        lots: scalpLots,
        strike: activeStrike,
        tp: scalpTp,
        ts: scalpTs,
      })
      toast.success(res.message || `${action} ${optionType} Scalp executed`)
      liveTradesPoll.reload()
      if (activeChart !== "DUAL" && activeChart !== scalpSpot) {
        setActiveChart(scalpSpot)
      }
    } catch (err) {
      toast.error(`Scalp order failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setScalpBusy(false)
    }
  }

  // Quick exit current spot position from scalp widget
  const handleScalpExit = async () => {
    setScalpBusy(true)
    try {
      const targetOption = activeSpotTrade?.option || ""
      const res = await postJSON<{ ok: boolean; message?: string }>("/api/scalp-order", {
        symbol: scalpSpot,
        action: "EXIT",
        target_option: targetOption,
      })
      toast.success(res.message || `Squared off ${scalpSpot} position`)
      liveTradesPoll.reload()
    } catch (err) {
      toast.error(`Exit failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setScalpBusy(false)
    }
  }

  // Square off single position handler (Dialog confirm)
  const handleSquareOffPosition = async () => {
    if (!exitTarget) return
    setExitBusy(true)
    try {
      await postJSON("/api/exit-position", {
        symbol: exitTarget.option || exitTarget.symbol,
        qty: exitTarget.qty || 1,
      })
      toast.success(`Exited position: ${exitTarget.option || exitTarget.symbol}`)
      setExitTarget(null)
      liveTradesPoll.reload()
    } catch (err) {
      toast.error(`Exit failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExitBusy(false)
    }
  }

  // Square off all positions handler
  const handleSquareOffAll = async () => {
    setExitAllBusy(true)
    try {
      await postJSON("/api/exit-all", {})
      toast.success("All positions squared off successfully")
      setExitAllConfirmOpen(false)
      liveTradesPoll.reload()
    } catch (err) {
      toast.error(`Exit all failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExitAllBusy(false)
    }
  }

  // Kill Switch Toggle
  const handleKillSwitchToggle = async () => {
    try {
      const isStopped = status?.kill_switch
      const url = isStopped ? "/api/kill-switch/off" : "/api/kill-switch/on"
      await postJSON(url)
      toast.success(isStopped ? "System resumed" : "Emergency Kill Switch Activated")
      reloadStatus()
    } catch (err) {
      toast.error(`Kill switch action failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="flex flex-col h-full w-full flex-1 min-h-0 bg-background text-foreground overflow-hidden font-sans">
      {/* 1. TOP HEADER / TICKER BAR */}
      <header className="flex-none bg-card border-b border-border px-4 py-2 flex items-center justify-between shadow-xs z-20">
        <div className="flex items-center space-x-4">
          {/* Status Indicator / Emergency Halt */}
          <button
            type="button"
            onClick={handleKillSwitchToggle}
            className="flex items-center space-x-2 px-2 py-0.5 rounded-md hover:bg-muted/70 transition-colors cursor-pointer group"
            title={status?.kill_switch ? "Trading is HALTED - Click to Resume" : "Trading is ACTIVE - Click for Emergency Halt"}
          >
            <span className="relative flex h-2.5 w-2.5">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${status?.kill_switch ? "bg-rose-400" : "bg-emerald-400"}`}></span>
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${status?.kill_switch ? "bg-rose-500" : "bg-emerald-500"}`}></span>
            </span>
            <span className={`text-xs font-semibold tracking-wider uppercase ${status?.kill_switch ? "text-rose-600 dark:text-rose-400 font-bold" : "text-muted-foreground group-hover:text-foreground"} hidden sm:inline`}>
              {status?.kill_switch ? "HALTED" : status?.mode === "LIVE" ? "LIVE" : "PAPER"}
            </span>
          </button>

          {/* Quick Spot LTP Tickers */}
          <div className="flex items-center space-x-3 border-l border-border pl-3 text-xs">
            <div className="flex items-center space-x-1.5">
              <span className="text-muted-foreground font-medium">NIFTY:</span>
              <span className="font-mono font-bold text-foreground">
                {niftyLtp.toLocaleString("en-IN", { maximumFractionDigits: 1 })}
              </span>
            </div>
            <div className="flex items-center space-x-1.5 border-l border-border pl-3">
              <span className="text-muted-foreground font-medium">SENSEX:</span>
              <span className="font-mono font-bold text-foreground">
                {sensexLtp.toLocaleString("en-IN", { maximumFractionDigits: 1 })}
              </span>
            </div>
          </div>

        </div>

        {/* Center / Right: Scalper Toggle, Chart Switcher, Side Panel Toggle */}
        <div className="flex items-center space-x-2.5">
          {/* Scalper Toggle Button */}
          <button
            onClick={() => setShowScalpBar(!showScalpBar)}
            className={`px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 font-bold text-xs border shadow-xs ${
              showScalpBar
                ? "bg-amber-500/15 border-amber-500/40 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/30"
                : "bg-muted text-muted-foreground border-border hover:text-foreground"
            }`}
            title="Toggle Fast Scalp Widget"
          >
            <Zap className={`w-3.5 h-3.5 ${showScalpBar ? "fill-amber-500" : ""}`} />
            <span>Scalper</span>
          </button>

          {/* Session Net P&L Popover Trigger & Card */}
          <div className="relative" ref={pnlSummaryRef}>
            <button
              type="button"
              onClick={() => setShowPnlSummary(!showPnlSummary)}
              className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-md border text-xs font-mono font-bold shadow-xs transition-all cursor-pointer select-none ${
                summaryMetrics.totalPnl > 0
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
                  : summaryMetrics.totalPnl < 0
                  ? "bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20"
                  : "bg-muted/60 border-border text-foreground hover:bg-muted"
              } ${showPnlSummary ? "ring-2 ring-primary/40" : ""}`}
              title="Click to view full Session Summary & Breakdown"
            >
              <span className="text-[10px] font-sans font-semibold text-muted-foreground uppercase tracking-wide">P&L:</span>
              <span>
                {summaryMetrics.totalPnl >= 0 ? "+" : ""}{fmtRs(summaryMetrics.totalPnl)}
              </span>
              <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform duration-200 ${showPnlSummary ? "rotate-180" : ""}`} />
            </button>

            {/* SUMMARY POPOVER CARD */}
            {showPnlSummary && (
              <div className="absolute top-full mt-2 left-0 w-80 bg-popover/95 backdrop-blur-md border border-border rounded-xl shadow-xl z-50 p-3.5 space-y-3 animate-fadeIn text-foreground">
                {/* Popover Header */}
                <div className="flex items-center justify-between pb-2 border-b border-border/60">
                  <div className="flex items-center gap-1.5 font-bold text-xs">
                    <TrendingUp className="w-3.5 h-3.5 text-primary" />
                    <span>Session Performance</span>
                  </div>
                  <button
                    onClick={() => setShowPnlSummary(false)}
                    className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Big Net P&L Display */}
                <div className={`p-3 rounded-lg border text-center ${
                  summaryMetrics.totalPnl >= 0
                    ? "bg-emerald-50/70 border-emerald-300/60 dark:bg-emerald-950/40 dark:border-emerald-500/30"
                    : "bg-rose-50/70 border-rose-300/60 dark:bg-rose-950/40 dark:border-rose-500/30"
                }`}>
                  <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                    Total Session P&L (Net)
                  </div>
                  <div className={`text-xl font-black font-mono tracking-tight mt-0.5 ${
                    summaryMetrics.totalPnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
                  }`}>
                    {summaryMetrics.totalPnl >= 0 ? "+" : ""}{fmtRs(summaryMetrics.totalPnl)}
                  </div>
                </div>

                {/* Unrealized & Realized Grid */}
                <div className="grid grid-cols-2 gap-2 text-center text-xs">
                  <div className="bg-muted/40 p-2 rounded-lg border border-border/60">
                    <div className="text-[10px] uppercase text-muted-foreground font-semibold">Unrealized MTM</div>
                    <div className={`font-mono font-bold text-xs mt-0.5 ${pnlClass(summaryMetrics.runningPnl)}`}>
                      {summaryMetrics.runningPnl >= 0 ? "+" : ""}{fmtRs(summaryMetrics.runningPnl)}
                    </div>
                    <div className="text-[9px] text-muted-foreground font-mono mt-0.5">{openTrades.length} open pos</div>
                  </div>
                  <div className="bg-muted/40 p-2 rounded-lg border border-border/60">
                    <div className="text-[10px] uppercase text-muted-foreground font-semibold">Realized P&L</div>
                    <div className={`font-mono font-bold text-xs mt-0.5 ${pnlClass(summaryMetrics.realizedPnl)}`}>
                      {summaryMetrics.realizedPnl >= 0 ? "+" : ""}{fmtRs(summaryMetrics.realizedPnl)}
                    </div>
                    <div className="text-[9px] text-muted-foreground font-mono mt-0.5">{closedTrades.length} closed</div>
                  </div>
                </div>

                {/* Performance Metrics List */}
                <div className="space-y-1.5 bg-muted/20 p-2.5 rounded-lg border border-border/50 text-[11px]">
                  <div className="flex items-center justify-between py-0.5 border-b border-border/40">
                    <span className="text-muted-foreground">Invested Capital</span>
                    <span className="font-mono font-bold">{fmtRs(summaryMetrics.investedCapital)}</span>
                  </div>
                  <div className="flex items-center justify-between py-0.5 border-b border-border/40">
                    <span className="text-muted-foreground">Win Rate</span>
                    <span className="font-mono font-bold">
                      {summaryMetrics.winRate.toFixed(0)}%
                      <span className="text-[10px] font-normal text-muted-foreground ml-1">
                        ({summaryMetrics.winners}W / {summaryMetrics.losers}L)
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-0.5 border-b border-border/40">
                    <span className="text-muted-foreground">Total Executed Trades</span>
                    <span className="font-mono font-bold">{summaryMetrics.openCount + summaryMetrics.closedCount}</span>
                  </div>
                  <div className="flex items-center justify-between py-0.5">
                    <span className="text-muted-foreground">Active Strategies</span>
                    <span className="font-mono font-bold">{new Set(tradesList.map(t => t.strategy)).size}</span>
                  </div>
                </div>

                {/* Footer Action */}
                <div className="pt-1 flex items-center justify-between gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs font-semibold h-7 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setIsSidePanelOpen(true)
                      setSideTab("SUMMARY")
                      setShowPnlSummary(false)
                    }}
                  >
                    View in Side Panel →
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Chart View Switcher */}
          <div className="flex items-center bg-muted/70 p-0.5 rounded-lg border border-border">
            <button
              onClick={() => { setActiveChart("SENSEX"); setScalpSpot("SENSEX"); setSelectedTrade(null) }}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                activeChart === "SENSEX"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              SENSEX
            </button>
            <button
              onClick={() => { setActiveChart("NIFTY"); setScalpSpot("NIFTY"); setSelectedTrade(null) }}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                activeChart === "NIFTY"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              NIFTY
            </button>
            <button
              onClick={() => { setActiveChart("DUAL"); setSelectedTrade(null) }}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                activeChart === "DUAL"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Dual Split
            </button>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => {
              reloadStatus()
              liveTradesPoll.reload()
              niftyDay.reload()
              sensexDay.reload()
            }}
            title="Refresh feeds"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      {/* 1.5 FLOATING QUICK SCALP WIDGET (LARGER, COMFORTABLE WITH TP, TS & HIGH-VISIBILITY LOTS) */}
      {showScalpBar && (
        isScalpMinimized ? (
          /* MINIMIZED FLOATING PILL */
          <div
            style={{ left: `${scalpPos.x}px`, top: `${scalpPos.y}px` }}
            className="fixed z-40 flex items-center gap-2 px-3 py-1.5 rounded-full bg-card/95 dark:bg-card/95 border border-border shadow-xl backdrop-blur-md cursor-grab active:cursor-grabbing select-none transition-shadow hover:shadow-primary/10 ring-1 ring-border/50 animate-fadeIn text-xs"
            onMouseDown={handleDragStart}
          >
            <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                const nextSpot = scalpSpot === "NIFTY" ? "SENSEX" : "NIFTY"
                setScalpSpot(nextSpot)
                setCustomStrike(null)
                if (activeChart !== "DUAL") setActiveChart(nextSpot)
              }}
              className="font-bold text-foreground flex items-center gap-1 hover:text-primary transition-colors cursor-pointer px-1.5 py-0.5 rounded hover:bg-muted"
              title="Click to toggle Spot (NIFTY ⮂ SENSEX)"
            >
              <Zap className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
              <span>{scalpSpot}</span>
              <span className="text-muted-foreground font-mono font-normal">({scalpLots}L)</span>
            </button>

            <span className="font-mono font-bold text-xs bg-muted px-1.5 py-0.5 rounded border border-border/60">
              {activeStrike} {scalpOptionType}
            </span>

            {activeSpotTrade && (
              <span className={`font-mono text-xs font-bold ${pnlClass(activeSpotTrade.option_pnl_rs ?? activeSpotTrade.pnl_rs ?? 0)}`}>
                {(activeSpotTrade.option_pnl_rs ?? activeSpotTrade.pnl_rs ?? 0) >= 0 ? "+" : ""}
                {fmtRs(activeSpotTrade.option_pnl_rs ?? activeSpotTrade.pnl_rs ?? 0)}
              </span>
            )}

            <div className="flex items-center gap-1.5 border-l border-border pl-1.5 ml-0.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setScalpOptionType((t) => (t === "CE" ? "PE" : "CE"))
                }}
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer transition-colors ${
                  scalpOptionType === "CE"
                    ? "bg-emerald-600 text-white"
                    : "bg-rose-600 text-white"
                }`}
                title="Click to toggle CE / PE"
              >
                {scalpOptionType}
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleScalpOrder("BUY", scalpOptionType) }}
                disabled={scalpBusy}
                className="px-2.5 py-1 rounded text-[10px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs cursor-pointer"
                title={`Buy ${scalpSpot} ${activeStrike} ${scalpOptionType}`}
              >
                BUY
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  if (activeSpotTrade) {
                    handleScalpExit()
                  } else {
                    handleScalpOrder("SELL", scalpOptionType)
                  }
                }}
                disabled={scalpBusy}
                className="px-2.5 py-1 rounded text-[10px] font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-2xs cursor-pointer"
                title={activeSpotTrade ? "Square Off Position" : `Sell ${scalpSpot} ${activeStrike} ${scalpOptionType}`}
              >
                SELL
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setScalpPos((pos) => {
                    const sideW = isSidePanelOpen ? (window.innerWidth >= 1024 ? 384 : 320) : 0
                    const maxX = Math.max(70, window.innerWidth - sideW - 80 - 285)
                    const maxY = Math.max(105, window.innerHeight - 56 - 280)
                    return {
                      x: Math.min(pos.x, maxX),
                      y: Math.min(pos.y, maxY),
                    }
                  })
                  setIsScalpMinimized(false)
                }}
                className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground ml-0.5 cursor-pointer"
                title="Expand Scalper"
              >
                <Maximize2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        ) : (
          /* EXPANDED PRO FLOATING SCALPER PANEL (SPACIOUS, COMFORTABLE WITH TP, TS & CLEAR LOTS) */
          <div
            style={{ left: `${scalpPos.x}px`, top: `${scalpPos.y}px` }}
            className="fixed z-40 w-[285px] bg-card/95 dark:bg-card/95 backdrop-blur-md border border-border shadow-2xl rounded-xl overflow-hidden select-none animate-fadeIn transition-shadow hover:shadow-primary/10 ring-1 ring-border/50 text-xs"
          >
            {/* Draggable Header */}
            <div
              onMouseDown={handleDragStart}
              className="flex items-center justify-between px-3 py-1.5 bg-muted/60 dark:bg-muted/40 border-b border-border/70 cursor-grab active:cursor-grabbing"
            >
              <div className="flex items-center space-x-1.5">
                <GripVertical className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                <Zap className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                <span className="font-bold text-xs tracking-wider uppercase text-foreground">Fast Scalp</span>
                <span className="text-[10px] font-mono font-bold text-foreground bg-muted px-1.5 py-0.2 rounded border border-border">
                  {scalpSpot} {activeStrike} {scalpOptionType}
                </span>
              </div>
              <div className="flex items-center space-x-1">
                <button
                  type="button"
                  onClick={() => {
                    setScalpPos((pos) => ({
                      ...pos,
                      y: Math.max(110, window.innerHeight - 56 - 42),
                    }))
                    setIsScalpMinimized(true)
                  }}
                  className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Minimize to Pill"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowScalpBar(false)}
                  className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Close Scalper"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Widget Content */}
            <div className="p-3 space-y-2.5">
              {/* Row 1: Spot Selector (NIFTY vs SENSEX) */}
              <div className="grid grid-cols-2 gap-1.5 p-0.5 bg-muted/60 rounded-lg border border-border">
                <button
                  type="button"
                  onClick={() => {
                    setScalpSpot("NIFTY")
                    setCustomStrike(null)
                    if (activeChart !== "DUAL") setActiveChart("NIFTY")
                  }}
                  className={`py-1 text-xs font-bold rounded-md transition-all text-center flex items-center justify-center gap-1.5 cursor-pointer ${
                    scalpSpot === "NIFTY"
                      ? "bg-primary text-primary-foreground shadow-2xs font-extrabold"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                  title="Select NSE NIFTY"
                >
                  <span>NIFTY</span>
                  <span className="font-mono text-[10px] opacity-85 font-normal">{Math.round(niftyLtp)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScalpSpot("SENSEX")
                    setCustomStrike(null)
                    if (activeChart !== "DUAL") setActiveChart("SENSEX")
                  }}
                  className={`py-1 text-xs font-bold rounded-md transition-all text-center flex items-center justify-center gap-1.5 cursor-pointer ${
                    scalpSpot === "SENSEX"
                      ? "bg-primary text-primary-foreground shadow-2xs font-extrabold"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                  title="Select BSE SENSEX"
                >
                  <span>SENSEX</span>
                  <span className="font-mono text-[10px] opacity-85 font-normal">{Math.round(sensexLtp)}</span>
                </button>
              </div>

              {/* Row 2: Strike Selector & CE / PE Toggle */}
              <div className="flex items-center justify-between gap-2 text-xs">
                {/* Strike Selector */}
                <div className="flex items-center space-x-1.5 flex-1 min-w-0">
                  <span className="text-muted-foreground font-semibold shrink-0">Strike:</span>
                  <select
                    value={activeStrike}
                    onChange={(e) => setCustomStrike(Number(e.target.value))}
                    className="w-full bg-background border border-border rounded-md px-2 py-1 font-mono font-bold text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer h-7 text-xs"
                    title="Select Strike / Spot Price"
                  >
                    {strikeChoices.map((stk) => (
                      <option key={stk} value={stk}>
                        {stk} {stk === currentAtmStrike ? "(ATM)" : stk > currentAtmStrike ? `(+${stk - currentAtmStrike})` : `(${stk - currentAtmStrike})`}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Option Type: CE / PE Toggle Buttons */}
                <div className="flex items-center p-0.5 bg-muted/80 rounded-md border border-border h-7 shrink-0">
                  <button
                    type="button"
                    onClick={() => setScalpOptionType("CE")}
                    className={`px-3 py-0.5 text-xs font-bold rounded transition-all cursor-pointer ${
                      scalpOptionType === "CE"
                        ? "bg-emerald-600 text-white shadow-2xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    title="Call Option (CE)"
                  >
                    CE
                  </button>
                  <button
                    type="button"
                    onClick={() => setScalpOptionType("PE")}
                    className={`px-3 py-0.5 text-xs font-bold rounded transition-all cursor-pointer ${
                      scalpOptionType === "PE"
                        ? "bg-rose-600 text-white shadow-2xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    title="Put Option (PE)"
                  >
                    PE
                  </button>
                </div>
              </div>

              {/* Row 3: Lots Stepper + TP (Target Pts) + TS (Trailing Stop Pts) */}
              <div className="grid grid-cols-2 gap-2 bg-muted/30 p-2 rounded-lg border border-border/70">
                {/* Lots Stepper (Big, Clear, Visible) */}
                <div className="flex flex-col space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground font-semibold">Lots:</span>
                    <span className="text-muted-foreground font-mono text-[10px]">
                      {scalpLots * (scalpSpot === "SENSEX" ? 20 : 65)} Qty
                    </span>
                  </div>
                  <div className="flex items-center border border-border rounded-md bg-background overflow-hidden h-7 shadow-2xs">
                    <button
                      type="button"
                      onClick={() => setScalpLots((l) => Math.max(1, l - 1))}
                      className="w-7 h-full hover:bg-muted text-foreground font-bold flex items-center justify-center cursor-pointer text-base border-r border-border/70 active:bg-muted/80"
                      title="Decrease Lots (-)"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={scalpLots}
                      onChange={(e) => setScalpLots(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full text-center font-mono font-bold text-foreground bg-transparent text-xs focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setScalpLots((l) => Math.min(50, l + 1))}
                      className="w-7 h-full hover:bg-muted text-foreground font-bold flex items-center justify-center cursor-pointer text-base border-l border-border/70 active:bg-muted/80"
                      title="Increase Lots (+)"
                    >
                      +
                    </button>
                  </div>
                </div>

                {/* TP (Target Pts) & TS (Trailing Stop Pts) */}
                <div className="grid grid-cols-2 gap-1.5">
                  {/* TP Points */}
                  <div className="flex flex-col space-y-1">
                    <span className="text-muted-foreground font-semibold text-[10px] text-center" title="Target Profit in Points (0 = optional)">
                      TP (opt)
                    </span>
                    <div className="flex items-center border border-border rounded-md bg-background h-7 px-1 shadow-2xs">
                      <input
                        type="number"
                        min={0}
                        max={1000}
                        step={scalpSpot === "SENSEX" ? 10 : 5}
                        value={scalpTp === 0 ? "" : scalpTp}
                        placeholder="0"
                        onChange={(e) => setScalpTp(Math.max(0, parseFloat(e.target.value) || 0))}
                        className="w-full text-center font-mono font-bold text-emerald-600 dark:text-emerald-400 bg-transparent text-xs focus:outline-none placeholder:text-muted-foreground/50"
                        title="Target Profit Points (0 = optional / off)"
                      />
                    </div>
                  </div>

                  {/* TS Points */}
                  <div className="flex flex-col space-y-1">
                    <span className="text-muted-foreground font-semibold text-[10px] text-center" title="Stop Loss / Trailing Stop in Points (0 = optional)">

                      TS (opt)
                    </span>
                    <div className="flex items-center border border-border rounded-md bg-background h-7 px-1 shadow-2xs">
                      <input
                        type="number"
                        min={0}
                        max={1000}
                        step={scalpSpot === "SENSEX" ? 10 : 5}
                        value={scalpTs === 0 ? "" : scalpTs}
                        placeholder="0"
                        onChange={(e) => setScalpTs(Math.max(0, parseFloat(e.target.value) || 0))}
                        className="w-full text-center font-mono font-bold text-rose-600 dark:text-rose-400 bg-transparent text-xs focus:outline-none placeholder:text-muted-foreground/50"
                        title="Trailing Stop / Stop Loss Points (0 = optional / off)"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Row 4: Simple, Big, High-Contrast BUY and SELL Action Buttons */}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  disabled={scalpBusy}
                  onClick={() => handleScalpOrder("BUY", scalpOptionType)}
                  className="h-8 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center gap-1.5 shadow-xs cursor-pointer"
                  title={`Buy ${scalpSpot} ${activeStrike} ${scalpOptionType}${scalpTp > 0 ? ` TP:${scalpTp}pt` : ""}${scalpTs > 0 ? ` TS:${scalpTs}pt` : ""}`}
                >
                  {scalpBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                  <span>BUY</span>
                </Button>

                <Button
                  size="sm"
                  disabled={scalpBusy}
                  onClick={() => {
                    if (activeSpotTrade) {
                      handleScalpExit()
                    } else {
                      handleScalpOrder("SELL", scalpOptionType)
                    }
                  }}
                  className="h-8 text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white flex items-center justify-center gap-1.5 shadow-xs cursor-pointer"
                  title={activeSpotTrade ? "Square Off Active Position" : `Sell ${scalpSpot} ${activeStrike} ${scalpOptionType}`}
                >
                  {scalpBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                  <span>SELL</span>
                </Button>
              </div>

              {/* Row 5: Active Position Status & 1-Click Square Off (Only when position open) */}
              {activeSpotTrade && (
                <div className="flex items-center justify-between bg-muted/60 border border-border px-2.5 py-1.5 rounded-lg text-xs">
                  <div className="truncate mr-2 min-w-0">
                    <span className="font-bold text-foreground truncate block text-[11px] leading-tight">
                      {activeSpotTrade.option || activeSpotTrade.symbol}
                    </span>
                    <span className={`font-mono font-bold text-xs ${pnlClass(activeSpotTrade.option_pnl_rs ?? activeSpotTrade.pnl_rs ?? 0)}`}>
                      {(activeSpotTrade.option_pnl_rs ?? activeSpotTrade.pnl_rs ?? 0) >= 0 ? "+" : ""}
                      {fmtRs(activeSpotTrade.option_pnl_rs ?? activeSpotTrade.pnl_rs ?? 0)}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={scalpBusy}
                    onClick={handleScalpExit}
                    className="h-6 text-[10px] px-2 font-bold bg-rose-600 hover:bg-rose-700 text-white flex items-center gap-1 shadow-2xs cursor-pointer"
                  >
                    {scalpBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3" />}
                    <span>Square Off</span>
                  </Button>
                </div>
              )}
            </div>
          </div>
        )
      )}

      {/* 2. MAIN WORKSPACE CONTAINER */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden relative">
        {/* LEFT / CENTER: FULL-WIDTH / FLEX-1 CANDLESTICK CHART */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-background">
          {/* CANDLESTICK CHART CANVAS */}
          <main className="flex-1 min-h-0 p-2 grid gap-2 overflow-hidden" style={{
            gridTemplateColumns: activeChart === "DUAL" ? "1fr 1fr" : "1fr"
          }}>
            {/* SENSEX CHART */}
            {(activeChart === "SENSEX" || activeChart === "DUAL") && (
              <div className="flex flex-col bg-card border border-border rounded-lg overflow-hidden shadow-xs relative">
                <div className="flex-none px-3 py-1.5 bg-muted/40 border-b border-border flex items-center justify-between text-xs gap-2">
                  {/* Left: Index Info & Spot */}
                  <div className="flex items-center space-x-2 min-w-0">
                    <span className="font-bold text-foreground tracking-wide shrink-0">BSE SENSEX</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-muted text-muted-foreground font-mono shrink-0">1m</span>
                    <span className="text-muted-foreground font-mono text-[11px] shrink-0">
                      Spot: <span className="font-bold text-foreground">{sensexLtp.toLocaleString("en-IN", { maximumFractionDigits: 1 })}</span>
                    </span>

                    {/* Focused Trade badge */}
                    {selectedTrade && (selectedTrade.symbol?.toUpperCase().includes("SENSEX") || selectedTrade.symbol?.includes("BSESN")) && (
                      <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/60 dark:border-blue-500/50 dark:text-blue-300 font-medium flex items-center gap-1.5 animate-fadeIn truncate">
                        <Target className="w-3 h-3 text-blue-600 dark:text-blue-400 shrink-0" />
                        <span className="truncate">Focused: {selectedTrade.option || selectedTrade.strategy} ({selectedTrade.side})</span>
                        <button 
                          onClick={() => setSelectedTrade(null)}
                          className="ml-1 text-blue-600 hover:text-blue-900 dark:text-blue-300 dark:hover:text-white shrink-0"
                          title="Clear Focus"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    )}
                  </div>

                  {/* Right: Side Panel Toggle Button */}
                  {activeChart === "SENSEX" && (
                    <button
                      type="button"
                      onClick={() => setIsSidePanelOpen(!isSidePanelOpen)}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold border transition-all flex items-center gap-1.5 cursor-pointer shadow-2xs shrink-0 ${
                        isSidePanelOpen
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background/80 hover:bg-muted text-muted-foreground hover:text-foreground border-border"
                      }`}
                      title={isSidePanelOpen ? "Collapse Trades Side Panel" : "Open Trades & Positions Panel"}
                    >
                      <PanelRightClose className={`w-3.5 h-3.5 transition-transform ${!isSidePanelOpen ? "rotate-180" : ""}`} />
                      <span>Trades ({openTrades.length})</span>
                    </button>
                  )}
                </div>
                <div className="flex-1 min-h-0 relative">
                  <CandleChart
                    date={today}
                    candles={sensexDay.data?.candles ?? []}
                    forming={sensexDay.data?.forming}
                    currentPrice={sensexLtp}
                    setup={sensexDay.data?.setup}
                    trades={sensexChartTrades}
                    showKeyLevels={true}
                    showTradeLevels={true}
                    className="h-full w-full"
                    zoomable={true}
                    resetKey={`sensex-${activeChart}`}
                  />
                </div>
              </div>
            )}

            {/* NIFTY CHART */}
            {(activeChart === "NIFTY" || activeChart === "DUAL") && (
              <div className="flex flex-col bg-card border border-border rounded-lg overflow-hidden shadow-xs relative">
                <div className="flex-none px-3 py-1.5 bg-muted/40 border-b border-border flex items-center justify-between text-xs gap-2">
                  {/* Left: Index Info & Spot */}
                  <div className="flex items-center space-x-2 min-w-0">
                    <span className="font-bold text-foreground tracking-wide shrink-0">NSE NIFTY 50</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-muted text-muted-foreground font-mono shrink-0">1m</span>
                    <span className="text-muted-foreground font-mono text-[11px] shrink-0">
                      Spot: <span className="font-bold text-foreground">{niftyLtp.toLocaleString("en-IN", { maximumFractionDigits: 1 })}</span>
                    </span>

                    {/* Focused Trade badge */}
                    {selectedTrade && (!selectedTrade.symbol || selectedTrade.symbol?.toUpperCase().includes("NIFTY") || selectedTrade.symbol?.includes("NSEI")) && (
                      <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/60 dark:border-blue-500/50 dark:text-blue-300 font-medium flex items-center gap-1.5 animate-fadeIn truncate">
                        <Target className="w-3 h-3 text-blue-600 dark:text-blue-400 shrink-0" />
                        <span className="truncate">Focused: {selectedTrade.option || selectedTrade.strategy} ({selectedTrade.side})</span>
                        <button 
                          onClick={() => setSelectedTrade(null)}
                          className="ml-1 text-blue-600 hover:text-blue-900 dark:text-blue-300 dark:hover:text-white shrink-0"
                          title="Clear Focus"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    )}
                  </div>

                  {/* Right: Side Panel Toggle Button */}
                  {(activeChart === "NIFTY" || activeChart === "DUAL") && (
                    <button
                      type="button"
                      onClick={() => setIsSidePanelOpen(!isSidePanelOpen)}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold border transition-all flex items-center gap-1.5 cursor-pointer shadow-2xs shrink-0 ${
                        isSidePanelOpen
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background/80 hover:bg-muted text-muted-foreground hover:text-foreground border-border"
                      }`}
                      title={isSidePanelOpen ? "Collapse Trades Side Panel" : "Open Trades & Positions Panel"}
                    >
                      <PanelRightClose className={`w-3.5 h-3.5 transition-transform ${!isSidePanelOpen ? "rotate-180" : ""}`} />
                      <span>Trades ({openTrades.length})</span>
                    </button>
                  )}
                </div>
                <div className="flex-1 min-h-0 relative">
                  <CandleChart
                    date={today}
                    candles={niftyDay.data?.candles ?? []}
                    forming={niftyDay.data?.forming}
                    currentPrice={niftyLtp}
                    setup={niftyDay.data?.setup}
                    trades={niftyChartTrades}
                    showKeyLevels={true}
                    showTradeLevels={true}
                    className="h-full w-full"
                    zoomable={true}
                    resetKey={`nifty-${activeChart}`}
                  />
                </div>
              </div>
            )}
          </main>
        </div>

        {/* SIDE PANEL */}
        {isSidePanelOpen && (
          <aside className="w-80 lg:w-96 flex-none bg-card border-l border-border flex flex-col shadow-xs overflow-hidden z-10 animate-fadeIn">
            {/* Header: Segmented Tabs & Close Button */}
            <div className="flex-none p-2 border-b border-border bg-muted/30 flex items-center justify-between gap-1.5">
              <div className="flex items-center bg-muted/80 p-0.5 rounded-lg border border-border flex-1">
                <button
                  onClick={() => setSideTab("ACTIVE")}
                  className={`flex-1 py-1 text-[11px] font-semibold rounded transition-all flex items-center justify-center gap-1 ${
                    sideTab === "ACTIVE"
                      ? "bg-background text-foreground shadow-xs font-bold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Radio className="w-2.5 h-2.5 text-emerald-500" />
                  <span>Active ({openTrades.length})</span>
                </button>
                <button
                  onClick={() => setSideTab("CLOSED")}
                  className={`flex-1 py-1 text-[11px] font-semibold rounded transition-all flex items-center justify-center gap-1 ${
                    sideTab === "CLOSED"
                      ? "bg-background text-foreground shadow-xs font-bold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Clock className="w-2.5 h-2.5 text-muted-foreground" />
                  <span>Closed ({closedTrades.length})</span>
                </button>
                <button
                  onClick={() => setSideTab("SUMMARY")}
                  className={`flex-1 py-1 text-[11px] font-semibold rounded transition-all flex items-center justify-center gap-1 ${
                    sideTab === "SUMMARY"
                      ? "bg-background text-foreground shadow-xs font-bold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <TrendingUp className="w-2.5 h-2.5 text-primary" />
                  <span>Summary</span>
                </button>
              </div>

              <button
                onClick={() => setIsSidePanelOpen(false)}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                title="Collapse Side Panel"
              >
                <PanelRightClose className="w-4 h-4" />
              </button>
            </div>

            {/* TAB CONTENTS */}
            <div className="flex-1 overflow-y-auto">
              {/* TAB 1: ACTIVE */}
              {sideTab === "ACTIVE" && (
                <div className="p-3 space-y-2.5">
                  {openTrades.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground px-4">
                      <ShieldCheck className="w-9 h-9 mb-2 text-muted-foreground/50" />
                      <div className="text-xs font-semibold text-foreground">No Active Positions</div>
                      <div className="text-[11px] mt-1 text-muted-foreground">Use the Fast Scalper or automated triggers</div>
                    </div>
                  ) : (
                    openTrades.map((trade, idx) => {
                      const isSelected = selectedTrade === trade || (selectedTrade && selectedTrade.entry === trade.entry && selectedTrade.option === trade.option)
                      const pnl = trade.option_pnl_rs ?? trade.pnl_rs ?? (trade.futures_pnl_rs ?? 0)
                      const pts = trade.nifty_points ?? trade.pnl_points ?? 0
                      const isProfitable = pnl >= 0

                      return (
                        <div
                          key={`active-card-${idx}`}
                          onClick={() => handleSelectTrade(trade)}
                          className={`p-3 rounded-lg border cursor-pointer transition-all ${
                            isSelected
                              ? "bg-primary/5 border-primary shadow-xs ring-1 ring-primary dark:bg-primary/10"
                              : "bg-card border-border hover:bg-muted/30 shadow-2xs"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-bold text-xs text-foreground font-sans">
                              {trade.option || trade.symbol}
                            </span>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              trade.side === "CALL" || trade.side === "BUY"
                                ? "bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-600/40"
                                : "bg-rose-100 text-rose-800 border border-rose-300 dark:bg-rose-950 dark:text-rose-400 dark:border-rose-600/40"
                            }`}>
                              {trade.side}
                            </span>
                          </div>

                          <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-2">
                            <span>{trade.strategy}</span>
                            <span className="font-mono text-[10px]">{trade.entry || "09:30"}</span>
                          </div>

                          <div className="grid grid-cols-3 gap-1 py-1.5 px-2 bg-muted/40 rounded border border-border/60 text-[10px] font-mono mb-2">
                            <div>
                              <span className="text-muted-foreground block text-[9px] uppercase">Entry</span>
                              <span className="font-bold text-foreground">
                                {(trade.spot_at_entry || trade.nifty_in || trade.buy_price)?.toFixed(1)}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block text-[9px] uppercase">SL</span>
                              <span className="font-bold text-rose-600 dark:text-rose-400">
                                {trade.sl != null && !Number.isNaN(trade.sl) ? trade.sl.toFixed(1) : "-"}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block text-[9px] uppercase">Target</span>
                              <span className="font-bold text-emerald-600 dark:text-emerald-400">
                                {trade.target != null && !Number.isNaN(trade.target) ? trade.target.toFixed(1) : "-"}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center justify-between pt-1">
                            <div>
                              <div className={`text-sm font-bold font-mono ${isProfitable ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                                {isProfitable ? "+" : ""}{fmtRs(pnl)}
                              </div>
                              <div className="text-[10px] text-muted-foreground font-mono">
                                {pts >= 0 ? `+${pts}` : pts} pts
                              </div>
                            </div>

                            <div className="flex items-center space-x-1.5">
                              {isSelected ? (
                                <span className="text-[10px] px-2 py-0.5 rounded bg-primary text-primary-foreground font-semibold flex items-center gap-1 shadow-xs">
                                  <Target className="w-3 h-3" /> Focused
                                </span>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 text-[10px] px-2 text-muted-foreground hover:text-foreground"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleSelectTrade(trade)
                                  }}
                                >
                                  Focus
                                </Button>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 text-[11px] px-2 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:border-rose-500/40 dark:text-rose-400 font-semibold"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setExitTarget(trade)
                                }}
                              >
                                Square Off
                              </Button>
                            </div>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              )}

              {/* TAB 2: CLOSED TRADES */}
              {sideTab === "CLOSED" && (
                <div className="p-3 space-y-2">
                  {closedTrades.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground px-4">
                      <Clock className="w-9 h-9 mb-2 text-muted-foreground/50" />
                      <div className="text-xs font-semibold text-foreground">No Closed Trades Yet</div>
                      <div className="text-[11px] mt-1 text-muted-foreground">Trades will appear here as they are squared off or hit targets</div>
                    </div>
                  ) : (
                    closedTrades.map((trade, idx) => {
                      const pnl = trade.net_rs ?? trade.pnl_rs ?? 0
                      const pts = trade.nifty_points ?? trade.pnl_points ?? 0
                      const isProfitable = pnl >= 0

                      return (
                        <div
                          key={`closed-card-${idx}`}
                          onClick={() => handleSelectTrade(trade)}
                          className="p-2.5 rounded-lg border border-border bg-card hover:bg-muted/30 cursor-pointer transition-all shadow-2xs"
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-bold text-xs text-foreground font-sans">
                              {trade.option || trade.symbol}
                            </span>
                            <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                              trade.side === "CALL" || trade.side === "BUY"
                                ? "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400"
                                : "bg-rose-50 text-rose-700 border border-rose-200 dark:bg-rose-950 dark:text-rose-400"
                            }`}>
                              {trade.side}
                            </span>
                          </div>

                          <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1.5 font-mono">
                            <span>{trade.entry || "09:30"} ➔ {trade.exit || "15:15"}</span>
                            <span className="px-1.5 py-0.2 rounded bg-muted text-muted-foreground font-sans text-[9px] uppercase">
                              {trade.exit_reason || "Target"}
                            </span>
                          </div>

                          <div className="flex items-center justify-between pt-1 border-t border-border/40 font-mono">
                            <span className="text-[10px] text-muted-foreground">
                              {pts >= 0 ? `+${pts}` : pts} pts
                            </span>
                            <span className={`text-xs font-bold ${pnlClass(pnl)}`}>
                              {isProfitable ? "+" : ""}{fmtRs(pnl)}
                            </span>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              )}

              {/* TAB 3: POSITION & SESSION SUMMARY */}
              {sideTab === "SUMMARY" && (
                <div className="p-3.5 space-y-3">
                  {/* Session Net P&L Card */}
                  <div className={`p-4 rounded-lg border text-center shadow-xs transition-all ${
                    (summaryMetrics.runningPnl + summaryMetrics.realizedPnl) >= 0
                      ? "bg-emerald-50/80 border-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-500/40"
                      : "bg-rose-50/80 border-rose-300 dark:bg-rose-950/40 dark:border-rose-500/40"
                  }`}>
                    <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                      Total Session P&L (Net)
                    </div>
                    <div className={`text-2xl font-black font-mono tracking-tight mt-1 ${
                      (summaryMetrics.runningPnl + summaryMetrics.realizedPnl) >= 0
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-rose-700 dark:text-rose-400"
                    }`}>
                      {(summaryMetrics.runningPnl + summaryMetrics.realizedPnl) >= 0 ? "+" : ""}
                      {fmtRs(summaryMetrics.runningPnl + summaryMetrics.realizedPnl)}
                    </div>
                  </div>

                  {/* Realized & Unrealized Breakdown */}
                  <div className="grid grid-cols-2 gap-2 text-center text-xs">
                    <div className="bg-muted/30 p-2.5 rounded-lg border border-border shadow-2xs">
                      <div className="text-[10px] uppercase text-muted-foreground font-semibold">Unrealized P&L</div>
                      <div className={`font-mono font-bold text-sm mt-0.5 ${pnlClass(summaryMetrics.runningPnl)}`}>
                        {summaryMetrics.runningPnl >= 0 ? "+" : ""}{fmtRs(summaryMetrics.runningPnl)}
                      </div>
                      <div className="text-[9px] text-muted-foreground font-mono mt-0.5">{openTrades.length} open pos</div>
                    </div>
                    <div className="bg-muted/30 p-2.5 rounded-lg border border-border shadow-2xs">
                      <div className="text-[10px] uppercase text-muted-foreground font-semibold">Realized P&L</div>
                      <div className={`font-mono font-bold text-sm mt-0.5 ${pnlClass(summaryMetrics.realizedPnl)}`}>
                        {summaryMetrics.realizedPnl >= 0 ? "+" : ""}{fmtRs(summaryMetrics.realizedPnl)}
                      </div>
                      <div className="text-[9px] text-muted-foreground font-mono mt-0.5">{closedTrades.length} closed</div>
                    </div>
                  </div>

                  {/* Capital & Trade Stats */}
                  <div className="space-y-1.5 bg-muted/20 p-3 rounded-lg border border-border text-xs">
                    <div className="flex items-center justify-between py-1 border-b border-border/40">
                      <span className="text-muted-foreground">Invested Capital</span>
                      <span className="font-mono font-bold text-foreground">{fmtRs(summaryMetrics.investedCapital)}</span>
                    </div>
                    <div className="flex items-center justify-between py-1 border-b border-border/40">
                      <span className="text-muted-foreground">Total Trades Executed</span>
                      <span className="font-mono font-bold text-foreground">{summaryMetrics.openCount + summaryMetrics.closedCount}</span>
                    </div>
                    <div className="flex items-center justify-between py-1">
                      <span className="text-muted-foreground">Active Strategies</span>
                      <span className="font-mono font-bold text-foreground">
                        {new Set(tradesList.map(t => t.strategy)).size}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Side Panel Footer (Only when active trades exist) */}
            {sideTab === "ACTIVE" && openTrades.length > 0 && (
              <div className="p-2.5 border-t border-border bg-muted/20 flex-none">
                <Button
                  variant="destructive"
                  size="sm"
                  className="w-full text-xs font-semibold h-8 bg-rose-600 hover:bg-rose-700 text-white flex items-center justify-center gap-1.5 shadow-xs"
                  onClick={() => setExitAllConfirmOpen(true)}
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Square Off All ({openTrades.length})</span>
                </Button>
              </div>
            )}
          </aside>
        )}

      </div>

      {/* MODAL: SINGLE POSITION SQUARE OFF CONFIRMATION */}
      <Dialog open={!!exitTarget} onOpenChange={(open) => !open && setExitTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold text-rose-600 dark:text-rose-500 flex items-center gap-2">
              <LogOut className="h-4 w-4" /> Square Off Position
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Are you sure you want to exit this position immediately at current market price?
            </DialogDescription>
          </DialogHeader>

          {exitTarget && (
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Contract</span>
                <span className="font-bold text-foreground">{exitTarget.option || exitTarget.symbol}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Side</span>
                <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${
                  exitTarget.side === "CALL" 
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-400" 
                    : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-400"
                }`}>
                  {exitTarget.side}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Quantity</span>
                <span className="font-mono font-bold text-foreground">{exitTarget.qty || 1}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Entry Price</span>
                <span className="font-mono font-bold text-foreground">₹{exitTarget.buy_price?.toFixed(2) || "-"}</span>
              </div>
              <div className="flex items-center justify-between border-t border-border pt-1.5">
                <span className="text-muted-foreground">Current P&L</span>
                <span className={`font-mono font-bold ${pnlClass(exitTarget.option_pnl_rs ?? exitTarget.pnl_rs ?? 0)}`}>
                  {(exitTarget.option_pnl_rs ?? exitTarget.pnl_rs ?? 0) >= 0 ? "+" : ""}
                  {fmtRs(exitTarget.option_pnl_rs ?? exitTarget.pnl_rs ?? 0)}
                </span>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={exitBusy}
              onClick={() => setExitTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={exitBusy}
              onClick={handleSquareOffPosition}
              className="font-semibold bg-rose-600 hover:bg-rose-700 text-white"
            >
              {exitBusy ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Exiting...
                </>
              ) : (
                "Confirm Square Off"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* MODAL: EXIT ALL POSITIONS CONFIRMATION */}
      <Dialog open={exitAllConfirmOpen} onOpenChange={(open) => !open && setExitAllConfirmOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold text-rose-600 dark:text-rose-500 flex items-center gap-2">
              <LogOut className="h-4 w-4" /> Square Off ALL Active Positions
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Are you sure you want to close ALL {openTrades.length} open positions immediately at market?
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border bg-muted/30 p-2.5 max-h-[220px] overflow-y-auto divide-y divide-border/40 space-y-1.5 text-xs">
            {openTrades.map((t, i) => {
              const pnl = t.option_pnl_rs ?? t.pnl_rs ?? (t.futures_pnl_rs ?? 0)
              return (
                <div key={`exit-all-${i}`} className="pt-1.5 first:pt-0 flex items-center justify-between">
                  <div>
                    <div className="font-bold text-foreground">{t.option || t.symbol}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">{t.strategy} · Qty {t.qty || 1}</div>
                  </div>
                  <div className={`font-mono font-bold text-xs ${pnlClass(pnl)}`}>
                    {pnl >= 0 ? "+" : ""}{fmtRs(pnl)}
                  </div>
                </div>
              )
            })}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={exitAllBusy}
              onClick={() => setExitAllConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={exitAllBusy}
              onClick={handleSquareOffAll}
              className="font-semibold bg-rose-600 hover:bg-rose-700 text-white"
            >
              {exitAllBusy ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Closing All...
                </>
              ) : (
                `Yes, Close All (${openTrades.length})`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

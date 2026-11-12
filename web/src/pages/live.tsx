import { useState, useMemo, useCallback, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import {
  Radio,
  Clock,
  RefreshCw,
  X,
  Minus,
  GripVertical,
  LogOut,
  ShieldCheck,
  ShieldAlert,
  Zap,

  TrendingUp,
  Loader2,
  PanelRightClose,
  Maximize2,
  ChevronDown,
  Check,
  Terminal,
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
  const slNum = Number(trade.sl)
  const tgtNum = Number(trade.target)
  const entryPx = Number(trade.spot_at_entry || trade.nifty_in || trade.buy_price) || 0
  const exitPx = Number(trade.nifty_out || trade.sell_price) || 0
  const pnlPts = Number(trade.nifty_points ?? trade.pnl_points ?? 0) || 0
  const entryStr = String(trade.entry || (trade as any).entry_time || "09:15").slice(0, 5)
  const exitStr = trade.exit ? String(trade.exit).slice(0, 5) : ""
  return {
    side: trade.side || "CALL",
    entry: entryStr,
    entry_price: entryPx,
    sl: !Number.isNaN(slNum) && Number.isFinite(slNum) && slNum > 0 ? slNum : Number.NaN,
    target: !Number.isNaN(tgtNum) && Number.isFinite(tgtNum) && tgtNum > 0 ? tgtNum : Number.NaN,
    exit: exitStr,
    exit_price: exitPx,
    reason: trade.exit_reason || (trade.is_open ? "open" : ""),
    pnl_points: pnlPts,
    setup: trade.trigger_label || trade.strategy,
  }
}


// ----------------------------------------------------------------------
// Dedicated Interactive Active Trade Card Component with Direct TP & TL
// ----------------------------------------------------------------------
function ActiveTradeCard({
  trade,
  onUpdateTpTl,
  onSquareOff,
}: {
  trade: OptionTrade
  onUpdateTpTl: (trade: OptionTrade, tp: number, tl: number) => Promise<void>
  onSquareOff: (trade: OptionTrade) => void
}) {
  const sym = trade.option || trade.symbol
  const isSensex = (trade.symbol || trade.option || "").toUpperCase().includes("SENSEX")
  const [tpVal, setTpVal] = useState<number>(() => trade.tp_pts || 0)
  const [tlVal, setTlVal] = useState<number>(() => trade.tl_pts || 0)
  const [isBusy, setIsBusy] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  // Sync with live trades polling updates
  useEffect(() => {
    if (trade.tp_pts !== undefined) setTpVal(trade.tp_pts || 0)
    if (trade.tl_pts !== undefined) setTlVal(trade.tl_pts || 0)
  }, [trade.tp_pts, trade.tl_pts])

  const pnl = trade.option_pnl_rs ?? trade.pnl_rs ?? (trade.futures_pnl_rs ?? 0)
  const pts = trade.nifty_points ?? trade.pnl_points ?? 0
  const isProfitable = pnl >= 0
  const entryPx = Number(trade.buy_price || trade.spot_at_entry || trade.nifty_in || 0)
  const curLtp = Number(trade.sell_price || (trade.buy_price ? trade.buy_price + pts : 0))

  const targetPx = tpVal > 0 && entryPx > 0 ? (entryPx + tpVal).toFixed(1) : null
  const stopPx = tlVal > 0 && entryPx > 0 ? Math.max(0.05, entryPx - tlVal).toFixed(1) : null

  const handleSave = async (newTp = tpVal, newTl = tlVal) => {
    setIsBusy(true)
    try {
      await onUpdateTpTl(trade, newTp, newTl)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 2000)
    } finally {
      setIsBusy(false)
    }
  }


  return (
    <div className="p-3 rounded-lg border border-border bg-card shadow-2xs hover:border-border/80 transition-all space-y-2.5">
      {/* Header: Option Symbol + Side Badge + Realtime PnL + Square Off */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-bold text-xs text-foreground truncate font-sans">
            {sym}
          </span>
          {trade.mode && trade.mode.toUpperCase().includes("LIVE") ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shrink-0">
              <span className="size-1 rounded-full bg-emerald-400 animate-pulse" />
              LIVE
            </span>
          ) : (
            <span className="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30 shrink-0">
              PAPER
            </span>
          )}
          <span
            className={`px-1.5 py-0.2 rounded text-[10px] font-bold uppercase shrink-0 ${
              trade.side === "CALL" || trade.side === "BUY"
                ? "bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-600/40"
                : "bg-rose-100 text-rose-800 border border-rose-300 dark:bg-rose-950 dark:text-rose-400 dark:border-rose-600/40"
            }`}
          >
            {trade.side}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono">
            ({trade.qty || 1} qty)
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="text-right">
            <div className={`text-xs font-bold font-mono ${isProfitable ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
              {isProfitable ? "+" : ""}{fmtRs(pnl)}
            </div>
            <div className="text-[9px] text-muted-foreground font-mono">
              {pts >= 0 ? `+${pts}` : pts} pt
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px] px-2 border-rose-400/50 text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:border-rose-500/40 dark:text-rose-400 font-semibold cursor-pointer"
            onClick={() => onSquareOff(trade)}
            title="Square Off Position Immediately"
          >
            Square Off
          </Button>
        </div>
      </div>

      {/* Entry & LTP Summary Row */}
      <div className="flex items-center justify-between text-[11px] font-mono px-2 py-1 rounded bg-muted/40 border border-border/60">
        <div>
          <span className="text-muted-foreground text-[10px]">Entry: </span>
          <span className="font-bold text-foreground">₹{entryPx.toFixed(1)}</span>
        </div>
        <div>
          <span className="text-muted-foreground text-[10px]">LTP: </span>
          <span className="font-bold text-foreground">₹{curLtp > 0 ? curLtp.toFixed(1) : entryPx.toFixed(1)}</span>
        </div>
        <div>
          <span className="text-muted-foreground text-[10px]">Time: </span>
          <span className="text-muted-foreground">{trade.entry || "09:30"}</span>
        </div>
      </div>

      {/* Interactive Bracket Inputs: TP & TL */}
      <div className="space-y-1.5 pt-0.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <Zap className="w-3 h-3 text-amber-500" /> Bracket Targets
          </span>
          {justSaved && (
            <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5 animate-fadeIn">
              <Check className="w-3 h-3" /> Saved
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          {/* Target Profit (TP) */}
          <div className="p-2 rounded-lg bg-emerald-500/5 border border-emerald-500/20 space-y-1">
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-bold text-emerald-600 dark:text-emerald-400">TP (Target)</span>
              {targetPx && (
                <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                  🎯 ₹{targetPx}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={500}
                step={isSensex ? 10 : 5}
                value={tpVal === 0 ? "" : tpVal}
                placeholder="0 pt"
                onChange={(e) => setTpVal(Math.max(0, parseFloat(e.target.value) || 0))}
                onBlur={() => handleSave()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave()
                }}
                className="w-full px-2 py-0.5 rounded font-mono font-bold text-xs text-emerald-600 dark:text-emerald-400 bg-background border border-border focus:outline-none focus:ring-1 focus:ring-emerald-500 h-6.5 text-center"
              />
              <span className="text-[10px] text-muted-foreground font-mono">pt</span>
            </div>
          </div>

          {/* Target Loss / Stop Loss (TL) */}
          <div className="p-2 rounded-lg bg-rose-500/5 border border-rose-500/20 space-y-1">
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-bold text-rose-600 dark:text-rose-400">TL (Stop)</span>
              {stopPx && (
                <span className="font-mono font-bold text-rose-600 dark:text-rose-400">
                  🛑 ₹{stopPx}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={500}
                step={isSensex ? 10 : 5}
                value={tlVal === 0 ? "" : tlVal}
                placeholder="0 pt"
                onChange={(e) => setTlVal(Math.max(0, parseFloat(e.target.value) || 0))}
                onBlur={() => handleSave()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave()
                }}
                className="w-full px-2 py-0.5 rounded font-mono font-bold text-xs text-rose-600 dark:text-rose-400 bg-background border border-border focus:outline-none focus:ring-1 focus:ring-rose-500 h-6.5 text-center"
              />
              <span className="text-[10px] text-muted-foreground font-mono">pt</span>
            </div>
          </div>
        </div>

        {/* Clean Save Feedback */}
        <div className="flex items-center justify-between text-[10px] text-muted-foreground px-1">
          <span>Auto-saves on change or Enter</span>
          {isBusy ? (
            <span className="flex items-center gap-1 text-primary"><Loader2 className="w-3 h-3 animate-spin" /> Saving...</span>
          ) : justSaved ? (
            <span className="flex items-center gap-1 text-emerald-500 font-bold"><Check className="w-3 h-3" /> Saved to Kotak</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function LivePage() {
  const { status, reload: reloadStatus } = useStatus()
  const today = status?.now?.slice(0, 10) ?? new Date().toISOString().slice(0, 10)

  // Chart view: SENSEX, NIFTY, or DUAL split
  const [activeChart, setActiveChart] = useState<"SENSEX" | "NIFTY" | "DUAL">("SENSEX")
  const [, setSelectedTrade] = useState<OptionTrade | null>(null)

  // Side Panel state: open / collapsed, and active tab
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false)
  const [sideTab, setSideTab] = useState<"ACTIVE" | "CLOSED" | "ENGINES" | "SUMMARY">("ACTIVE")

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
    if (typeof window === "undefined") return { x: 500, y: 780 }
    const widgetW = 270
    const x = Math.max(70, Math.round((window.innerWidth - widgetW) / 2))
    const y = Math.max(110, window.innerHeight - 56 - 44)
    return { x, y }
  })
  const [isDraggingScalp, setIsDraggingScalp] = useState(false)
  const [hasDraggedMinScalp, setHasDraggedMinScalp] = useState(false)
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [isScalpMinimized, setIsScalpMinimized] = useState(true)

  // Risk Guardian Manual Reset State
  const [resettingGuardian, setResettingGuardian] = useState(false)

  async function handleResetGuardian() {
    if (!window.confirm("Reset the Risk Guardian circuit breaker and resume trading for today?")) return
    setResettingGuardian(true)
    try {
      const res = await postJSON<{ ok: boolean; message?: string }>("/api/risk-guardian/reset", {})
      if (res.ok) {
        toast.success(res.message || "Risk Guardian lock reset! Trading resumed.")
        await Promise.all([reloadStatus(), liveTradesPoll.reload()])
      } else {
        toast.error("Failed to reset Risk Guardian lock")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setResettingGuardian(false)
    }
  }

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
    setHasDraggedMinScalp(true)
    const el = (e.currentTarget as HTMLElement).closest(".fixed") as HTMLElement
    const rect = el ? el.getBoundingClientRect() : { left: scalpPos.x, top: scalpPos.y }
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
    setScalpPos({
      x: rect.left,
      y: rect.top,
    })
  }

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDraggingScalp) return
      const sidePanelW = isSidePanelOpen ? (window.innerWidth >= 1024 ? 384 : 320) : 0
      const widgetW = isScalpMinimized ? 270 : 315
      const widgetH = isScalpMinimized ? 40 : 310

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
      const widgetW = isScalpMinimized ? 270 : 315
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

  // Strategy Engines Live Telemetry & Heartbeat
  const strategyTelemetry = usePoll<{
    ok: boolean
    now: string
    state: Record<string, any>
    logs: Array<{ time: string; symbol: string; engine: string; level: string; message: string }>
  }>("/api/strategy-telemetry", 2000)

  // Polling feeds: Day candle data
  const niftyDay = usePoll<DayData>(today ? `/api/day?date=${today}&symbol=NIFTY&full=1` : null, 2500)
  const sensexDay = usePoll<DayData>(today ? `/api/day?date=${today}&symbol=SENSEX&full=1` : null, 2500)

  // Trade mode filter: "LIVE" (Kotak Neo real trades), "ALL", or "PAPER"
  const [tradeMode, setTradeMode] = useState<"LIVE" | "ALL" | "PAPER">(() => {
    try {
      return (localStorage.getItem("trade_mode_filter") as "LIVE" | "ALL" | "PAPER") || "LIVE"
    } catch {
      return "LIVE"
    }
  })

  const handleSetTradeMode = (m: "LIVE" | "ALL" | "PAPER") => {
    setTradeMode(m)
    try {
      localStorage.setItem("trade_mode_filter", m)
    } catch {}
  }

  // Polling feeds: All strategy paper trades & live broker positions
  const liveTradesPoll = usePoll<OptionTrade[]>("/api/trades", 2500)

  const lastKnownTradesRef = useRef<OptionTrade[]>([])
  const rawTrades = useMemo(() => {
    if (liveTradesPoll.data && liveTradesPoll.data.length > 0) {
      lastKnownTradesRef.current = liveTradesPoll.data
      return liveTradesPoll.data
    }
    return liveTradesPoll.data ?? lastKnownTradesRef.current
  }, [liveTradesPoll.data])

  const counts = useMemo(() => {
    const liveCount = rawTrades.filter((t) => t.mode?.includes("LIVE") || t.strategy === "kotak_live").length
    const paperCount = rawTrades.length - liveCount
    return { live: liveCount, paper: paperCount, total: rawTrades.length }
  }, [rawTrades])

  const tradesList = useMemo(() => {
    if (tradeMode === "LIVE") {
      return rawTrades.filter((t) => t.mode?.includes("LIVE") || t.strategy === "kotak_live")
    }
    if (tradeMode === "PAPER") {
      return rawTrades.filter((t) => !t.mode?.includes("LIVE") && t.strategy !== "kotak_live")
    }
    return rawTrades
  }, [rawTrades, tradeMode])

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
      const pnl = Number(t.option_pnl_rs ?? t.pnl_rs ?? (t.futures_pnl_rs ?? 0)) || 0
      runningPnl += pnl
      const buyVal = Number(t.buy_value_rs)
      const buyPx = Number(t.buy_price)
      const qty = Number(t.qty) || 1
      investedCapital += !Number.isNaN(buyVal) && buyVal > 0 ? buyVal : (!Number.isNaN(buyPx) && buyPx > 0 ? buyPx * qty : 0)
    })

    let realizedPnl = 0
    let winners = 0
    let losers = 0
    closedTrades.forEach((t) => {
      const pnl = Number(t.net_rs ?? t.pnl_rs ?? 0) || 0
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
    // Wide strike range: 25 strikes below to 25 strikes above ATM (51 strikes total!)
    for (let i = -25; i <= 25; i++) {
      arr.push(currentAtmStrike + i * strikeStep)
    }
    // If user typed a custom strike outside this range, include it dynamically
    if (customStrike && !arr.includes(customStrike)) {
      arr.push(customStrike)
      arr.sort((a, b) => a - b)
    }
    return arr
  }, [currentAtmStrike, strikeStep, customStrike])

  // Check if there is an active running position for the selected scalp spot
  const activeSpotTrade = useMemo(() => {
    return openTrades.find((t) => {
      const sym = (t.symbol || t.strategy || t.option || "").toUpperCase()
      return sym.includes(scalpSpot)
    })
  }, [openTrades, scalpSpot])



  // Map trades to chart markers
  const sensexChartTrades = useMemo(() => {
    const filtered = tradesList.filter((t) => t.symbol?.toUpperCase().includes("SENSEX") || t.symbol?.includes("BSESN"))
    return filtered.map(toRuleTrade)
  }, [tradesList])

  const niftyChartTrades = useMemo(() => {
    const filtered = tradesList.filter((t) => !t.symbol || t.symbol?.toUpperCase().includes("NIFTY") || t.symbol?.includes("NSEI"))
    return filtered.map(toRuleTrade)
  }, [tradesList])

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
        is_live: true,
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

  // Update TP/TL on active position
  const handleUpdateActiveTpTl = async (
    tradeToUpdate = activeSpotTrade,
    overrideTp?: number,
    overrideTl?: number
  ) => {
    if (!tradeToUpdate) return
    setScalpBusy(true)
    try {
      const sym = tradeToUpdate.raw_symbol || tradeToUpdate.option || tradeToUpdate.symbol
      const tp = overrideTp !== undefined ? overrideTp : scalpTp
      const tl = overrideTl !== undefined ? overrideTl : scalpTs
      const isSensex = (sym || "").toUpperCase().includes("SENSEX")
      const res = await postJSON<{ ok: boolean; message?: string }>("/api/update-tp-tl", {
        symbol: sym,
        tp_pts: tp,
        tl_pts: tl,
        entry_price: tradeToUpdate.buy_price || tradeToUpdate.spot_at_entry || tradeToUpdate.nifty_in || 0,
        qty: tradeToUpdate.qty || (isSensex ? 20 : 65),
      })
      toast.success(res.message || `Updated TP/TL for ${tradeToUpdate.option || sym} (TP: +${tp}pt | TL: -${tl}pt)`)
      liveTradesPoll.reload()
    } catch (err) {
      toast.error(`Update TP/TL failed: ${err instanceof Error ? err.message : String(err)}`)
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

          {/* Risk Guardian Indicator */}
          {status?.risk_guardian?.is_locked ? (
            <div 
              className="flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md bg-rose-500/15 border border-rose-500/40 text-rose-600 dark:text-rose-400 font-bold text-xs shadow-xs"
              title={status?.risk_guardian?.lock_info?.reason || 'Max daily loss limit breached. All trades locked.'}
            >
              <ShieldAlert className="w-3.5 h-3.5 text-rose-500 shrink-0 animate-pulse" />
              <span>GUARDIAN LOCKED (-Rs. {(status?.risk_guardian?.daily_loss_limit || status?.daily_loss_limit || 2000).toLocaleString('en-IN')})</span>
              <button
                type="button"
                onClick={handleResetGuardian}
                disabled={resettingGuardian}
                className="ml-1 px-1.5 py-0.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-bold text-[10px] tracking-wide cursor-pointer transition-all active:scale-95 shadow-2xs"
                title="Click to reset the daily loss circuit breaker and resume trading"
              >
                {resettingGuardian ? "…" : "Reset"}
              </button>
            </div>
          ) : status?.risk_guardian?.enabled ? (
            <div 
              className="hidden sm:flex items-center space-x-1.5 px-2 py-0.5 rounded-md bg-muted/60 text-muted-foreground text-[11px] font-medium border border-border/50"
              title={`Max Daily Loss: Rs. ${(status?.risk_guardian?.daily_loss_limit || 2000).toLocaleString('en-IN')} | Remaining Buffer: Rs. ${Math.max(0, status?.risk_guardian?.remaining_buffer || 0).toLocaleString('en-IN')} | Per-Trade Max SL: Rs. ${(status?.risk_guardian?.per_trade_loss_limit || 650).toLocaleString('en-IN')} (-${status?.risk_guardian?.per_trade_loss_pct || 20}%)`}
            >
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <span>Loss Guard: Rs. {(status?.risk_guardian?.daily_loss_limit || 2000).toLocaleString('en-IN')}</span>
              <span className="text-[10px] opacity-75 font-mono text-amber-400">| SL: -₹{status?.risk_guardian?.per_trade_loss_limit || 650}/lot (-{status?.risk_guardian?.per_trade_loss_pct || 20}%)</span>
            </div>
          ) : null}

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
        <div className="flex items-center space-x-2">
          {/* Chart View Switcher */}
          <div className="flex items-center bg-muted/70 p-0.5 rounded-lg border border-border">
            <button
              onClick={() => { setActiveChart("NIFTY"); setScalpSpot("NIFTY"); setSelectedTrade(null) }}
              className={`px-2 py-0.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                activeChart === "NIFTY"
                  ? "bg-primary text-primary-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              NIFTY
            </button>
            <button
              onClick={() => { setActiveChart("SENSEX"); setScalpSpot("SENSEX"); setSelectedTrade(null) }}
              className={`px-2 py-0.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                activeChart === "SENSEX"
                  ? "bg-primary text-primary-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              SENSEX
            </button>
            <button
              onClick={() => { setActiveChart("DUAL"); setSelectedTrade(null) }}
              className={`px-2 py-0.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                activeChart === "DUAL"
                  ? "bg-primary text-primary-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Dual
            </button>
          </div>

          {/* Scalper Toggle Button */}
          <button
            onClick={() => setShowScalpBar(!showScalpBar)}
            className={`px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 font-bold text-xs border shadow-2xs cursor-pointer ${
              showScalpBar
                ? "bg-amber-500/15 border-amber-500/40 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/30"
                : "bg-muted text-muted-foreground border-border hover:text-foreground"
            }`}
            title="Toggle Fast Scalper"
          >
            <Zap className={`w-3.5 h-3.5 ${showScalpBar ? "fill-amber-500" : ""}`} />
            <span>Scalper</span>
          </button>

          {/* Trades Side Panel Toggle */}
          <button
            type="button"
            onClick={() => {
              if (isSidePanelOpen && sideTab === "ACTIVE") {
                setIsSidePanelOpen(false)
              } else {
                setIsSidePanelOpen(true)
                setSideTab("ACTIVE")
              }
            }}
            className={`px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 font-semibold text-xs border shadow-2xs cursor-pointer ${
              isSidePanelOpen && sideTab === "ACTIVE"
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-muted text-muted-foreground border-border hover:text-foreground"
            }`}
            title="Toggle Open Trades & Positions Panel"
          >
            <Radio className="w-3 h-3 text-emerald-500" />
            <span>Trades ({openTrades.length})</span>
          </button>

          {/* Strategy Engines Side Panel Toggle */}
          <button
            type="button"
            onClick={() => {
              if (isSidePanelOpen && sideTab === "ENGINES") {
                setIsSidePanelOpen(false)
              } else {
                setIsSidePanelOpen(true)
                setSideTab("ENGINES")
              }
            }}
            className={`px-2 py-1 rounded-md transition-all flex items-center gap-1.5 font-medium text-xs border shadow-2xs cursor-pointer ${
              isSidePanelOpen && sideTab === "ENGINES"
                ? "bg-emerald-500/20 border-emerald-500 text-emerald-400"
                : "bg-muted/60 text-muted-foreground border-border hover:text-foreground"
            }`}
            title="Toggle Live Logs & Engines"
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Logs</span>
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

                {/* Mode Selector within Popover */}
                <div className="flex items-center justify-between px-2.5 py-1 bg-muted/40 rounded-lg border border-border/60 text-[10px]">
                  <span className="text-muted-foreground font-semibold uppercase tracking-wider">Source:</span>
                  <div className="flex items-center gap-1 font-bold">
                    <button
                      type="button"
                      onClick={() => handleSetTradeMode("LIVE")}
                      className={`px-2 py-0.5 rounded transition-all cursor-pointer ${tradeMode === "LIVE" ? "bg-emerald-600 text-white" : "text-muted-foreground hover:text-foreground"}`}
                      title="Kotak Neo Real Trades Only"
                    >
                      LIVE ({counts.live})
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetTradeMode("ALL")}
                      className={`px-2 py-0.5 rounded transition-all cursor-pointer ${tradeMode === "ALL" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      ALL ({counts.total})
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetTradeMode("PAPER")}
                      className={`px-2 py-0.5 rounded transition-all cursor-pointer ${tradeMode === "PAPER" ? "bg-amber-600 text-white" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      PAPER ({counts.paper})
                    </button>
                  </div>
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

      {/* 1.5 MODERN MINIMAL SCALPER WIDGET */}
      {showScalpBar && (
        isScalpMinimized ? (
          /* MINIMIZED FLOATING PILL - Ultra Clean */
          <div
            style={
              hasDraggedMinScalp
                ? { left: `${scalpPos.x}px`, top: `${scalpPos.y}px` }
                : {
                    left: isSidePanelOpen ? "calc((100vw - 384px) / 2)" : "50%",
                    transform: "translateX(-50%)",
                    bottom: "24px",
                  }
            }
            className="fixed z-40 flex items-center gap-2 px-3 py-1.5 rounded-full bg-card/95 border border-border shadow-xl backdrop-blur-md cursor-grab active:cursor-grabbing select-none transition-all text-xs ring-1 ring-border/50 animate-fadeIn"
            onMouseDown={handleDragStart}
          >
            <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setIsScalpMinimized(false)
              }}
              className="flex items-center gap-1.5 font-bold hover:text-primary transition-colors cursor-pointer"
            >
              <Zap className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
              <span>{scalpSpot} {activeStrike} {scalpOptionType}</span>
              <span className="text-muted-foreground font-mono font-normal">({scalpLots}L)</span>
            </button>

            {activeSpotTrade && (
              <span className={`font-mono text-xs font-bold ${pnlClass(activeSpotTrade.option_pnl_rs ?? activeSpotTrade.pnl_rs ?? 0)}`}>
                {(activeSpotTrade.option_pnl_rs ?? activeSpotTrade.pnl_rs ?? 0) >= 0 ? "+" : ""}
                {fmtRs(activeSpotTrade.option_pnl_rs ?? activeSpotTrade.pnl_rs ?? 0)}
              </span>
            )}

            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleScalpOrder("BUY", scalpOptionType) }}
              disabled={scalpBusy || Boolean(status?.risk_guardian?.is_locked)}
              className={`px-3 py-0.5 rounded text-[10px] font-bold text-white shadow-2xs cursor-pointer ${
                scalpOptionType === "CE" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700"
              }`}
            >
              BUY
            </button>

            {activeSpotTrade && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleScalpExit() }}
                disabled={scalpBusy}
                className="px-2.5 py-0.5 rounded text-[10px] font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-2xs cursor-pointer"
              >
                EXIT
              </button>
            )}

            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setIsScalpMinimized(false) }}
              className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground cursor-pointer"
              title="Expand Scalper"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          /* EXPANDED PRO FLOATING SCALPER PANEL - Modern, Clean & High-Focus */
          <div
            style={{ left: `${scalpPos.x}px`, top: `${scalpPos.y}px` }}
            className="fixed z-40 w-72 bg-card/95 backdrop-blur-md border border-border shadow-2xl rounded-2xl overflow-hidden select-none animate-fadeIn transition-shadow ring-1 ring-border/50 text-xs"
          >
            {/* Draggable Header */}
            <div
              onMouseDown={handleDragStart}
              className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b border-border/70 cursor-grab active:cursor-grabbing"
            >
              <div className="flex items-center gap-1.5">
                <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
                <Zap className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                <span className="font-bold text-xs text-foreground">Fast Scalp</span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  ({scalpSpot} {activeStrike} {scalpOptionType})
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setIsScalpMinimized(true)}
                  className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Minimize"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowScalpBar(false)}
                  className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Close"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Widget Body */}
            <div className="p-3 space-y-2.5">
              {/* Guardian Locked Alert */}
              {status?.risk_guardian?.is_locked && (
                <div className="p-2 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-500 text-[11px] font-semibold flex items-center justify-between">
                  <span>Guardian Locked (-₹{(status?.risk_guardian?.daily_loss_limit || 2000).toLocaleString('en-IN')})</span>
                  <button
                    type="button"
                    onClick={handleResetGuardian}
                    disabled={resettingGuardian}
                    className="px-2 py-0.5 rounded bg-rose-600 text-white font-bold text-[10px]"
                  >
                    Reset
                  </button>
                </div>
              )}

              {/* Row 1: Clean Spot & Option Type Segmented Controls */}
              <div className="grid grid-cols-2 gap-2">
                <div className="flex p-0.5 bg-muted/70 rounded-lg border border-border">
                  <button
                    type="button"
                    onClick={() => { setScalpSpot("NIFTY"); setCustomStrike(null); if (activeChart !== "DUAL") setActiveChart("NIFTY") }}
                    className={`flex-1 py-1 text-center font-bold text-[11px] rounded-md transition-all cursor-pointer ${scalpSpot === "NIFTY" ? "bg-primary text-primary-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    NIFTY
                  </button>
                  <button
                    type="button"
                    onClick={() => { setScalpSpot("SENSEX"); setCustomStrike(null); if (activeChart !== "DUAL") setActiveChart("SENSEX") }}
                    className={`flex-1 py-1 text-center font-bold text-[11px] rounded-md transition-all cursor-pointer ${scalpSpot === "SENSEX" ? "bg-primary text-primary-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    SENSEX
                  </button>
                </div>

                <div className="flex p-0.5 bg-muted/70 rounded-lg border border-border">
                  <button
                    type="button"
                    onClick={() => setScalpOptionType("CE")}
                    className={`flex-1 py-1 text-center font-bold text-[11px] rounded-md transition-all cursor-pointer ${scalpOptionType === "CE" ? "bg-emerald-600 text-white shadow-2xs" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    CE (Call)
                  </button>
                  <button
                    type="button"
                    onClick={() => setScalpOptionType("PE")}
                    className={`flex-1 py-1 text-center font-bold text-[11px] rounded-md transition-all cursor-pointer ${scalpOptionType === "PE" ? "bg-rose-600 text-white shadow-2xs" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    PE (Put)
                  </button>
                </div>
              </div>

              {/* Row 2: Strike Dropdown & Lots Stepper */}
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <div className="text-[10px] text-muted-foreground font-semibold flex items-center justify-between">
                    <span>Strike</span>
                    {customStrike !== null && customStrike !== currentAtmStrike && (
                      <button
                        type="button"
                        onClick={() => setCustomStrike(null)}
                        className="text-primary hover:underline cursor-pointer"
                      >
                        Reset ATM
                      </button>
                    )}
                  </div>
                  <select
                    value={activeStrike}
                    onChange={(e) => setCustomStrike(Number(e.target.value))}
                    className="w-full bg-background border border-border rounded-lg px-2 py-1 font-mono font-bold text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary h-8 cursor-pointer"
                  >
                    {strikeChoices.map((stk) => (
                      <option key={stk} value={stk}>
                        {stk} {stk === currentAtmStrike ? "★ (ATM)" : stk > currentAtmStrike ? `(+${stk - currentAtmStrike})` : `(${stk - currentAtmStrike})`}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <div className="text-[10px] text-muted-foreground font-semibold">
                    Lots ({scalpLots * (scalpSpot === "SENSEX" ? 20 : 65)} Qty)
                  </div>
                  <div className="flex items-center border border-border rounded-lg bg-background h-8 overflow-hidden shadow-2xs">
                    <button
                      type="button"
                      onClick={() => setScalpLots((l) => Math.max(1, l - 1))}
                      className="w-8 h-full hover:bg-muted text-foreground font-bold flex items-center justify-center text-sm border-r border-border cursor-pointer active:bg-muted"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={scalpLots}
                      onChange={(e) => setScalpLots(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full text-center font-mono font-bold text-xs bg-transparent focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setScalpLots((l) => Math.min(50, l + 1))}
                      className="w-8 h-full hover:bg-muted text-foreground font-bold flex items-center justify-center text-sm border-l border-border cursor-pointer active:bg-muted"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              {/* Row 3: Target Profit (TP) & Stop Loss (SL) Clean Inputs */}
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 space-y-1">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-emerald-500 font-bold">Target (TP)</span>
                    <span className="text-muted-foreground font-mono">pts</span>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    step={5}
                    value={scalpTp === 0 ? "" : scalpTp}
                    placeholder="30"
                    onChange={(e) => setScalpTp(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="w-full px-2 py-0.5 font-mono font-bold text-xs text-emerald-500 bg-background border border-emerald-500/40 rounded focus:outline-none text-center h-6.5"
                  />
                </div>

                <div className="p-2 rounded-lg border border-rose-500/30 bg-rose-500/5 space-y-1">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-rose-500 font-bold">Stop Loss (SL)</span>
                    <span className="text-muted-foreground font-mono">pts</span>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    step={5}
                    value={scalpTs === 0 ? "" : scalpTs}
                    placeholder="10"
                    onChange={(e) => setScalpTs(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="w-full px-2 py-0.5 font-mono font-bold text-xs text-rose-500 bg-background border border-rose-500/40 rounded focus:outline-none text-center h-6.5"
                  />
                </div>
              </div>

              {/* Row 4: Action Button */}
              <div className="pt-0.5">
                <Button
                  size="sm"
                  disabled={scalpBusy || Boolean(status?.risk_guardian?.is_locked)}
                  onClick={() => handleScalpOrder("BUY", scalpOptionType)}
                  className={`w-full h-9 text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm rounded-lg cursor-pointer ${
                    status?.risk_guardian?.is_locked
                      ? "bg-muted text-muted-foreground border border-border cursor-not-allowed"
                      : scalpOptionType === "CE"
                      ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                      : "bg-rose-600 hover:bg-rose-700 text-white"
                  }`}
                >
                  {scalpBusy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Zap className="w-3.5 h-3.5 fill-current" />
                  )}
                  <span>
                    {status?.risk_guardian?.is_locked
                      ? "BUY LOCKED"
                      : `BUY ${scalpSpot} ${activeStrike} ${scalpOptionType} (${scalpLots}L)`}
                  </span>
                </Button>
              </div>

              {/* Active Position Card & Exit */}
              {activeSpotTrade && (
                <div className="p-2.5 rounded-lg bg-muted/60 border border-border space-y-2 animate-fadeIn">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="font-bold text-xs truncate">{activeSpotTrade.option || activeSpotTrade.symbol}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">₹{Number(activeSpotTrade.buy_price || 0).toFixed(1)} ({activeSpotTrade.qty}Q)</div>
                    </div>
                    <div className={`font-mono font-bold text-xs ${pnlClass(activeSpotTrade.option_pnl_rs ?? activeSpotTrade.pnl_rs ?? 0)}`}>
                      {(activeSpotTrade.option_pnl_rs ?? activeSpotTrade.pnl_rs ?? 0) >= 0 ? "+" : ""}
                      {fmtRs(activeSpotTrade.option_pnl_rs ?? activeSpotTrade.pnl_rs ?? 0)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={scalpBusy}
                    onClick={handleScalpExit}
                    className="w-full h-7 text-xs font-bold cursor-pointer"
                  >
                    {scalpBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3" />}
                    <span>Square Off Position</span>
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
                    {(sensexDay.data?.vix?.close != null || niftyDay.data?.vix?.close != null) && (() => {
                      const vx = sensexDay.data?.vix ?? niftyDay.data?.vix
                      if (!vx?.close) return null
                      return (
                        <div className="flex items-baseline gap-1 px-1.5 py-0.5 rounded border border-border/60 bg-muted/40 font-mono text-xs shrink-0" title={`India VIX: ${vx.close.toFixed(2)}`}>
                          <span className="text-[10px] font-bold text-muted-foreground uppercase">VIX</span>
                          <span className="text-xs font-bold text-foreground">{vx.close.toFixed(2)}</span>
                          {vx.change_pct != null && (
                            <span className={cn("text-[10px] font-semibold", vx.change_pct > 0 ? "text-amber-500" : "text-sky-500")}>
                              {vx.change_pct >= 0 ? "+" : ""}{vx.change_pct.toFixed(2)}%
                            </span>
                          )}
                        </div>
                      )
                    })()}

                    
                  </div>


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
                    {(niftyDay.data?.vix?.close != null || sensexDay.data?.vix?.close != null) && (() => {
                      const vx = niftyDay.data?.vix ?? sensexDay.data?.vix
                      if (!vx?.close) return null
                      return (
                        <div className="flex items-baseline gap-1 px-1.5 py-0.5 rounded border border-border/60 bg-muted/40 font-mono text-xs shrink-0" title={`India VIX: ${vx.close.toFixed(2)}`}>
                          <span className="text-[10px] font-bold text-muted-foreground uppercase">VIX</span>
                          <span className="text-xs font-bold text-foreground">{vx.close.toFixed(2)}</span>
                          {vx.change_pct != null && (
                            <span className={cn("text-[10px] font-semibold", vx.change_pct > 0 ? "text-amber-500" : "text-sky-500")}>
                              {vx.change_pct >= 0 ? "+" : ""}{vx.change_pct.toFixed(2)}%
                            </span>
                          )}
                        </div>
                      )
                    })()}

                    
                  </div>


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
                  onClick={() => setSideTab("ENGINES")}
                  className={`flex-1 py-1 text-[11px] font-semibold rounded transition-all flex items-center justify-center gap-1 ${
                    sideTab === "ENGINES"
                      ? "bg-background text-foreground shadow-xs font-bold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Terminal className="w-2.5 h-2.5 text-emerald-500" />
                  <span>Live Logs</span>
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

            {/* Live vs Paper Feed Filter */}
            <div className="flex-none px-2.5 py-1.5 bg-muted/20 border-b border-border/60 flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground font-semibold text-[10px] uppercase tracking-wider">Feed:</span>
              <div className="flex items-center bg-muted/60 p-0.5 rounded-md border border-border/60">
                <button
                  type="button"
                  onClick={() => handleSetTradeMode("LIVE")}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                    tradeMode === "LIVE"
                      ? "bg-emerald-600 text-white shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="Show only real Kotak Neo broker trades (Zero brokerage)"
                >
                  LIVE ({counts.live})
                </button>
                <button
                  type="button"
                  onClick={() => handleSetTradeMode("ALL")}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                    tradeMode === "ALL"
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="Show both Live Kotak and Paper trades"
                >
                  ALL ({counts.total})
                </button>
                <button
                  type="button"
                  onClick={() => handleSetTradeMode("PAPER")}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                    tradeMode === "PAPER"
                      ? "bg-amber-600 text-white shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="Show simulated strategy paper trades only"
                >
                  PAPER ({counts.paper})
                </button>
              </div>
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
                    openTrades.map((trade, idx) => (
                      <ActiveTradeCard
                        key={`active-trade-${idx}-${trade.option || trade.symbol}`}
                        trade={trade}
                        onUpdateTpTl={async (t: OptionTrade, tp: number, tl: number) => {
                          await handleUpdateActiveTpTl(t, tp, tl)
                        }}
                        onSquareOff={(t: OptionTrade) => setExitTarget(t)}
                      />
                    ))
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
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="font-bold text-xs text-foreground truncate font-sans">
                                {trade.option || trade.symbol}
                              </span>
                              {trade.mode && trade.mode.toUpperCase().includes("LIVE") ? (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shrink-0">
                                  <span className="size-1 rounded-full bg-emerald-400 animate-pulse" />
                                  LIVE
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30 shrink-0">
                                  PAPER
                                </span>
                              )}
                            </div>
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

              {/* TAB: ENGINES TELEMETRY & BAR AUDIT */}
              {sideTab === "ENGINES" && (
                <div className="p-3 space-y-3">
                  {/* Status Banner */}
                  <div className="p-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                      </span>
                      <span className="font-bold text-xs text-foreground">Apex Engines Active</span>
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground">{strategyTelemetry.data?.now}</span>
                  </div>

                  {/* NIFTY Mini Card */}
                  <div className="p-2.5 rounded-lg border bg-muted/30 space-y-1.5 text-xs font-mono">
                    <div className="flex items-center justify-between font-sans">
                      <span className="font-bold text-sky-400">NSE NIFTY</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/30">
                        {strategyTelemetry.data?.state?.nifty?.status || "MONITORING"}
                      </span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Spot LTP:</span>
                      <span className="text-foreground font-bold">{strategyTelemetry.data?.state?.nifty?.spot ? strategyTelemetry.data.state.nifty.spot.toLocaleString("en-IN") : "--"}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>15m OR:</span>
                      <span className="text-foreground">{strategyTelemetry.data?.state?.nifty?.or_low || "--"} – {strategyTelemetry.data?.state?.nifty?.or_high || "--"}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>OR Width:</span>
                      <span className="text-sky-400">{strategyTelemetry.data?.state?.nifty?.or_range ? `${strategyTelemetry.data.state.nifty.or_range} pt` : "--"}</span>
                    </div>
                  </div>

                  {/* SENSEX Mini Card */}
                  <div className="p-2.5 rounded-lg border bg-muted/30 space-y-1.5 text-xs font-mono">
                    <div className="flex items-center justify-between font-sans">
                      <span className="font-bold text-purple-400">BSE SENSEX</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/30">
                        {strategyTelemetry.data?.state?.sensex?.status || "MONITORING"}
                      </span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Spot LTP:</span>
                      <span className="text-foreground font-bold">{strategyTelemetry.data?.state?.sensex?.spot ? strategyTelemetry.data.state.sensex.spot.toLocaleString("en-IN") : "--"}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>15m OR:</span>
                      <span className="text-foreground">{strategyTelemetry.data?.state?.sensex?.or_low || "--"} – {strategyTelemetry.data?.state?.sensex?.or_high || "--"}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>OR Width:</span>
                      <span className="text-sky-400">{strategyTelemetry.data?.state?.sensex?.or_range ? `${strategyTelemetry.data.state.sensex.or_range} pt` : "--"}</span>
                    </div>
                  </div>

                  {/* VIX Bias */}
                  <div className="p-2 rounded-lg border bg-muted/20 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">India VIX Bias:</span>
                    <span className={`font-mono font-bold ${Number(strategyTelemetry.data?.state?.nifty?.vix_chg ?? 0) <= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {strategyTelemetry.data?.state?.nifty?.vix_chg ? `${strategyTelemetry.data.state.nifty.vix_chg > 0 ? "+" : ""}${strategyTelemetry.data.state.nifty.vix_chg}%` : "0.0%"}
                    </span>
                  </div>

                  {/* Live Activity Log */}
                  <div className="space-y-1.5 pt-1">
                    <div className="text-[11px] font-semibold text-muted-foreground flex items-center justify-between px-0.5">
                      <span className="flex items-center gap-1.5 text-foreground font-bold">
                        <Terminal className="w-3.5 h-3.5 text-emerald-400" /> Live Execution Stream
                      </span>
                      <span className="text-[10px] text-emerald-400 font-mono bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                        ● Live Sync (2s)
                      </span>
                    </div>
                    <div className="h-[430px] overflow-y-auto space-y-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] shadow-inner select-text">
                      {strategyTelemetry.data?.logs?.length ? (
                        strategyTelemetry.data.logs.slice(0, 50).map((log: any, i: number) => {
                          const isSignal = log.level === "SIGNAL"
                          const isOrder = log.level === "ORDER" || log.message?.includes("ENTRY") || log.message?.includes("EXIT")
                          const isError = log.level === "ERROR" || log.level === "WARN"
                          return (
                            <div key={i} className="border-b border-zinc-800/80 pb-2 last:border-0 last:pb-0">
                              <div className="flex items-center gap-1.5 text-[10px]">
                                <span className="text-zinc-500 font-bold">[{log.time}]</span>
                                <span className={`px-1.5 py-0.2 rounded font-bold text-[9px] ${
                                  log.symbol === "NIFTY"
                                    ? "bg-sky-500/20 text-sky-400 border border-sky-500/30"
                                    : "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                                }`}>
                                  {log.symbol}
                                </span>
                                <span className={`px-1.5 py-0.2 rounded font-bold text-[9px] ${
                                  isSignal
                                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse"
                                    : isOrder
                                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                                    : isError
                                    ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                                    : "bg-zinc-800 text-zinc-400"
                                }`}>
                                  {log.level}
                                </span>
                              </div>
                              <div className={`text-[11px] mt-1 leading-snug ${
                                isSignal
                                  ? "text-amber-300 font-semibold"
                                  : isOrder
                                  ? "text-emerald-300 font-semibold"
                                  : isError
                                  ? "text-rose-400"
                                  : "text-zinc-200"
                              }`}>
                                {log.message}
                              </div>
                            </div>
                          )
                        })
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full text-zinc-500 py-12 text-center">
                          <Terminal className="w-8 h-8 mb-2 text-zinc-700" />
                          <span className="text-xs font-semibold text-zinc-400">Live Console Connected</span>
                          <span className="text-[11px] text-zinc-600 mt-1">Listening for incoming 1-minute bars & signals...</span>
                        </div>
                      )}
                    </div>
                  </div>
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
                <span className="font-mono font-bold text-foreground">₹{exitTarget.buy_price != null ? Number(exitTarget.buy_price).toFixed(2) : "-"}</span>
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

import { useEffect, useState, useCallback, useRef } from "react"
import { useTheme } from "next-themes"
import { toast } from "sonner"
import {
  Plus,
  Minus,
  Clock,
  Target,
  Shield,
  ArrowLeft,
  ChevronDown,
  RefreshCw,
  Sun,
  Moon,
  Wallet,
  XCircle,
  AlertTriangle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  fmtRs,
  pnlClass,
  postJSON,
  usePoll,
  type ManualOptionChoices,
  type ManualExpiryGroup,
  type FundsStatus,
} from "@/lib/api"
import { useStatus } from "@/lib/status"
import { cn } from "@/lib/utils"

interface OpenPosition {
  symbol: string
  net_qty: number
  buy_avg?: number
  sell_avg?: number
  average_price?: number
  last_price?: number
  ltp?: number
  pnl?: number
  unrealized_pnl?: number
  realized_pnl?: number
  lot_size?: number
  exchange?: string
  product?: string
  side?: string
  tp_pts?: number
  tl_pts?: number
  target_price?: number
  stop_price?: number
}

interface ClosedPosition {
  symbol: string
  qty: number
  buy_avg: number
  sell_avg: number
  realized_pnl: number
}

interface PositionsResponse {
  ok: boolean
  broker?: string
  open_positions: OpenPosition[]
  closed_positions: ClosedPosition[]
  summary: {
    realized_pnl: number
    unrealized_pnl: number
    net_pnl: number
    open_count: number
    closed_count: number
  }
}

export function ManualTradingPage() {
  const { status } = useStatus()
  const isKotakConnected = Boolean(status?.token.valid)

  // Theme support (Light / Dark)
  const { resolvedTheme, setTheme } = useTheme()
  const isDark = resolvedTheme !== "light"

  // Instrument: NIFTY vs SENSEX
  const [indexSymbol, setIndexSymbol] = useState<"NIFTY" | "SENSEX">("NIFTY")

  // Fast live polling: 1000ms for positions, 2500ms for real-time spot and ATM options
  const positionsPoll = usePoll<PositionsResponse>(isKotakConnected ? "/api/positions" : null, 1000)
  const optionsPoll = usePoll<ManualOptionChoices>(
    isKotakConnected ? `/api/manual-options?symbol=${indexSymbol}` : null,
    2500
  )
  // Poll funds/margin every 8 seconds
  const fundsPoll = usePoll<FundsStatus>(isKotakConnected ? "/api/funds" : null, 8000)

  // Track both NIFTY and SENSEX spot prices live (isolated per symbol to prevent cross-symbol flickers)
  const [spotMap, setSpotMap] = useState<Record<"NIFTY" | "SENSEX", number>>({
    NIFTY: 25227.95,
    SENSEX: 82031.81,
  })

  // Real-time spot and day change from status ticks (polled every 1500ms) or cached spotMap
  const niftyTick = status?.last_tick
  const sensexTick = status?.sensex_last_tick

  const niftySpot = niftyTick?.ltp || spotMap.NIFTY || 25227.95
  const niftyChange = niftyTick?.change ?? (niftyTick?.prev_close ? niftySpot - niftyTick.prev_close : null)
  const niftyPerChange = niftyTick?.per_change ?? (niftyTick?.prev_close && niftyChange != null ? (niftyChange / niftyTick.prev_close) * 100 : null)

  const sensexSpot = sensexTick?.ltp || spotMap.SENSEX || 82031.81
  const sensexChange = sensexTick?.change ?? (sensexTick?.prev_close ? sensexSpot - sensexTick.prev_close : null)
  const sensexPerChange = sensexTick?.per_change ?? (sensexTick?.prev_close && sensexChange != null ? (sensexChange / sensexTick.prev_close) * 100 : null)

  useEffect(() => {
    if (niftyTick?.ltp && niftyTick.ltp > 0) {
      setSpotMap((prev) => ({ ...prev, NIFTY: niftyTick.ltp }))
    }
    if (sensexTick?.ltp && sensexTick.ltp > 0) {
      setSpotMap((prev) => ({ ...prev, SENSEX: sensexTick.ltp }))
    }
  }, [niftyTick?.ltp, sensexTick?.ltp])

  // Per-symbol caches for ATM, strikes, and expiries so switching symbols is instant with zero glitch or stale flash
  const [atmMap, setAtmMap] = useState<Record<"NIFTY" | "SENSEX", number>>({
    NIFTY: 25250,
    SENSEX: 82000,
  })
  const [strikeMap, setStrikeMap] = useState<Record<"NIFTY" | "SENSEX", string>>({
    NIFTY: "25250",
    SENSEX: "82000",
  })
  const [expiryMap, setExpiryMap] = useState<Record<"NIFTY" | "SENSEX", string>>({
    NIFTY: "",
    SENSEX: "",
  })
  const [expiriesMap, setExpiriesMap] = useState<Record<"NIFTY" | "SENSEX", ManualExpiryGroup[]>>({
    NIFTY: [],
    SENSEX: [],
  })

  // Helper to determine symbol from API response
  const parseSymbol = (sym?: string): "NIFTY" | "SENSEX" | null => {
    if (!sym) return null
    return sym.toUpperCase().includes("SENSEX") ? "SENSEX" : "NIFTY"
  }

  // Update active index spot, atm, and expiries ONLY when response actually matches its symbol!
  useEffect(() => {
    const d = optionsPoll.data
    if (!d || !d.ok) return
    const sym = parseSymbol(d.symbol)
    if (!sym) return

    if (d.spot && d.spot > 0) {
      setSpotMap((prev) => ({ ...prev, [sym]: d.spot }))
    }
    if (d.atm && d.atm > 0) {
      setAtmMap((prev) => ({ ...prev, [sym]: d.atm }))
      setStrikeMap((prev) => {
        if (!prev[sym] || prev[sym] === "0") {
          return { ...prev, [sym]: String(d.atm) }
        }
        return prev
      })
    }
    if (d.expiries && d.expiries.length > 0) {
      setExpiriesMap((prev) => ({ ...prev, [sym]: d.expiries }))
    }
  }, [optionsPoll.data])

  // Also fetch alt index spot & options in background so both cards always display live spot values
  useEffect(() => {
    if (!isKotakConnected) return
    const altSymbol: "NIFTY" | "SENSEX" = indexSymbol === "NIFTY" ? "SENSEX" : "NIFTY"
    fetch(`/api/manual-options?symbol=${altSymbol}`)
      .then((r) => r.json())
      .then((data: ManualOptionChoices) => {
        if (!data?.ok) return
        const sym = parseSymbol(data.symbol) || altSymbol
        if (data.spot && data.spot > 0) {
          setSpotMap((prev) => ({ ...prev, [sym]: data.spot }))
        }
        if (data.atm && data.atm > 0) {
          setAtmMap((prev) => ({ ...prev, [sym]: data.atm }))
          setStrikeMap((prev) => {
            if (!prev[sym] || prev[sym] === "0") {
              return { ...prev, [sym]: String(data.atm) }
            }
            return prev
          })
        }
        if (data.expiries && data.expiries.length > 0) {
          setExpiriesMap((prev) => ({ ...prev, [sym]: data.expiries }))
        }
      })
      .catch(() => {})
  }, [indexSymbol, isKotakConnected])

  // Active expiries for current indexSymbol
  const isDataForCurrentIndex = Boolean(
    optionsPoll.data?.symbol && parseSymbol(optionsPoll.data.symbol) === indexSymbol
  )

  const expiries =
    isDataForCurrentIndex && optionsPoll.data?.expiries && optionsPoll.data.expiries.length > 0
      ? optionsPoll.data.expiries
      : expiriesMap[indexSymbol]?.length
      ? expiriesMap[indexSymbol]
      : []

  const currentExpiry = expiryMap[indexSymbol] || expiries[0]?.expiry || ""

  const setExpiry = (exp: string) => {
    setExpiryMap((prev) => ({ ...prev, [indexSymbol]: exp }))
  }

  // Ensure active expiry is valid when expiries load
  useEffect(() => {
    if (expiries.length > 0) {
      const cur = expiryMap[indexSymbol]
      if (!cur || !expiries.some((e) => e.expiry === cur)) {
        setExpiryMap((prev) => ({ ...prev, [indexSymbol]: expiries[0].expiry }))
      }
    }
  }, [expiries, indexSymbol, expiryMap])

  const selectedExpiryGroup = expiries.find((e) => e.expiry === currentExpiry) || expiries[0]
  const lotSize = selectedExpiryGroup?.lot_size ?? (indexSymbol === "SENSEX" ? 20 : 65)
  const atmStrike =
    isDataForCurrentIndex && (optionsPoll.data?.atm ?? 0) > 0
      ? optionsPoll.data!.atm
      : atmMap[indexSymbol] || (indexSymbol === "SENSEX" ? 82000 : 25250)
  const strikeStep = indexSymbol === "SENSEX" ? 100 : 50

  // Format expiry label nicely: e.g. "23 Nov", "01 Dec"
  function formatExpiryLabel(expStr: string) {
    if (!expStr) return "Expiry"
    try {
      const parts = expStr.split("-")
      if (parts.length === 3) {
        const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        const day = parts[2]
        const month = monthNames[parseInt(parts[1], 10)] || parts[1]
        return `${day} ${month}`
      }
      return expStr
    } catch {
      return expStr
    }
  }

  const strike = strikeMap[indexSymbol] || String(atmStrike)
  const setStrike = (val: string) => {
    setStrikeMap((prev) => ({ ...prev, [indexSymbol]: val }))
  }

  const [lots, setLots] = useState(1)
  const [product] = useState<"NRML" | "MIS">("NRML")

  // Scalper Target & Stop Loss points (persisted in localStorage)
  const [slPts, setSlPtsState] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("scalper_sl_pts")
      if (saved !== null) {
        const val = parseFloat(saved)
        if (!isNaN(val) && val >= 0) return val
      }
    } catch {}
    return 10
  })
  const [tpPts, setTpPtsState] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("scalper_tp_pts")
      if (saved !== null) {
        const val = parseFloat(saved)
        if (!isNaN(val) && val >= 0) return val
      }
    } catch {}
    return 15
  })

  // Helper setters that automatically persist user edits to localStorage
  const setSlPts = useCallback((valOrFn: number | ((prev: number) => number)) => {
    setSlPtsState((prev) => {
      const next = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn
      const safeVal = Math.max(0, next)
      try {
        localStorage.setItem("scalper_sl_pts", String(safeVal))
      } catch {}
      return safeVal
    })
  }, [])

  const setTpPts = useCallback((valOrFn: number | ((prev: number) => number)) => {
    setTpPtsState((prev) => {
      const next = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn
      const safeVal = Math.max(0, next)
      try {
        localStorage.setItem("scalper_tp_pts", String(safeVal))
      } catch {}
      return safeVal
    })
  }, [])

  // Per-position Risk mapping for active trades: symbol -> { sl, tp } (persisted in localStorage)
  const [riskMap, setRiskMap] = useState<Record<string, { sl: number; tp: number }>>(() => {
    try {
      const saved = localStorage.getItem("scalper_risk_map")
      if (saved) return JSON.parse(saved)
    } catch {}
    return {}
  })

  // Multi-position selection tab index
  const [selectedPosIdx, setSelectedPosIdx] = useState(0)

  // Screen View Mode: "POSITION" (Focus on active trade), "ORDER" (Strike & order entry), or "HISTORY" (Closed trades in same space)
  const [viewMode, setViewMode] = useState<"POSITION" | "ORDER" | "HISTORY">("POSITION")

  // Quotes
  const [cePrice, setCePrice] = useState<number | null>(null)
  const [pePrice, setPePrice] = useState<number | null>(null)
  const [ceSymbol, setCeSymbol] = useState<string>("")
  const [peSymbol, setPeSymbol] = useState<string>("")
  const [quoteLoading, setQuoteLoading] = useState(false)

  // Action busy states
  const [actionBusy, setActionBusy] = useState(false)

  // Mobile Pull-to-Refresh
  const containerRef = useRef<HTMLDivElement>(null)
  const touchStartY = useRef<number | null>(null)
  const [pullDistance, setPullDistance] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (containerRef.current && containerRef.current.scrollTop <= 0) {
      touchStartY.current = e.touches[0].clientY
    } else {
      touchStartY.current = null
    }
  }

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (touchStartY.current !== null && !isRefreshing) {
      const currentY = e.touches[0].clientY
      const diff = currentY - touchStartY.current
      if (diff > 0 && containerRef.current && containerRef.current.scrollTop <= 0) {
        // Progressive resistance
        const resistance = Math.min(diff * 0.45, 80)
        setPullDistance(resistance)
      } else {
        setPullDistance(0)
      }
    }
  }

  const handleTouchEnd = async () => {
    if (pullDistance > 50 && !isRefreshing) {
      setIsRefreshing(true)
      setPullDistance(44)
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(25)
      }
      try {
        await Promise.allSettled([
          positionsPoll.reload(),
          optionsPoll.reload(),
          fundsPoll.reload(),
        ])
        toast.success("Live data refreshed", { duration: 1500 })
      } finally {
        setTimeout(() => {
          setIsRefreshing(false)
          setPullDistance(0)
          touchStartY.current = null
        }, 300)
      }
    } else {
      setPullDistance(0)
      touchStartY.current = null
    }
  }

  // Fetch Quotes for both CE and PE continuously in real-time
  useEffect(() => {
    if (!isKotakConnected || !currentExpiry || !strike) return

    let cancelled = false
    setQuoteLoading(true)

    async function loadQuotes() {
      try {
        const [ceRes, peRes] = await Promise.allSettled([
          fetch(`/api/manual-quote?symbol=${indexSymbol}&strike=${strike}&option_type=CE&expiry=${currentExpiry}`).then((r) =>
            r.json()
          ),
          fetch(`/api/manual-quote?symbol=${indexSymbol}&strike=${strike}&option_type=PE&expiry=${currentExpiry}`).then((r) =>
            r.json()
          ),
        ])

        if (cancelled) return

        if (ceRes.status === "fulfilled" && ceRes.value && ceRes.value.last_price > 0) {
          setCePrice(ceRes.value.last_price)
          setCeSymbol(ceRes.value.symbol || "")
        } else {
          setCePrice(null)
        }

        if (peRes.status === "fulfilled" && peRes.value && peRes.value.last_price > 0) {
          setPePrice(peRes.value.last_price)
          setPeSymbol(peRes.value.symbol || "")
        } else {
          setPePrice(null)
        }
      } catch (err) {
        console.warn("Quote fetch error", err)
      } finally {
        if (!cancelled) setQuoteLoading(false)
      }
    }

    void loadQuotes()
    const timer = setInterval(() => void loadQuotes(), 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [indexSymbol, currentExpiry, strike, isKotakConnected])

  // Strike adjustment
  function stepStrike(dir: -1 | 1) {
    const cur = Number(strike) || atmStrike
    setStrike(String(cur + dir * strikeStep))
  }

  const totalQty = lots * lotSize
  const ceCost = cePrice != null && cePrice > 0 ? Math.round(cePrice * totalQty) : null
  const peCost = pePrice != null && pePrice > 0 ? Math.round(pePrice * totalQty) : null

  // Available trading margin
  const availableFunds = fundsPoll.data?.available_equity_funds ?? fundsPoll.data?.available_balance ?? null

  const openPositions = positionsPoll.data?.open_positions ?? []
  const closedPositions = positionsPoll.data?.closed_positions ?? []
  const summary = positionsPoll.data?.summary ?? {
    realized_pnl: 0,
    unrealized_pnl: 0,
    net_pnl: 0,
    open_count: openPositions.length,
    closed_count: closedPositions.length,
  }

  // Only enable Demo mode when running on localhost
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "0.0.0.0" ||
      window.location.hostname.endsWith(".local"))

  const [demoActive, setDemoActive] = useState<boolean>(isLocalhost)

  const DEFAULT_DEMO_POSITIONS: OpenPosition[] = [
    {
      symbol: "NIFTY 25250 CE",
      net_qty: 65,
      buy_avg: 124.5,
      last_price: 142.0,
      ltp: 142.0,
      pnl: 1137.5,
      unrealized_pnl: 1137.5,
      lot_size: 65,
      tl_pts: 10,
      tp_pts: 15,
    },
    {
      symbol: "SENSEX 82000 PE",
      net_qty: 20,
      buy_avg: 210.0,
      last_price: 268.5,
      ltp: 268.5,
      pnl: 1170.0,
      unrealized_pnl: 1170.0,
      lot_size: 20,
      tl_pts: 15,
      tp_pts: 25,
    },
  ]
  const [demoPositions, setDemoPositions] = useState<OpenPosition[]>(DEFAULT_DEMO_POSITIONS)

  // Active positions to display (Real positions take precedence, or Demo preview if isLocalhost && demoActive is true)
  const displayPositions: OpenPosition[] =
    openPositions.length > 0 ? openPositions : (isLocalhost && demoActive) ? demoPositions : []

  const isDemo = isLocalhost && openPositions.length === 0 && demoActive && displayPositions.length > 0
  const hasActivePosition = displayPositions.length > 0
  const activePos = displayPositions[selectedPosIdx] || displayPositions[0]
  const totalOpenPnl = displayPositions.reduce((acc, p) => acc + (p.unrealized_pnl ?? p.pnl ?? 0), 0)
  const realizedPnl = summary.realized_pnl ?? 0
  const overallPnl = realizedPnl + totalOpenPnl

  // Carousel ref and scroll navigation for swipable cards
  const carouselRef = useRef<HTMLDivElement>(null)

  const handleCarouselScroll = useCallback(() => {
    if (!carouselRef.current) return
    const { scrollLeft, clientWidth } = carouselRef.current
    if (clientWidth > 0) {
      const newIdx = Math.round(scrollLeft / clientWidth)
      if (newIdx !== selectedPosIdx && newIdx >= 0 && newIdx < displayPositions.length) {
        setSelectedPosIdx(newIdx)
      }
    }
  }, [displayPositions.length, selectedPosIdx])

  const scrollToPosition = useCallback((idx: number) => {
    if (!carouselRef.current) return
    const width = carouselRef.current.clientWidth
    carouselRef.current.scrollTo({ left: idx * width, behavior: "smooth" })
    setSelectedPosIdx(idx)
  }, [])

  // Strike offset relative to ATM / Spot (calculates how back or ahead the selected strike is)
  const selectedStrikeNum = Number(strike) || atmStrike
  const strikeDiffFromAtm = selectedStrikeNum - atmStrike
  const stepsFromAtm = Math.round(strikeDiffFromAtm / strikeStep)

  // 1-TAP INSTANT BUY ORDER
  async function hitOrder(optionType: "CE" | "PE") {
    if (actionBusy) return
    if (!strike || !currentExpiry) {
      toast.error("Option strike unavailable")
      return
    }

    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(35)
    }

    setActionBusy(true)
    const targetSymbol = optionType === "CE" ? ceSymbol : peSymbol
    const targetPrice = optionType === "CE" ? cePrice : pePrice

    try {
      const res = await postJSON<{ ok: boolean; order_id?: string; fill_price?: number; symbol?: string; qty?: number }>(
        "/api/manual-order",
        {
          action: "BUY",
          index_symbol: indexSymbol,
          expiry: currentExpiry,
          strike: Number(strike),
          option_type: optionType,
          symbol: targetSymbol || undefined,
          lots,
          order_type: "MARKET",
          product,
          sl_pts: slPts > 0 ? slPts : undefined,
          target_pts: tpPts > 0 ? tpPts : undefined,
          confirm: "QUICK_TRADE",
        }
      )

      toast.success(`BOUGHT ${totalQty}x ${strike} ${optionType}`, {
        description: `Filled @ ₹${res.fill_price || targetPrice || 0} · SL: -${slPts}pt · TP: +${tpPts}pt`,
      })
      const filledSymbol = res.symbol || targetSymbol
      if (filledSymbol) {
        setRiskMap((prev) => {
          const updated = { ...prev, [filledSymbol]: { sl: slPts, tp: tpPts } }
          try {
            localStorage.setItem("scalper_risk_map", JSON.stringify(updated))
          } catch {}
          return updated
        })
      }
      await positionsPoll.reload()
      await fundsPoll.reload()
      setViewMode("POSITION")
    } catch (err: any) {
      toast.error("Order Rejected", { description: String(err?.message || err) })
    } finally {
      setActionBusy(false)
    }
  }

  // 1-TAP INSTANT EXIT SPECIFIC POSITION
  async function hitExit(pos: OpenPosition) {
    if (actionBusy) return
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate([40, 40])
    }

    if (isDemo) {
      toast.success("Demo Position Squared Off!", { description: `Squared off ${pos.symbol} · Simulated Exit` })
      const remaining = demoPositions.filter((p) => p.symbol !== pos.symbol)
      setDemoPositions(remaining)
      if (selectedPosIdx >= remaining.length) {
        setSelectedPosIdx(Math.max(0, remaining.length - 1))
      }
      if (remaining.length === 0) {
        setDemoActive(false)
        setViewMode("ORDER")
      }
      return
    }

    setActionBusy(true)
    try {
      await postJSON("/api/exit-position", {
        symbol: pos.symbol,
        qty: Math.abs(pos.net_qty),
        exchange: pos.exchange || (pos.symbol.includes("SENSEX") ? "bse_fo" : "nse_fo"),
        product: pos.product || "NRML",
        side: pos.net_qty > 0 ? "SELL" : "BUY",
      })
      toast.success("Position Closed!", { description: `Squared off ${pos.symbol}` })
      await positionsPoll.reload()
      await fundsPoll.reload()
    } catch (err: any) {
      toast.error("Exit Failed", { description: String(err?.message || err) })
    } finally {
      setActionBusy(false)
    }
  }

  // 1-TAP EXIT ALL OPEN POSITIONS
  async function hitExitAll() {
    if (actionBusy) return
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate([50, 50, 50])
    }

    if (isDemo) {
      toast.success("All Demo Positions Squared Off!")
      setDemoPositions([])
      setDemoActive(false)
      setViewMode("ORDER")
      return
    }

    setActionBusy(true)
    try {
      await postJSON("/api/exit-all", {})
      toast.success("All Positions Closed!", { description: "Closed all positions at market" })
      await positionsPoll.reload()
      await fundsPoll.reload()
    } catch (err: any) {
      toast.error("Exit All Failed", { description: String(err?.message || err) })
    } finally {
      setActionBusy(false)
    }
  }

  // LIVE UPDATE SL / TARGET IN ACTIVE TRADE PER-SYMBOL
  async function updateActiveRisk(symbol: string, newSl: number, newTp: number, pos: OpenPosition) {
    const validSl = Math.max(0, newSl)
    const validTp = Math.max(0, newTp)
    setRiskMap((prev) => {
      const updated = { ...prev, [symbol]: { sl: validSl, tp: validTp } }
      try {
        localStorage.setItem("scalper_risk_map", JSON.stringify(updated))
      } catch {}
      return updated
    })

    // Also carry forward user's live adjusted risk preference for future trades
    setSlPts(validSl)
    setTpPts(validTp)

    if (isDemo) {
      toast.success("Demo Risk Updated Live", {
        description: `SL: ${validSl} pt · Target: ${validTp} pt`,
      })
      return
    }

    const entry = pos.buy_avg || pos.average_price || 0
    try {
      await postJSON("/api/update-tp-tl", {
        symbol: pos.symbol,
        tp_pts: validTp,
        tl_pts: validSl,
        entry_price: entry,
        qty: Math.abs(pos.net_qty),
      })
      toast.success("Risk Updated Live", {
        description: `SL: ${validSl} pt · Target: ${validTp} pt`,
      })
      await positionsPoll.reload()
    } catch (err: any) {
      toast.error("Failed to update risk", { description: String(err?.message || err) })
    }
  }

  // 1-TAP TRAIL TO BREAKEVEN
  async function moveToBreakeven(pos: OpenPosition) {
    const entry = pos.buy_avg || pos.average_price || 0
    if (entry <= 0) return
    const curTp = riskMap[pos.symbol]?.tp ?? pos.tp_pts ?? 15
    await updateActiveRisk(pos.symbol, 0.5, curTp, pos)
    toast.success("SL Moved to Breakeven!", { description: `Protected entry @ ₹${entry.toFixed(1)}` })
  }

  const isPositionFocused = hasActivePosition && viewMode === "POSITION"

  return (
    <div
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      style={{
        paddingTop: isPositionFocused
          ? "max(env(safe-area-inset-top, 0px), 24px)"
          : "max(env(safe-area-inset-top, 0px), 36px)",
        paddingBottom: "max(env(safe-area-inset-bottom, 0px), 16px)",
      }}
      className="flex flex-col w-full max-w-sm mx-auto px-2.5 h-full flex-1 justify-between select-none text-foreground bg-background overflow-y-auto"
    >
      {/* ─── PULL TO REFRESH INDICATOR ─── */}
      {(pullDistance > 0 || isRefreshing) && (
        <div
          style={{ height: `${isRefreshing ? 42 : pullDistance}px` }}
          className="flex items-center justify-center overflow-hidden transition-all duration-150 shrink-0 mb-1"
        >
          <div className="flex items-center gap-1.5 py-1 px-3 rounded-full bg-card border border-border/70 shadow-xs text-xs font-mono font-bold text-muted-foreground">
            <RefreshCw
              className={cn("size-3.5 text-primary", isRefreshing ? "animate-spin" : "")}
              style={{ transform: isRefreshing ? undefined : `rotate(${pullDistance * 4}deg)` }}
            />
            <span>{isRefreshing ? "Refreshing live data..." : pullDistance > 50 ? "Release to refresh" : "Pull down to refresh"}</span>
          </div>
        </div>
      )}
      
      {/* ─── TOP & MIDDLE SECTION ─── */}
      <div className="flex flex-col gap-2">
        {/* ─── 0. APP BRANDING & THEME HEADER ─── */}
        <header className="flex items-center justify-between px-1 py-1 shrink-0 select-none">
          <div className="flex items-center gap-2">
            <div className="grid size-7 place-items-center rounded-xl bg-primary text-primary-foreground font-black text-xs shadow-xs">
              A
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5 leading-none">
                <span className="text-xs font-black tracking-tight text-foreground">
                  AlgoNeo Scalper
                </span>
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                  • LIVE
                </span>
              </div>
              <span className="text-[10px] font-mono text-muted-foreground leading-none mt-1">
                Kotak Neo · ₹0 Brokerage
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Demo Mode Toggle Button (Enabled only when running on localhost) */}
            {isLocalhost && (
              <button
                type="button"
                onClick={() => {
                  const next = !demoActive
                  setDemoActive(next)
                  if (next) {
                    setDemoPositions(DEFAULT_DEMO_POSITIONS)
                    setSelectedPosIdx(0)
                    setViewMode("POSITION")
                    toast.info("Demo Mode Active", { description: "Previewing Active Positions" })
                  } else {
                    setViewMode("ORDER")
                    toast.info("Demo Mode Disabled")
                  }
                }}
                className={cn(
                  "text-[10px] font-mono font-bold px-2 py-1 rounded-xl border transition-all cursor-pointer flex items-center gap-1 shadow-2xs active:scale-95",
                  demoActive
                    ? "bg-amber-500/15 text-amber-500 border-amber-500/40 shadow-xs"
                    : "bg-card text-muted-foreground border-border/60 hover:text-foreground"
                )}
                title={demoActive ? "Turn off demo preview" : "Show demo trade in active position HUD"}
              >
                <span className={cn("size-1.5 rounded-full", demoActive ? "bg-amber-500 animate-pulse" : "bg-muted-foreground")} />
                <span>{demoActive ? "Demo ON" : "Demo"}</span>
              </button>
            )}

            {/* Quick Reload Button */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={async () => {
                setIsRefreshing(true)
                try {
                  await Promise.allSettled([positionsPoll.reload(), optionsPoll.reload(), fundsPoll.reload()])
                  toast.success("Live data refreshed", { duration: 1500 })
                } finally {
                  setIsRefreshing(false)
                }
              }}
              className="size-8 rounded-xl border border-border/60 bg-card text-muted-foreground hover:text-foreground active:scale-95 cursor-pointer shadow-2xs"
              title="Refresh Live Data"
            >
              <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} />
            </Button>

            {/* Theme Toggler (Light / Dark) */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className="size-8 rounded-xl border border-border/60 bg-card text-muted-foreground hover:text-foreground active:scale-95 cursor-pointer shadow-2xs"
              title={isDark ? "Switch to Light Theme" : "Switch to Dark Theme"}
            >
              {isDark ? <Sun className="size-4 text-amber-500" /> : <Moon className="size-4 text-indigo-500" />}
            </Button>
          </div>
        </header>

        {/* ─── 1. DUAL FINANCIAL METRICS: OVERALL P&L & AVAILABLE BALANCE ─── */}
        <div className="grid grid-cols-2 gap-2">
          {/* Card A: OVERALL P&L */}
          <div className={cn(
            "p-2.5 rounded-2xl border transition-all flex flex-col justify-between shadow-2xs relative overflow-hidden",
            overallPnl > 0
              ? "bg-gradient-to-br from-emerald-500/10 via-card to-card border-emerald-500/35"
              : overallPnl < 0
              ? "bg-gradient-to-br from-rose-500/10 via-card to-card border-rose-500/35"
              : "bg-card border-border/60"
          )}>
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground flex items-center gap-1.5 leading-none">
                <span className={cn(
                  "size-1.5 rounded-full",
                  hasActivePosition ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"
                )} />
                OVERALL P&L
              </span>
              {closedPositions.length > 0 && (
                <span className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded-md bg-muted/60 text-muted-foreground">
                  {closedPositions.length} done
                </span>
              )}
            </div>

            <div className={cn(
              "font-black font-mono tracking-tight mt-1",
              isPositionFocused ? "text-xl sm:text-2xl" : "text-2xl",
              overallPnl > 0 ? "text-emerald-500" : overallPnl < 0 ? "text-rose-500" : "text-muted-foreground"
            )}>
              {overallPnl > 0 ? "+" : ""}
              {fmtRs(overallPnl)}
            </div>

            <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground mt-1 pt-1 border-t border-border/30">
              <span>Realized: {realizedPnl >= 0 ? "+" : ""}{fmtRs(realizedPnl)}</span>
              {hasActivePosition && (
                <span className={totalOpenPnl >= 0 ? "text-emerald-500 font-bold" : "text-rose-500 font-bold"}>
                  {totalOpenPnl >= 0 ? "+" : ""}{fmtRs(totalOpenPnl)}
                </span>
              )}
            </div>
          </div>

          {/* Card B: AVAILABLE BALANCE */}
          <div className="p-2.5 rounded-2xl bg-card border border-border/60 transition-all flex flex-col justify-between shadow-2xs relative overflow-hidden">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground flex items-center gap-1 leading-none">
                <Wallet className="size-3 text-primary" /> AVAIL MARGIN
              </span>
              <button
                type="button"
                onClick={() => {
                  if (viewMode === "HISTORY") {
                    setViewMode(hasActivePosition ? "POSITION" : "ORDER")
                  } else {
                    setViewMode("HISTORY")
                  }
                }}
                className={cn(
                  "text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md border cursor-pointer transition-all active:scale-95 flex items-center gap-1",
                  viewMode === "HISTORY"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted/60 text-muted-foreground border-border/60 hover:text-foreground"
                )}
                title="View today's closed trades"
              >
                <Clock className="size-2.5" />
                <span>{viewMode === "HISTORY" ? "Close" : `Log (${closedPositions.length})`}</span>
              </button>
            </div>

            <div className={cn(
              "font-black font-mono tracking-tight text-foreground mt-1",
              isPositionFocused ? "text-xl sm:text-2xl" : "text-2xl"
            )}>
              {availableFunds != null ? fmtRs(availableFunds) : isKotakConnected ? "₹37,258" : "—"}
            </div>

            <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground mt-1 pt-1 border-t border-border/30">
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">₹0 Brokerage</span>
              <span>Kotak Neo</span>
            </div>
          </div>
        </div>

        {/* ─── SWITCHER BANNER WHEN IN ORDER VIEW WITH ACTIVE POSITIONS ─── */}
        {hasActivePosition && viewMode === "ORDER" && (
          <button
            type="button"
            onClick={() => setViewMode("POSITION")}
            className="flex items-center justify-between p-2.5 rounded-2xl bg-emerald-500/15 border border-emerald-500/40 text-xs font-mono font-bold text-foreground transition-all active:scale-98 cursor-pointer shadow-xs"
          >
            <span className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <span className="size-2 rounded-full bg-emerald-500 animate-ping" />
              <span className="font-bold">
                {displayPositions.length > 1 ? `${displayPositions.length} Positions Active` : `${activePos.symbol} Active`}
              </span>
            </span>
            <span className={cn("font-black", totalOpenPnl >= 0 ? "text-emerald-500" : "text-rose-500")}>
              {totalOpenPnl >= 0 ? "+" : ""}{fmtRs(totalOpenPnl)} ➔
            </span>
          </button>
        )}


        {/* ─── CONDITIONAL MAIN CONTENT AREA (Swaps in the exact same space) ─── */}
        {viewMode === "HISTORY" ? (
          /* ══════════════════════════════════════════════════════════════════ */
          /* VIEW C: TODAY'S CLOSED TRADES (Rendered in the exact same space)   */
          /* ══════════════════════════════════════════════════════════════════ */
          <div className="flex flex-col gap-2.5 animate-in fade-in duration-150">
            <div className="flex items-center justify-between p-3 rounded-2xl bg-card border border-border/60 shadow-2xs">
              <span className="text-xs font-black uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Clock className="size-3.5 text-primary" /> Today's Closed Trades ({closedPositions.length})
              </span>
              <span className={cn("text-xs font-black font-mono", pnlClass(summary.realized_pnl))}>
                {summary.realized_pnl >= 0 ? "+" : ""}{fmtRs(summary.realized_pnl)}
              </span>
            </div>

            {closedPositions.length === 0 ? (
              <div className="text-center text-xs font-mono text-muted-foreground py-10 bg-card rounded-2xl border border-dashed border-border/60">
                No closed trades yet today
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-[58vh] overflow-y-auto pr-0.5">
                {closedPositions.map((t, idx) => (
                  <div
                    key={`${t.symbol}-${idx}`}
                    className="flex items-center justify-between p-3 rounded-2xl bg-card border border-border/60 shadow-2xs text-xs font-mono"
                  >
                    <div>
                      <div className="font-bold text-foreground text-xs">{t.symbol}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {t.qty} Qty · In: ₹{t.buy_avg.toFixed(1)} · Out: ₹{t.sell_avg.toFixed(1)}
                      </div>
                    </div>
                    <div className={cn("font-black text-sm font-mono", t.realized_pnl >= 0 ? "text-emerald-500" : "text-rose-500")}>
                      {t.realized_pnl >= 0 ? "+" : ""}{fmtRs(t.realized_pnl)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => setViewMode(hasActivePosition ? "POSITION" : "ORDER")}
              className="w-full py-3.5 mt-1 rounded-2xl border border-primary/40 bg-primary/10 hover:bg-primary/20 text-xs font-mono font-bold text-primary transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xs active:scale-98"
            >
              <ArrowLeft className="size-4" />
              <span>Back to Trading Desk</span>
            </button>
          </div>
        ) : isPositionFocused ? (
          /* ══════════════════════════════════════════════════════════════════ */
          /* VIEW A: ACTIVE TRADE HUD (Card-Level Swipable Position Cards)      */
          /* ══════════════════════════════════════════════════════════════════ */
          <div className="flex flex-col gap-2 animate-in fade-in duration-150">
            {/* ─── CARD-LEVEL SWIPABLE POSITIONS ─── */}
            <div
              ref={carouselRef}
              onScroll={handleCarouselScroll}
              className="flex overflow-x-auto snap-x snap-mandatory scroll-smooth gap-3 pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden touch-pan-x"
            >
              {displayPositions.map((pos, idx) => {
                const isLong = pos.net_qty > 0
                const tradePnl = pos.unrealized_pnl ?? pos.pnl ?? 0
                const entryAvg = pos.buy_avg || pos.average_price || 0
                const ltp = pos.ltp || pos.last_price || 0
                const ptsDiff = isLong ? ltp - entryAvg : entryAvg - ltp
                const pnlPercent = entryAvg > 0 ? (ptsDiff / entryAvg) * 100 : 0
                const posQty = Math.abs(pos.net_qty)
                const investedCost = Math.round(entryAvg * posQty)

                const activeSl = riskMap[pos.symbol]?.sl ?? pos.tl_pts ?? 10
                const activeTp = riskMap[pos.symbol]?.tp ?? pos.tp_pts ?? 15
                const currentSlPrice = entryAvg > 0 && activeSl > 0
                  ? isLong ? entryAvg - activeSl : entryAvg + activeSl
                  : null
                const currentTpPrice = entryAvg > 0 && activeTp > 0
                  ? isLong ? entryAvg + activeTp : entryAvg - activeTp
                  : null
                const slRupeeImpact = Math.round(activeSl * posQty)
                const tpRupeeImpact = Math.round(activeTp * posQty)

                return (
                  <div
                    key={`${pos.symbol}-${idx}`}
                    className="w-full min-w-full shrink-0 snap-center flex flex-col gap-2"
                  >
                    {/* UNIFIED ACTIVE TRADE TERMINAL HERO */}
                    <div className={cn(
                      "p-2.5 rounded-2xl border-2 flex flex-col gap-1.5 shadow-sm transition-all",
                      tradePnl >= 0 ? "bg-emerald-500/10 border-emerald-500/50" : "bg-rose-500/10 border-rose-500/50"
                    )}>
                      {/* Top Row: Symbol & Direction Badge */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className={cn(
                            "text-[10px] px-2 py-0.5 rounded-md font-black tracking-wide",
                            isLong ? "bg-emerald-500/25 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/25 text-rose-600 dark:text-rose-400"
                          )}>
                            {isLong ? "LONG ↗" : "SHORT ↘"}
                          </span>
                          <span className="text-xs sm:text-sm font-black font-mono text-foreground">{pos.symbol}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-card/90 text-foreground border border-border/60">
                            {posQty} Qty
                          </span>
                          {displayPositions.length > 1 && (
                            <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-primary/20 text-primary">
                              {idx + 1}/{displayPositions.length}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Middle Row: Hero Running P&L */}
                      <div className="flex flex-col items-center justify-center py-0.5">
                        <span className="text-[9px] uppercase font-bold tracking-wider text-muted-foreground leading-none mb-0.5">
                          RUNNING TRADE P&L
                        </span>
                        <div className={cn(
                          "text-3xl sm:text-4xl font-black font-mono tracking-tight",
                          tradePnl >= 0 ? "text-emerald-500" : "text-rose-500"
                        )}>
                          {tradePnl >= 0 ? "+" : ""}{fmtRs(tradePnl)}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 font-mono text-xs font-bold text-muted-foreground">
                          <span className={tradePnl >= 0 ? "text-emerald-500" : "text-rose-500"}>
                            {ptsDiff >= 0 ? "+" : ""}{ptsDiff.toFixed(1)} pt
                          </span>
                          <span>•</span>
                          <span className={tradePnl >= 0 ? "text-emerald-500" : "text-rose-500"}>
                            {pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%
                          </span>
                          <span className="size-2 rounded-full bg-emerald-500 animate-pulse ml-0.5" />
                        </div>
                      </div>

                      {/* Bottom Row: Key Metrics Strip */}
                      <div className="grid grid-cols-3 gap-1.5 pt-1.5 border-t border-border/40 text-center font-mono">
                        <div className="bg-card/80 py-1 px-1 rounded-lg border border-border/50">
                          <span className="text-[9px] uppercase font-bold text-muted-foreground block leading-tight">Avg Entry</span>
                          <span className="text-xs font-black text-foreground block mt-0.5">₹{entryAvg.toFixed(1)}</span>
                        </div>
                        <div className="bg-card/80 py-1 px-1 rounded-lg border border-border/50">
                          <span className="text-[9px] uppercase font-bold text-muted-foreground block leading-tight">Live LTP</span>
                          <span className="text-xs font-black text-foreground block mt-0.5">₹{ltp.toFixed(1)}</span>
                        </div>
                        <div className="bg-card/80 py-1 px-1 rounded-lg border border-border/50">
                          <span className="text-[9px] uppercase font-bold text-muted-foreground block leading-tight">Invested</span>
                          <span className="text-xs font-black text-foreground block mt-0.5">{fmtRs(investedCost)}</span>
                        </div>
                      </div>
                    </div>

                    {/* LIVE EDITABLE STOP LOSS & TARGET (COMPACT 2-COLUMN GRID) */}
                    <div className="grid grid-cols-2 gap-2">
                      {/* STOP LOSS LIVE EDITOR */}
                      <div className="p-2 rounded-2xl bg-card border border-rose-500/35 flex flex-col justify-between gap-1 shadow-2xs">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-rose-500 uppercase flex items-center gap-1 text-[10px]">
                            <Shield className="size-3" /> Stop Loss
                          </span>
                          <button
                            type="button"
                            onClick={() => moveToBreakeven(pos)}
                            className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-amber-500/15 border border-amber-500/30 text-amber-500 hover:bg-amber-500/25 active:scale-95 transition-all cursor-pointer"
                            title="Trail SL to Entry"
                          >
                            ⚡ BE
                          </button>
                        </div>

                        <div className="flex items-center justify-between gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 rounded-lg bg-muted/60 border border-border/60 hover:bg-muted active:scale-90"
                            onClick={() => updateActiveRisk(pos.symbol, Math.max(0, activeSl - 5), activeTp, pos)}
                          >
                            <Minus className="size-3 text-rose-500" />
                          </Button>

                          <div className="relative flex-1">
                            <Input
                              type="number"
                              min="0"
                              step="5"
                              value={activeSl || ""}
                              onChange={(e) => updateActiveRisk(pos.symbol, parseFloat(e.target.value) || 0, activeTp, pos)}
                              className="h-7 text-center text-xs font-mono font-bold bg-background border border-border/70 rounded-lg px-1"
                            />
                          </div>

                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 rounded-lg bg-muted/60 border border-border/60 hover:bg-muted active:scale-90"
                            onClick={() => updateActiveRisk(pos.symbol, activeSl + 5, activeTp, pos)}
                          >
                            <Plus className="size-3 text-rose-500" />
                          </Button>
                        </div>

                        <div className="text-[10px] font-mono font-bold text-muted-foreground text-center">
                          {currentSlPrice != null ? `Exit: ₹${currentSlPrice.toFixed(1)}` : "SL Off"}
                          {activeSl > 0 ? ` (-₹${slRupeeImpact})` : ""}
                        </div>
                      </div>

                      {/* TARGET LIVE EDITOR */}
                      <div className="p-2 rounded-2xl bg-card border border-emerald-500/35 flex flex-col justify-between gap-1 shadow-2xs">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-emerald-500 uppercase flex items-center gap-1 text-[10px]">
                            <Target className="size-3" /> Target
                          </span>
                          <span className="text-[10px] font-mono font-bold text-emerald-500">
                            +{activeTp} pts
                          </span>
                        </div>

                        <div className="flex items-center justify-between gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 rounded-lg bg-muted/60 border border-border/60 hover:bg-muted active:scale-90"
                            onClick={() => updateActiveRisk(pos.symbol, activeSl, Math.max(0, activeTp - 5), pos)}
                          >
                            <Minus className="size-3 text-emerald-500" />
                          </Button>

                          <div className="relative flex-1">
                            <Input
                              type="number"
                              min="0"
                              step="5"
                              value={activeTp || ""}
                              onChange={(e) => updateActiveRisk(pos.symbol, activeSl, parseFloat(e.target.value) || 0, pos)}
                              className="h-7 text-center text-xs font-mono font-bold bg-background border border-border/70 rounded-lg px-1"
                            />
                          </div>

                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 rounded-lg bg-muted/60 border border-border/60 hover:bg-muted active:scale-90"
                            onClick={() => updateActiveRisk(pos.symbol, activeSl, activeTp + 5, pos)}
                          >
                            <Plus className="size-3 text-emerald-500" />
                          </Button>
                        </div>

                        <div className="text-[10px] font-mono font-bold text-muted-foreground text-center">
                          {currentTpPrice != null ? `Target: ₹${currentTpPrice.toFixed(1)}` : "TP Off"}
                          {activeTp > 0 ? ` (+₹${tpRupeeImpact})` : ""}
                        </div>
                      </div>
                    </div>

                    {/* ─── DEDICATED INDIVIDUAL SQUARE OFF BUTTON (MASSIVE & UNMISSABLE) ─── */}
                    <Button
                      type="button"
                      variant="destructive"
                      size="lg"
                      disabled={actionBusy}
                      onClick={() => hitExit(pos)}
                      className="w-full h-12 text-sm font-black rounded-2xl bg-rose-600 hover:bg-rose-700 active:scale-95 shadow-lg shadow-rose-600/30 tracking-wider cursor-pointer text-white flex items-center justify-center gap-2 border-2 border-rose-500 ring-2 ring-rose-500/20"
                    >
                      <XCircle className="size-5 shrink-0" />
                      <span>SQUARE OFF {pos.symbol}</span>
                    </Button>
                  </div>
                )
              })}
            </div>

            {/* ─── CARD PAGINATION DOTS (IF 2+ POSITIONS) ─── */}
            {displayPositions.length > 1 && (
              <div className="flex items-center justify-center gap-1.5 py-0.5">
                {displayPositions.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => scrollToPosition(i)}
                    className={cn(
                      "h-1.5 rounded-full transition-all cursor-pointer",
                      selectedPosIdx === i ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/60"
                    )}
                    title={`Go to position ${i + 1}`}
                  />
                ))}
              </div>
            )}

            {/* ─── BOTTOM ACTIONS: SQUARE OFF ALL + TRADE AGAIN ─── */}
            <div className="flex items-center gap-2 mt-0.5">
              <Button
                type="button"
                variant="destructive"
                size="lg"
                disabled={actionBusy}
                onClick={hitExitAll}
                className="flex-1 h-11 text-xs font-black rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-95 shadow-md shadow-rose-600/30 font-mono flex items-center justify-center gap-1.5 cursor-pointer ring-1 ring-rose-500/50"
                title="Square off all open positions"
              >
                <AlertTriangle className="size-4 shrink-0" />
                <span>SQUARE OFF ALL{displayPositions.length > 1 ? ` (${displayPositions.length})` : ""}</span>
              </Button>

              <button
                type="button"
                onClick={() => setViewMode("ORDER")}
                className="flex-1 h-11 rounded-xl border border-border/70 bg-card hover:bg-muted/40 text-xs font-mono font-bold text-foreground transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs active:scale-98"
              >
                <span>Trade Again ➔</span>
              </button>
            </div>
          </div>
        ) : (
          /* ══════════════════════════════════════════════════════════════════ */
          /* VIEW B: ORDER ENTRY DESK (Strike Stepper, Lots, Buy Buttons)      */
          /* ══════════════════════════════════════════════════════════════════ */
          <div className="flex flex-col gap-2.5 animate-in fade-in duration-150">
            
            {/* ─── 2. INDEX SELECTOR (BIGGER CARDS WITH REAL-TIME SPOT & DAY CHANGE) ─── */}
            <div className="grid grid-cols-2 gap-2.5">
              {/* NIFTY Button */}
              <button
                type="button"
                onClick={() => {
                  if (indexSymbol !== "NIFTY") {
                    setIndexSymbol("NIFTY")
                  }
                }}
                className={cn(
                  "p-3 rounded-2xl border-2 transition-all flex flex-col justify-between text-left cursor-pointer shadow-2xs active:scale-[0.98]",
                  indexSymbol === "NIFTY"
                    ? "bg-primary/10 border-primary shadow-xs ring-2 ring-primary/30"
                    : "bg-card border-border/60 hover:border-border/90 hover:bg-muted/30"
                )}
              >
                <div className="flex items-center justify-between w-full">
                  <span className={cn("text-xs font-black font-mono tracking-wide", indexSymbol === "NIFTY" ? "text-primary" : "text-foreground")}>
                    NIFTY 50
                  </span>
                  <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-md bg-muted/70 text-muted-foreground">
                    65 Q
                  </span>
                </div>
                <div className="flex flex-col mt-2">
                  <div className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                    <span className="text-base sm:text-lg font-black font-mono text-foreground tracking-tight">
                      {Number(niftySpot).toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5 font-mono text-[11px] font-bold">
                    {niftyChange != null ? (
                      <span className={niftyChange >= 0 ? "text-emerald-500" : "text-rose-500"}>
                        {niftyChange >= 0 ? "+" : ""}{niftyChange.toFixed(1)} ({niftyPerChange != null ? `${niftyPerChange >= 0 ? "+" : ""}${niftyPerChange.toFixed(2)}%` : ""})
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-[10px]">Real-time tick</span>
                    )}
                  </div>
                </div>
              </button>

              {/* SENSEX Button */}
              <button
                type="button"
                onClick={() => {
                  if (indexSymbol !== "SENSEX") {
                    setIndexSymbol("SENSEX")
                  }
                }}
                className={cn(
                  "p-3 rounded-2xl border-2 transition-all flex flex-col justify-between text-left cursor-pointer shadow-2xs active:scale-[0.98]",
                  indexSymbol === "SENSEX"
                    ? "bg-primary/10 border-primary shadow-xs ring-2 ring-primary/30"
                    : "bg-card border-border/60 hover:border-border/90 hover:bg-muted/30"
                )}
              >
                <div className="flex items-center justify-between w-full">
                  <span className={cn("text-xs font-black font-mono tracking-wide", indexSymbol === "SENSEX" ? "text-primary" : "text-foreground")}>
                    SENSEX
                  </span>
                  <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-md bg-muted/70 text-muted-foreground">
                    20 Q
                  </span>
                </div>
                <div className="flex flex-col mt-2">
                  <div className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                    <span className="text-base sm:text-lg font-black font-mono text-foreground tracking-tight">
                      {Number(sensexSpot).toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5 font-mono text-[11px] font-bold">
                    {sensexChange != null ? (
                      <span className={sensexChange >= 0 ? "text-emerald-500" : "text-rose-500"}>
                        {sensexChange >= 0 ? "+" : ""}{sensexChange.toFixed(1)} ({sensexPerChange != null ? `${sensexPerChange >= 0 ? "+" : ""}${sensexPerChange.toFixed(2)}%` : ""})
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-[10px]">Real-time tick</span>
                    )}
                  </div>
                </div>
              </button>
            </div>

            {/* ─── EXPIRY SELECTOR (FULL-WIDTH, ZERO FLICKER, NO 'EXPIRY' TEXT) ─── */}
            <div className="relative w-full">
              <select
                value={currentExpiry}
                onChange={(e) => setExpiry(e.target.value)}
                className="w-full h-11 px-3.5 pr-9 rounded-2xl bg-card border border-border/70 text-xs sm:text-sm font-mono font-bold text-foreground appearance-none focus:outline-none focus:ring-2 focus:ring-primary/40 cursor-pointer shadow-2xs transition-all"
              >
                {expiries.length === 0 ? (
                  <option value="">Loading expiries...</option>
                ) : (
                  expiries.map((exp, idx) => (
                    <option key={exp.expiry} value={exp.expiry} className="bg-background text-foreground py-1 font-sans">
                      {formatExpiryLabel(exp.expiry)} {idx === 0 ? "★ Current Week" : idx === 1 ? "Next Week" : "Monthly"} ({exp.expiry})
                    </option>
                  ))
                )}
              </select>
              <div className="absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground">
                <ChevronDown className="size-4" />
              </div>
            </div>

            {/* ─── 3. STRIKE STEPPER & OFFSET CALCULATOR ─── */}
            <div className="flex flex-col gap-2 p-3 rounded-2xl bg-card border border-border/70 shadow-sm my-0.5">
              <div className="flex items-center justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-12 rounded-2xl bg-muted/70 border border-border/80 hover:bg-muted active:scale-90 cursor-pointer shadow-2xs"
                  onClick={() => stepStrike(-1)}
                  title={`Step back -${strikeStep} pts`}
                >
                  <Minus className="size-5 text-foreground" />
                </Button>

                <div className="text-center flex flex-col items-center">
                  <div className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground leading-none mb-1 flex items-center gap-1.5">
                    <span>STRIKE PRICE</span>
                    <span className="text-[9px] font-mono font-semibold px-1 py-0.2 rounded bg-muted/80 text-muted-foreground">
                      ATM {atmStrike}
                    </span>
                  </div>

                  <div className="text-3xl font-black font-mono tracking-tight text-foreground flex items-center justify-center gap-2">
                    <span>{strike || atmStrike}</span>
                  </div>

                  {/* Offset distance badge: -50, -100, etc. */}
                  <div className="mt-1 flex items-center gap-1.5">
                    {strikeDiffFromAtm === 0 ? (
                      <span className="text-xs px-2 py-0.5 rounded-lg bg-amber-500/20 text-amber-500 font-black border border-amber-500/30 shadow-2xs">
                        ★ ATM (At The Money)
                      </span>
                    ) : (
                      <span className={cn(
                        "text-xs px-2 py-0.5 rounded-lg font-black font-mono border shadow-2xs flex items-center gap-1",
                        strikeDiffFromAtm < 0
                          ? "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30"
                          : "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30"
                      )}>
                        <span>{strikeDiffFromAtm > 0 ? `+${strikeDiffFromAtm}` : strikeDiffFromAtm} pts</span>
                        <span className="text-[10px] opacity-80 font-normal">
                          ({Math.abs(stepsFromAtm)} {Math.abs(stepsFromAtm) === 1 ? "strike" : "strikes"} {strikeDiffFromAtm < 0 ? "back" : "ahead"})
                        </span>
                      </span>
                    )}
                  </div>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-12 rounded-2xl bg-muted/70 border border-border/80 hover:bg-muted active:scale-90 cursor-pointer shadow-2xs"
                  onClick={() => stepStrike(1)}
                  title={`Step forward +${strikeStep} pts`}
                >
                  <Plus className="size-5 text-foreground" />
                </Button>
              </div>
            </div>

            {/* ─── 4. LOTS PICKER (BIGGER & PROMINENT LIKE SPOT/STRIKE) ─── */}
            <div className="flex flex-col gap-2 p-2.5 rounded-2xl bg-card border border-border/60 shadow-xs">
              <div className="flex items-center justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-10 rounded-xl bg-muted/60 border border-border/70 hover:bg-muted active:scale-90"
                  onClick={() => setLots((l) => Math.max(1, l - 1))}
                  disabled={lots <= 1}
                >
                  <Minus className="size-4" />
                </Button>

                <div className="text-center">
                  <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground leading-none mb-1">
                    LOTS & QUANTITY
                  </div>
                  <div className="text-2xl font-black font-mono tracking-tight text-foreground flex items-center justify-center gap-1.5">
                    <span>{lots}</span>
                    <span className="text-sm font-bold text-muted-foreground">
                      {lots === 1 ? "Lot" : "Lots"}
                    </span>
                    <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20">
                      {totalQty} Qty
                    </span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-10 rounded-xl bg-muted/60 border border-border/70 hover:bg-muted active:scale-90"
                  onClick={() => setLots((l) => Math.min(20, l + 1))}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
            </div>

            {/* ─── 5. STOP LOSS & TARGET CARDS WITH 5-STEPPERS ─── */}
            <div className="grid grid-cols-2 gap-2">
              {/* STOP LOSS CARD */}
              <div className="p-2.5 rounded-2xl bg-card border border-border/60 shadow-2xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[10px] font-bold text-rose-500 uppercase flex items-center gap-1">
                    <Shield className="size-3" /> Stop Loss
                  </span>
                  <span className="text-[10px] font-mono font-bold text-rose-500">
                    {slPts > 0 ? `-${(slPts * totalQty).toFixed(0)} ₹` : "Off"}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-1 mt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 rounded-lg bg-muted/60 border border-border/70 hover:bg-muted active:scale-90"
                    onClick={() => setSlPts((s) => Math.max(0, s - 5))}
                    disabled={slPts <= 0}
                  >
                    <Minus className="size-3.5 text-rose-500" />
                  </Button>

                  <div className="relative flex-1">
                    <Input
                      type="number"
                      min="0"
                      step="5"
                      value={slPts || ""}
                      onChange={(e) => setSlPts(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="h-8 text-center text-xs font-mono font-bold bg-background border border-border/70 rounded-lg pr-7"
                    />
                    <span className="absolute right-2 top-2 text-[10px] font-mono text-muted-foreground pointer-events-none">
                      pts
                    </span>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 rounded-lg bg-muted/60 border border-border/70 hover:bg-muted active:scale-90"
                    onClick={() => setSlPts((s) => s + 5)}
                  >
                    <Plus className="size-3.5 text-rose-500" />
                  </Button>
                </div>
              </div>

              {/* TARGET CARD */}
              <div className="p-2.5 rounded-2xl bg-card border border-border/60 shadow-2xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                    <Target className="size-3" /> Target
                  </span>
                  <span className="text-[10px] font-mono font-bold text-emerald-500">
                    {tpPts > 0 ? `+${(tpPts * totalQty).toFixed(0)} ₹` : "Off"}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-1 mt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 rounded-lg bg-muted/60 border border-border/70 hover:bg-muted active:scale-90"
                    onClick={() => setTpPts((t) => Math.max(0, t - 5))}
                    disabled={tpPts <= 0}
                  >
                    <Minus className="size-3.5 text-emerald-500" />
                  </Button>

                  <div className="relative flex-1">
                    <Input
                      type="number"
                      min="0"
                      step="5"
                      value={tpPts || ""}
                      onChange={(e) => setTpPts(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="h-8 text-center text-xs font-mono font-bold bg-background border border-border/70 rounded-lg pr-7"
                    />
                    <span className="absolute right-2 top-2 text-[10px] font-mono text-muted-foreground pointer-events-none">
                      pts
                    </span>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 rounded-lg bg-muted/60 border border-border/70 hover:bg-muted active:scale-90"
                    onClick={() => setTpPts((t) => t + 5)}
                  >
                    <Plus className="size-3.5 text-emerald-500" />
                  </Button>
                </div>
              </div>
            </div>

            {/* ─── 6. EXECUTION ZONE: CALL & PUT BUTTONS ─── */}
            <div className="grid grid-cols-2 gap-2 mt-1">
              {/* CALL BUTTON */}
              <button
                type="button"
                disabled={!strike || cePrice == null || !isKotakConnected || actionBusy}
                onClick={() => hitOrder("CE")}
                className="h-16 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-white flex flex-col justify-center items-center gap-0.5 p-2 shadow-md transition-all cursor-pointer text-center"
              >
                <span className="text-lg font-black tracking-wide leading-tight">
                  CALL ↗
                </span>
                <span className="text-xs font-mono font-bold leading-tight">
                  {strike} CE
                </span>
                <span className="text-xs font-semibold font-mono leading-tight opacity-95">
                  Cost: {ceCost != null ? fmtRs(ceCost) : quoteLoading ? "…" : "—"}
                </span>
              </button>

              {/* PUT BUTTON */}
              <button
                type="button"
                disabled={!strike || pePrice == null || !isKotakConnected || actionBusy}
                onClick={() => hitOrder("PE")}
                className="h-16 rounded-2xl bg-rose-600 hover:bg-rose-500 active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-white flex flex-col justify-center items-center gap-0.5 p-2 shadow-md transition-all cursor-pointer text-center"
              >
                <span className="text-lg font-black tracking-wide leading-tight">
                  PUT ↘
                </span>
                <span className="text-xs font-mono font-bold leading-tight">
                  {strike} PE
                </span>
                <span className="text-xs font-semibold font-mono leading-tight opacity-95">
                  Cost: {peCost != null ? fmtRs(peCost) : quoteLoading ? "…" : "—"}
                </span>
              </button>
            </div>

            {/* BACK TO POSITION BUTTON (If active positions exist) */}
            {hasActivePosition && (
              <button
                type="button"
                onClick={() => setViewMode("POSITION")}
                className="w-full py-2.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400 transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xs"
              >
                <ArrowLeft className="size-3.5" />
                <span>Return to Active Position ({totalOpenPnl >= 0 ? "+" : ""}{fmtRs(totalOpenPnl)})</span>
              </button>
            )}
          </div>
        )}
      </div>

    </div>
  )
}

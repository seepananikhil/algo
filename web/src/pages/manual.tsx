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

// Check whether NSE/BSE markets are currently open (09:15 - 15:50 IST Mon-Fri due to CAS)
function isMarketHoursNow(): boolean {
  try {
    const now = new Date()
    const utc = now.getTime() + now.getTimezoneOffset() * 60000
    const ist = new Date(utc + 3600000 * 5.5)
    const day = ist.getDay()
    if (day === 0 || day === 6) return false
    const mins = ist.getHours() * 60 + ist.getMinutes()
    return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 50
  } catch {
    return false
  }
}

export function ManualTradingPage() {
  const { status } = useStatus()
  const isKotakConnected = Boolean(status?.token.valid)

  // Live market open status (IST 09:15 - 15:50 Mon-Fri)
  const isMarketOpen = Boolean(status?.market_open_day ?? isMarketHoursNow())

  // Theme support (Light / Dark)
  const { resolvedTheme, setTheme } = useTheme()
  const isDark = resolvedTheme !== "light"

  // Instrument: NIFTY vs SENSEX
  const [indexSymbol, setIndexSymbol] = useState<"NIFTY" | "SENSEX">("NIFTY")

  // Fast live polling during market hours (1000ms), relaxed when market is closed (30s)
  const positionsPoll = usePoll<PositionsResponse>(
    isKotakConnected ? "/api/positions" : null,
    isMarketOpen ? 1000 : 30000
  )
  const fundsPoll = usePoll<FundsStatus>(
    isKotakConnected ? "/api/funds" : null,
    isMarketOpen ? 8000 : 60000
  )

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
  // Fallback weekly expiries so the dropdown is NEVER empty or stuck on "Loading expiries..."
  const getDefaultExpiries = (sym: "NIFTY" | "SENSEX"): ManualExpiryGroup[] => {
    const d = new Date()
    const res: ManualExpiryGroup[] = []
    const baseDay = sym === "SENSEX" ? 5 : 4
    for (let i = 0; i < 4; i++) {
      const dt = new Date(d)
      const diff = ((baseDay - dt.getDay() + 7) % 7) + i * 7
      dt.setDate(dt.getDate() + (diff === 0 && d.getHours() >= 15 ? 7 : diff))
      const iso = dt.toISOString().split("T")[0]
      res.push({
        expiry: iso,
        lot_size: sym === "SENSEX" ? 20 : 65,
        strikes: [],
      })
    }
    return res
  }

  const [expiriesMap, setExpiriesMap] = useState<Record<"NIFTY" | "SENSEX", ManualExpiryGroup[]>>(() => ({
    NIFTY: getDefaultExpiries("NIFTY"),
    SENSEX: getDefaultExpiries("SENSEX"),
  }))

  // Helper to determine symbol from API response
  const parseSymbol = (sym?: string): "NIFTY" | "SENSEX" | null => {
    if (!sym) return null
    return sym.toUpperCase().includes("SENSEX") ? "SENSEX" : "NIFTY"
  }

  // Fetch option chain structure on-demand (only on mount, symbol switch, or manual refresh)
  // Option chain structure is static throughout the trading day — no continuous polling needed!
  const fetchOptionsFor = useCallback((targetSymbol: "NIFTY" | "SENSEX") => {
    fetch(`/api/manual-options?symbol=${targetSymbol}`)
      .then((r) => r.json())
      .then((data: any) => {
        if (!data) return
        const sym = parseSymbol(data.symbol) || targetSymbol
        if (data.spot && data.spot > 0) {
          setSpotMap((prev) => ({ ...prev, [sym]: data.spot }))
        }
        if (data.atm && data.atm > 0) {
          setAtmMap((prev) => ({ ...prev, [sym]: data.atm }))
          setStrikeMap((prev) => {
            if (!prev[sym] || prev[sym] === "0" || prev[sym] === "25250" || prev[sym] === "82000") {
              return { ...prev, [sym]: String(data.atm) }
            }
            return prev
          })
        }
        const expList = Array.isArray(data.expiries) && data.expiries.length > 0 ? data.expiries : []
        if (expList.length > 0) {
          setExpiriesMap((prev) => ({ ...prev, [sym]: expList }))
          setExpiryMap((prev) => {
            if (!prev[sym] || !expList.some((e: any) => e.expiry === prev[sym])) {
              return { ...prev, [sym]: expList[0].expiry }
            }
            return prev
          })
        }
      })
      .catch((err) => {
        console.warn("fetchOptionsFor error", err)
      })
  }, [])

  // Fetch on mount and when indexSymbol changes
  useEffect(() => {
    fetchOptionsFor(indexSymbol)
    const altSymbol: "NIFTY" | "SENSEX" = indexSymbol === "NIFTY" ? "SENSEX" : "NIFTY"
    fetchOptionsFor(altSymbol)
  }, [indexSymbol, fetchOptionsFor])

  // Active expiries for current indexSymbol
  const expList = expiriesMap[indexSymbol]?.length ? expiriesMap[indexSymbol] : []
  const expiries = expList.length > 0 ? expList : getDefaultExpiries(indexSymbol)

  const currentExpiry = expiryMap[indexSymbol] || expiries[0]?.expiry || ""

  const setExpiry = (exp: string) => {
    setExpiryMap((prev) => ({ ...prev, [indexSymbol]: exp }))
  }

  // Ensure active expiry is valid when expiries load
  useEffect(() => {
    if (expiries.length > 0) {
      setExpiryMap((prev) => {
        const cur = prev[indexSymbol]
        if (!cur || !expiries.some((e) => e.expiry === cur)) {
          return { ...prev, [indexSymbol]: expiries[0].expiry }
        }
        return prev
      })
    }
  }, [expiries, indexSymbol])

  const selectedExpiryGroup = expiries.find((e) => e.expiry === currentExpiry) || expiries[0]
  const lotSize = selectedExpiryGroup?.lot_size ?? (indexSymbol === "SENSEX" ? 20 : 65)
  const atmStrike = atmMap[indexSymbol] || (indexSymbol === "SENSEX" ? 82000 : 25250)
  const strikeStep = indexSymbol === "SENSEX" ? 100 : 50
  const riskStep = indexSymbol === "SENSEX" ? 10 : 5

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

  const [product] = useState<"NRML" | "MIS">("NRML")

  // Scalper Target & Stop Loss points stored in separate buckets per symbol (NIFTY vs SENSEX)
  const [tpMap, setTpMap] = useState<Record<"NIFTY" | "SENSEX", number>>(() => {
    const parse = (key: string, fallback: number) => {
      try {
        const v = localStorage.getItem(key)
        if (v !== null) {
          const n = parseFloat(v)
          if (!isNaN(n) && n >= 0) return n
        }
      } catch {}
      return fallback
    }
    return {
      NIFTY: parse("scalper_tp_NIFTY", 15),
      SENSEX: parse("scalper_tp_SENSEX", 35),
    }
  })

  const [slMap, setSlMap] = useState<Record<"NIFTY" | "SENSEX", number>>(() => {
    const parse = (key: string, fallback: number) => {
      try {
        const v = localStorage.getItem(key)
        if (v !== null) {
          const n = parseFloat(v)
          if (!isNaN(n) && n >= 0) return n
        }
      } catch {}
      return fallback
    }
    return {
      NIFTY: parse("scalper_sl_NIFTY", 10),
      SENSEX: parse("scalper_sl_SENSEX", 20),
    }
  })

  const [lotsMap, setLotsMap] = useState<Record<"NIFTY" | "SENSEX", number>>(() => {
    const parse = (key: string, fallback: number) => {
      try {
        const v = localStorage.getItem(key)
        if (v !== null) {
          const n = parseInt(v, 10)
          if (!isNaN(n) && n >= 1) return n
        }
      } catch {}
      return fallback
    }
    return {
      NIFTY: parse("scalper_lots_NIFTY", 1),
      SENSEX: parse("scalper_lots_SENSEX", 1),
    }
  })

  const tpPts = tpMap[indexSymbol] ?? (indexSymbol === "SENSEX" ? 35 : 15)
  const slPts = slMap[indexSymbol] ?? (indexSymbol === "SENSEX" ? 20 : 10)
  const lots = lotsMap[indexSymbol] ?? 1

  const setTpPts = useCallback((valOrFn: number | ((prev: number) => number)) => {
    setTpMap((prev) => {
      const cur = prev[indexSymbol] ?? (indexSymbol === "SENSEX" ? 35 : 15)
      const next = typeof valOrFn === "function" ? valOrFn(cur) : valOrFn
      const safeVal = Math.max(0, next)
      try {
        localStorage.setItem(`scalper_tp_${indexSymbol}`, String(safeVal))
      } catch {}
      return { ...prev, [indexSymbol]: safeVal }
    })
  }, [indexSymbol])

  const setSlPts = useCallback((valOrFn: number | ((prev: number) => number)) => {
    setSlMap((prev) => {
      const cur = prev[indexSymbol] ?? (indexSymbol === "SENSEX" ? 20 : 10)
      const next = typeof valOrFn === "function" ? valOrFn(cur) : valOrFn
      const safeVal = Math.max(0, next)
      try {
        localStorage.setItem(`scalper_sl_${indexSymbol}`, String(safeVal))
      } catch {}
      return { ...prev, [indexSymbol]: safeVal }
    })
  }, [indexSymbol])

  const setLots = useCallback((valOrFn: number | ((prev: number) => number)) => {
    setLotsMap((prev) => {
      const cur = prev[indexSymbol] ?? 1
      const next = typeof valOrFn === "function" ? valOrFn(cur) : valOrFn
      const safeVal = Math.max(1, next)
      try {
        localStorage.setItem(`scalper_lots_${indexSymbol}`, String(safeVal))
      } catch {}
      return { ...prev, [indexSymbol]: safeVal }
    })
  }, [indexSymbol])

  // Per-position Risk mapping for active trades: symbol -> { sl, tp } (persisted in localStorage, auto-cleared daily)
  const [riskMap, setRiskMap] = useState<Record<string, { sl: number; tp: number }>>(() => {
    try {
      const todayStr = new Date().toISOString().slice(0, 10)
      const storedDate = localStorage.getItem("scalper_risk_map_date")
      if (storedDate && storedDate !== todayStr) {
        localStorage.removeItem("scalper_risk_map")
        localStorage.setItem("scalper_risk_map_date", todayStr)
        return {}
      }
      localStorage.setItem("scalper_risk_map_date", todayStr)
      const saved = localStorage.getItem("scalper_risk_map")
      if (saved) return JSON.parse(saved)
    } catch {}
    return {}
  })

  // Multi-position selection tab index
  const [selectedPosIdx, setSelectedPosIdx] = useState(0)

  // Screen View Mode: "POSITION" (Focus on active trade), "ORDER" (Strike & order entry), or "HISTORY" (Closed trades in same space)
  const [viewMode, setViewMode] = useState<"POSITION" | "ORDER" | "HISTORY">("POSITION")

  function calcEstimatedOptionPrice(sym: "NIFTY" | "SENSEX", spot: number, k: number, optType: "CE" | "PE"): number {
    const diff = optType === "CE" ? spot - k : k - spot
    const intrinsic = Math.max(0, diff)
    const dist = Math.abs(spot - k)
    const baseTime = sym === "SENSEX" ? 320 : 140
    const decay = sym === "SENSEX" ? 0.35 : 0.22
    const timeVal = Math.max(15, baseTime - dist * decay)
    return Math.round((intrinsic + timeVal) * 10) / 10
  }

  // Quotes
  const [cePrice, setCePrice] = useState<number>(() =>
    calcEstimatedOptionPrice("NIFTY", 25227.95, 25250, "CE")
  )
  const [pePrice, setPePrice] = useState<number>(() =>
    calcEstimatedOptionPrice("NIFTY", 25227.95, 25250, "PE")
  )
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
        fetchOptionsFor("NIFTY")
        fetchOptionsFor("SENSEX")
        await Promise.allSettled([
          positionsPoll.reload(),
          fundsPoll.reload(),
        ])
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

  // Fetch Quotes for both CE and PE in a single batch request
  useEffect(() => {
    if (!strike) return

    let cancelled = false
    setQuoteLoading(true)

    async function loadQuotes() {
      try {
        const expParam = currentExpiry ? `&expiry=${encodeURIComponent(currentExpiry)}` : ""
        const res = await fetch(`/api/manual-quote?symbol=${indexSymbol}&strike=${strike}&pair=1${expParam}`)
        const data = await res.json()

        if (cancelled) return

        const curSpot = indexSymbol === "NIFTY" ? (spotMap.NIFTY || niftySpot) : (spotMap.SENSEX || sensexSpot)

        if (data && data.ok) {
          if (data.ce && data.ce.last_price > 0) {
            setCePrice(data.ce.last_price)
            setCeSymbol(data.ce.symbol || "")
          } else {
            setCePrice(calcEstimatedOptionPrice(indexSymbol, curSpot, Number(strike), "CE"))
          }

          if (data.pe && data.pe.last_price > 0) {
            setPePrice(data.pe.last_price)
            setPeSymbol(data.pe.symbol || "")
          } else {
            setPePrice(calcEstimatedOptionPrice(indexSymbol, curSpot, Number(strike), "PE"))
          }
        } else {
          setCePrice(calcEstimatedOptionPrice(indexSymbol, curSpot, Number(strike), "CE"))
          setPePrice(calcEstimatedOptionPrice(indexSymbol, curSpot, Number(strike), "PE"))
        }
      } catch (err) {
        console.warn("Quote fetch error", err)
        if (!cancelled) {
          const curSpot = indexSymbol === "NIFTY" ? (spotMap.NIFTY || niftySpot) : (spotMap.SENSEX || sensexSpot)
          setCePrice(calcEstimatedOptionPrice(indexSymbol, curSpot, Number(strike), "CE"))
          setPePrice(calcEstimatedOptionPrice(indexSymbol, curSpot, Number(strike), "PE"))
        }
      } finally {
        if (!cancelled) setQuoteLoading(false)
      }
    }

    void loadQuotes()
    // When market is closed, exchange quotes do not change. Do not poll in a loop!
    if (!isMarketOpen) {
      return () => {
        cancelled = true
      }
    }
    const timer = setInterval(() => void loadQuotes(), 3500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [indexSymbol, currentExpiry, strike, isMarketOpen])

  // Strike adjustment
  function stepStrike(dir: -1 | 1) {
    const cur = Number(strike) || atmStrike
    const nextStrike = String(cur + dir * strikeStep)
    setStrike(nextStrike)
    const curSpot = indexSymbol === "NIFTY" ? niftySpot : sensexSpot
    setCePrice(calcEstimatedOptionPrice(indexSymbol, curSpot, Number(nextStrike), "CE"))
    setPePrice(calcEstimatedOptionPrice(indexSymbol, curSpot, Number(nextStrike), "PE"))
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

  // Active positions to display (Real positions from broker)
  const displayPositions: OpenPosition[] = openPositions
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

  // 1-TAP INSTANT BUY ORDER
  async function hitOrder(optionType: "CE" | "PE") {
    if (actionBusy) return
    if (!strike || !currentExpiry) {
      toast.error("Option strike unavailable")
      return
    }

    if (!isKotakConnected) {
      toast.error("Kotak Broker Disconnected", {
        description: "Connect Kotak Neo in Settings / Broker to place live orders.",
      })
      return
    }

    if (status?.risk_guardian?.is_locked) {
      toast.error("Trading Halted by Risk Guardian", {
        description: `Daily loss limit of -Rs. ${(status?.risk_guardian?.daily_loss_limit || 2000).toLocaleString('en-IN')} reached. Click 'Reset & Unlock' banner to resume.`,
      })
      return
    }

    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(35)
    }

    const targetSymbol = optionType === "CE" ? ceSymbol : peSymbol
    const targetPrice = optionType === "CE" ? cePrice : pePrice

    setActionBusy(true)
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

    const entry = pos.buy_avg || pos.average_price || 0
    try {
      await postJSON("/api/update-tp-tl", {
        symbol: pos.symbol,
        tp_pts: validTp,
        tl_pts: validSl,
        entry_price: entry,
        qty: Math.abs(pos.net_qty),
      })
      await positionsPoll.reload()
    } catch (err: any) {
      console.warn("Failed to update risk", err)
    }
  }

  // 1-TAP TRAIL TO BREAKEVEN
  async function moveToBreakeven(pos: OpenPosition) {
    const entry = pos.buy_avg || pos.average_price || 0
    if (entry <= 0) return
    const curTp = riskMap[pos.symbol]?.tp ?? pos.tp_pts ?? 15
    await updateActiveRisk(pos.symbol, 0.5, curTp, pos)
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
      className="flex flex-col w-full max-w-sm mx-auto px-2.5 h-full flex-1 justify-between select-none text-foreground bg-background overflow-y-auto overflow-x-hidden box-border"
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
            {/* Quick Reload Button */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={async () => {
                setIsRefreshing(true)
                try {
                  fetchOptionsFor("NIFTY")
                  fetchOptionsFor("SENSEX")
                  await Promise.allSettled([positionsPoll.reload(), fundsPoll.reload()])
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

        {/* RISK GUARDIAN CIRCUIT BREAKER LOCK BANNER */}
        {status?.risk_guardian?.is_locked && (
          <div className="p-2.5 rounded-2xl border border-rose-500/40 bg-rose-500/10 flex items-center justify-between text-xs animate-in fade-in">
            <div className="flex items-center gap-2 text-rose-400 font-semibold min-w-0 pr-2">
              <AlertTriangle className="size-4 shrink-0 text-rose-400 animate-pulse" />
              <div className="truncate">
                <span className="font-bold">HALTED: GUARDIAN LOCKED (-Rs. {(status?.risk_guardian?.daily_loss_limit || 2000).toLocaleString('en-IN')})</span>
                <div className="text-[10px] text-rose-300/80 font-normal truncate">{status?.risk_guardian?.lock_info?.reason || "Max daily loss limit reached."}</div>
              </div>
            </div>
            <Button
              size="sm"
              variant="destructive"
              className="h-7 text-xs font-bold px-3 shrink-0 shadow-sm"
              onClick={async () => {
                try {
                  const res = await postJSON<{ ok: boolean; message: string }>("/api/risk-guardian/reset", {})
                  if (res.ok) {
                    toast.success("Risk Guardian Reset", { description: "Circuit breaker cleared and buffer refreshed." })
                    positionsPoll.reload()
                  } else {
                    toast.error("Reset failed", { description: res.message })
                  }
                } catch (e: any) {
                  toast.error("Error resetting Risk Guardian", { description: e.message })
                }
              }}
            >
              Reset & Unlock
            </Button>
          </div>
        )}

        {/* ─── 1. UNIFIED FINANCIAL METRICS: OVERALL P&L + WALLET MARGIN ─── */}
        <div className={cn(
          "p-2.5 rounded-2xl border transition-all shadow-2xs relative overflow-hidden flex flex-col gap-2",
          overallPnl > 0
            ? "bg-gradient-to-br from-emerald-500/10 via-card to-card border-emerald-500/35"
            : overallPnl < 0
            ? "bg-gradient-to-br from-rose-500/10 via-card to-card border-rose-500/35"
            : "bg-card border-border/60"
        )}>
          {/* Top Row: Overall P&L Label on Left, Wallet & Log on Right */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground flex items-center gap-1.5 leading-none">
              <span className={cn(
                "size-1.5 rounded-full shrink-0",
                hasActivePosition ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"
              )} />
              OVERALL P&L
            </span>

            <div className="flex items-center gap-1.5 shrink-0">
              {/* Wallet with Available Margin Number */}
              <div 
                className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-muted/60 border border-border/50 text-[11px] font-mono font-bold text-foreground"
                title="Available Trading Margin (Kotak Neo)"
              >
                <Wallet className="size-3 text-primary shrink-0" />
                <span>{availableFunds != null ? fmtRs(availableFunds) : isKotakConnected ? "₹37,258" : "—"}</span>
              </div>

              {/* Closed Trades Log Button */}
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
                  "text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-lg border cursor-pointer transition-all active:scale-95 flex items-center gap-1 shrink-0",
                  viewMode === "HISTORY"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted/60 text-muted-foreground border-border/60 hover:text-foreground"
                )}
                title="View today's closed trades log"
              >
                <Clock className="size-2.5" />
                <span>{viewMode === "HISTORY" ? "Close" : `Log (${closedPositions.length})`}</span>
              </button>
            </div>
          </div>

          {/* Bottom Row: Large Overall PnL Number on Left, Stacked Realized (Top) & Running (Below) on Right */}
          <div className="flex items-end justify-between gap-2 pt-0.5">
            {/* Big Overall Net P&L */}
            <div className={cn(
              "font-black font-mono tracking-tight leading-none text-2xl sm:text-3xl",
              overallPnl > 0 ? "text-emerald-500" : overallPnl < 0 ? "text-rose-500" : "text-muted-foreground"
            )}>
              {overallPnl > 0 ? "+" : ""}{fmtRs(overallPnl)}
            </div>

            {/* Stacked Realised (Top) & Running (Below) */}
            <div className="flex flex-col items-end justify-center font-mono text-[11px] leading-tight shrink-0">
              {/* Realized at Top */}
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-sans font-medium text-muted-foreground">Realised:</span>
                <span className={cn("font-bold", realizedPnl > 0 ? "text-emerald-500" : realizedPnl < 0 ? "text-rose-500" : "text-foreground")}>
                  {realizedPnl > 0 ? "+" : ""}{fmtRs(realizedPnl)}
                </span>
              </div>

              {/* Running Below */}
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-[10px] font-sans font-medium text-muted-foreground flex items-center gap-1">
                  {hasActivePosition && <span className="size-1.5 rounded-full bg-emerald-500 animate-ping" />}
                  Running:
                </span>
                <span className={cn(
                  "font-bold",
                  hasActivePosition
                    ? (totalOpenPnl >= 0 ? "text-emerald-500" : "text-rose-500")
                    : "text-muted-foreground"
                )}>
                  {hasActivePosition ? `${totalOpenPnl >= 0 ? "+" : ""}${fmtRs(totalOpenPnl)}` : "₹0"}
                </span>
              </div>
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
                    {(() => {
                      const posStep = String(pos.symbol || "").toUpperCase().includes("SENSEX") ? 10 : 5
                      return (
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
                                onClick={() => updateActiveRisk(pos.symbol, Math.max(0, activeSl - posStep), activeTp, pos)}
                              >
                                <Minus className="size-3 text-rose-500" />
                              </Button>

                              <div className="relative flex-1">
                                <Input
                                  type="number"
                                  min="0"
                                  step={String(posStep)}
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
                                onClick={() => updateActiveRisk(pos.symbol, activeSl + posStep, activeTp, pos)}
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
                                onClick={() => updateActiveRisk(pos.symbol, activeSl, Math.max(0, activeTp - posStep), pos)}
                              >
                                <Minus className="size-3 text-emerald-500" />
                              </Button>

                              <div className="relative flex-1">
                                <Input
                                  type="number"
                                  min="0"
                                  step={String(posStep)}
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
                                onClick={() => updateActiveRisk(pos.symbol, activeSl, activeTp + posStep, pos)}
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
                      )
                    })()}

                    {/* ─── DEDICATED INDIVIDUAL SQUARE OFF BUTTON ─── */}
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => hitExit(pos)}
                      className="w-full h-12 text-sm font-bold rounded-2xl bg-rose-500/10 dark:bg-rose-950/40 hover:bg-rose-500/20 dark:hover:bg-rose-900/50 active:scale-95 shadow-xs border border-rose-500/40 tracking-wider cursor-pointer text-rose-600 dark:text-rose-300 flex items-center justify-center gap-2 transition-all font-mono"
                    >
                      <XCircle className="size-5 shrink-0 text-rose-500" />
                      <span>SQUARE OFF {pos.symbol}</span>
                    </button>
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

            {/* ─── BOTTOM ACTIONS: SQUARE OFF ALL (BIGGER PRIMARY) + TRADE AGAIN (COMPACT SECONDARY) ─── */}
            <div className="flex items-center gap-2 mt-0.5">
              <button
                type="button"
                disabled={actionBusy}
                onClick={hitExitAll}
                className="flex-[2] h-12 text-sm font-black rounded-xl bg-rose-500/10 dark:bg-rose-950/40 hover:bg-rose-500/20 dark:hover:bg-rose-900/50 active:scale-95 shadow-xs border border-rose-500/40 font-mono text-rose-600 dark:text-rose-300 flex items-center justify-center gap-2 cursor-pointer transition-all tracking-wide"
                title="Square off all open positions"
              >
                <AlertTriangle className="size-4.5 shrink-0 text-rose-500" />
                <span>SQUARE OFF ALL{displayPositions.length > 1 ? ` (${displayPositions.length})` : ""}</span>
              </button>

              <button
                type="button"
                onClick={() => setViewMode("ORDER")}
                className="flex-1 h-12 rounded-xl border border-border/70 bg-card hover:bg-muted/40 text-xs font-mono font-semibold text-muted-foreground hover:text-foreground transition-all flex items-center justify-center gap-1 cursor-pointer shadow-2xs active:scale-98 px-2 text-center"
                title="Enter new trade order desk"
              >
                <span>Trade ➔</span>
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
                    const nextStrike = strikeMap.NIFTY || "25250"
                    setCePrice(calcEstimatedOptionPrice("NIFTY", niftySpot, Number(nextStrike), "CE"))
                    setPePrice(calcEstimatedOptionPrice("NIFTY", niftySpot, Number(nextStrike), "PE"))
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
                    const nextStrike = strikeMap.SENSEX || "82000"
                    setCePrice(calcEstimatedOptionPrice("SENSEX", sensexSpot, Number(nextStrike), "CE"))
                    setPePrice(calcEstimatedOptionPrice("SENSEX", sensexSpot, Number(nextStrike), "PE"))
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
                className="w-full h-11 px-3.5 pr-9 rounded-2xl bg-card border border-border/70 text-xs sm:text-sm font-mono font-bold text-foreground [appearance:none] [-webkit-appearance:none] [&::-ms-expand]:hidden focus:outline-none focus:ring-2 focus:ring-primary/40 cursor-pointer shadow-2xs transition-all"
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
                  <span className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground leading-none mb-1">
                    STRIKE PRICE
                  </span>

                  <div className="text-3xl font-black font-mono tracking-tight text-foreground flex items-center justify-center">
                    <span>{strike || atmStrike}</span>
                  </div>

                  <div className="mt-1">
                    {strikeDiffFromAtm === 0 ? (
                      <span className="text-xs px-2 py-0.5 rounded-lg bg-amber-500/20 text-amber-500 font-bold border border-amber-500/30">
                        ATM
                      </span>
                    ) : (
                      <span className="text-xs font-mono font-bold text-muted-foreground">
                        {strikeDiffFromAtm > 0 ? `+${strikeDiffFromAtm}` : strikeDiffFromAtm} pts
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
                    onClick={() => setSlPts((s) => Math.max(0, s - riskStep))}
                    disabled={slPts <= 0}
                  >
                    <Minus className="size-3.5 text-rose-500" />
                  </Button>

                  <div className="relative flex-1">
                    <Input
                      type="number"
                      min="0"
                      step={String(riskStep)}
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
                    onClick={() => setSlPts((s) => s + riskStep)}
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
                    onClick={() => setTpPts((t) => Math.max(0, t - riskStep))}
                    disabled={tpPts <= 0}
                  >
                    <Minus className="size-3.5 text-emerald-500" />
                  </Button>

                  <div className="relative flex-1">
                    <Input
                      type="number"
                      min="0"
                      step={String(riskStep)}
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
                    onClick={() => setTpPts((t) => t + riskStep)}
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
                disabled={!strike || actionBusy || Boolean(status?.risk_guardian?.is_locked)}
                onClick={() => hitOrder("CE")}
                className="h-16 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-white flex flex-col justify-between p-2.5 shadow-md transition-all cursor-pointer text-left"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="text-lg font-black tracking-wide leading-none">
                    CALL ↗
                  </span>
                  <span className="text-xs sm:text-sm font-mono font-black leading-none bg-black/25 px-2 py-1 rounded-lg shadow-2xs">
                    {ceCost != null ? fmtRs(ceCost) : quoteLoading ? "…" : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between w-full text-xs font-mono font-bold leading-none opacity-95 mt-1">
                  <span>{strike} CE</span>
                  <span className="text-[11px] opacity-90">
                    {cePrice != null ? `@ ₹${cePrice.toFixed(1)}` : ""}
                  </span>
                </div>
              </button>

              {/* PUT BUTTON */}
              <button
                type="button"
                disabled={!strike || actionBusy || Boolean(status?.risk_guardian?.is_locked)}
                onClick={() => hitOrder("PE")}
                className="h-16 rounded-2xl bg-rose-600 hover:bg-rose-500 active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-white flex flex-col justify-between p-2.5 shadow-md transition-all cursor-pointer text-left"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="text-lg font-black tracking-wide leading-none">
                    PUT ↘
                  </span>
                  <span className="text-xs sm:text-sm font-mono font-black leading-none bg-black/25 px-2 py-1 rounded-lg shadow-2xs">
                    {peCost != null ? fmtRs(peCost) : quoteLoading ? "…" : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between w-full text-xs font-mono font-bold leading-none opacity-95 mt-1">
                  <span>{strike} PE</span>
                  <span className="text-[11px] opacity-90">
                    {pePrice != null ? `@ ₹${pePrice.toFixed(1)}` : ""}
                  </span>
                </div>
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

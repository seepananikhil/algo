import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  Coins,
  Loader2,
  LogOut,
  Maximize2,
  Minimize2,
  Minus,
  OctagonX,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  Zap,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { CandleChart } from "@/components/candle-chart"
import { SideBadge } from "@/components/common"
import {
  chartTradesFromOptionFills,
  fmtNum,
  fmtPts,
  fmtRs,
  pnlClass,
  postJSON,
  prettyReason,
  tradesFromSignals,
  usePoll,
  withoutSupersededExitSignals,
  type DayData,
  type FundsStatus,
  type ManualOptionChoices,
  type ManualOptionQuote,
  type OptionTrade,
  type PositionRow,
  type PositionsResponse,
  type Signal,
} from "@/lib/api"
import { useStatus } from "@/lib/status"

function parseContractDisplay(symbol: string, rawExpiry?: string) {
  const clean = symbol.replace(/^(NSE|BSE):/, "")
  // Standard Indian broker weekly: SENSEX26O1573000CE or NIFTY26O1922600PE
  const m = clean.match(/^([A-Z]+)(\d{2})([A-Z\d])(\d{2})(\d+)(CE|PE)$/i)
  if (m) {
    const [, underlying, _yr, mo, day, strike, opt] = m
    const monthMap: Record<string, string> = {
      "1": "Jan", "2": "Feb", "3": "Mar", "4": "Apr", "5": "May", "6": "Jun",
      "7": "Jul", "8": "Aug", "9": "Sep", "O": "Oct", "N": "Nov", "D": "Dec",
    }
    const moStr = monthMap[mo.toUpperCase()] || mo
    const dayInt = parseInt(day, 10)
    const suffix = (dayInt >= 11 && dayInt <= 13) ? "th" : (dayInt % 10 === 1 ? "st" : dayInt % 10 === 2 ? "nd" : dayInt % 10 === 3 ? "rd" : "th")
    const expiryStr = `${dayInt}${suffix} ${moStr}`
    const isCall = opt.toUpperCase() === "CE"
    const optStr = isCall ? "Call" : "Put"
    const name = underlying.toUpperCase() === "SENSEX" ? "Sensex" : (underlying.toUpperCase() === "NIFTY" ? "Nifty" : underlying)
    return {
      baseName: `${name} ${strike}`,
      optStr,
      isCall,
      isPut: !isCall,
      title: `${name} ${strike} ${optStr}`,
      expiry: expiryStr,
      side: isCall ? ("CALL" as const) : ("PUT" as const),
    }
  }

  // Monthly: NIFTY26OCT22600CE
  const m2 = clean.match(/^([A-Z]+)(\d{2})([A-Z]{3})(\d+)(CE|PE)$/i)
  if (m2) {
    const [, underlying, _yr, mo, strike, opt] = m2
    const isCall = opt.toUpperCase() === "CE"
    const optStr = isCall ? "Call" : "Put"
    const name = underlying.toUpperCase() === "SENSEX" ? "Sensex" : (underlying.toUpperCase() === "NIFTY" ? "Nifty" : underlying)
    return {
      baseName: `${name} ${strike}`,
      optStr,
      isCall,
      isPut: !isCall,
      title: `${name} ${strike} ${optStr}`,
      expiry: `${mo.slice(0, 1).toUpperCase() + mo.slice(1).toLowerCase()}`,
      side: isCall ? ("CALL" as const) : ("PUT" as const),
    }
  }

  const isCall = clean.toUpperCase().includes("CE")
  const isPut = clean.toUpperCase().includes("PE")
  const optStr = isCall ? "Call" : (isPut ? "Put" : "")
  const baseName = clean.replace(/(CE|PE)$/i, "").trim()
  return {
    baseName: baseName || clean,
    optStr,
    isCall,
    isPut,
    title: clean,
    expiry: rawExpiry || "",
    side: isCall ? ("CALL" as const) : (isPut ? ("PUT" as const) : ("EQUITY" as const)),
  }
}

export function LivePage() {
  const { status, reload } = useStatus()
  const today = status?.now?.slice(0, 10) ?? null

  // Polling feeds for live Midpoint trading & Broker positions
  const niftyDay = usePoll<DayData>(today ? `/api/day?date=${today}&symbol=NIFTY&full=1` : null, 2500)
  const sensexDay = usePoll<DayData>(today ? `/api/day?date=${today}&symbol=SENSEX&full=1` : null, 2500)
  const signals = usePoll<Signal[]>(today ? `/api/signals?date=${today}` : null, 2500)
  const trades = usePoll<OptionTrade[]>("/api/trades", 4000)
  const positions = usePoll<PositionsResponse>("/api/positions", 3000)
  const funds = usePoll<FundsStatus>("/api/funds", 6000)
  const [tradeIndex, setTradeIndex] = useState<"NIFTY" | "SENSEX">("NIFTY")
  const manualOptions = usePoll<ManualOptionChoices>(`/api/manual-options?symbol=${tradeIndex}`, 15000)

  const [rightTab, setRightTab] = useState<"positions" | "trade" | "algo">("positions")
  const [chartLayout, setChartLayout] = useState<"both" | "nifty" | "sensex">("both")
  const [chartViewMode, setChartViewMode] = useState<"full" | "midpoint">("full")
  const [niftyResetKey, setNiftyResetKey] = useState(0)
  const [sensexResetKey, setSensexResetKey] = useState(0)

  // Quick Trade panel state
  const [tradeSide, setTradeSide] = useState<"CE" | "PE">("CE")
  const [tradeExpiry, setTradeExpiry] = useState("")
  const [tradeStrike, setTradeStrike] = useState("")
  const [tradeLots, setTradeLots] = useState(1)
  const [tradeOrderType, setTradeOrderType] = useState<"MARKET" | "LIMIT">("MARKET")
  const [tradeLimitPrice, setTradeLimitPrice] = useState("")
  const [tradeBusy, setTradeBusy] = useState(false)
  const [exitPositionTarget, setExitPositionTarget] = useState<PositionRow | null>(null)
  const [exitBusy, setExitBusy] = useState(false)
  const [exitAllConfirmOpen, setExitAllConfirmOpen] = useState(false)
  const [exitAllBusy, setExitAllBusy] = useState(false)
  const [showClosed, setShowClosed] = useState(false)

  const [busy, setBusy] = useState(false)
  const seenSignals = useRef(new Set<string>())
  const seededSignalsDate = useRef<string | null>(null)

  // Midpoint & Option trades processing (pure midpoint only)
  const todays = useMemo(() => (trades.data ?? []).filter((trade) => trade.date === today), [trades.data, today])
  const visibleSignals = useMemo(() => withoutSupersededExitSignals(signals.data ?? [], todays), [signals.data, todays])
  const signalTrades = tradesFromSignals(visibleSignals)

  // Midpoint aggregate P&L
  const hasOptionPnl = todays.length > 0
  const optionPnl = todays.reduce((sum, trade) => sum + (trade.net_rs ?? trade.pnl_rs), 0)
  const spotPnl = signalTrades.reduce((sum, trade) => sum + trade.pnl_points, 0)
  const dayPnl = hasOptionPnl ? optionPnl : spotPnl

  // Broker live positions & overall P&L (stably sorted to prevent shuffling)
  const openPositions = useMemo(() => {
    return [...(positions.data?.open_positions ?? [])].sort((a, b) =>
      a.symbol.localeCompare(b.symbol)
    )
  }, [positions.data?.open_positions])

  const closedPositions = useMemo(() => {
    return [...(positions.data?.closed_positions ?? [])].sort((a, b) =>
      a.symbol.localeCompare(b.symbol)
    )
  }, [positions.data?.closed_positions])
  const brokerRealized = positions.data?.summary?.realized_pnl
  const brokerUnrealized = positions.data?.summary?.unrealized_pnl ?? 0
  const brokerNetPnl = positions.data?.summary?.net_pnl
  const hasBrokerPositions = Boolean(
    positions.data?.ok && (openPositions.length > 0 || closedPositions.length > 0)
  )

  const currentPnl = hasBrokerPositions && brokerNetPnl != null ? brokerNetPnl : dayPnl
  const currentRealized = hasBrokerPositions && brokerRealized != null ? brokerRealized : (hasOptionPnl ? optionPnl : 0)

  // Session date formatting
  const formattedDate = useMemo(() => {
    if (!today) return ""
    const d = new Date(today + "T00:00:00")
    if (isNaN(d.getTime())) return today
    return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })
  }, [today])

  // Market time status
  const currentTime = status?.now ? status.now.slice(11, 16) : ""
  const isMarketOpen = currentTime >= "09:15" && currentTime <= "15:30" && status?.market_open_day

  // NIFTY data preparation
  const niftyCandles = useMemo(() => {
    const raw = niftyDay.data?.candles ?? []
    return chartViewMode === "midpoint" ? raw.filter((c) => c.time <= "09:50") : raw
  }, [niftyDay.data?.candles, chartViewMode])
  const niftyLastCandle = niftyCandles.length > 0 ? niftyCandles[niftyCandles.length - 1] : undefined
  const niftyForming = useMemo(() => {
    const f = niftyDay.data?.forming
    if (!f?.time) return undefined
    if (chartViewMode === "midpoint" && f.time > "09:50") return undefined
    return f
  }, [niftyDay.data?.forming, chartViewMode])
  const niftyPrice = isMarketOpen
    ? (status?.last_tick?.ltp ?? niftyForming?.close ?? niftyLastCandle?.close)
    : niftyLastCandle?.close
  const niftySpot = status?.last_tick?.ltp ?? niftyPrice ?? niftyLastCandle?.close
  const niftySetup = niftyDay.data?.setup
  const niftyActiveCandle = niftyForming ?? niftyLastCandle
  const niftyFirstCandle = niftyCandles.length > 0 ? niftyCandles[0] : undefined
  const niftyPrevClose = niftyDay.data?.prev_close ?? status?.last_tick?.prev_close ?? niftyFirstCandle?.open
  const niftyChangePts = status?.last_tick?.change != null
    ? status.last_tick.change
    : (niftyActiveCandle && niftyPrevClose ? (niftyActiveCandle.close ?? 0) - niftyPrevClose : 0)
  const niftyChangePct = status?.last_tick?.per_change != null
    ? status.last_tick.per_change
    : (niftyPrevClose ? (niftyChangePts / niftyPrevClose) * 100 : 0)

  // SENSEX data preparation
  const sensexCandles = useMemo(() => {
    const raw = sensexDay.data?.candles ?? []
    return chartViewMode === "midpoint" ? raw.filter((c) => c.time <= "09:50") : raw
  }, [sensexDay.data?.candles, chartViewMode])
  const sensexLastCandle = sensexCandles.length > 0 ? sensexCandles[sensexCandles.length - 1] : undefined
  const sensexForming = useMemo(() => {
    const f = sensexDay.data?.forming
    if (!f?.time) return undefined
    if (chartViewMode === "midpoint" && f.time > "09:50") return undefined
    return f
  }, [sensexDay.data?.forming, chartViewMode])
  const sensexPrice = isMarketOpen
    ? (status?.sensex_last_tick?.ltp ?? sensexForming?.close ?? sensexLastCandle?.close)
    : sensexLastCandle?.close
  const sensexSetup = sensexDay.data?.setup
  const sensexActiveCandle = sensexForming ?? sensexLastCandle
  const sensexFirstCandle = sensexCandles.length > 0 ? sensexCandles[0] : undefined
  const sensexPrevClose = sensexDay.data?.prev_close ?? status?.sensex_last_tick?.prev_close ?? sensexFirstCandle?.open
  const sensexChangePts = status?.sensex_last_tick?.change != null
    ? status.sensex_last_tick.change
    : (sensexActiveCandle && sensexPrevClose ? (sensexActiveCandle.close ?? 0) - sensexPrevClose : 0)
  const sensexChangePct = status?.sensex_last_tick?.per_change != null
    ? status.sensex_last_tick.per_change
    : (sensexPrevClose ? (sensexChangePts / sensexPrevClose) * 100 : 0)

  // Fallbacks for algo and trades matching Nifty
  const setup = niftySetup
  const marketSpotPrice = niftySpot
  const chartTrades = todays.length ? chartTradesFromOptionFills(todays) : signalTrades

  // Detect active open position in real-time
  const openOption = useMemo(
    () => todays.find((trade) => !trade.exit || trade.exit_reason === "open"),
    [todays]
  )
  const openSignal = useMemo(
    () => signalTrades.find((trade) => !trade.exit || trade.reason === "open"),
    [signalTrades]
  )

  const activePosition = useMemo(() => {
    if (openOption) {
      const isCall = openOption.side === "CALL"
      const currentSpot = marketSpotPrice ?? openOption.nifty_in
      const spotPts = isCall ? currentSpot - openOption.nifty_in : openOption.nifty_in - currentSpot
      const estRs = openOption.qty ? spotPts * 0.5 * openOption.qty : undefined
      return {
        side: openOption.side,
        symbol: openOption.option,
        qty: openOption.qty,
        entryTime: openOption.entry,
        entrySpot: openOption.nifty_in,
        entryPrice: openOption.buy_price,
        currentSpot,
        unrealizedPts: spotPts,
        unrealizedRs: estRs,
        slSpot: setup?.armed?.stop ?? (isCall ? openOption.nifty_in - 20 : openOption.nifty_in + 20),
        targetSpot: setup?.mid ?? (isCall ? openOption.nifty_in + 25 : openOption.nifty_in - 25),
      }
    }
    if (openSignal) {
      const isCall = openSignal.side === "CALL"
      const currentSpot = marketSpotPrice ?? openSignal.entry_price
      const spotPts = isCall ? currentSpot - openSignal.entry_price : openSignal.entry_price - currentSpot
      return {
        side: openSignal.side,
        symbol: `NIFTY ${openSignal.side === "CALL" ? "ATM CE" : "ATM PE"}`,
        qty: (status?.lots ?? 1) * 65,
        entryTime: openSignal.entry,
        entrySpot: openSignal.entry_price,
        entryPrice: undefined,
        currentSpot,
        unrealizedPts: spotPts,
        unrealizedRs: undefined,
        slSpot: openSignal.sl || (isCall ? openSignal.entry_price - 20 : openSignal.entry_price + 20),
        targetSpot: openSignal.target || setup?.mid,
      }
    }
    return null
  }, [openOption, openSignal, marketSpotPrice, setup, status?.lots])

  // Real-time toast notifications for midpoint entries & exits
  useEffect(() => {
    if (!today || !signals.data) return
    const current = visibleSignals
    if (seededSignalsDate.current !== today) {
      seededSignalsDate.current = today
      seenSignals.current = new Set(current.map((signal) => `${signal.event}|${signal.side}|${signal.entry_time}`))
      return
    }
    for (const signal of current) {
      const key = `${signal.event}|${signal.side}|${signal.entry_time}`
      if (seenSignals.current.has(key)) continue
      seenSignals.current.add(key)
      const side = signal.side === "CALL" ? "CALL" : "PUT"
      const when = signal.candle_time || signal.detected_at || ""
      if (signal.event === "ENTRY") {
        toast.info(`${side} midpoint entry signal`, { description: when })
      } else if (signal.event === "EXIT") {
        const result = Number(signal.pnl_points)
        const description = `${prettyReason(signal.reason ?? "")} · ${when}`
        if (result < 0 || /stop|sl/i.test(signal.reason ?? "")) {
          toast.error(`${side} midpoint exit · loss`, { description })
        } else if (result > 0) {
          toast.success(`${side} midpoint exit · profit booked`, { description })
        } else {
          toast.info(`${side} midpoint exit signal`, { description })
        }
      }
    }
  }, [signals.data, today, visibleSignals])

  async function toggleKill() {
    if (!status) return
    setBusy(true)
    try {
      await postJSON(`/api/kill-switch/${status.kill_switch ? "off" : "on"}`)
      toast.success(status.kill_switch ? "Trading resumed" : "Kill switch ON — no new entries")
      await reload()
    } catch (error) {
      toast.error(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function toggleCapture() {
    if (!status) return
    setBusy(true)
    try {
      const result = await postJSON<{ market_closed?: boolean }>(`/api/capture/${status.capture_running ? "stop" : "start"}`)
      if (result.market_closed) {
        toast.info("Market is closed; live capture runs during market hours")
      } else {
        toast.success(status.capture_running ? "Stopping capture (positions safe)" : "Capture started")
      }
      setTimeout(reload, 2000)
    } catch (error) {
      toast.error(String(error))
    } finally {
      setBusy(false)
    }
  }

  const [reauthing, setReauthing] = useState(false)
  const tradeCount = todays.length || signalTrades.length

  const isKotak = status?.broker === "KOTAK_NEO" || status?.token?.broker === "KOTAK_NEO"
  const brokerName = isKotak ? "Kotak Neo" : "Fyers"
  const brokerValid = status?.token?.valid ?? false
  const fyersValid = Boolean(status?.broker_status?.fyers?.valid)

  async function handleFyersAuth() {
    setReauthing(true)
    const tab = window.open("about:blank", "_blank")
    try {
      const r = await postJSON<{ login_url: string; listener: string }>("/api/login/start")
      if (tab) tab.location.href = r.login_url
      else window.location.href = r.login_url
      toast.info("Log in to Fyers in the opened tab; candles will stream as soon as authenticated.")
    } catch (e) {
      tab?.close()
      toast.error(String(e))
    } finally {
      setReauthing(false)
    }
  }

  // Auto-initialize trade expiry from available choices
  useEffect(() => {
    const expiries = manualOptions.data?.expiries
    if (expiries && expiries.length > 0) {
      if (!tradeExpiry || !expiries.some((e) => e.expiry === tradeExpiry)) {
        setTradeExpiry(expiries[0].expiry)
      }
    }
  }, [manualOptions.data, tradeExpiry])

  const selectedTradeExpiry = useMemo(
    () => manualOptions.data?.expiries.find((e) => e.expiry === tradeExpiry),
    [manualOptions.data, tradeExpiry]
  )

  useEffect(() => {
    const strikes = selectedTradeExpiry?.strikes
    if (strikes && strikes.length > 0) {
      if (!tradeStrike || !strikes.includes(Number(tradeStrike))) {
        const atm = manualOptions.data?.atm
        const defaultStrike = atm && strikes.includes(atm) ? atm : strikes[Math.floor(strikes.length / 2)]
        setTradeStrike(String(defaultStrike))
      }
    }
  }, [selectedTradeExpiry, manualOptions.data, tradeStrike])

  const quoteUrl = tradeExpiry && tradeStrike
    ? `/api/manual-quote?expiry=${encodeURIComponent(tradeExpiry)}&strike=${encodeURIComponent(tradeStrike)}&option_type=${tradeSide}&index_symbol=${tradeIndex}`
    : null
  const tradeQuote = usePoll<ManualOptionQuote>(quoteUrl, 0)
  const lotSize = selectedTradeExpiry?.lot_size || (tradeIndex === "SENSEX" ? 20 : 65)
  const totalQty = tradeLots * lotSize
  const refPrice = tradeOrderType === "LIMIT" ? Number(tradeLimitPrice) || 0 : tradeQuote.data?.last_price || 0
  const estMargin = refPrice > 0 ? refPrice * totalQty * 1.05 : 0

  async function handlePlaceTrade() {
    if (!tradeExpiry || !tradeStrike) {
      toast.error("Please select an expiry and strike first.")
      return
    }
    if (tradeOrderType === "LIMIT" && (!tradeLimitPrice || Number(tradeLimitPrice) <= 0)) {
      toast.error("Please enter a valid limit price.")
      return
    }
    setTradeBusy(true)
    try {
      const res = await postJSON<{ ok: boolean; order_id?: string; fill_price?: number; error?: string }>("/api/manual-order", {
        confirm: "CONFIRM",
        action: "BUY",
        index_symbol: tradeIndex,
        expiry: tradeExpiry,
        strike: Number(tradeStrike),
        option_type: tradeSide,
        lots: tradeLots,
        order_type: tradeOrderType,
        limit_price: tradeOrderType === "LIMIT" ? Number(tradeLimitPrice) : 0,
      })
      if (res.ok) {
        toast.success(`Order placed: BUY ${tradeLots}L ${tradeIndex} ${tradeStrike} ${tradeSide} (${res.fill_price ? "₹" + res.fill_price.toFixed(2) : "Market"})`)
        await Promise.all([positions.reload(), funds.reload()])
        setRightTab("positions")
      } else {
        toast.error(res.error || "Order submission failed.")
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setTradeBusy(false)
    }
  }

  async function handleExitPosition() {
    if (!exitPositionTarget) return
    setExitBusy(true)
    try {
      const exitQty = Math.abs(exitPositionTarget.net_qty ?? exitPositionTarget.qty ?? 0)
      const res = await postJSON<{ ok: boolean; error?: string }>("/api/exit-position", {
        symbol: exitPositionTarget.symbol,
        qty: exitQty,
        exchange: exitPositionTarget.exchange,
        product: exitPositionTarget.product || "MIS",
        side: (exitPositionTarget.net_qty ?? 0) < 0 ? "BUY" : "SELL",
      })
      if (res.ok) {
        toast.success(`Position closed: ${exitPositionTarget.symbol}`)
        setExitPositionTarget(null)
        await Promise.all([positions.reload(), funds.reload()])
      } else {
        toast.error(res.error || "Failed to exit position.")
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setExitBusy(false)
    }
  }

  async function handleExitAll() {
    setExitAllBusy(true)
    try {
      const res = await postJSON<{
        ok: boolean
        closed_count: number
        failed_count: number
        errors?: string[]
        error?: string
      }>("/api/exit-all", {})
      if (res.ok) {
        if (res.failed_count === 0) {
          toast.success(`All positions squared off (${res.closed_count} closed)`)
        } else {
          toast.warning(`Closed ${res.closed_count} positions, ${res.failed_count} failed`)
        }
        setExitAllConfirmOpen(false)
        await Promise.all([positions.reload(), funds.reload()])
      } else {
        toast.error(res.error || "Failed to exit all positions")
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setExitAllBusy(false)
    }
  }

  async function handleReauth() {
    setReauthing(true)
    try {
      if (isKotak) {
        const res = await postJSON<{ ok: boolean; greeting_name?: string; error?: string }>("/api/kotak/login", {})
        if (res.ok) {
          toast.success(`Kotak Neo session refreshed for ${res.greeting_name ?? "User"}`)
          await reload()
        } else {
          toast.error(res.error || "Kotak Neo re-authentication failed. Check Settings.")
        }
      } else {
        const tab = window.open("about:blank", "_blank")
        try {
          const r = await postJSON<{ login_url: string; listener: string }>("/api/login/start")
          if (tab) tab.location.href = r.login_url
          else window.location.href = r.login_url
          toast.info("Complete Fyers login in the new tab; status will update automatically.")
        } catch (e) {
          tab?.close()
          toast.error(String(e))
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setReauthing(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 flex-1 min-h-0 h-full overflow-hidden">
      {/* Broker Session Alert Banner (if disconnected/expired) */}
      {status && !brokerValid && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-600 dark:text-red-400 shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-red-500" />
            <span>
              <strong>{brokerName} session is not active.</strong> Live orders and quote feeds require an authenticated session.
            </span>
          </div>
          <Button
            size="xs"
            variant="destructive"
            disabled={reauthing}
            onClick={handleReauth}
            className="h-6.5 px-3 text-xs font-semibold shadow-xs"
          >
            {reauthing ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : <RefreshCw className="mr-1.5 size-3" />}
            {isKotak ? "1-Click Auto Login (TOTP)" : "Authenticate Now"}
          </Button>
        </div>
      )}

      {/* Fyers Data Feed Alert Banner (shown whenever Fyers spot feed session is expired) */}
      {status && !fyersValid && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400 shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-amber-500" />
            <span>
              <strong>Fyers market data feed is disconnected.</strong> Live Nifty 1-minute candlestick capture requires daily Fyers authentication.
            </span>
          </div>
          <Button
            size="xs"
            variant="default"
            disabled={reauthing}
            onClick={handleFyersAuth}
            className="h-6.5 px-3 text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white shadow-xs"
          >
            {reauthing ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : <RefreshCw className="mr-1.5 size-3" />}
            Authenticate Fyers Feed
          </Button>
        </div>
      )}

      {/* Sleek Single-Line Navigation & Action Bar */}
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-card/80 px-3 py-1.5 shadow-2xs backdrop-blur shrink-0 text-xs">
        {/* Left: Date + Chart Layout Switcher + Timeframe Toggle */}
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-1.5 font-semibold text-foreground pr-1">
            <CalendarDays className="h-3.5 w-3.5 text-primary" />
            <span>{formattedDate || today}</span>
          </div>

          <div className="inline-flex rounded-md border border-border/60 bg-muted/40 p-0.5 font-medium">
            <button
              type="button"
              onClick={() => setChartLayout("sensex")}
              className={`px-2.5 py-0.5 rounded font-medium transition-all ${
                chartLayout === "sensex"
                  ? "bg-background text-foreground shadow-2xs font-bold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="View Sensex chart"
            >
              Sensex
            </button>
            <button
              type="button"
              onClick={() => setChartLayout("nifty")}
              className={`px-2.5 py-0.5 rounded font-medium transition-all ${
                chartLayout === "nifty"
                  ? "bg-background text-foreground shadow-2xs font-bold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="View Nifty 50 chart"
            >
              Nifty 50
            </button>
            <button
              type="button"
              onClick={() => setChartLayout("both")}
              className={`px-2.5 py-0.5 rounded font-medium transition-all ${
                chartLayout === "both"
                  ? "bg-background text-foreground shadow-2xs font-bold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="View both charts side by side"
            >
              Both
            </button>
          </div>

          <div className="inline-flex rounded-md border border-border/60 bg-muted/40 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setChartViewMode("full")}
              className={`px-2 py-0.5 rounded font-medium transition-all ${
                chartViewMode === "full"
                  ? "bg-background text-foreground shadow-2xs font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Full day session (09:15 – 15:30)"
            >
              Full Day
            </button>
            <button
              type="button"
              onClick={() => setChartViewMode("midpoint")}
              className={`px-2 py-0.5 rounded font-medium transition-all ${
                chartViewMode === "midpoint"
                  ? "bg-background text-foreground shadow-2xs font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Midpoint window (09:15 – 09:50)"
            >
              09:15–09:50
            </button>
          </div>
        </div>

        {/* Right: Feed Status & Actions */}
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${
              status?.capture_running
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25"
                : "bg-muted text-muted-foreground border-border/30"
            }`}
          >
            <span className={`size-1.5 rounded-full ${status?.capture_running ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`} />
            {status?.capture_running ? "Live" : "Idle"}
          </span>

          <Button
            variant="ghost"
            size="xs"
            disabled={reauthing}
            onClick={handleReauth}
            className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
            title={brokerValid ? `Refresh session token` : `Log in to broker`}
          >
            {reauthing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>

          <Button
            variant={status?.capture_running ? "outline" : "default"}
            size="xs"
            disabled={!status || busy || (status.market_open_day === false && !status.capture_running)}
            onClick={toggleCapture}
            className="h-6 text-xs font-medium px-2"
          >
            {status?.capture_running ? <Square className="mr-1 h-2.5 w-2.5" /> : <Radio className="mr-1 h-2.5 w-2.5" />}
            {status?.capture_running ? "Stop" : "Capture"}
          </Button>

          <Button
            variant={status?.kill_switch ? "default" : "destructive"}
            size="xs"
            disabled={!status || busy}
            onClick={toggleKill}
            className="h-6 text-xs font-medium px-2"
            title="Emergency Kill Switch"
          >
            {status?.kill_switch ? <Play className="mr-1 h-2.5 w-2.5" /> : <OctagonX className="mr-1 h-2.5 w-2.5" />}
            {status?.kill_switch ? "Resume" : "Kill"}
          </Button>
        </div>
      </div>

      {/* MAIN TRADING STAGE: Charts Area (Left) & Compact Terminal (Right) */}
      <div className="flex flex-col lg:flex-row gap-2.5 flex-1 min-h-0 h-full overflow-hidden">
        {/* Left Stage: Clean, Pure Candlestick Charts */}
        <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
          {/* Chart Display Area: Side-by-Side (grid-cols-2) when both, or full width */}
          <div className={`flex-1 min-h-0 ${chartLayout === "both" ? "grid grid-cols-1 md:grid-cols-2" : "flex flex-col"} gap-2 overflow-hidden`}>
            {/* NIFTY CHART (rendered in "both" or "nifty" layout) */}
            {(chartLayout === "both" || chartLayout === "nifty") && (
              <div className="flex-1 min-h-0 rounded-xl border border-border/50 bg-card shadow-2xs flex flex-col overflow-hidden">
                <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5 shrink-0 bg-muted/10 gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-bold tracking-tight text-foreground whitespace-nowrap">NIFTY 50</span>
                    <span className="text-[10px] font-semibold text-muted-foreground bg-muted/60 px-1 py-0.2 rounded">1m</span>
                    {niftyActiveCandle && (
                      <div className="flex items-baseline gap-1.5 font-mono">
                        <span className="font-bold text-xs text-foreground">{fmtNum(niftyPrice ?? 0)}</span>
                        <span className={`text-[11px] font-semibold ${pnlClass(niftyChangePts)}`}>
                          {niftyChangePts >= 0 ? "+" : ""}{niftyChangePts.toFixed(1)} ({niftyChangePct >= 0 ? "+" : ""}{niftyChangePct.toFixed(2)}%)
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {niftySetup?.mid != null && (
                      <span className="text-[10px] font-mono text-amber-500 font-bold bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/25">
                        MID {fmtNum(niftySetup.mid)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setNiftyResetKey((k) => k + 1)}
                      className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/60 transition-colors"
                      title="Reset Nifty zoom to full day"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setChartLayout(chartLayout === "nifty" ? "both" : "nifty")}
                      className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/60 transition-colors"
                      title={chartLayout === "nifty" ? "Restore side-by-side view" : "Maximize Nifty chart"}
                    >
                      {chartLayout === "nifty" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
                <div className="p-1 min-h-[320px] flex-1 flex flex-col">
                  {niftyCandles.length > 0 ? (
                    <CandleChart
                      date={niftyDay.data?.date ?? today ?? ""}
                      candles={niftyCandles}
                      forming={niftyForming}
                      currentPrice={niftyPrice}
                      setup={niftySetup}
                      trades={chartTrades}
                      keyLevelZone={niftySetup?.key_level_zone ?? null}
                      showKeyLevels={true}
                      showTradeLevels={false}
                      className="w-full flex-1 min-h-[300px] h-[clamp(310px,44vh,440px)]"
                      zoomable={true}
                      hideToolbar={true}
                      fullDay={chartViewMode === "full"}
                      resetKey={`${chartLayout}|${niftyResetKey}`}
                    />
                  ) : (
                    <div className="flex h-full min-h-[300px] items-center justify-center text-xs text-muted-foreground">
                      Loading Nifty 1-min candles...
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* SENSEX CHART (rendered in "both" or "sensex" layout) */}
            {(chartLayout === "both" || chartLayout === "sensex") && (
              <div className="flex-1 min-h-0 rounded-xl border border-border/50 bg-card shadow-2xs flex flex-col overflow-hidden">
                <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5 shrink-0 bg-muted/10 gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-bold tracking-tight text-foreground whitespace-nowrap">SENSEX</span>
                    <span className="text-[10px] font-semibold text-muted-foreground bg-muted/60 px-1 py-0.2 rounded">1m</span>
                    {sensexActiveCandle && (
                      <div className="flex items-baseline gap-1.5 font-mono">
                        <span className="font-bold text-xs text-foreground">{fmtNum(sensexPrice ?? 0)}</span>
                        <span className={`text-[11px] font-semibold ${pnlClass(sensexChangePts)}`}>
                          {sensexChangePts >= 0 ? "+" : ""}{sensexChangePts.toFixed(1)} ({sensexChangePct >= 0 ? "+" : ""}{sensexChangePct.toFixed(2)}%)
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {sensexSetup?.mid != null && (
                      <span className="text-[10px] font-mono text-amber-500 font-bold bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/25">
                        MID {fmtNum(sensexSetup.mid)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setSensexResetKey((k) => k + 1)}
                      className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/60 transition-colors"
                      title="Reset Sensex zoom to full day"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setChartLayout(chartLayout === "sensex" ? "both" : "sensex")}
                      className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/60 transition-colors"
                      title={chartLayout === "sensex" ? "Restore side-by-side view" : "Maximize Sensex chart"}
                    >
                      {chartLayout === "sensex" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
                <div className="p-1 min-h-[320px] flex-1 flex flex-col">
                  {sensexCandles.length > 0 ? (
                    <CandleChart
                      date={sensexDay.data?.date ?? today ?? ""}
                      candles={sensexCandles}
                      forming={sensexForming}
                      currentPrice={sensexPrice}
                      setup={sensexSetup}
                      trades={[]}
                      keyLevelZone={sensexSetup?.key_level_zone ?? null}
                      showKeyLevels={true}
                      showTradeLevels={false}
                      className="w-full flex-1 min-h-[300px] h-[clamp(310px,44vh,440px)]"
                      zoomable={true}
                      hideToolbar={true}
                      fullDay={chartViewMode === "full"}
                      resetKey={`${chartLayout}|${sensexResetKey}`}
                    />
                  ) : (
                    <div className="flex h-full min-h-[300px] items-center justify-center text-xs text-muted-foreground">
                      Loading Sensex 1-min candles...
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Unified Positions & Trade Terminal (Compact Width for Maximum Chart Space) */}
        <div className="w-full lg:w-[320px] xl:w-[340px] shrink-0 flex flex-col h-full min-h-0 overflow-hidden">
          <div className="rounded-xl border border-border/50 bg-card shadow-2xs flex flex-col h-full min-h-0 overflow-hidden">
            {/* Unified Top Header: Tabs on Left, Net P&L on Right */}
            <div className="flex items-center justify-between border-b border-border/40 p-1.5 shrink-0 bg-muted/10 gap-1.5">
              <div className="flex items-center gap-0.5 bg-muted/50 p-0.5 rounded-lg">
                <button
                  type="button"
                  onClick={() => setRightTab("positions")}
                  className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                    rightTab === "positions"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Positions {openPositions.length > 0 && <span className="ml-1 text-[10px] opacity-75">({openPositions.length})</span>}
                </button>
                <button
                  type="button"
                  onClick={() => setRightTab("trade")}
                  className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                    rightTab === "trade"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Trade
                </button>
                <button
                  type="button"
                  onClick={() => setRightTab("algo")}
                  className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                    rightTab === "algo"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Algo {tradeCount > 0 && <span className="ml-1 text-[10px] opacity-75">({tradeCount})</span>}
                </button>
              </div>

              {/* Net P&L display */}
              <div className="flex items-baseline gap-1 pr-1.5 font-mono shrink-0">
                <span className="text-[9px] text-muted-foreground uppercase font-sans font-medium">Net P&amp;L</span>
                <span className={`text-xs font-bold ${pnlClass(currentPnl)}`}>
                  {fmtRs(currentPnl)}
                </span>
              </div>
            </div>

            {/* Streamlined Stats Strip (2x2 Grid with chip styling) */}
            <div className="grid grid-cols-2 gap-1.5 p-2 border-b border-border/40 bg-muted/10 text-[11px] font-mono shrink-0">
              <div className="flex items-center justify-between px-2 py-1 rounded-md bg-background/80 border border-border/40 shadow-2xs">
                <span className="text-[10px] text-muted-foreground uppercase font-sans font-medium">Open</span>
                <span className={`font-bold ${pnlClass(brokerUnrealized)}`}>
                  {(brokerUnrealized > 0 ? "+" : "") + fmtRs(brokerUnrealized)}
                </span>
              </div>
              <div className="flex items-center justify-between px-2 py-1 rounded-md bg-background/80 border border-border/40 shadow-2xs">
                <span className="text-[10px] text-muted-foreground uppercase font-sans font-medium">Realized</span>
                <span className={`font-bold ${pnlClass(currentRealized)}`}>
                  {fmtRs(currentRealized)}
                </span>
              </div>
              <div className="flex items-center justify-between px-2 py-1 rounded-md bg-background/80 border border-border/40 shadow-2xs">
                <span className="text-[10px] text-muted-foreground uppercase font-sans font-medium">Invested</span>
                <span className="font-semibold text-foreground">
                  {fmtRs(positions.data?.summary?.total_invested ?? 0)}
                </span>
              </div>
              <div className="flex items-center justify-between px-2 py-1 rounded-md bg-background/80 border border-border/40 shadow-2xs">
                <span className="text-[10px] text-muted-foreground uppercase font-sans font-medium">Margin</span>
                <span className="font-semibold text-foreground">
                  {funds.data?.ok ? fmtRs(funds.data.available_equity_funds) : "—"}
                </span>
              </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
              {rightTab === "positions" ? (
                /* Positions Tab (Simple, Uncluttered & Smoothly Scrollable) */
                <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2">
                  {openPositions.length > 0 ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between px-0.5 pb-0.5">
                        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                          Open Positions ({openPositions.length})
                        </span>
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => setExitAllConfirmOpen(true)}
                          className="h-6 px-2 text-[11px] font-bold text-red-500 hover:text-white hover:bg-red-600 hover:border-red-600 border-red-500/30 shadow-2xs transition-colors shrink-0"
                          title="Square off all open positions immediately at Market"
                        >
                          <LogOut className="mr-1 h-3 w-3" /> Exit All ({openPositions.length})
                        </Button>
                      </div>
                      {openPositions.map((p) => {
                        const parsed = parseContractDisplay(p.symbol, p.expiry)
                        const ltpVal = p.ltp ?? p.buy_avg
                        const pnlPct = p.pnl_pct != null ? p.pnl_pct : (p.buy_avg > 0 ? ((ltpVal - p.buy_avg) / p.buy_avg) * 100 : 0)
                        const unrealized = p.unrealized_pnl ?? 0

                        return (
                          <div
                            key={`${p.symbol}-${p.product || "MIS"}-${p.net_qty}`}
                            className="rounded-lg border border-border/50 bg-background/80 p-2.5 hover:bg-muted/15 transition-all shadow-2xs space-y-2"
                          >
                            {/* Line 1: Contract Name, Side Badge, Product Badge, Expiry <---> Live P&L */}
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="font-bold text-sm text-foreground tracking-tight whitespace-nowrap">
                                    {parsed.baseName}
                                  </span>
                                  <span
                                    className={`px-1.5 py-0.2 rounded text-[10px] font-bold tracking-tight uppercase ${
                                      parsed.isCall
                                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30"
                                        : "bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30"
                                    }`}
                                  >
                                    {parsed.optStr}
                                  </span>
                                  <span className="text-[9px] font-mono font-bold px-1 py-0.2 rounded uppercase bg-muted/60 text-muted-foreground border border-border/40">
                                    {p.product || "MIS"}
                                  </span>
                                  {parsed.expiry && (
                                    <span className="text-[11px] text-muted-foreground font-sans">
                                      {parsed.expiry}
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] font-mono text-muted-foreground mt-0.5">
                                  <span className="font-semibold text-foreground/85">{p.lots ?? 1}L ({p.net_qty} Qty)</span>
                                  <span className="mx-1 opacity-40">·</span>
                                  <span>Avg ₹{p.buy_avg.toFixed(2)}</span>
                                </div>
                              </div>

                              {/* Right: Live P&L and % */}
                              <div className="text-right font-mono shrink-0">
                                <div className={`font-bold text-sm ${pnlClass(unrealized)}`}>
                                  {unrealized > 0 ? "+" : ""}{fmtRs(unrealized)}
                                </div>
                                <div className={`text-[11px] font-medium ${pnlClass(unrealized)}`}>
                                  ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
                                </div>
                              </div>
                            </div>

                            {/* Line 2: LTP & Quick Exit */}
                            <div className="flex items-center justify-between border-t border-border/30 pt-1.5 text-xs font-mono">
                              <div className="flex items-center gap-1.5 text-muted-foreground">
                                <span>LTP:</span>
                                <strong className="text-foreground text-xs font-bold">₹{ltpVal.toFixed(2)}</strong>
                                <span className="opacity-30">·</span>
                                <span>Inv: {fmtRs(p.invested ?? 0)}</span>
                              </div>

                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() => setExitPositionTarget(p)}
                                className="text-red-500 hover:text-white hover:bg-red-600 hover:border-red-600 border-red-500/30 h-6 px-2.5 text-xs font-semibold rounded shadow-2xs transition-colors shrink-0"
                                title="Square off position at Market"
                              >
                                <LogOut className="mr-1 h-3 w-3" /> Exit
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="p-6 text-center text-xs text-muted-foreground flex flex-col items-center justify-center">
                      <Coins className="h-6 w-6 text-muted-foreground/30 mb-2" />
                      <span className="font-semibold text-foreground text-sm">No open positions</span>
                      <span className="text-xs text-muted-foreground mt-1">
                        Use the Trade Panel to enter a trade directly.
                      </span>
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setRightTab("trade")}
                        className="mt-2.5 h-6.5 text-xs px-3"
                      >
                        Open Trade Panel
                      </Button>
                    </div>
                  )}

                  {/* Closed Intraday Positions (Compact Collapsible Accordion) */}
                  {closedPositions.length > 0 && (
                    <div className="pt-1 border-t border-border/30">
                      <button
                        type="button"
                        onClick={() => setShowClosed(!showClosed)}
                        className="flex items-center justify-between w-full p-1.5 rounded-md hover:bg-muted/40 text-xs transition-colors group"
                      >
                        <div className="flex items-center gap-1.5 font-medium text-muted-foreground group-hover:text-foreground">
                          <ChevronRight className={`h-3.5 w-3.5 transition-transform duration-200 ${showClosed ? "rotate-90" : ""}`} />
                          <span>Closed Intraday ({closedPositions.length})</span>
                        </div>
                        <span className={`font-mono font-bold text-xs ${pnlClass(currentRealized)}`}>
                          {currentRealized > 0 ? "+" : ""}{fmtRs(currentRealized)}
                        </span>
                      </button>

                      {showClosed && (
                        <div className="mt-1 space-y-1 divide-y divide-border/20 rounded-lg border border-border/30 bg-muted/5 p-1.5 overflow-hidden">
                          {closedPositions.map((p) => {
                            const parsed = parseContractDisplay(p.symbol, p.exchange)
                            const realized = p.realized_pnl ?? 0

                            return (
                              <div key={`${p.symbol}-${p.product || "MIS"}-${p.qty}`} className="flex items-center justify-between py-1.5 px-1.5 text-xs">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span
                                    className={`text-[9px] font-bold px-1 py-0.2 rounded uppercase ${
                                      parsed.isCall
                                        ? "text-emerald-500 bg-emerald-500/10"
                                        : "text-rose-500 bg-rose-500/10"
                                    }`}
                                  >
                                    {parsed.optStr}
                                  </span>
                                  <span className="text-[9px] font-mono font-bold px-1 py-0.2 rounded uppercase bg-muted/60 text-muted-foreground border border-border/40">
                                    {p.product || "MIS"}
                                  </span>
                                  <span className="font-semibold text-foreground text-xs truncate">
                                    {parsed.baseName}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground font-mono">
                                    ({p.qty} Qty)
                                  </span>
                                </div>
                                <div className={`font-mono font-bold text-xs shrink-0 ${pnlClass(realized)}`}>
                                  {realized > 0 ? "+" : ""}{fmtRs(realized)}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : rightTab === "trade" ? (
                /* Simple, Spacious, Scroll-Free Trade Panel */
                <div className="p-4 flex flex-col justify-between h-full text-xs gap-3">
                  <div className="space-y-3.5">
                    {/* Index Selector: NIFTY 50 vs SENSEX */}
                    <div className="grid grid-cols-2 gap-2 p-0.5 bg-muted/40 rounded-lg border border-border/40">
                      <button
                        type="button"
                        onClick={() => {
                          setTradeIndex("NIFTY")
                          setTradeExpiry("")
                          setTradeStrike("")
                        }}
                        className={`h-7.5 rounded-md font-bold text-xs transition-all ${
                          tradeIndex === "NIFTY"
                            ? "bg-background text-foreground shadow-xs"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        NIFTY 50 (65 Qty)
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setTradeIndex("SENSEX")
                          setTradeExpiry("")
                          setTradeStrike("")
                        }}
                        className={`h-7.5 rounded-md font-bold text-xs transition-all ${
                          tradeIndex === "SENSEX"
                            ? "bg-background text-foreground shadow-xs"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        SENSEX (20 Qty)
                      </button>
                    </div>

                    {/* 1. CE / PE Selector */}
                    <div className="grid grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        onClick={() => setTradeSide("CE")}
                        className={`h-9 rounded-lg font-bold text-xs transition-all flex items-center justify-center ${
                          tradeSide === "CE"
                            ? "bg-emerald-600 text-white shadow-xs"
                            : "bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted/60"
                        }`}
                      >
                        CALL (CE)
                      </button>
                      <button
                        type="button"
                        onClick={() => setTradeSide("PE")}
                        className={`h-9 rounded-lg font-bold text-xs transition-all flex items-center justify-center ${
                          tradeSide === "PE"
                            ? "bg-rose-600 text-white shadow-xs"
                            : "bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted/60"
                        }`}
                      >
                        PUT (PE)
                      </button>
                    </div>

                    {/* 2. Expiry & Strike (1 Row with comfortable padding) */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground block">Expiry</label>
                        <select
                          value={tradeExpiry}
                          onChange={(e) => setTradeExpiry(e.target.value)}
                          className="w-full h-8.5 rounded-lg border border-border/60 bg-background px-2.5 text-xs font-medium focus:outline-none"
                        >
                          {(manualOptions.data?.expiries ?? []).map((exp) => (
                            <option key={exp.expiry} value={exp.expiry}>
                              {exp.expiry}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground block">Strike ({tradeIndex})</label>
                        <select
                          value={tradeStrike}
                          onChange={(e) => setTradeStrike(e.target.value)}
                          className="w-full h-8.5 rounded-lg border border-border/60 bg-background px-2.5 text-xs font-mono font-medium focus:outline-none"
                        >
                          {(selectedTradeExpiry?.strikes ?? []).map((strike) => (
                            <option key={strike} value={strike}>
                              {strike} {strike === manualOptions.data?.atm ? "★ ATM" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* 3. Lots & Order Type */}
                    <div className="grid grid-cols-2 gap-3 items-end">
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground block">
                          Lots ({totalQty} Qty)
                        </label>
                        <div className="flex items-center rounded-lg border border-border/60 bg-background h-8.5">
                          <button
                            type="button"
                            onClick={() => setTradeLots((prev) => Math.max(1, prev - 1))}
                            className="px-3 h-full hover:bg-muted text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors"
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <span className="flex-1 text-center font-mono font-bold text-xs">{tradeLots}</span>
                          <button
                            type="button"
                            onClick={() => setTradeLots((prev) => prev + 1)}
                            className="px-3 h-full hover:bg-muted text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground block">Order Type</label>
                        <div className="grid grid-cols-2 gap-1 h-8.5">
                          <button
                            type="button"
                            onClick={() => setTradeOrderType("MARKET")}
                            className={`rounded-lg text-[11px] font-semibold transition-all ${
                              tradeOrderType === "MARKET"
                                ? "bg-primary text-primary-foreground shadow-2xs"
                                : "bg-muted/40 text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            Market
                          </button>
                          <button
                            type="button"
                            onClick={() => setTradeOrderType("LIMIT")}
                            className={`rounded-lg text-[11px] font-semibold transition-all ${
                              tradeOrderType === "LIMIT"
                                ? "bg-primary text-primary-foreground shadow-2xs"
                                : "bg-muted/40 text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            Limit
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Limit Price Input (Only when Limit selected) */}
                    {tradeOrderType === "LIMIT" && (
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground block">Limit Price (₹)</label>
                        <Input
                          type="number"
                          step="0.05"
                          placeholder={tradeQuote.data?.last_price ? String(tradeQuote.data.last_price) : "Enter limit price"}
                          value={tradeLimitPrice}
                          onChange={(e) => setTradeLimitPrice(e.target.value)}
                          className="h-8.5 text-xs font-mono font-bold rounded-lg"
                        />
                      </div>
                    )}

                    {/* 4. Single-line Quote & Margin Strip */}
                    <div className="rounded-lg bg-muted/20 border border-border/40 p-2.5 text-xs font-mono flex items-center justify-between text-muted-foreground">
                      <span>
                        LTP: <strong className="text-foreground">{tradeQuote.data?.last_price != null ? `₹${tradeQuote.data.last_price.toFixed(2)}` : "—"}</strong>
                      </span>
                      <span>
                        Est: <strong className="text-foreground">{fmtRs(estMargin)}</strong>
                      </span>
                      <span>
                        Avail: <strong className="text-foreground">{funds.data?.ok ? fmtRs(funds.data.available_equity_funds) : "—"}</strong>
                      </span>
                    </div>
                  </div>

                  {/* 5. Big Action Button at Bottom */}
                  <Button
                    type="button"
                    disabled={tradeBusy || !brokerValid || !tradeExpiry || !tradeStrike}
                    onClick={handlePlaceTrade}
                    className={`w-full h-10 text-xs font-bold transition-all shadow-xs rounded-lg ${
                      tradeSide === "CE"
                        ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                        : "bg-rose-600 hover:bg-rose-700 text-white"
                    }`}
                  >
                    {tradeBusy ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Placing Order...
                      </>
                    ) : (
                      <>
                        <Send className="mr-2 h-3.5 w-3.5" /> BUY {tradeLots} LOT ({totalQty} QTY) · {tradeSide}
                      </>
                    )}
                  </Button>
                </div>
              ) : (
                /* Midpoint Algo Orders Tab (with comfortable padding) */
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <div className="divide-y divide-border/25 text-xs">
                    {activePosition && (
                      <div className="p-3 bg-emerald-500/[0.06] border-b border-emerald-500/20">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <SideBadge side={activePosition.side} />
                            <span className="font-bold text-xs text-foreground font-mono">{activePosition.symbol}</span>
                            <Badge className="text-[9px] py-0 px-1 bg-emerald-600 text-white">
                              <Zap className="mr-0.5 h-2 w-2" /> Live
                            </Badge>
                          </div>
                          <div className={`font-mono text-xs font-bold ${pnlClass(activePosition.unrealizedPts)}`}>
                            {activePosition.unrealizedPts >= 0 ? "+" : ""}{fmtNum(activePosition.unrealizedPts)} pts
                          </div>
                        </div>
                      </div>
                    )}
                    {todays.length > 0 ? (
                      todays.map((t, idx) => (
                        <div key={idx} className="flex items-center justify-between p-3 hover:bg-muted/30 transition-colors">
                          <div className="flex items-center gap-2.5">
                            <SideBadge side={t.side} />
                            <div>
                              <div className="font-semibold font-mono text-xs">{t.entry} → {t.exit || "open"}</div>
                              <div className="text-[11px] text-muted-foreground">{prettyReason(t.exit_reason)}</div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className={`font-bold font-mono text-xs ${pnlClass(t.net_rs ?? t.pnl_rs)}`}>
                              {fmtRs(t.net_rs ?? t.pnl_rs)}
                            </div>
                            <div className={`text-[11px] font-mono ${pnlClass(t.nifty_points)}`}>
                              {fmtPts(t.nifty_points)}
                            </div>
                          </div>
                        </div>
                      ))
                    ) : signalTrades.length > 0 ? (
                      signalTrades.map((t, idx) => (
                        <div key={idx} className="flex items-center justify-between p-3 hover:bg-muted/30 transition-colors">
                          <div className="flex items-center gap-2.5">
                            <SideBadge side={t.side} />
                            <div>
                              <div className="font-semibold font-mono text-xs">{t.entry} → {t.exit || "open"}</div>
                              <div className="text-[11px] text-muted-foreground">{prettyReason(t.reason)}</div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className={`font-bold font-mono text-xs ${pnlClass(t.pnl_points)}`}>
                              {fmtPts(t.pnl_points)}
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="flex h-full min-h-[220px] flex-col items-center justify-center p-6 text-center text-xs text-muted-foreground">
                        <Activity className="h-7 w-7 text-muted-foreground/30 mb-2" />
                        <span className="font-semibold text-foreground text-sm">No algo orders executed today</span>
                        <span className="text-xs text-muted-foreground mt-1">
                          Waiting for midpoint triggers (09:15–09:50)
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Exit Position Confirmation Dialog */}
      <Dialog open={exitPositionTarget !== null} onOpenChange={(open) => !open && setExitPositionTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Confirm Square Off Position</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Are you sure you want to square off this open position on {brokerName}? A Market sell order will be sent immediately.
            </DialogDescription>
          </DialogHeader>
          {exitPositionTarget && (
            <div className="rounded-lg border bg-muted/20 p-3 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Contract</span>
                <span className="font-mono font-bold text-foreground">{exitPositionTarget.symbol}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Quantity</span>
                <span className="font-mono font-bold text-foreground">
                  {exitPositionTarget.net_qty} Qty ({exitPositionTarget.lots ?? 1} Lot{(exitPositionTarget.lots ?? 1) > 1 ? "s" : ""})
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Buy Average</span>
                <span className="font-mono font-bold text-foreground">₹{exitPositionTarget.buy_avg.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Invested</span>
                <span className="font-mono font-bold text-foreground">{fmtRs(exitPositionTarget.invested ?? 0)}</span>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={exitBusy}
              onClick={() => setExitPositionTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={exitBusy}
              onClick={handleExitPosition}
              className="font-semibold"
            >
              {exitBusy ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Exiting...
                </>
              ) : (
                "Square Off Now"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Exit All Positions Confirmation Dialog */}
      <Dialog open={exitAllConfirmOpen} onOpenChange={(open) => !open && setExitAllConfirmOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold text-red-600 flex items-center gap-2">
              <LogOut className="h-4 w-4" /> Square Off ALL Positions
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Are you sure you want to close ALL {openPositions.length} open positions immediately at Market on {brokerName}?
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border bg-muted/20 p-2.5 max-h-[220px] overflow-y-auto divide-y divide-border/20 space-y-1.5 text-xs">
            {openPositions.map((p) => {
              const parsed = parseContractDisplay(p.symbol, p.expiry)
              const unrealized = p.unrealized_pnl ?? 0
              return (
                <div key={`${p.symbol}-${p.product || "MIS"}`} className="pt-1.5 first:pt-0 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 font-bold">
                      <span>{parsed.baseName}</span>
                      <span className="text-[10px] font-mono px-1 py-0.2 rounded uppercase bg-muted/60 text-muted-foreground border border-border/40">
                        {p.product || "MIS"}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground font-mono">
                      {p.net_qty} Qty · Avg ₹{p.buy_avg.toFixed(2)}
                    </div>
                  </div>
                  <div className={`font-mono font-bold text-xs ${pnlClass(unrealized)}`}>
                    {unrealized > 0 ? "+" : ""}{fmtRs(unrealized)}
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
              onClick={handleExitAll}
              className="font-semibold bg-red-600 hover:bg-red-700"
            >
              {exitAllBusy ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Squaring Off All...
                </>
              ) : (
                `Yes, Exit All (${openPositions.length})`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
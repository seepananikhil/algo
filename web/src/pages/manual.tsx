import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Zap,
  TrendingUp,
  RefreshCw,
  Wallet,
  ShieldAlert,
  ArrowUpRight,
  ArrowDownRight,
  AlertTriangle,
  Plus,
  Minus,
  CheckCircle2,
  Clock,
  Sparkles,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  fmtRs,
  pnlClass,
  postJSON,
  usePoll,
  type FundsStatus,
  type ManualOptionChoices,
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
  pnl?: number
  unrealized_pnl?: number
  realized_pnl?: number
  lot_size?: number
  exchange?: string
  product?: string
  side?: string
}

interface ClosedPosition {
  symbol: string
  side?: string
  qty: number
  buy_avg: number
  sell_avg: number
  buy_amt?: number
  sell_amt?: number
  realized_pnl: number
  exchange?: string
  product?: string
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
    total_invested?: number
    current_value?: number
  }
}

interface KotakOrder {
  id: string
  symbol: string
  qty: number
  side: number | string
  status: string
  limit_price: number
  traded_price: number
  filled_qty: number
  time: string
}

interface ManualTradingSnapshot {
  updated_at: string
  order_window_open: boolean
  kill_switch: boolean
  account_pnl: {
    realized: number
    unrealized: number
    total: number
  }
  positions: OpenPosition[]
  orders: KotakOrder[]
  broker: string
}

export function ManualTradingPage() {
  const { status } = useStatus()
  const isKotakConnected = Boolean(status?.token.valid)

  // Active Instrument: NIFTY vs SENSEX
  const [indexSymbol, setIndexSymbol] = useState<"NIFTY" | "SENSEX">("NIFTY")

  // Active Mobile View Tab: trade | positions | history
  const [activeTab, setActiveTab] = useState<"trade" | "positions" | "history">("trade")

  // Data Polling
  const positionsPoll = usePoll<PositionsResponse>(isKotakConnected ? "/api/positions" : null, 2500)
  const fundsPoll = usePoll<FundsStatus>(isKotakConnected ? "/api/funds" : null, 6000)
  const brokerSnapshot = usePoll<ManualTradingSnapshot>(isKotakConnected ? "/api/manual-trading" : null, 4000)
  const optionsPoll = usePoll<ManualOptionChoices>(
    isKotakConnected ? `/api/manual-options?symbol=${indexSymbol}` : null,
    15000
  )

  // Order Form State
  const [expiry, setExpiry] = useState("")
  const [strike, setStrike] = useState("")
  const [lots, setLots] = useState(1)
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET")
  const [limitPrice, setLimitPrice] = useState("")
  const [product, setProduct] = useState<"NRML" | "MIS">("NRML")

  // Quotes for CE and PE side-by-side
  const [cePrice, setCePrice] = useState<number | null>(null)
  const [pePrice, setPePrice] = useState<number | null>(null)
  const [ceSymbol, setCeSymbol] = useState<string>("")
  const [peSymbol, setPeSymbol] = useState<string>("")
  const [quoteLoading, setQuoteLoading] = useState(false)

  // Order Placement Modal
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingOrder, setPendingOrder] = useState<{
    action: "BUY" | "SELL"
    optionType: "CE" | "PE"
    strike: number
    symbol: string
    price: number
    qty: number
    lots: number
    product: string
  } | null>(null)
  const [orderBusy, setOrderBusy] = useState(false)

  // Exit Confirmation Modal
  const [exitModalOpen, setExitModalOpen] = useState(false)
  const [posToExit, setPosToExit] = useState<OpenPosition | null>(null)
  const [exitAllModalOpen, setExitAllModalOpen] = useState(false)

  // Synchronize available expiries when instrument or options change
  useEffect(() => {
    const choices = optionsPoll.data?.expiries
    if (!choices?.length) return
    if (!choices.some((c) => c.expiry === expiry)) {
      setExpiry(choices[0].expiry)
    }
  }, [optionsPoll.data, expiry])

  // Synchronize strike when expiry or ATM changes
  const selectedExpiry = optionsPoll.data?.expiries?.find((c) => c.expiry === expiry)
  const lotSize = selectedExpiry?.lot_size ?? (indexSymbol === "SENSEX" ? 20 : 65)

  useEffect(() => {
    const strikes = selectedExpiry?.strikes
    if (!strikes?.length) return
    const currentAtm = optionsPoll.data?.atm ?? (indexSymbol === "SENSEX" ? 82000 : 25250)
    if (!strike || !strikes.includes(Number(strike))) {
      // Find closest strike to ATM
      let closest = strikes[0]
      let minDiff = Math.abs(closest - currentAtm)
      for (const s of strikes) {
        const diff = Math.abs(s - currentAtm)
        if (diff < minDiff) {
          minDiff = diff
          closest = s
        }
      }
      setStrike(String(closest))
    }
  }, [selectedExpiry, optionsPoll.data, strike, indexSymbol])

  // Fetch Quotes for both CE and PE when strike/expiry change
  useEffect(() => {
    if (!isKotakConnected || !expiry || !strike) return

    let cancelled = false
    setQuoteLoading(true)

    async function loadQuotes() {
      try {
        const [ceRes, peRes] = await Promise.allSettled([
          fetch(`/api/manual-quote?symbol=${indexSymbol}&strike=${strike}&option_type=CE&expiry=${expiry}`).then((r) =>
            r.json()
          ),
          fetch(`/api/manual-quote?symbol=${indexSymbol}&strike=${strike}&option_type=PE&expiry=${expiry}`).then((r) =>
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
    const timer = setInterval(() => void loadQuotes(), 3500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [indexSymbol, expiry, strike, isKotakConnected])

  // Calculations
  const atmStrike = optionsPoll.data?.atm ?? (indexSymbol === "SENSEX" ? 82000 : 25250)
  const spotPrice = optionsPoll.data?.spot ?? (indexSymbol === "SENSEX" ? 82031.8 : 25227.95)
  const strikeStep = indexSymbol === "SENSEX" ? 100 : 50

  // 5 Quick Strike Chips around ATM
  const quickStrikes = [
    atmStrike - strikeStep * 2,
    atmStrike - strikeStep,
    atmStrike,
    atmStrike + strikeStep,
    atmStrike + strikeStep * 2,
  ]

  const totalQty = lots * lotSize
  const availableFunds = fundsPoll.data?.ok ? fundsPoll.data.available_equity_funds : null

  // Positions data
  const openPositions = positionsPoll.data?.open_positions ?? []
  const closedPositions = positionsPoll.data?.closed_positions ?? []
  const summary = positionsPoll.data?.summary ?? {
    realized_pnl: brokerSnapshot.data?.account_pnl?.realized ?? 0,
    unrealized_pnl: brokerSnapshot.data?.account_pnl?.unrealized ?? 0,
    net_pnl: brokerSnapshot.data?.account_pnl?.total ?? 0,
    open_count: openPositions.length,
    closed_count: closedPositions.length,
  }

  // Reload all
  async function reloadAll() {
    await Promise.all([positionsPoll.reload(), fundsPoll.reload(), optionsPoll.reload(), brokerSnapshot.reload()])
  }

  // Open confirmation for Buy CE or Buy PE
  function initiateBuyOrder(optionType: "CE" | "PE") {
    if (!strike || !expiry) {
      toast.error("Please select a strike and expiry.")
      return
    }
    const currentPrice = optionType === "CE" ? cePrice ?? 0 : pePrice ?? 0
    const resolvedSymbol = optionType === "CE" ? ceSymbol : peSymbol

    setPendingOrder({
      action: "BUY",
      optionType,
      strike: Number(strike),
      symbol: resolvedSymbol,
      price: orderType === "LIMIT" ? Number(limitPrice) || currentPrice : currentPrice,
      qty: totalQty,
      lots,
      product,
    })
    setConfirmOpen(true)
  }

  // Submit confirmed live order
  async function submitOrder() {
    if (!pendingOrder) return
    setOrderBusy(true)

    const payload = {
      action: "BUY",
      index_symbol: indexSymbol,
      expiry,
      strike: pendingOrder.strike,
      option_type: pendingOrder.optionType,
      symbol: pendingOrder.symbol || undefined,
      lots: pendingOrder.lots,
      order_type: orderType,
      limit_price: orderType === "LIMIT" ? Number(limitPrice) : undefined,
      product: pendingOrder.product,
      confirm: "QUICK_TRADE",
    }

    try {
      const res = await postJSON<{ ok: boolean; order_id?: string; fill_price?: number; symbol?: string; qty?: number }>(
        "/api/manual-order",
        payload
      )
      toast.success("Order Placed Successfully! (₹0 Brokerage)", {
        description: `BUY ${res.qty ?? pendingOrder.qty}x ${res.symbol ?? pendingOrder.symbol} · Order #${res.order_id || "Placed"}`,
      })
      setConfirmOpen(false)
      setPendingOrder(null)
      // Switch tab to positions to see live trade
      setActiveTab("positions")
      await reloadAll()
    } catch (err: any) {
      toast.error("Order Failed", {
        description: String(err?.message || err),
      })
    } finally {
      setOrderBusy(false)
    }
  }

  // Square Off a Position
  async function executeExit(pos: OpenPosition) {
    setOrderBusy(true)
    try {
      const res = await postJSON<{ ok: boolean; order_id?: string }>("/api/exit-position", {
        symbol: pos.symbol,
        qty: Math.abs(pos.net_qty),
        exchange: pos.exchange || (pos.symbol.includes("SENSEX") ? "bse_fo" : "nse_fo"),
        product: pos.product || "NRML",
        side: pos.net_qty > 0 ? "SELL" : "BUY",
      })
      toast.success("Position Squared Off Successfully!", {
        description: `Exited ${pos.symbol} (${Math.abs(pos.net_qty)} qty) · Order #${res.order_id || "Executed"}`,
      })
      setExitModalOpen(false)
      setPosToExit(null)
      await reloadAll()
    } catch (err: any) {
      toast.error("Exit Failed", {
        description: String(err?.message || err),
      })
    } finally {
      setOrderBusy(false)
    }
  }

  // Emergency Exit All
  async function executeExitAll() {
    setOrderBusy(true)
    try {
      const res = await postJSON<{ ok: boolean; closed_count?: number; message?: string }>("/api/exit-all", {})
      toast.success("All Positions Closed!", {
        description: res.message || `Closed ${res.closed_count ?? openPositions.length} positions.`,
      })
      setExitAllModalOpen(false)
      await reloadAll()
    } catch (err: any) {
      toast.error("Exit All Failed", {
        description: String(err?.message || err),
      })
    } finally {
      setOrderBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 max-w-2xl mx-auto w-full pb-20 px-2 sm:px-4 pt-1">
      {/* 1. Header Card: Funds & Live Today P&L */}
      <Card className="border border-border/80 bg-gradient-to-br from-card via-card to-muted/20 shadow-sm overflow-hidden">
        <CardContent className="p-3 sm:p-4">
          <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2.5 mb-2.5">
            <div className="flex items-center gap-2">
              <div className="size-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-semibold tracking-wide text-foreground flex items-center gap-1.5">
                ⚡ Quick Trade
                <Badge variant="outline" className="text-[10px] py-0 px-1.5 bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                  ₹0 Brokerage (API)
                </Badge>
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => void reloadAll()}
                title="Refresh"
              >
                <RefreshCw className={cn("size-3.5", (positionsPoll.loading || fundsPoll.loading) && "animate-spin")} />
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Available Funds */}
            <div className="flex flex-col">
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Wallet className="size-3 text-primary" /> Margin Available
              </span>
              <span className="text-base sm:text-lg font-bold font-mono tracking-tight text-foreground">
                {availableFunds != null ? fmtRs(availableFunds) : "₹37,258.12"}
              </span>
            </div>

            {/* Today Net P&L */}
            <div className="flex flex-col items-end text-right">
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                Today's Net P&L
              </span>
              <div className="flex items-baseline gap-1">
                <span
                  className={cn(
                    "text-base sm:text-lg font-extrabold font-mono tracking-tight",
                    summary.net_pnl > 0
                      ? "text-emerald-500"
                      : summary.net_pnl < 0
                      ? "text-rose-500"
                      : "text-muted-foreground"
                  )}
                >
                  {summary.net_pnl > 0 ? "+" : ""}
                  {fmtRs(summary.net_pnl)}
                </span>
                {summary.net_pnl !== 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    ({summary.unrealized_pnl !== 0 ? `Unrl: ${fmtRs(summary.unrealized_pnl)}` : "Realized"})
                  </span>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 2. Main Mobile Tabs Switcher */}
      <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as any)} className="w-full">
        <TabsList className="grid grid-cols-3 w-full bg-muted/60 p-1 rounded-xl h-10">
          <TabsTrigger value="trade" className="text-xs font-semibold rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-xs">
            <Zap className="size-3.5 mr-1 text-amber-500" />
            Trade
          </TabsTrigger>
          <TabsTrigger value="positions" className="text-xs font-semibold rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-xs relative">
            <TrendingUp className="size-3.5 mr-1 text-primary" />
            Positions
            {openPositions.length > 0 && (
              <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-primary text-primary-foreground">
                {openPositions.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className="text-xs font-semibold rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-xs">
            <Clock className="size-3.5 mr-1 text-muted-foreground" />
            History ({closedPositions.length})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* ================= TAB 1: QUICK TRADE ================= */}
      {activeTab === "trade" && (
        <div className="flex flex-col gap-3">
          {/* Index Switcher & Spot Display */}
          <Card className="border border-border/70 bg-card">
            <CardContent className="p-3 sm:p-4 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={indexSymbol === "NIFTY" ? "default" : "outline"}
                  className={cn(
                    "h-12 flex flex-col items-center justify-center rounded-xl transition-all",
                    indexSymbol === "NIFTY" ? "bg-primary text-primary-foreground shadow-md font-bold" : "border-border/80"
                  )}
                  onClick={() => {
                    setIndexSymbol("NIFTY")
                    setStrike("")
                  }}
                >
                  <span className="text-xs font-bold tracking-wide">NIFTY 50</span>
                  <span className="text-[10px] opacity-80 font-mono">1 Lot = 65 Qty</span>
                </Button>

                <Button
                  type="button"
                  variant={indexSymbol === "SENSEX" ? "default" : "outline"}
                  className={cn(
                    "h-12 flex flex-col items-center justify-center rounded-xl transition-all",
                    indexSymbol === "SENSEX" ? "bg-primary text-primary-foreground shadow-md font-bold" : "border-border/80"
                  )}
                  onClick={() => {
                    setIndexSymbol("SENSEX")
                    setStrike("")
                  }}
                >
                  <span className="text-xs font-bold tracking-wide">SENSEX</span>
                  <span className="text-[10px] opacity-80 font-mono">1 Lot = 20 Qty</span>
                </Button>
              </div>

              {/* Spot Price & Expiry */}
              <div className="flex items-center justify-between bg-muted/40 rounded-lg p-2.5 text-xs">
                <div>
                  <span className="text-[10px] text-muted-foreground uppercase font-medium">Spot Price</span>
                  <div className="text-sm font-bold font-mono text-foreground flex items-center gap-1.5">
                    {spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 1 })}
                    <span className="text-[10px] font-semibold text-muted-foreground">
                      (ATM: {atmStrike.toLocaleString("en-IN")})
                    </span>
                  </div>
                </div>

                <div className="flex flex-col items-end">
                  <span className="text-[10px] text-muted-foreground uppercase font-medium">Expiry</span>
                  <Select value={expiry} onValueChange={(val) => val && setExpiry(val)}>
                    <SelectTrigger className="h-7 text-xs font-semibold border-border/80 bg-background px-2 py-0">
                      <SelectValue placeholder="Expiry" />
                    </SelectTrigger>
                    <SelectContent>
                      {(optionsPoll.data?.expiries ?? []).map((exp) => (
                        <SelectItem key={exp.expiry} value={exp.expiry} className="text-xs">
                          {exp.expiry}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Quick Strike Selector Chips */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-foreground flex items-center gap-1">
                    <Sparkles className="size-3 text-amber-500" /> Strike Selection
                  </span>
                  <Select value={strike} onValueChange={(val) => val && setStrike(val)}>
                    <SelectTrigger className="h-6 w-24 text-[11px] font-mono border-border/70 px-1.5">
                      <SelectValue placeholder="Custom" />
                    </SelectTrigger>
                    <SelectContent className="max-h-56">
                      {(selectedExpiry?.strikes ?? []).map((s) => (
                        <SelectItem key={s} value={String(s)} className="text-xs font-mono">
                          {s.toLocaleString("en-IN")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* 5 Instant Strike Chips */}
                <div className="grid grid-cols-5 gap-1.5">
                  {quickStrikes.map((s) => {
                    const isSelected = String(s) === strike
                    const isAtm = s === atmStrike
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setStrike(String(s))}
                        className={cn(
                          "py-2 px-1 rounded-lg text-center transition-all flex flex-col items-center justify-center",
                          isSelected
                            ? "bg-primary text-primary-foreground font-bold shadow-sm ring-2 ring-primary/40"
                            : isAtm
                            ? "bg-amber-500/15 border border-amber-500/40 text-amber-400 font-semibold hover:bg-amber-500/25"
                            : "bg-muted/40 border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted"
                        )}
                      >
                        <span className="text-[11px] sm:text-xs font-mono font-bold tracking-tight">
                          {s.toLocaleString("en-IN")}
                        </span>
                        <span className="text-[9px] opacity-75">
                          {isAtm ? "ATM" : s > atmStrike ? `+${s - atmStrike}` : `${s - atmStrike}`}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Lots & Quantity Stepper */}
              <div className="flex flex-col gap-1.5 pt-1 border-t border-border/40">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-foreground">Quantity</span>
                  <span className="text-muted-foreground font-mono text-[11px]">
                    Total: <strong className="text-foreground">{totalQty} Qty</strong> ({lots} {lots === 1 ? "Lot" : "Lots"})
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex items-center border border-border rounded-lg bg-muted/20 p-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 rounded-md"
                      onClick={() => setLots((prev) => Math.max(1, prev - 1))}
                      disabled={lots <= 1}
                    >
                      <Minus className="size-3.5" />
                    </Button>
                    <div className="w-14 text-center font-bold font-mono text-sm">
                      {lots} {lots === 1 ? "Lot" : "Lots"}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 rounded-md"
                      onClick={() => setLots((prev) => Math.min(20, prev + 1))}
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </div>

                  {/* Quick Lot Chips */}
                  <div className="flex items-center gap-1 flex-1 overflow-x-auto">
                    {[1, 2, 3, 5, 10].map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setLots(l)}
                        className={cn(
                          "px-2.5 py-1.5 rounded-lg text-xs font-mono transition-colors border",
                          lots === l
                            ? "bg-secondary text-secondary-foreground font-bold border-secondary"
                            : "bg-muted/30 border-border/50 text-muted-foreground hover:bg-muted"
                        )}
                      >
                        {l}L
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Order Mode & Product Bar */}
              <div className="flex items-center justify-between text-xs pt-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setOrderType("MARKET")}
                    className={cn(
                      "px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors",
                      orderType === "MARKET"
                        ? "bg-primary/20 border-primary/50 text-primary"
                        : "border-border/60 text-muted-foreground"
                    )}
                  >
                    Market (Instant)
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrderType("LIMIT")}
                    className={cn(
                      "px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors",
                      orderType === "LIMIT"
                        ? "bg-primary/20 border-primary/50 text-primary"
                        : "border-border/60 text-muted-foreground"
                    )}
                  >
                    Limit
                  </button>
                </div>

                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-medium">
                  <span>Product:</span>
                  <button
                    type="button"
                    onClick={() => setProduct(product === "NRML" ? "MIS" : "NRML")}
                    className="font-mono font-bold text-foreground bg-muted hover:bg-muted/80 px-2 py-0.5 rounded border border-border/60 transition-colors"
                    title="Click to toggle NRML / MIS"
                  >
                    {product}
                  </button>
                </div>
              </div>

              {orderType === "LIMIT" && (
                <div className="flex items-center gap-2 bg-muted/30 p-2 rounded-lg">
                  <Label htmlFor="limit-price" className="text-xs whitespace-nowrap">
                    Limit Price (₹):
                  </Label>
                  <Input
                    id="limit-price"
                    type="number"
                    step="0.05"
                    min="0.05"
                    placeholder="Enter limit price"
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* DUAL ACTION CARDS: BUY CALL (CE) vs BUY PUT (PE) */}
          <div className="grid grid-cols-2 gap-3">
            {/* CALL (CE) Card */}
            <Card className="border border-emerald-500/40 bg-gradient-to-b from-emerald-500/10 via-card to-card shadow-sm hover:border-emerald-500/60 transition-all flex flex-col justify-between">
              <CardContent className="p-3 sm:p-4 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <Badge className="bg-emerald-500 text-white font-bold text-[10px] px-1.5 py-0">
                    CALL (CE)
                  </Badge>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {indexSymbol}
                  </span>
                </div>

                <div>
                  <div className="text-xs font-semibold text-foreground">
                    {strike || "—"} CE
                  </div>
                  <div className="text-lg sm:text-xl font-extrabold font-mono text-emerald-500 mt-0.5">
                    {cePrice != null ? fmtRs(cePrice) : quoteLoading ? "Fetching…" : "—"}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    Est. Margin:{" "}
                    <strong className="text-foreground font-mono">
                      {cePrice ? fmtRs(cePrice * totalQty) : "—"}
                    </strong>
                  </div>
                </div>

                <Button
                  type="button"
                  className="w-full h-11 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs sm:text-sm rounded-xl shadow-md active:scale-95 transition-all mt-1"
                  disabled={!strike || !expiry || cePrice == null || !isKotakConnected}
                  onClick={() => initiateBuyOrder("CE")}
                >
                  <ArrowUpRight className="size-4 mr-1 stroke-[3]" />
                  BUY CALL (CE)
                </Button>
              </CardContent>
            </Card>

            {/* PUT (PE) Card */}
            <Card className="border border-rose-500/40 bg-gradient-to-b from-rose-500/10 via-card to-card shadow-sm hover:border-rose-500/60 transition-all flex flex-col justify-between">
              <CardContent className="p-3 sm:p-4 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <Badge className="bg-rose-500 text-white font-bold text-[10px] px-1.5 py-0">
                    PUT (PE)
                  </Badge>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {indexSymbol}
                  </span>
                </div>

                <div>
                  <div className="text-xs font-semibold text-foreground">
                    {strike || "—"} PE
                  </div>
                  <div className="text-lg sm:text-xl font-extrabold font-mono text-rose-500 mt-0.5">
                    {pePrice != null ? fmtRs(pePrice) : quoteLoading ? "Fetching…" : "—"}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    Est. Margin:{" "}
                    <strong className="text-foreground font-mono">
                      {pePrice ? fmtRs(pePrice * totalQty) : "—"}
                    </strong>
                  </div>
                </div>

                <Button
                  type="button"
                  className="w-full h-11 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs sm:text-sm rounded-xl shadow-md active:scale-95 transition-all mt-1"
                  disabled={!strike || !expiry || pePrice == null || !isKotakConnected}
                  onClick={() => initiateBuyOrder("PE")}
                >
                  <ArrowDownRight className="size-4 mr-1 stroke-[3]" />
                  BUY PUT (PE)
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ================= TAB 2: ACTIVE POSITIONS ================= */}
      {activeTab === "positions" && (
        <div className="flex flex-col gap-3">
          {/* Top Bar for Positions */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-foreground">Active Positions</span>
              <Badge variant="outline" className="text-[10px] font-mono">
                {openPositions.length} Open
              </Badge>
            </div>

            {openPositions.length > 1 && (
              <Button
                variant="destructive"
                size="sm"
                className="h-7 text-xs font-bold px-2.5 bg-rose-600 hover:bg-rose-700"
                onClick={() => setExitAllModalOpen(true)}
              >
                🛑 Close All ({openPositions.length})
              </Button>
            )}
          </div>

          {openPositions.length === 0 ? (
            <Card className="border border-dashed border-border/80 bg-card/50">
              <CardContent className="p-8 flex flex-col items-center justify-center text-center gap-2">
                <div className="size-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
                  <CheckCircle2 className="size-5" />
                </div>
                <div className="text-sm font-semibold text-foreground">No Open Positions</div>
                <p className="text-xs text-muted-foreground max-w-xs">
                  You have zero open risk in your account. Use the Quick Trade tab above to enter your next setup.
                </p>
                <Button
                  size="sm"
                  className="mt-2 text-xs font-semibold"
                  onClick={() => setActiveTab("trade")}
                >
                  Go to Quick Trade
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-2.5">
              {openPositions.map((pos) => {
                const isLong = pos.net_qty > 0
                const currentPnl = pos.unrealized_pnl ?? pos.pnl ?? 0
                const entryAvg = pos.buy_avg || pos.average_price || 0
                const ltp = pos.last_price || 0
                const pnlPercent = entryAvg > 0 ? ((ltp - entryAvg) / entryAvg) * 100 * (isLong ? 1 : -1) : 0

                return (
                  <Card
                    key={pos.symbol}
                    className="border border-border/80 bg-card shadow-xs overflow-hidden"
                  >
                    <CardContent className="p-3 sm:p-4 flex flex-col gap-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <Badge
                              className={cn(
                                "text-[10px] font-bold py-0 px-1.5",
                                isLong ? "bg-emerald-600 text-white" : "bg-rose-600 text-white"
                              )}
                            >
                              {isLong ? "BUY / LONG" : "SELL / SHORT"}
                            </Badge>
                            <span className="text-xs font-bold font-mono tracking-tight text-foreground">
                              {pos.symbol}
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground font-mono mt-1">
                            Qty: <strong className="text-foreground">{Math.abs(pos.net_qty)}</strong> · {pos.product || "NRML"}
                          </div>
                        </div>

                        {/* Large Live P&L Pill */}
                        <div className="text-right">
                          <div
                            className={cn(
                              "text-base sm:text-lg font-extrabold font-mono",
                              currentPnl > 0 ? "text-emerald-500" : currentPnl < 0 ? "text-rose-500" : "text-muted-foreground"
                            )}
                          >
                            {currentPnl > 0 ? "+" : ""}
                            {fmtRs(currentPnl)}
                          </div>
                          <div
                            className={cn(
                              "text-[10px] font-mono font-semibold",
                              pnlPercent >= 0 ? "text-emerald-400" : "text-rose-400"
                            )}
                          >
                            {pnlPercent >= 0 ? "+" : ""}
                            {pnlPercent.toFixed(1)}%
                          </div>
                        </div>
                      </div>

                      {/* Prices & 1-Tap Square Off Button */}
                      <div className="flex items-center justify-between border-t border-border/40 pt-2 text-xs">
                        <div className="flex items-center gap-3 text-[11px] font-mono text-muted-foreground">
                          <div>
                            Avg: <span className="text-foreground font-medium">{fmtRs(entryAvg)}</span>
                          </div>
                          <div>
                            LTP: <span className="text-foreground font-medium">{fmtRs(ltp)}</span>
                          </div>
                        </div>

                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-8 text-xs font-bold px-3 rounded-lg shadow-xs active:scale-95 transition-all"
                          onClick={() => {
                            setPosToExit(pos)
                            setExitModalOpen(true)
                          }}
                        >
                          Square Off
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ================= TAB 3: HISTORY & ORDERS ================= */}
      {activeTab === "history" && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-foreground">Today's Completed Trades</span>
            <span className="text-xs font-mono font-bold text-muted-foreground">
              Total Realized:{" "}
              <strong className={pnlClass(summary.realized_pnl)}>{fmtRs(summary.realized_pnl)}</strong>
            </span>
          </div>

          {closedPositions.length === 0 ? (
            <Card className="border border-dashed border-border/80 bg-card/50">
              <CardContent className="p-6 text-center text-xs text-muted-foreground">
                No closed trades yet today.
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              {closedPositions.map((trade, idx) => (
                <Card key={`${trade.symbol}-${idx}`} className="border border-border/60 bg-card">
                  <CardContent className="p-3 flex items-center justify-between text-xs">
                    <div>
                      <div className="font-bold font-mono text-foreground">{trade.symbol}</div>
                      <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                        Qty: {trade.qty} · Buy: ₹{trade.buy_avg.toFixed(1)} · Sell: ₹{trade.sell_avg.toFixed(1)}
                      </div>
                    </div>
                    <div className="text-right">
                      <span
                        className={cn(
                          "font-bold font-mono text-sm",
                          trade.realized_pnl > 0 ? "text-emerald-500" : trade.realized_pnl < 0 ? "text-rose-500" : "text-muted-foreground"
                        )}
                      >
                        {trade.realized_pnl > 0 ? "+" : ""}
                        {fmtRs(trade.realized_pnl)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ================= DIALOG: CONFIRM ORDER SUBMISSION ================= */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              Confirm Live Order
              <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[10px] py-0">
                ₹0 Brokerage
              </Badge>
            </DialogTitle>
            <DialogDescription className="text-xs">
              Orders execute directly on Kotak Neo Trade API from your deployed machine.
            </DialogDescription>
          </DialogHeader>

          {pendingOrder && (
            <div className="flex flex-col gap-2.5 py-2 text-xs">
              <div className="bg-muted/40 rounded-xl p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Contract:</span>
                  <span className="font-bold font-mono text-foreground">
                    {pendingOrder.strike} {pendingOrder.optionType} ({indexSymbol})
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Quantity:</span>
                  <span className="font-bold font-mono text-foreground">
                    {pendingOrder.qty} Qty ({pendingOrder.lots} {pendingOrder.lots === 1 ? "Lot" : "Lots"})
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Order Type:</span>
                  <span className="font-bold text-foreground">
                    {orderType} {orderType === "LIMIT" ? `@ ₹${pendingOrder.price}` : "(Market LTP)"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Est. Total Value:</span>
                  <span className="font-extrabold font-mono text-base text-foreground">
                    {fmtRs(pendingOrder.price * pendingOrder.qty)}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-border/40 pt-1.5 text-[11px]">
                  <span className="text-emerald-400 font-medium">Kotak Brokerage:</span>
                  <span className="text-emerald-400 font-bold font-mono">₹0.00 FREE</span>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="flex flex-row items-center gap-2 pt-2">
            <Button
              variant="outline"
              className="flex-1 text-xs"
              onClick={() => setConfirmOpen(false)}
              disabled={orderBusy}
            >
              Cancel
            </Button>
            <Button
              className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs"
              onClick={() => void submitOrder()}
              disabled={orderBusy}
            >
              {orderBusy ? "Placing..." : "Confirm & Buy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ================= DIALOG: CONFIRM SQUARE OFF ================= */}
      <Dialog open={exitModalOpen} onOpenChange={setExitModalOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2 text-rose-500">
              <AlertTriangle className="size-5" />
              Square Off Position?
            </DialogTitle>
            <DialogDescription className="text-xs">
              This will send an immediate market order to close your position on Kotak Neo.
            </DialogDescription>
          </DialogHeader>

          {posToExit && (
            <div className="bg-muted/40 rounded-xl p-3 flex flex-col gap-1.5 text-xs">
              <div className="font-bold font-mono text-foreground">{posToExit.symbol}</div>
              <div className="text-muted-foreground font-mono">
                Quantity: {Math.abs(posToExit.net_qty)} · Current P&L:{" "}
                <strong className={pnlClass(posToExit.unrealized_pnl ?? 0)}>
                  {fmtRs(posToExit.unrealized_pnl ?? 0)}
                </strong>
              </div>
            </div>
          )}

          <DialogFooter className="flex flex-row items-center gap-2 pt-2">
            <Button
              variant="outline"
              className="flex-1 text-xs"
              onClick={() => setExitModalOpen(false)}
              disabled={orderBusy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1 text-xs font-bold bg-rose-600 hover:bg-rose-700"
              onClick={() => posToExit && void executeExit(posToExit)}
              disabled={orderBusy}
            >
              {orderBusy ? "Closing..." : "Yes, Square Off"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ================= DIALOG: EMERGENCY EXIT ALL ================= */}
      <Dialog open={exitAllModalOpen} onOpenChange={setExitAllModalOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2 text-rose-500">
              <ShieldAlert className="size-5" />
              Exit ALL Open Positions?
            </DialogTitle>
            <DialogDescription className="text-xs">
              This will immediately square off ALL {openPositions.length} active positions on Kotak Neo.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="flex flex-row items-center gap-2 pt-2">
            <Button
              variant="outline"
              className="flex-1 text-xs"
              onClick={() => setExitAllModalOpen(false)}
              disabled={orderBusy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1 text-xs font-bold bg-rose-600 hover:bg-rose-700"
              onClick={() => void executeExitAll()}
              disabled={orderBusy}
            >
              {orderBusy ? "Closing All..." : "Exit Everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

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
    <div className="flex flex-col h-full max-h-full w-full max-w-md mx-auto overflow-hidden justify-between p-1 sm:p-2 select-none">
      {/* 1. Ultra-Compact Top Summary Bar */}
      <div className="shrink-0 flex items-center justify-between bg-card/90 border border-border/80 rounded-xl px-2.5 py-1.5 shadow-2xs backdrop-blur-xs mb-1.5">
        <div className="flex items-center gap-1.5">
          <Wallet className="size-3.5 text-primary" />
          <div className="flex flex-col leading-none">
            <span className="text-[9px] text-muted-foreground uppercase font-semibold">Margin</span>
            <span className="text-xs font-bold font-mono text-foreground">
              {availableFunds != null ? fmtRs(availableFunds) : "₹37,258"}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Badge variant="outline" className="text-[9px] py-0 px-1.5 bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
            ₹0 Brokerage
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => void reloadAll()}
            title="Refresh"
          >
            <RefreshCw className={cn("size-3", (positionsPoll.loading || fundsPoll.loading) && "animate-spin")} />
          </Button>
        </div>

        <div className="flex flex-col items-end leading-none">
          <span className="text-[9px] text-muted-foreground uppercase font-semibold">Today P&L</span>
          <span
            className={cn(
              "text-xs font-extrabold font-mono",
              summary.net_pnl > 0 ? "text-emerald-500" : summary.net_pnl < 0 ? "text-rose-500" : "text-muted-foreground"
            )}
          >
            {summary.net_pnl > 0 ? "+" : ""}
            {fmtRs(summary.net_pnl)}
          </span>
        </div>
      </div>

      {/* 2. Compact Mobile Navigation Tabs */}
      <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as any)} className="w-full shrink-0 mb-1.5">
        <TabsList className="grid grid-cols-3 w-full bg-muted/60 p-0.5 rounded-lg h-7">
          <TabsTrigger value="trade" className="text-[11px] font-semibold py-0.5 rounded-md data-[state=active]:bg-background">
            <Zap className="size-3 mr-1 text-amber-500" />
            Trade
          </TabsTrigger>
          <TabsTrigger value="positions" className="text-[11px] font-semibold py-0.5 rounded-md data-[state=active]:bg-background relative">
            <TrendingUp className="size-3 mr-1 text-primary" />
            Positions
            {openPositions.length > 0 && (
              <span className="ml-1 px-1 py-0 rounded-full text-[9px] font-bold bg-primary text-primary-foreground">
                {openPositions.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className="text-[11px] font-semibold py-0.5 rounded-md data-[state=active]:bg-background">
            <Clock className="size-3 mr-1 text-muted-foreground" />
            History ({closedPositions.length})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* ================= TAB 1: QUICK TRADE (ZERO-SCROLL FIT) ================= */}
      {activeTab === "trade" && (
        <div className="flex-1 flex flex-col min-h-0 justify-between gap-1.5">
          {/* Top Panel: Instrument, Expiry, Strike & Lots */}
          <Card className="border border-border/80 bg-card/95 shadow-2xs shrink-0">
            <CardContent className="p-2 sm:p-2.5 flex flex-col gap-1.5">
              {/* Row 1: Index Switcher & Expiry */}
              <div className="flex items-center justify-between gap-1.5">
                <div className="grid grid-cols-2 gap-1 flex-1">
                  <button
                    type="button"
                    onClick={() => {
                      setIndexSymbol("NIFTY")
                      setStrike("")
                    }}
                    className={cn(
                      "py-1 px-2 rounded-lg text-left transition-all border",
                      indexSymbol === "NIFTY"
                        ? "bg-primary text-primary-foreground font-bold border-primary shadow-xs"
                        : "bg-muted/40 border-border/60 text-muted-foreground hover:bg-muted"
                    )}
                  >
                    <div className="text-[11px] font-bold leading-tight">NIFTY 50</div>
                    <div className="text-[9px] font-mono opacity-80 leading-tight">
                      {spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 0 })} · 65Q
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setIndexSymbol("SENSEX")
                      setStrike("")
                    }}
                    className={cn(
                      "py-1 px-2 rounded-lg text-left transition-all border",
                      indexSymbol === "SENSEX"
                        ? "bg-primary text-primary-foreground font-bold border-primary shadow-xs"
                        : "bg-muted/40 border-border/60 text-muted-foreground hover:bg-muted"
                    )}
                  >
                    <div className="text-[11px] font-bold leading-tight">SENSEX</div>
                    <div className="text-[9px] font-mono opacity-80 leading-tight">
                      {indexSymbol === "SENSEX" ? spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : "82,032"} · 20Q
                    </div>
                  </button>
                </div>

                <div className="shrink-0">
                  <Select value={expiry} onValueChange={(val) => val && setExpiry(val)}>
                    <SelectTrigger className="h-8 text-[11px] font-semibold border-border/80 bg-background px-2 py-0">
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

              {/* Row 2: 5 Strike Chips around ATM + Custom Dropdown */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-foreground flex items-center gap-1 text-[10px] uppercase">
                    <Sparkles className="size-2.5 text-amber-500" /> Strike (ATM: {atmStrike})
                  </span>
                  <Select value={strike} onValueChange={(val) => val && setStrike(val)}>
                    <SelectTrigger className="h-5 w-20 text-[10px] font-mono border-border/70 px-1 py-0">
                      <SelectValue placeholder="All" />
                    </SelectTrigger>
                    <SelectContent className="max-h-48">
                      {(selectedExpiry?.strikes ?? []).map((s) => (
                        <SelectItem key={s} value={String(s)} className="text-xs font-mono">
                          {s.toLocaleString("en-IN")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-5 gap-1">
                  {quickStrikes.map((s) => {
                    const isSelected = String(s) === strike
                    const isAtm = s === atmStrike
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setStrike(String(s))}
                        className={cn(
                          "py-1 px-0.5 rounded-md text-center transition-all flex flex-col items-center justify-center leading-tight",
                          isSelected
                            ? "bg-primary text-primary-foreground font-bold shadow-xs ring-1 ring-primary/40"
                            : isAtm
                            ? "bg-amber-500/15 border border-amber-500/40 text-amber-400 font-semibold"
                            : "bg-muted/40 border border-border/60 text-muted-foreground hover:bg-muted"
                        )}
                      >
                        <span className="text-[10px] sm:text-[11px] font-mono font-bold">
                          {s}
                        </span>
                        <span className="text-[8px] opacity-75">
                          {isAtm ? "ATM" : s > atmStrike ? `+${s - atmStrike}` : `${s - atmStrike}`}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Row 3: Lots, Product & Order Type */}
              <div className="flex items-center justify-between gap-1 pt-1 border-t border-border/40 text-xs">
                {/* Lots Stepper */}
                <div className="flex items-center border border-border rounded-lg bg-muted/20 p-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 rounded-md"
                    onClick={() => setLots((prev) => Math.max(1, prev - 1))}
                    disabled={lots <= 1}
                  >
                    <Minus className="size-3" />
                  </Button>
                  <div className="w-10 text-center font-bold font-mono text-xs">
                    {lots}L
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 rounded-md"
                    onClick={() => setLots((prev) => Math.min(20, prev + 1))}
                  >
                    <Plus className="size-3" />
                  </Button>
                </div>

                {/* Quick Lot Chips */}
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 5].map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => setLots(l)}
                      className={cn(
                        "px-1.5 py-0.5 rounded text-[10px] font-mono border",
                        lots === l
                          ? "bg-secondary text-secondary-foreground font-bold border-secondary"
                          : "bg-muted/30 border-border/50 text-muted-foreground"
                      )}
                    >
                      {l}L
                    </button>
                  ))}
                </div>

                {/* Product & Qty Info */}
                <div className="flex items-center gap-1 text-[10px] font-mono">
                  <span className="text-muted-foreground">{totalQty}Q</span>
                  <button
                    type="button"
                    onClick={() => setProduct(product === "NRML" ? "MIS" : "NRML")}
                    className="font-bold text-foreground bg-muted hover:bg-muted/80 px-1.5 py-0.5 rounded border border-border/60"
                    title="Toggle NRML / MIS"
                  >
                    {product}
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrderType(orderType === "MARKET" ? "LIMIT" : "MARKET")}
                    className={cn(
                      "px-1.5 py-0.5 rounded border font-semibold",
                      orderType === "MARKET" ? "bg-primary/20 text-primary border-primary/40" : "border-border/60 text-muted-foreground"
                    )}
                  >
                    {orderType === "MARKET" ? "MKT" : "LMT"}
                  </button>
                </div>
              </div>

              {orderType === "LIMIT" && (
                <div className="flex items-center gap-2 bg-muted/30 p-1 rounded-md">
                  <Label htmlFor="limit-price" className="text-[10px] whitespace-nowrap">
                    Limit Price (₹):
                  </Label>
                  <Input
                    id="limit-price"
                    type="number"
                    step="0.05"
                    min="0.05"
                    placeholder="Limit price"
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value)}
                    className="h-6 text-xs font-mono"
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Bottom Panel: Two Big Action Cards (CE vs PE) taking remaining screen height */}
          <div className="flex-1 min-h-0 grid grid-cols-2 gap-2">
            {/* CALL (CE) Card */}
            <Card className="border border-emerald-500/40 bg-gradient-to-b from-emerald-500/10 via-card to-card shadow-xs flex flex-col justify-between overflow-hidden">
              <CardContent className="p-2.5 flex-1 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <Badge className="bg-emerald-600 text-white font-bold text-[9px] px-1 py-0">
                      CALL (CE)
                    </Badge>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {strike || "—"}
                    </span>
                  </div>

                  <div className="mt-1">
                    <div className="text-xl sm:text-2xl font-black font-mono text-emerald-500 tracking-tight">
                      {cePrice != null ? fmtRs(cePrice) : quoteLoading ? "…" : "—"}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                      Req: <strong className="text-foreground">{cePrice ? fmtRs(cePrice * totalQty) : "—"}</strong>
                    </div>
                  </div>
                </div>

                <Button
                  type="button"
                  className="w-full h-11 bg-emerald-600 hover:bg-emerald-500 text-white font-black text-xs sm:text-sm rounded-xl shadow-md active:scale-95 transition-all mt-2"
                  disabled={!strike || !expiry || cePrice == null || !isKotakConnected}
                  onClick={() => initiateBuyOrder("CE")}
                >
                  <ArrowUpRight className="size-4 mr-0.5 stroke-[3]" />
                  BUY CE
                </Button>
              </CardContent>
            </Card>

            {/* PUT (PE) Card */}
            <Card className="border border-rose-500/40 bg-gradient-to-b from-rose-500/10 via-card to-card shadow-xs flex flex-col justify-between overflow-hidden">
              <CardContent className="p-2.5 flex-1 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <Badge className="bg-rose-600 text-white font-bold text-[9px] px-1 py-0">
                      PUT (PE)
                    </Badge>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {strike || "—"}
                    </span>
                  </div>

                  <div className="mt-1">
                    <div className="text-xl sm:text-2xl font-black font-mono text-rose-500 tracking-tight">
                      {pePrice != null ? fmtRs(pePrice) : quoteLoading ? "…" : "—"}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                      Req: <strong className="text-foreground">{pePrice ? fmtRs(pePrice * totalQty) : "—"}</strong>
                    </div>
                  </div>
                </div>

                <Button
                  type="button"
                  className="w-full h-11 bg-rose-600 hover:bg-rose-500 text-white font-black text-xs sm:text-sm rounded-xl shadow-md active:scale-95 transition-all mt-2"
                  disabled={!strike || !expiry || pePrice == null || !isKotakConnected}
                  onClick={() => initiateBuyOrder("PE")}
                >
                  <ArrowDownRight className="size-4 mr-0.5 stroke-[3]" />
                  BUY PE
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ================= TAB 2: ACTIVE POSITIONS (SCROLLABLE CONTAINER) ================= */}
      {activeTab === "positions" && (
        <div className="flex-1 min-h-0 flex flex-col justify-between gap-1.5 overflow-hidden">
          <div className="flex items-center justify-between shrink-0 px-0.5">
            <span className="text-xs font-bold text-foreground">
              Positions ({openPositions.length})
            </span>
            {openPositions.length > 1 && (
              <Button
                variant="destructive"
                size="sm"
                className="h-6 text-[11px] font-bold px-2 bg-rose-600 hover:bg-rose-700"
                onClick={() => setExitAllModalOpen(true)}
              >
                🛑 Close All ({openPositions.length})
              </Button>
            )}
          </div>

          {openPositions.length === 0 ? (
            <Card className="border border-dashed border-border/80 bg-card/50 flex-1 flex items-center justify-center">
              <CardContent className="p-4 flex flex-col items-center justify-center text-center gap-1.5">
                <CheckCircle2 className="size-8 text-muted-foreground opacity-60" />
                <div className="text-xs font-semibold text-foreground">No Open Positions</div>
                <p className="text-[10px] text-muted-foreground">Zero open risk in your account.</p>
                <Button size="sm" className="h-7 text-xs font-semibold mt-1" onClick={() => setActiveTab("trade")}>
                  Go to Quick Trade
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 pr-0.5">
              {openPositions.map((pos) => {
                const isLong = pos.net_qty > 0
                const currentPnl = pos.unrealized_pnl ?? pos.pnl ?? 0
                const entryAvg = pos.buy_avg || pos.average_price || 0
                const ltp = pos.last_price || 0
                const pnlPercent = entryAvg > 0 ? ((ltp - entryAvg) / entryAvg) * 100 * (isLong ? 1 : -1) : 0

                return (
                  <Card key={pos.symbol} className="border border-border/80 bg-card shadow-2xs">
                    <CardContent className="p-2 sm:p-2.5 flex flex-col gap-1.5">
                      <div className="flex items-start justify-between gap-1">
                        <div>
                          <div className="flex items-center gap-1">
                            <Badge
                              className={cn(
                                "text-[9px] font-bold py-0 px-1",
                                isLong ? "bg-emerald-600 text-white" : "bg-rose-600 text-white"
                              )}
                            >
                              {isLong ? "BUY" : "SELL"}
                            </Badge>
                            <span className="text-[11px] font-bold font-mono tracking-tight text-foreground truncate max-w-[140px]">
                              {pos.symbol}
                            </span>
                          </div>
                          <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                            Qty: <strong className="text-foreground">{Math.abs(pos.net_qty)}</strong> · Avg: ₹{entryAvg.toFixed(1)}
                          </div>
                        </div>

                        <div className="text-right">
                          <div
                            className={cn(
                              "text-sm sm:text-base font-extrabold font-mono",
                              currentPnl > 0 ? "text-emerald-500" : currentPnl < 0 ? "text-rose-500" : "text-muted-foreground"
                            )}
                          >
                            {currentPnl > 0 ? "+" : ""}
                            {fmtRs(currentPnl)}
                          </div>
                          <div
                            className={cn(
                              "text-[9px] font-mono font-semibold",
                              pnlPercent >= 0 ? "text-emerald-400" : "text-rose-400"
                            )}
                          >
                            {pnlPercent >= 0 ? "+" : ""}
                            {pnlPercent.toFixed(1)}%
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between border-t border-border/40 pt-1 text-[11px]">
                        <span className="text-[10px] text-muted-foreground font-mono">
                          LTP: <strong className="text-foreground">₹{ltp.toFixed(1)}</strong>
                        </span>
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-6 text-[10px] font-bold px-2 rounded-md"
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

      {/* ================= TAB 3: HISTORY (SCROLLABLE CONTAINER) ================= */}
      {activeTab === "history" && (
        <div className="flex-1 min-h-0 flex flex-col justify-between gap-1.5 overflow-hidden">
          <div className="flex items-center justify-between shrink-0 px-0.5 text-xs">
            <span className="font-bold text-foreground">Completed Trades</span>
            <span className="font-mono text-muted-foreground">
              Total: <strong className={pnlClass(summary.realized_pnl)}>{fmtRs(summary.realized_pnl)}</strong>
            </span>
          </div>

          {closedPositions.length === 0 ? (
            <Card className="border border-dashed border-border/80 bg-card/50 flex-1 flex items-center justify-center">
              <CardContent className="p-4 text-center text-xs text-muted-foreground">
                No closed trades yet today.
              </CardContent>
            </Card>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1 pr-0.5">
              {closedPositions.map((trade, idx) => (
                <Card key={`${trade.symbol}-${idx}`} className="border border-border/60 bg-card">
                  <CardContent className="p-2 flex items-center justify-between text-xs">
                    <div>
                      <div className="font-bold font-mono text-[11px] text-foreground">{trade.symbol}</div>
                      <div className="text-[9px] text-muted-foreground font-mono">
                        {trade.qty}Q · Buy: ₹{trade.buy_avg.toFixed(1)} · Sell: ₹{trade.sell_avg.toFixed(1)}
                      </div>
                    </div>
                    <div className="text-right">
                      <span
                        className={cn(
                          "font-bold font-mono text-xs sm:text-sm",
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
        <DialogContent className="max-w-xs rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm font-bold flex items-center gap-1.5">
              Confirm Live Order
              <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[9px] py-0">
                ₹0 Brokerage
              </Badge>
            </DialogTitle>
          </DialogHeader>

          {pendingOrder && (
            <div className="flex flex-col gap-2 py-1 text-xs">
              <div className="bg-muted/40 rounded-xl p-2.5 flex flex-col gap-1.5 font-mono">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Contract:</span>
                  <span className="font-bold text-foreground">
                    {pendingOrder.strike} {pendingOrder.optionType}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Quantity:</span>
                  <span className="font-bold text-foreground">
                    {pendingOrder.qty} Qty ({pendingOrder.lots}L)
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Est. Value:</span>
                  <span className="font-black text-sm text-foreground">
                    {fmtRs(pendingOrder.price * pendingOrder.qty)}
                  </span>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="flex flex-row items-center gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 text-xs"
              onClick={() => setConfirmOpen(false)}
              disabled={orderBusy}
            >
              Cancel
            </Button>
            <Button
              size="sm"
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
        <DialogContent className="max-w-xs rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm font-bold flex items-center gap-1.5 text-rose-500">
              <AlertTriangle className="size-4" />
              Square Off Position?
            </DialogTitle>
          </DialogHeader>

          {posToExit && (
            <div className="bg-muted/40 rounded-xl p-2 flex flex-col gap-1 text-xs font-mono">
              <div className="font-bold text-foreground truncate">{posToExit.symbol}</div>
              <div className="text-muted-foreground">
                Qty: {Math.abs(posToExit.net_qty)} · P&L:{" "}
                <strong className={pnlClass(posToExit.unrealized_pnl ?? 0)}>
                  {fmtRs(posToExit.unrealized_pnl ?? 0)}
                </strong>
              </div>
            </div>
          )}

          <DialogFooter className="flex flex-row items-center gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 text-xs"
              onClick={() => setExitModalOpen(false)}
              disabled={orderBusy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="flex-1 text-xs font-bold bg-rose-600 hover:bg-rose-700"
              onClick={() => posToExit && void executeExit(posToExit)}
              disabled={orderBusy}
            >
              {orderBusy ? "Closing..." : "Yes, Exit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ================= DIALOG: EMERGENCY EXIT ALL ================= */}
      <Dialog open={exitAllModalOpen} onOpenChange={setExitAllModalOpen}>
        <DialogContent className="max-w-xs rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm font-bold flex items-center gap-1.5 text-rose-500">
              <ShieldAlert className="size-4" />
              Exit ALL Positions?
            </DialogTitle>
            <DialogDescription className="text-xs">
              This will immediately square off ALL {openPositions.length} active positions.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="flex flex-row items-center gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 text-xs"
              onClick={() => setExitAllModalOpen(false)}
              disabled={orderBusy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="flex-1 text-xs font-bold bg-rose-600 hover:bg-rose-700"
              onClick={() => void executeExitAll()}
              disabled={orderBusy}
            >
              {orderBusy ? "Closing..." : "Exit All"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

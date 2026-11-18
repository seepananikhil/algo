import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Plus,
  Minus,
  Clock,
  Target,
  Shield,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  fmtRs,
  pnlClass,
  postJSON,
  usePoll,
  type ManualOptionChoices,
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
  is_demo?: boolean
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

  // Expiry selection
  const [expiry, setExpiry] = useState<string>("")

  // Trading parameters
  const [strike, setStrike] = useState("")
  const [lots, setLots] = useState(1)
  const [product] = useState<"NRML" | "MIS">("NRML")

  // Scalper Target & Stop Loss points
  const [slPts, setSlPts] = useState<number>(10)
  const [tpPts, setTpPts] = useState<number>(15)

  // Simulation Toggle (Demo Mode to inspect Open Position HUD)
  const [simulateOpen, setSimulateOpen] = useState(false)

  // Quotes
  const [cePrice, setCePrice] = useState<number | null>(null)
  const [pePrice, setPePrice] = useState<number | null>(null)
  const [ceSymbol, setCeSymbol] = useState<string>("")
  const [peSymbol, setPeSymbol] = useState<string>("")
  const [quoteLoading, setQuoteLoading] = useState(false)

  // Action busy states
  const [actionBusy, setActionBusy] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  // Expiries from symbol master (chronologically sorted)
  const expiries = optionsPoll.data?.expiries ?? []

  // Always default to current week expiry (first item) whenever expiries load or index switches
  useEffect(() => {
    if (expiries.length > 0) {
      if (!expiry || !expiries.some((e) => e.expiry === expiry)) {
        setExpiry(expiries[0].expiry)
      }
    }
  }, [expiries, indexSymbol])

  const selectedExpiryGroup = expiries.find((e) => e.expiry === expiry) || expiries[0]
  const currentExpiry = selectedExpiryGroup?.expiry ?? ""
  const isCurrentWeek = expiries.length > 0 && expiries[0]?.expiry === currentExpiry
  const lotSize = selectedExpiryGroup?.lot_size ?? (indexSymbol === "SENSEX" ? 20 : 65)
  const atmStrike = optionsPoll.data?.atm ?? (indexSymbol === "SENSEX" ? 82000 : 25250)
  const spotPrice = optionsPoll.data?.spot ?? (indexSymbol === "SENSEX" ? 82031.8 : 25227.95)
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

  // Automatically default strike to ATM on load or instrument switch
  useEffect(() => {
    if (atmStrike > 0) {
      setStrike(String(atmStrike))
    }
  }, [atmStrike, indexSymbol])

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

  // Active positions to display (Real or Simulated)
  const displayPositions: OpenPosition[] = openPositions.length > 0
    ? openPositions
    : simulateOpen
    ? [
        {
          symbol: `${indexSymbol} ${strike || atmStrike} CE`,
          net_qty: totalQty,
          buy_avg: cePrice || 142.5,
          ltp: (cePrice || 142.5) + 13.5,
          unrealized_pnl: Math.round(13.5 * totalQty),
          is_demo: true,
        },
      ]
    : []

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
      await positionsPoll.reload()
      await fundsPoll.reload()
    } catch (err: any) {
      toast.error("Order Rejected", { description: String(err?.message || err) })
    } finally {
      setActionBusy(false)
    }
  }

  // 1-TAP INSTANT EXIT
  async function hitExit(pos: OpenPosition) {
    if (pos.is_demo) {
      setSimulateOpen(false)
      toast.success("Demo Position Squared Off!", { description: "Simulation exited at market" })
      return
    }

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

  // 1-TAP TRAIL TO BREAKEVEN
  async function moveToBreakeven(pos: OpenPosition) {
    if (pos.is_demo) {
      toast.success("Demo SL Moved to Breakeven!", { description: "Protected entry @ ₹" + (pos.buy_avg || 142.5).toFixed(1) })
      return
    }

    const entry = pos.buy_avg || pos.average_price || 0
    if (entry <= 0) return
    try {
      await postJSON("/api/update-tp-tl", {
        symbol: pos.symbol,
        tp_pts: pos.tp_pts || tpPts || 15,
        tl_pts: 0.5,
        entry_price: entry,
        qty: Math.abs(pos.net_qty),
      })
      toast.success("SL Moved to Breakeven!", { description: `Protected entry @ ₹${entry.toFixed(1)}` })
      await positionsPoll.reload()
    } catch (err: any) {
      toast.error("Failed to move SL", { description: String(err?.message || err) })
    }
  }

  return (
    <div className="flex flex-col w-full max-w-sm mx-auto p-2 gap-2 select-none text-foreground bg-background">
      
      {/* ─── 1. TOPMOST HEADER: DAY P&L + AVAILABLE BALANCE + ACTIONS ─── */}
      <div className="flex items-center justify-between p-2.5 rounded-2xl bg-card border border-border/50 shadow-2xs">
        {/* Day P&L */}
        <div className="flex flex-col">
          <span className="text-[9px] uppercase font-bold tracking-wider text-muted-foreground leading-none">
            DAY'S P&L {closedPositions.length > 0 ? `(${closedPositions.length})` : ""}
          </span>
          <div
            className={cn(
              "text-xl font-black font-mono tracking-tight mt-0.5",
              summary.net_pnl > 0 ? "text-emerald-500" : summary.net_pnl < 0 ? "text-rose-500" : "text-muted-foreground"
            )}
          >
            {summary.net_pnl > 0 ? "+" : ""}
            {fmtRs(summary.net_pnl)}
          </div>
        </div>

        {/* Available Trading Margin */}
        <div className="flex flex-col items-center">
          <span className="text-[9px] uppercase font-bold tracking-wider text-muted-foreground leading-none">
            AVAIL BALANCE
          </span>
          <div className="text-sm font-black font-mono text-foreground mt-0.5">
            {availableFunds != null ? fmtRs(availableFunds) : isKotakConnected ? "₹37,258" : "—"}
          </div>
        </div>

        {/* Demo & History Controls */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSimulateOpen((v) => !v)}
            className={cn(
              "text-[9px] font-mono px-2 py-1 rounded-lg border font-bold transition-all cursor-pointer",
              simulateOpen
                ? "bg-amber-500/20 text-amber-500 border-amber-500/40"
                : "bg-muted/40 border-border/60 text-muted-foreground hover:text-foreground"
            )}
            title="Toggle simulated trade HUD"
          >
            {simulateOpen ? "Demo On" : "👁️ Demo"}
          </button>

          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="text-[9px] font-mono px-2 py-1 rounded-lg border border-border/60 bg-muted/40 text-muted-foreground hover:text-foreground font-bold cursor-pointer"
            title="View today's closed trades"
          >
            History
          </button>
        </div>
      </div>

      {/* ─── 2. INDEX SWITCHER & DEFAULT CURRENT WEEK EXPIRY ─── */}
      <div className="flex flex-col gap-1">
        <div className="grid grid-cols-2 gap-2">
          {/* NIFTY Button */}
          <button
            type="button"
            onClick={() => {
              setIndexSymbol("NIFTY")
              setStrike("")
            }}
            className={cn(
              "p-2 rounded-2xl border transition-all text-left flex flex-col justify-between cursor-pointer",
              indexSymbol === "NIFTY"
                ? "bg-primary/10 border-primary shadow-xs ring-1 ring-primary/30"
                : "bg-card border-border/50 hover:bg-muted/30"
            )}
          >
            <div className="flex items-center justify-between w-full">
              <span className="text-xs font-black font-mono">NIFTY 50</span>
              <span className="text-[10px] text-muted-foreground font-mono font-bold">65 Q</span>
            </div>
            <div className="text-lg font-black font-mono mt-0.5 text-foreground flex items-baseline gap-1">
              <span>{spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 1 })}</span>
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
            </div>
          </button>

          {/* SENSEX Button */}
          <button
            type="button"
            onClick={() => {
              setIndexSymbol("SENSEX")
              setStrike("")
            }}
            className={cn(
              "p-2 rounded-2xl border transition-all text-left flex flex-col justify-between cursor-pointer",
              indexSymbol === "SENSEX"
                ? "bg-primary/10 border-primary shadow-xs ring-1 ring-primary/30"
                : "bg-card border-border/50 hover:bg-muted/30"
            )}
          >
            <div className="flex items-center justify-between w-full">
              <span className="text-xs font-black font-mono">SENSEX</span>
              <span className="text-[10px] text-muted-foreground font-mono font-bold">20 Q</span>
            </div>
            <div className="text-lg font-black font-mono mt-0.5 text-foreground flex items-baseline gap-1">
              <span>{indexSymbol === "SENSEX" ? spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 1 }) : "82,031.8"}</span>
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
            </div>
          </button>
        </div>

        {/* Current Week Expiry: Defaults to current weekly, selectable if next week needed */}
        <div className="flex items-center justify-between px-1 text-xs font-mono text-muted-foreground">
          <span className="text-[10px] font-semibold flex items-center gap-1">
            📅 Expiry:
          </span>
          {expiries.length > 0 && (
            <Select value={expiry} onValueChange={(val) => val && setExpiry(val)}>
              <SelectTrigger className="h-6 text-[11px] font-mono font-bold px-2 py-0 border-border/50 bg-card rounded-lg gap-1">
                <SelectValue placeholder="Expiry">
                  {formatExpiryLabel(expiry)} {isCurrentWeek ? "(Current Week)" : ""}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {expiries.map((exp, idx) => (
                  <SelectItem key={exp.expiry} value={exp.expiry} className="text-xs font-mono">
                    {formatExpiryLabel(exp.expiry)} {idx === 0 ? "★ Current Week" : idx === 1 ? "Next Week" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* ─── 3. ACTIVE TRADE HUD (COMPACT & CLEAN, DOES NOT PUSH BUTTONS BELOW) ─── */}
      {displayPositions.length > 0 && (
        <div className="flex flex-col gap-1 animate-in fade-in">
          {displayPositions.map((pos) => {
            const isLong = pos.net_qty > 0
            const tradePnl = pos.unrealized_pnl ?? pos.pnl ?? 0
            const entryAvg = pos.buy_avg || pos.average_price || 0
            const ltp = pos.ltp || pos.last_price || 0
            const ptsDiff = isLong ? ltp - entryAvg : entryAvg - ltp
            const pnlPercent = entryAvg > 0 ? (ptsDiff / entryAvg) * 100 : 0

            return (
              <div
                key={pos.symbol}
                className={cn(
                  "p-2 rounded-2xl border-2 flex items-center justify-between gap-2 shadow-md transition-all",
                  pos.is_demo
                    ? "bg-amber-500/10 border-amber-500/50"
                    : tradePnl >= 0
                    ? "bg-emerald-500/10 border-emerald-500/60"
                    : "bg-rose-500/10 border-rose-500/60"
                )}
              >
                {/* Position Details & Live P&L */}
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-mono font-bold text-foreground">
                    <span className={cn("text-[9px] px-1 py-0.2 rounded font-black", isLong ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/20 text-rose-600 dark:text-rose-400")}>
                      {isLong ? "LONG" : "SHORT"}
                    </span>
                    <span className="truncate">{pos.symbol}</span>
                    <span className="text-[10px] text-muted-foreground">({Math.abs(pos.net_qty)}Q)</span>
                    {pos.is_demo && (
                      <span className="text-[8px] bg-amber-500/20 text-amber-500 px-1 rounded font-bold">DEMO</span>
                    )}
                  </div>

                  <div className="flex items-baseline gap-1.5 mt-0.5">
                    <span className={cn("text-lg font-black font-mono tracking-tight leading-none", tradePnl >= 0 ? "text-emerald-500" : "text-rose-500")}>
                      {tradePnl >= 0 ? "+" : ""}{fmtRs(tradePnl)}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground font-bold">
                      ({ptsDiff >= 0 ? "+" : ""}{ptsDiff.toFixed(1)}pt · {pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%)
                    </span>
                  </div>
                </div>

                {/* Quick Actions: Breakeven & One-Touch Exit */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => moveToBreakeven(pos)}
                    className="text-[10px] font-bold text-amber-500 bg-amber-500/15 border border-amber-500/30 px-2 py-2 rounded-xl hover:bg-amber-500/25 active:scale-95 cursor-pointer"
                    title="Move SL to breakeven"
                  >
                    ⚡ BE
                  </button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={actionBusy}
                    onClick={() => hitExit(pos)}
                    className="h-9 px-3 text-xs font-black rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-95 shadow-md tracking-wider cursor-pointer"
                  >
                    EXIT
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ─── 4. STRIKE STEPPER ─── */}
      <div className="flex items-center justify-between p-1.5 px-3 rounded-2xl bg-card border border-border/50 shadow-2xs">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 rounded-xl bg-muted/40 border border-border/60 hover:bg-muted active:scale-90"
          onClick={() => stepStrike(-1)}
        >
          <Minus className="size-4" />
        </Button>

        <div className="text-center">
          <div className="text-[9px] uppercase font-bold tracking-wider text-muted-foreground leading-none mb-0.5">
            STRIKE PRICE
          </div>
          <div className="text-xl font-black font-mono tracking-tight text-foreground flex items-center justify-center gap-1.5">
            {strike || atmStrike}
            {Number(strike) === atmStrike && (
              <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-500 font-bold border border-amber-500/30">
                ATM
              </span>
            )}
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 rounded-xl bg-muted/40 border border-border/60 hover:bg-muted active:scale-90"
          onClick={() => stepStrike(1)}
        >
          <Plus className="size-4" />
        </Button>
      </div>

      {/* ─── 5. LOTS PICKER & RISK ROW (COMPACT ALL-IN-ONE) ─── */}
      <div className="flex flex-col gap-1.5 p-2 rounded-2xl bg-card border border-border/50 shadow-2xs">
        {/* Lots Stepper & Total Qty */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 rounded-lg bg-muted/40 border border-border/60 hover:bg-muted active:scale-90"
              onClick={() => setLots((l) => Math.max(1, l - 1))}
              disabled={lots <= 1}
            >
              <Minus className="size-3" />
            </Button>

            <span className="text-xs font-black font-mono text-foreground">
              {lots} {lots === 1 ? "Lot" : "Lots"}
            </span>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 rounded-lg bg-muted/40 border border-border/60 hover:bg-muted active:scale-90"
              onClick={() => setLots((l) => Math.min(20, l + 1))}
            >
              <Plus className="size-3" />
            </Button>
          </div>

          <span className="text-[11px] font-mono font-bold text-muted-foreground">
            Total: <strong className="text-primary">{totalQty} Qty</strong>
          </span>
        </div>

        {/* Quick Chips Row */}
        <div className="grid grid-cols-5 gap-1 pt-1 border-t border-border/30">
          {[1, 2, 3, 5, 10].map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLots(l)}
              className={cn(
                "py-1 rounded-lg text-[11px] font-mono font-bold border transition-all cursor-pointer text-center",
                lots === l
                  ? "bg-foreground text-background border-foreground shadow-xs"
                  : "bg-muted/40 border-border/50 text-muted-foreground hover:text-foreground"
              )}
            >
              {l}L
            </button>
          ))}
        </div>

        {/* SL & Target Grid */}
        <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-border/30">
          {/* SL */}
          <div className="flex items-center justify-between bg-muted/30 p-1.5 rounded-xl border border-border/40">
            <div className="flex flex-col">
              <span className="text-[9px] font-bold text-rose-500 uppercase flex items-center gap-0.5 leading-none">
                <Shield className="size-2.5" /> SL
              </span>
              <span className="text-[9px] font-mono text-muted-foreground mt-0.5">
                {slPts > 0 ? `-${(slPts * totalQty).toFixed(0)} ₹` : "Off"}
              </span>
            </div>
            <div className="relative flex items-center w-14">
              <Input
                type="number"
                min="0"
                value={slPts || ""}
                onChange={(e) => setSlPts(Math.max(0, parseFloat(e.target.value) || 0))}
                className="h-6 text-center text-xs font-mono font-bold bg-background border border-border/60 p-0 rounded-md pr-5"
              />
              <span className="absolute right-1 text-[9px] font-mono text-muted-foreground pointer-events-none">pt</span>
            </div>
          </div>

          {/* Target */}
          <div className="flex items-center justify-between bg-muted/30 p-1.5 rounded-xl border border-border/40">
            <div className="flex flex-col">
              <span className="text-[9px] font-bold text-emerald-500 uppercase flex items-center gap-0.5 leading-none">
                <Target className="size-2.5" /> Target
              </span>
              <span className="text-[9px] font-mono text-muted-foreground mt-0.5">
                {tpPts > 0 ? `+${(tpPts * totalQty).toFixed(0)} ₹` : "Off"}
              </span>
            </div>
            <div className="relative flex items-center w-14">
              <Input
                type="number"
                min="0"
                value={tpPts || ""}
                onChange={(e) => setTpPts(Math.max(0, parseFloat(e.target.value) || 0))}
                className="h-6 text-center text-xs font-mono font-bold bg-background border border-border/60 p-0 rounded-md pr-5"
              />
              <span className="absolute right-1 text-[9px] font-mono text-muted-foreground pointer-events-none">pt</span>
            </div>
          </div>
        </div>
      </div>

      {/* ─── 6. BIGGER BUY CALL & BUY PUT BUTTONS WITH EXPECTED COST ─── */}
      <div className="grid grid-cols-2 gap-2 mt-0.5">
        {/* BUY CALL BUTTON */}
        <button
          type="button"
          disabled={!strike || cePrice == null || !isKotakConnected || actionBusy}
          onClick={() => hitOrder("CE")}
          className="h-20 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-white flex flex-col justify-between p-2.5 shadow-lg transition-all cursor-pointer text-left"
        >
          <div className="flex items-center justify-between w-full">
            <span className="text-xs font-black tracking-wide flex items-center gap-1">
              <Zap className="size-3.5 fill-current" /> BUY CALL ↗
            </span>
            <span className="text-[10px] font-mono font-bold bg-white/20 px-1.5 py-0.5 rounded">
              {strike} CE
            </span>
          </div>

          <div className="flex items-baseline justify-between w-full">
            <span className="text-lg font-black font-mono">
              {cePrice != null ? fmtRs(cePrice) : quoteLoading ? "…" : "—"}
            </span>
            <div className="text-right">
              <span className="text-[11px] font-mono text-emerald-100 font-semibold block leading-tight">
                Cost: <strong className="text-white">{ceCost != null ? fmtRs(ceCost) : "—"}</strong>
              </span>
              <span className="text-[9px] text-emerald-200/80 font-mono block">
                ({totalQty} Qty)
              </span>
            </div>
          </div>
        </button>

        {/* BUY PUT BUTTON */}
        <button
          type="button"
          disabled={!strike || pePrice == null || !isKotakConnected || actionBusy}
          onClick={() => hitOrder("PE")}
          className="h-20 rounded-2xl bg-rose-600 hover:bg-rose-500 active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-white flex flex-col justify-between p-2.5 shadow-lg transition-all cursor-pointer text-left"
        >
          <div className="flex items-center justify-between w-full">
            <span className="text-xs font-black tracking-wide flex items-center gap-1">
              <Zap className="size-3.5 fill-current" /> BUY PUT ↘
            </span>
            <span className="text-[10px] font-mono font-bold bg-white/20 px-1.5 py-0.5 rounded">
              {strike} PE
            </span>
          </div>

          <div className="flex items-baseline justify-between w-full">
            <span className="text-lg font-black font-mono">
              {pePrice != null ? fmtRs(pePrice) : quoteLoading ? "…" : "—"}
            </span>
            <div className="text-right">
              <span className="text-[11px] font-mono text-rose-100 font-semibold block leading-tight">
                Cost: <strong className="text-white">{peCost != null ? fmtRs(peCost) : "—"}</strong>
              </span>
              <span className="text-[9px] text-rose-200/80 font-mono block">
                ({totalQty} Qty)
              </span>
            </div>
          </div>
        </button>
      </div>

      {/* ─── TODAY'S COMPLETED TRADES MODAL ─── */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-xs rounded-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm font-bold flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Clock className="size-3.5 text-muted-foreground" /> Today's Closed Trades
              </span>
              <span className={cn("text-xs font-black font-mono", pnlClass(summary.realized_pnl))}>
                {summary.realized_pnl > 0 ? "+" : ""}{fmtRs(summary.realized_pnl)}
              </span>
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 py-1 pr-1">
            {closedPositions.length === 0 ? (
              <div className="text-center text-xs text-muted-foreground py-6">
                No closed trades yet today.
              </div>
            ) : (
              closedPositions.map((t, idx) => (
                <div
                  key={`${t.symbol}-${idx}`}
                  className="flex items-center justify-between p-2 rounded-lg bg-muted/30 border border-border/40 text-xs font-mono"
                >
                  <div>
                    <div className="font-bold text-foreground text-[11px]">{t.symbol}</div>
                    <div className="text-[9px] text-muted-foreground">
                      {t.qty}Q · In: ₹{t.buy_avg.toFixed(1)} · Out: ₹{t.sell_avg.toFixed(1)}
                    </div>
                  </div>
                  <div className={cn("font-bold text-xs", t.realized_pnl >= 0 ? "text-emerald-500" : "text-rose-500")}>
                    {t.realized_pnl >= 0 ? "+" : ""}{fmtRs(t.realized_pnl)}
                  </div>
                </div>
              ))
            )}
          </div>

          <DialogFooter className="pt-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs"
              onClick={() => setHistoryOpen(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}

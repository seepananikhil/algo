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

  // Expiries from symbol master
  const expiries = optionsPoll.data?.expiries ?? []

  // Default to first weekly expiry if none selected or if index switched
  useEffect(() => {
    if (expiries.length > 0) {
      if (!expiry || !expiries.some((e) => e.expiry === expiry)) {
        setExpiry(expiries[0].expiry)
      }
    }
  }, [expiries, indexSymbol])

  const selectedExpiryGroup = expiries.find((e) => e.expiry === expiry) || expiries[0]
  const currentExpiry = selectedExpiryGroup?.expiry ?? ""
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
    <div className="flex flex-col w-full max-w-sm mx-auto p-2.5 gap-3 select-none text-foreground bg-background">
      
      {/* ─── 1. TOPMOST HEADER: BIG DAY'S P&L + STATUS ACTIONS ─── */}
      <div className="flex items-center justify-between p-3 rounded-2xl bg-card border border-border/50 shadow-2xs">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
            DAY'S P&L {closedPositions.length > 0 ? `(${closedPositions.length} TRADES)` : ""}
          </span>
          <div
            className={cn(
              "text-2xl font-black font-mono tracking-tight mt-0.5",
              summary.net_pnl > 0 ? "text-emerald-500" : summary.net_pnl < 0 ? "text-rose-500" : "text-muted-foreground"
            )}
          >
            {summary.net_pnl > 0 ? "+" : ""}
            {fmtRs(summary.net_pnl)}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSimulateOpen((v) => !v)}
            className={cn(
              "text-[10px] font-mono px-2 py-1 rounded-lg border font-bold transition-all cursor-pointer",
              simulateOpen
                ? "bg-amber-500/20 text-amber-500 border-amber-500/40"
                : "bg-muted/40 border-border/60 text-muted-foreground hover:text-foreground"
            )}
            title="Toggle simulated open trade HUD to preview active card"
          >
            {simulateOpen ? "Hide Demo" : "👁️ Demo Trade"}
          </button>

          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="text-[10px] font-mono px-2 py-1 rounded-lg border border-border/60 bg-muted/40 text-muted-foreground hover:text-foreground font-bold cursor-pointer"
            title="View today's closed trades"
          >
            History
          </button>
        </div>
      </div>

      {/* ─── 2. BIGGER & BETTER NIFTY / SENSEX BUTTONS (With Real-Time Spot) ─── */}
      <div className="flex flex-col gap-1.5">
        <div className="grid grid-cols-2 gap-2">
          {/* NIFTY Button */}
          <button
            type="button"
            onClick={() => {
              setIndexSymbol("NIFTY")
              setStrike("")
            }}
            className={cn(
              "p-3 rounded-2xl border transition-all text-left flex flex-col justify-between cursor-pointer",
              indexSymbol === "NIFTY"
                ? "bg-primary/10 border-primary shadow-xs ring-1 ring-primary/30"
                : "bg-card border-border/50 hover:bg-muted/30"
            )}
          >
            <div className="flex items-center justify-between w-full">
              <span className="text-xs font-black font-mono">NIFTY 50</span>
              <span className="text-[10px] text-muted-foreground font-mono font-bold">65 Q</span>
            </div>
            <div className="text-xl font-black font-mono mt-1 text-foreground flex items-baseline gap-1">
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
              "p-3 rounded-2xl border transition-all text-left flex flex-col justify-between cursor-pointer",
              indexSymbol === "SENSEX"
                ? "bg-primary/10 border-primary shadow-xs ring-1 ring-primary/30"
                : "bg-card border-border/50 hover:bg-muted/30"
            )}
          >
            <div className="flex items-center justify-between w-full">
              <span className="text-xs font-black font-mono">SENSEX</span>
              <span className="text-[10px] text-muted-foreground font-mono font-bold">20 Q</span>
            </div>
            <div className="text-xl font-black font-mono mt-1 text-foreground flex items-baseline gap-1">
              <span>{indexSymbol === "SENSEX" ? spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 1 }) : "82,031.8"}</span>
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
            </div>
          </button>
        </div>

        {/* Expiry Bar directly beneath index switcher */}
        <div className="flex items-center justify-between px-1 text-xs font-mono text-muted-foreground">
          <span>Weekly Expiry:</span>
          {expiries.length > 0 && (
            <Select value={expiry} onValueChange={(val) => val && setExpiry(val)}>
              <SelectTrigger className="h-7 text-xs font-mono font-bold px-2.5 py-0 border-border/50 bg-card rounded-xl gap-1">
                <SelectValue placeholder="Expiry">
                  {formatExpiryLabel(expiry)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {expiries.map((exp, idx) => (
                  <SelectItem key={exp.expiry} value={exp.expiry} className="text-xs font-mono">
                    {exp.expiry} {idx === 0 ? "★ Current Weekly" : idx === 1 ? "Next Weekly" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* ─── 3. RUNNING TRADE FOCUS CARD (With One-Touch Exit) ─── */}
      {displayPositions.length > 0 && (
        <div className="flex flex-col gap-2">
          {displayPositions.map((pos) => {
            const isLong = pos.net_qty > 0
            const tradePnl = pos.unrealized_pnl ?? pos.pnl ?? 0
            const entryAvg = pos.buy_avg || pos.average_price || 0
            const ltp = pos.ltp || pos.last_price || 0
            const pnlPercent = entryAvg > 0 ? ((ltp - entryAvg) / entryAvg) * 100 * (isLong ? 1 : -1) : 0
            const ptsDiff = isLong ? ltp - entryAvg : entryAvg - ltp

            return (
              <div
                key={pos.symbol}
                className={cn(
                  "p-3 rounded-2xl shadow-xl flex flex-col gap-2.5 transition-all border-2",
                  pos.is_demo
                    ? "bg-amber-500/5 border-amber-500/50"
                    : "bg-card border-primary/70"
                )}
              >
                {/* Header: Position info + Trail BE */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-black font-mono text-foreground">
                    <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-black", isLong ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/20 text-rose-600 dark:text-rose-400")}>
                      {isLong ? "LONG" : "SHORT"}
                    </span>
                    <span>{pos.symbol}</span>
                    <span className="text-[10px] text-muted-foreground font-normal">({Math.abs(pos.net_qty)} Q)</span>
                    {pos.is_demo && (
                      <span className="text-[8px] bg-amber-500/20 text-amber-500 px-1 rounded font-bold">DEMO</span>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => moveToBreakeven(pos)}
                    className="text-[10px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-md hover:bg-amber-500/20 active:scale-95 cursor-pointer"
                  >
                    ⚡ Trail BE
                  </button>
                </div>

                {/* Big Focused Trade P&L */}
                <div className="flex items-center justify-between bg-muted/40 p-2.5 rounded-xl border border-border/40">
                  <div className="text-[10px] text-muted-foreground font-mono">
                    In: ₹{entryAvg.toFixed(1)} → LTP: ₹{ltp.toFixed(1)}
                  </div>
                  <div className="text-right">
                    <div className="text-[9px] uppercase font-bold text-muted-foreground tracking-wider leading-none mb-0.5">
                      RUNNING TRADE P&L
                    </div>
                    <div
                      className={cn(
                        "text-2xl font-black font-mono tracking-tight",
                        tradePnl > 0 ? "text-emerald-500" : tradePnl < 0 ? "text-rose-500" : "text-muted-foreground"
                      )}
                    >
                      {tradePnl > 0 ? "+" : ""}
                      {fmtRs(tradePnl)}
                    </div>
                    <div className="text-[10px] font-mono font-bold text-muted-foreground">
                      {ptsDiff >= 0 ? "+" : ""}{ptsDiff.toFixed(1)} pt ({pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%)
                    </div>
                  </div>
                </div>

                {/* ONE-TOUCH EXIT BUTTON */}
                <Button
                  variant="destructive"
                  size="default"
                  disabled={actionBusy}
                  className="h-12 w-full text-sm font-black rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-95 shadow-lg tracking-wider cursor-pointer"
                  onClick={() => hitExit(pos)}
                >
                  ONE-TOUCH EXIT (MARKET)
                </Button>
              </div>
            )
          })}
        </div>
      )}

      {/* ─── 4. STRIKE STEPPER ─── */}
      <div className="flex flex-col gap-1 p-2.5 rounded-2xl bg-card border border-border/50 shadow-2xs">
        <div className="text-center text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
          STRIKE PRICE
        </div>
        <div className="flex items-center justify-between px-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 rounded-xl bg-muted/40 border border-border/60 hover:bg-muted active:scale-90"
            onClick={() => stepStrike(-1)}
          >
            <Minus className="size-5" />
          </Button>

          <div className="text-2xl font-black font-mono tracking-tight text-foreground flex items-center gap-2">
            {strike || atmStrike}
            {Number(strike) === atmStrike && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-500 font-bold border border-amber-500/30">
                ATM
              </span>
            )}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 rounded-xl bg-muted/40 border border-border/60 hover:bg-muted active:scale-90"
            onClick={() => stepStrike(1)}
          >
            <Plus className="size-5" />
          </Button>
        </div>
      </div>

      {/* ─── 5. FULL ROW FOR LOTS PICKER ─── */}
      <div className="flex flex-col gap-2 p-3 rounded-2xl bg-card border border-border/50 shadow-2xs">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
            SELECT LOTS
          </span>
          <span className="text-xs font-mono font-bold text-foreground">
            Total: <strong className="text-primary">{totalQty} Qty</strong>
          </span>
        </div>

        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 rounded-xl bg-muted/40 border border-border/60 hover:bg-muted active:scale-90"
            onClick={() => setLots((l) => Math.max(1, l - 1))}
            disabled={lots <= 1}
          >
            <Minus className="size-5" />
          </Button>

          <div className="text-center">
            <div className="text-2xl font-black font-mono tracking-tight text-foreground">
              {lots} {lots === 1 ? "Lot" : "Lots"}
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 rounded-xl bg-muted/40 border border-border/60 hover:bg-muted active:scale-90"
            onClick={() => setLots((l) => Math.min(20, l + 1))}
          >
            <Plus className="size-5" />
          </Button>
        </div>

        {/* Quick Lot Chips across the full row */}
        <div className="grid grid-cols-5 gap-1.5 pt-1 border-t border-border/30">
          {[1, 2, 3, 5, 10].map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLots(l)}
              className={cn(
                "py-1.5 rounded-xl text-xs font-mono font-bold border transition-all cursor-pointer text-center",
                lots === l
                  ? "bg-foreground text-background border-foreground shadow-xs"
                  : "bg-muted/40 border-border/50 text-muted-foreground hover:text-foreground"
              )}
            >
              {l}L
            </button>
          ))}
        </div>
      </div>

      {/* ─── 6. SL & TARGET (2 EQUAL COLUMNS) ─── */}
      <div className="grid grid-cols-2 gap-2">
        {/* Stop Loss (SL) */}
        <div className="flex flex-col justify-between p-2.5 rounded-2xl bg-card border border-border/50 shadow-2xs">
          <div className="flex items-center justify-between text-rose-500 font-bold text-[10px] uppercase tracking-wider">
            <span className="flex items-center gap-1">
              <Shield className="size-3" /> Stop Loss
            </span>
            <span className="font-mono text-[9px] text-muted-foreground">
              {slPts > 0 ? `-${(slPts * totalQty).toFixed(0)} ₹` : "Off"}
            </span>
          </div>
          <div className="relative flex items-center mt-1.5">
            <Input
              type="number"
              min="0"
              step="1"
              placeholder="0 (off)"
              value={slPts || ""}
              onChange={(e) => setSlPts(Math.max(0, parseFloat(e.target.value) || 0))}
              className="h-8 text-center text-xs font-mono font-bold bg-muted/40 border-0 p-0 rounded-lg pr-7"
            />
            <span className="absolute right-2 text-[10px] font-mono text-muted-foreground pointer-events-none">
              pts
            </span>
          </div>
        </div>

        {/* Target (TP) */}
        <div className="flex flex-col justify-between p-2.5 rounded-2xl bg-card border border-border/50 shadow-2xs">
          <div className="flex items-center justify-between text-emerald-500 font-bold text-[10px] uppercase tracking-wider">
            <span className="flex items-center gap-1">
              <Target className="size-3" /> Target
            </span>
            <span className="font-mono text-[9px] text-muted-foreground">
              {tpPts > 0 ? `+${(tpPts * totalQty).toFixed(0)} ₹` : "Off"}
            </span>
          </div>
          <div className="relative flex items-center mt-1.5">
            <Input
              type="number"
              min="0"
              step="1"
              placeholder="0 (off)"
              value={tpPts || ""}
              onChange={(e) => setTpPts(Math.max(0, parseFloat(e.target.value) || 0))}
              className="h-8 text-center text-xs font-mono font-bold bg-muted/40 border-0 p-0 rounded-lg pr-7"
            />
            <span className="absolute right-2 text-[10px] font-mono text-muted-foreground pointer-events-none">
              pts
            </span>
          </div>
        </div>
      </div>

      {/* ─── 7. EXECUTION ZONE: COST ABOVE + MEDIUM BUY BUTTONS ─── */}
      <div className="flex flex-col gap-2 p-2.5 rounded-2xl bg-card border border-border/50 shadow-2xs">
        {/* Cost Cards Above */}
        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          {/* CE Cost Card */}
          <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex flex-col justify-between">
            <div className="flex items-center justify-between font-bold text-emerald-600 dark:text-emerald-400">
              <span className="text-[11px]">{strike} CE</span>
              <span className="text-sm font-black">{cePrice != null ? fmtRs(cePrice) : quoteLoading ? "…" : "—"}</span>
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-1">
              <span>Cost: <strong className="text-foreground">{ceCost != null ? fmtRs(ceCost) : "—"}</strong></span>
              <span>({totalQty} Q)</span>
            </div>
          </div>

          {/* PE Cost Card */}
          <div className="p-2 rounded-xl bg-rose-500/10 border border-rose-500/30 flex flex-col justify-between">
            <div className="flex items-center justify-between font-bold text-rose-600 dark:text-rose-400">
              <span className="text-[11px]">{strike} PE</span>
              <span className="text-sm font-black">{pePrice != null ? fmtRs(pePrice) : quoteLoading ? "…" : "—"}</span>
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-1">
              <span>Cost: <strong className="text-foreground">{peCost != null ? fmtRs(peCost) : "—"}</strong></span>
              <span>({totalQty} Q)</span>
            </div>
          </div>
        </div>

        {/* Medium Action Buttons Directly Below */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!strike || cePrice == null || !isKotakConnected || actionBusy}
            onClick={() => hitOrder("CE")}
            className="h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-white font-black text-sm tracking-wide shadow-md flex items-center justify-center gap-1.5 transition-all cursor-pointer"
          >
            <Zap className="size-4 fill-current" />
            <span>BUY CALL ↗</span>
          </button>

          <button
            type="button"
            disabled={!strike || pePrice == null || !isKotakConnected || actionBusy}
            onClick={() => hitOrder("PE")}
            className="h-12 rounded-xl bg-rose-600 hover:bg-rose-500 active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-white font-black text-sm tracking-wide shadow-md flex items-center justify-center gap-1.5 transition-all cursor-pointer"
          >
            <Zap className="size-4 fill-current" />
            <span>BUY PUT ↘</span>
          </button>
        </div>
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

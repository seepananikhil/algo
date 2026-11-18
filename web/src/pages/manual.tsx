import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Plus,
  Minus,
  Clock,
  Target,
  Shield,
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

  // Fast live polling: 1000ms for active scalping positions & PnL
  const positionsPoll = usePoll<PositionsResponse>(isKotakConnected ? "/api/positions" : null, 1000)
  const optionsPoll = usePoll<ManualOptionChoices>(
    isKotakConnected ? `/api/manual-options?symbol=${indexSymbol}` : null,
    15000
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

  // Fetch Quotes for both CE and PE continuously
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
    const timer = setInterval(() => void loadQuotes(), 2000)
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
    <div className="flex flex-col h-full max-h-full w-full max-w-md mx-auto p-2 justify-between select-none text-foreground bg-background overflow-hidden">
      
      {/* ─── 2. INSTRUMENT & EXPIRY ROW ─── */}
      <div className="flex items-center justify-between gap-2 shrink-0">
        {/* [ NIFTY | SENSEX ] */}
        <div className="flex bg-muted/60 p-0.5 rounded-xl border border-border/40">
          <button
            type="button"
            onClick={() => {
              setIndexSymbol("NIFTY")
              setStrike("")
            }}
            className={cn(
              "px-3 py-1 rounded-lg text-xs font-bold font-mono transition-all",
              indexSymbol === "NIFTY"
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            NIFTY
          </button>
          <button
            type="button"
            onClick={() => {
              setIndexSymbol("SENSEX")
              setStrike("")
            }}
            className={cn(
              "px-3 py-1 rounded-lg text-xs font-bold font-mono transition-all",
              indexSymbol === "SENSEX"
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            SENSEX
          </button>
        </div>

        {/* [23 Nov ▾] Expiry Pill */}
        {expiries.length > 0 && (
          <Select value={expiry} onValueChange={(val) => val && setExpiry(val)}>
            <SelectTrigger className="h-7 text-xs font-mono font-bold px-2.5 py-0 border-border/50 bg-muted/40 rounded-xl gap-1">
              <SelectValue placeholder="Expiry">
                {formatExpiryLabel(expiry)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {expiries.map((exp, idx) => (
                <SelectItem key={exp.expiry} value={exp.expiry} className="text-xs font-mono">
                  {exp.expiry} {idx === 0 ? "★ Current" : idx === 1 ? "Next" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* ─── 3. SPOT & LIVE P&L ROW ─── */}
      <div className="flex items-center justify-between text-xs font-mono px-0.5 shrink-0">
        <span className="text-muted-foreground">
          Spot: <strong className="text-foreground font-bold">{spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</strong>
        </span>

        {/* DAY P&L (count): +₹... */}
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="text-xs font-mono font-bold flex items-center gap-1 hover:underline cursor-pointer"
          title="Click to view today's closed trades ledger"
        >
          <span className="text-muted-foreground">
            DAY P&L{closedPositions.length > 0 ? ` (${closedPositions.length})` : ""}:
          </span>
          <span className={cn(summary.net_pnl > 0 ? "text-emerald-400" : summary.net_pnl < 0 ? "text-rose-400" : "text-muted-foreground")}>
            {summary.net_pnl > 0 ? "+" : ""}{fmtRs(summary.net_pnl)}
          </span>
        </button>
      </div>

      {/* ─── 4. STRIKE STEPPER ─── */}
      <div className="flex flex-col gap-1 p-2 rounded-2xl bg-card border border-border/50 shadow-sm shrink-0">
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
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-bold border border-amber-500/30">
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

      {/* ─── 5. RISK & QTY GRID (3 Columns) ─── */}
      <div className="grid grid-cols-3 gap-2 p-2 rounded-2xl bg-muted/20 border border-border/40 shrink-0">
        {/* Col 1: LOTS */}
        <div className="flex flex-col items-center justify-center bg-background/60 p-1.5 rounded-xl border border-border/30">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold mb-1">
            LOTS
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setLots((l) => Math.max(1, l - 1))}
              disabled={lots <= 1}
              className="size-6 rounded-lg bg-muted flex items-center justify-center active:scale-90 disabled:opacity-30"
            >
              <Minus className="size-3" />
            </button>
            <span className="w-6 text-center font-black font-mono text-xs">
              {lots}L
            </span>
            <button
              type="button"
              onClick={() => setLots((l) => Math.min(20, l + 1))}
              className="size-6 rounded-lg bg-muted flex items-center justify-center active:scale-90"
            >
              <Plus className="size-3" />
            </button>
          </div>
          <span className="text-[8px] font-mono text-muted-foreground mt-0.5">
            ({totalQty} Q)
          </span>
        </div>

        {/* Col 2: SL PTS */}
        <div className="flex flex-col items-center justify-center bg-background/60 p-1.5 rounded-xl border border-border/30">
          <span className="text-[9px] uppercase tracking-wider text-rose-400 font-bold mb-1 flex items-center gap-1">
            <Shield className="size-2.5" /> SL PTS
          </span>
          <div className="relative flex items-center w-full px-1">
            <Input
              type="number"
              min="0"
              step="1"
              value={slPts || ""}
              onChange={(e) => setSlPts(Math.max(0, parseFloat(e.target.value) || 0))}
              className="h-7 text-center text-xs font-mono font-bold bg-muted/40 border-0 p-0 rounded-lg"
            />
          </div>
          <span className="text-[8px] font-mono text-muted-foreground mt-0.5">
            {slPts > 0 ? `-${(slPts * totalQty).toFixed(0)} ₹` : "Off"}
          </span>
        </div>

        {/* Col 3: TARGET */}
        <div className="flex flex-col items-center justify-center bg-background/60 p-1.5 rounded-xl border border-border/30">
          <span className="text-[9px] uppercase tracking-wider text-emerald-400 font-bold mb-1 flex items-center gap-1">
            <Target className="size-2.5" /> TARGET
          </span>
          <div className="relative flex items-center w-full px-1">
            <Input
              type="number"
              min="0"
              step="1"
              value={tpPts || ""}
              onChange={(e) => setTpPts(Math.max(0, parseFloat(e.target.value) || 0))}
              className="h-7 text-center text-xs font-mono font-bold bg-muted/40 border-0 p-0 rounded-lg"
            />
          </div>
          <span className="text-[8px] font-mono text-muted-foreground mt-0.5">
            {tpPts > 0 ? `+${(tpPts * totalQty).toFixed(0)} ₹` : "Off"}
          </span>
        </div>
      </div>

      {/* ─── 6. EXECUTION ZONE (BUY CALL ↗ vs BUY PUT ↘) ─── */}
      <div className="grid grid-cols-2 gap-2.5 my-auto shrink-0">
        {/* BUY CALL */}
        <button
          type="button"
          disabled={!strike || cePrice == null || !isKotakConnected || actionBusy}
          onClick={() => hitOrder("CE")}
          className="h-32 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:scale-95 disabled:opacity-30 disabled:pointer-events-none text-white p-3 flex flex-col justify-between text-left shadow-lg transition-transform"
        >
          <div className="flex items-center justify-between w-full">
            <span className="text-xs font-black tracking-wide flex items-center gap-0.5">
              BUY CALL ↗
            </span>
            <span className="text-[11px] font-mono opacity-80 font-bold">{strike} CE</span>
          </div>

          <div>
            <div className="text-2xl font-black font-mono leading-none tracking-tight">
              {cePrice != null ? fmtRs(cePrice) : quoteLoading ? "…" : "—"}
            </div>
            <div className="text-xs font-mono mt-1 font-bold opacity-90">
              Cost: {ceCost != null ? fmtRs(ceCost) : "—"}
            </div>
            <div className="text-[10px] font-mono opacity-70">
              ({totalQty} Q)
            </div>
          </div>
        </button>

        {/* BUY PUT */}
        <button
          type="button"
          disabled={!strike || pePrice == null || !isKotakConnected || actionBusy}
          onClick={() => hitOrder("PE")}
          className="h-32 rounded-2xl bg-rose-600 hover:bg-rose-500 active:scale-95 disabled:opacity-30 disabled:pointer-events-none text-white p-3 flex flex-col justify-between text-left shadow-lg transition-transform"
        >
          <div className="flex items-center justify-between w-full">
            <span className="text-xs font-black tracking-wide flex items-center gap-0.5">
              BUY PUT ↘
            </span>
            <span className="text-[11px] font-mono opacity-80 font-bold">{strike} PE</span>
          </div>

          <div>
            <div className="text-2xl font-black font-mono leading-none tracking-tight">
              {pePrice != null ? fmtRs(pePrice) : quoteLoading ? "…" : "—"}
            </div>
            <div className="text-xs font-mono mt-1 font-bold opacity-90">
              Cost: {peCost != null ? fmtRs(peCost) : "—"}
            </div>
            <div className="text-[10px] font-mono opacity-70">
              ({totalQty} Q)
            </div>
          </div>
        </button>
      </div>

      {/* ACTIVE TRADE CARD (If Open Position) */}
      {openPositions.length > 0 && (
        <div className="flex flex-col gap-1.5 shrink-0 pt-0.5">
          {openPositions.map((pos) => {
            const isLong = pos.net_qty > 0
            const tradePnl = pos.unrealized_pnl ?? pos.pnl ?? 0
            const entryAvg = pos.buy_avg || pos.average_price || 0
            const ltp = pos.ltp || pos.last_price || 0
            const pnlPercent = entryAvg > 0 ? ((ltp - entryAvg) / entryAvg) * 100 * (isLong ? 1 : -1) : 0
            const ptsDiff = isLong ? ltp - entryAvg : entryAvg - ltp

            return (
              <div
                key={pos.symbol}
                className="p-2.5 bg-card border-2 border-primary/70 rounded-2xl shadow-xl flex items-center justify-between gap-2"
              >
                <div className="flex flex-col">
                  <div className="flex items-center gap-1.5 text-xs font-black font-mono text-foreground">
                    <span className={cn("text-[9px] px-1.5 py-0.2 rounded font-black", isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400")}>
                      {isLong ? "LONG" : "SHORT"}
                    </span>
                    {pos.symbol}
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                    {Math.abs(pos.net_qty)}Q · In: ₹{entryAvg.toFixed(1)} → LTP: ₹{ltp.toFixed(1)}
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    <button
                      type="button"
                      onClick={() => moveToBreakeven(pos)}
                      className="text-[9px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-md hover:bg-amber-500/20 active:scale-95 cursor-pointer"
                    >
                      ⚡ Trail BE
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <div className="text-[9px] uppercase font-bold text-muted-foreground tracking-wider leading-none">
                      Trade P&L
                    </div>
                    <div
                      className={cn(
                        "text-base font-black font-mono tracking-tight",
                        tradePnl > 0 ? "text-emerald-400" : tradePnl < 0 ? "text-rose-400" : "text-muted-foreground"
                      )}
                    >
                      {tradePnl > 0 ? "+" : ""}
                      {fmtRs(tradePnl)}
                    </div>
                    <div className="text-[9px] font-mono font-bold text-muted-foreground">
                      {ptsDiff >= 0 ? "+" : ""}{ptsDiff.toFixed(1)} pt ({pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%)
                    </div>
                  </div>

                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={actionBusy}
                    className="h-10 text-xs font-black px-3.5 rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-95 shadow-md cursor-pointer"
                    onClick={() => hitExit(pos)}
                  >
                    EXIT
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

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

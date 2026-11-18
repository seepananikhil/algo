import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  RefreshCw,
  Wallet,
  ArrowUpRight,
  ArrowDownRight,
  Plus,
  Minus,
  CheckCircle2,
  Clock,
  Download,
  Zap,
  Target,
  Shield,
  ChevronDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
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
  const fundsPoll = usePoll<FundsStatus>(isKotakConnected ? "/api/funds" : null, 5000)
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

  // PWA Install prompt state
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)
  const [isInstallable, setIsInstallable] = useState(false)

  // Quotes
  const [cePrice, setCePrice] = useState<number | null>(null)
  const [pePrice, setPePrice] = useState<number | null>(null)
  const [ceSymbol, setCeSymbol] = useState<string>("")
  const [peSymbol, setPeSymbol] = useState<string>("")
  const [quoteLoading, setQuoteLoading] = useState(false)

  // Action busy states
  const [actionBusy, setActionBusy] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  // Listen for Chrome PWA install prompt
  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault()
      setDeferredPrompt(e)
      setIsInstallable(true)
    }
    window.addEventListener("beforeinstallprompt", handler)
    return () => window.removeEventListener("beforeinstallprompt", handler)
  }, [])

  async function handleInstallApp() {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === "accepted") {
      setIsInstallable(false)
      setDeferredPrompt(null)
    }
  }

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
  function formatExpiryLabel(expStr: string, idx: number) {
    if (!expStr) return "Expiry"
    try {
      const parts = expStr.split("-")
      if (parts.length === 3) {
        const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        const day = parts[2]
        const month = monthNames[parseInt(parts[1], 10)] || parts[1]
        const tag = idx === 0 ? "Weekly" : idx === 1 ? "Next" : ""
        return `${day} ${month}${tag ? ` (${tag})` : ""}`
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
    const timer = setInterval(() => void loadQuotes(), 2500)
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

  const availableFunds = fundsPoll.data?.ok ? fundsPoll.data.available_equity_funds : null
  const openPositions = positionsPoll.data?.open_positions ?? []
  const closedPositions = positionsPoll.data?.closed_positions ?? []
  const summary = positionsPoll.data?.summary ?? {
    realized_pnl: 0,
    unrealized_pnl: 0,
    net_pnl: 0,
    open_count: openPositions.length,
    closed_count: closedPositions.length,
  }

  // 1-TAP INSTANT BUY ORDER (With Target & SL configured)
  async function hitOrder(optionType: "CE" | "PE") {
    if (actionBusy) return
    if (!strike || !currentExpiry) {
      toast.error("Option strike unavailable")
      return
    }

    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(40)
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
      await fundsPoll.reload()
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
    <div className="flex flex-col h-full max-h-full w-full max-w-sm mx-auto overflow-hidden justify-between p-2 select-none text-foreground font-sans bg-background">
      {/* 1. TOP HUD: Net P&L + Margin + Install PWA */}
      <div className="flex items-center justify-between pb-1.5 border-b border-border/40">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
            Live P&L
          </div>
          <div
            className={cn(
              "text-2xl font-black font-mono tracking-tight",
              summary.net_pnl > 0 ? "text-emerald-500" : summary.net_pnl < 0 ? "text-rose-500" : "text-muted-foreground"
            )}
          >
            {summary.net_pnl > 0 ? "+" : ""}
            {fmtRs(summary.net_pnl)}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
            <Wallet className="size-3 text-muted-foreground" />
            <span className="font-bold text-foreground">
              {availableFunds != null ? fmtRs(availableFunds) : "₹37,258"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-5 ml-0.5 text-muted-foreground"
              onClick={() => {
                void positionsPoll.reload()
                void fundsPoll.reload()
              }}
              title="Refresh"
            >
              <RefreshCw className={cn("size-2.5", positionsPoll.loading && "animate-spin")} />
            </Button>
          </div>

          <div className="flex items-center gap-1.5">
            {isInstallable && (
              <button
                type="button"
                onClick={handleInstallApp}
                className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded-md flex items-center gap-1 animate-pulse"
              >
                <Download className="size-2.5" /> Install
              </button>
            )}
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="text-[10px] font-semibold text-primary hover:underline flex items-center gap-0.5"
            >
              <Clock className="size-2.5" />
              {closedPositions.length} trades
            </button>
          </div>
        </div>
      </div>

      {/* 2. INSTRUMENT & EXPIRY SELECTOR */}
      <div className="flex items-center justify-between gap-1.5 my-1">
        {/* NIFTY vs SENSEX Segmented Toggle */}
        <div className="flex bg-muted/60 p-0.5 rounded-xl border border-border/40 flex-1">
          <button
            type="button"
            onClick={() => {
              setIndexSymbol("NIFTY")
              setStrike("")
            }}
            className={cn(
              "flex-1 py-1 rounded-lg text-center transition-all",
              indexSymbol === "NIFTY"
                ? "bg-background text-foreground font-black shadow-xs"
                : "text-muted-foreground font-medium hover:text-foreground"
            )}
          >
            <div className="text-xs font-bold leading-tight">NIFTY 50</div>
            <div className="text-[10px] font-mono opacity-80">
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
              "flex-1 py-1 rounded-lg text-center transition-all",
              indexSymbol === "SENSEX"
                ? "bg-background text-foreground font-black shadow-xs"
                : "text-muted-foreground font-medium hover:text-foreground"
            )}
          >
            <div className="text-xs font-bold leading-tight">SENSEX</div>
            <div className="text-[10px] font-mono opacity-80">
              {indexSymbol === "SENSEX" ? spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : "82,032"} · 20Q
            </div>
          </button>
        </div>

        {/* Quick Expiry Switcher (Current vs Next Weekly) */}
        {expiries.length > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setExpiry(expiries[0]?.expiry || "")}
              className={cn(
                "px-2 py-1.5 rounded-xl text-[10px] font-bold font-mono transition-all border leading-tight",
                expiry === expiries[0]?.expiry
                  ? "bg-primary text-primary-foreground border-primary shadow-xs"
                  : "bg-muted/40 border-border/50 text-muted-foreground hover:text-foreground"
              )}
              title="Current Weekly Expiry"
            >
              {formatExpiryLabel(expiries[0]?.expiry, 0)}
            </button>

            {expiries.length > 1 && (
              <button
                type="button"
                onClick={() => setExpiry(expiries[1]?.expiry || "")}
                className={cn(
                  "px-2 py-1.5 rounded-xl text-[10px] font-bold font-mono transition-all border leading-tight",
                  expiry === expiries[1]?.expiry
                    ? "bg-primary text-primary-foreground border-primary shadow-xs"
                    : "bg-muted/40 border-border/50 text-muted-foreground hover:text-foreground"
                )}
                title="Next Weekly Expiry"
              >
                {formatExpiryLabel(expiries[1]?.expiry, 1)}
              </button>
            )}

            {expiries.length > 2 && (
              <Select value={expiry} onValueChange={(val) => val && setExpiry(val)}>
                <SelectTrigger className="h-7 w-6 text-[10px] p-0 border-border/60 bg-muted/40 justify-center rounded-xl">
                  <ChevronDown className="size-3" />
                </SelectTrigger>
                <SelectContent>
                  {expiries.map((exp, idx) => (
                    <SelectItem key={exp.expiry} value={exp.expiry} className="text-xs">
                      {exp.expiry} {idx === 0 ? "(Current Weekly)" : idx === 1 ? "(Next Weekly)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
      </div>

      {/* 3. STRIKE CONTROLLER (With Live Option Cost) */}
      <div className="flex flex-col gap-1 py-1.5 bg-muted/30 rounded-xl px-2.5 border border-border/40">
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-lg bg-background border border-border/60 shadow-2xs hover:bg-muted active:scale-95"
            onClick={() => stepStrike(-1)}
          >
            <Minus className="size-4" />
          </Button>

          <div className="text-center flex flex-col items-center">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wider font-semibold">
              Selected Strike ({currentExpiry ? formatExpiryLabel(currentExpiry, expiries.findIndex(e => e.expiry === currentExpiry)) : "Weekly"})
            </span>
            <div className="text-xl font-black font-mono tracking-tight text-foreground flex items-center justify-center gap-1.5">
              {strike || atmStrike}
              {Number(strike) === atmStrike && (
                <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-400 font-bold">
                  ATM
                </span>
              )}
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-lg bg-background border border-border/60 shadow-2xs hover:bg-muted active:scale-95"
            onClick={() => stepStrike(1)}
          >
            <Plus className="size-4" />
          </Button>
        </div>

        {/* Live Total Cost for CE & PE */}
        <div className="flex items-center justify-between text-[11px] font-mono border-t border-border/40 pt-1 mt-0.5 px-1">
          <div className="flex items-center gap-1 text-emerald-400 font-bold">
            <span className="text-[9px] uppercase opacity-75">CE Cost:</span>
            <span>{ceCost != null ? fmtRs(ceCost) : "…"}</span>
          </div>
          <div className="text-[9px] text-muted-foreground font-semibold">
            {totalQty} Qty ({lots}L)
          </div>
          <div className="flex items-center gap-1 text-rose-400 font-bold">
            <span className="text-[9px] uppercase opacity-75">PE Cost:</span>
            <span>{peCost != null ? fmtRs(peCost) : "…"}</span>
          </div>
        </div>
      </div>

      {/* 4. TARGET & STOP LOSS INPUT BOXES */}
      <div className="grid grid-cols-2 gap-2 bg-muted/20 p-2 rounded-xl border border-border/30">
        {/* Stop Loss (SL) Input */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px] font-bold text-rose-400">
            <span className="flex items-center gap-1">
              <Shield className="size-3" /> Stop Loss
            </span>
            <span className="font-mono text-[9px] text-muted-foreground">
              {slPts > 0 ? `-${(slPts * totalQty).toFixed(0)} ₹` : "Off"}
            </span>
          </div>
          <div className="relative flex items-center">
            <Input
              type="number"
              min="0"
              step="1"
              placeholder="0 (off)"
              value={slPts || ""}
              onChange={(e) => setSlPts(Math.max(0, parseFloat(e.target.value) || 0))}
              className="h-8 text-xs font-mono font-bold bg-background/80 border-border/60 pl-2.5 pr-8 rounded-lg"
            />
            <span className="absolute right-2 text-[10px] font-mono text-muted-foreground pointer-events-none">
              pts
            </span>
          </div>
        </div>

        {/* Target (TP) Input */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px] font-bold text-emerald-400">
            <span className="flex items-center gap-1">
              <Target className="size-3" /> Target
            </span>
            <span className="font-mono text-[9px] text-muted-foreground">
              {tpPts > 0 ? `+${(tpPts * totalQty).toFixed(0)} ₹` : "Off"}
            </span>
          </div>
          <div className="relative flex items-center">
            <Input
              type="number"
              min="0"
              step="1"
              placeholder="0 (off)"
              value={tpPts || ""}
              onChange={(e) => setTpPts(Math.max(0, parseFloat(e.target.value) || 0))}
              className="h-8 text-xs font-mono font-bold bg-background/80 border-border/60 pl-2.5 pr-8 rounded-lg"
            />
            <span className="absolute right-2 text-[10px] font-mono text-muted-foreground pointer-events-none">
              pts
            </span>
          </div>
        </div>
      </div>

      {/* 5. LOTS STEPPER & CHIPS */}
      <div className="flex items-center justify-between gap-1 py-0.5 px-0.5">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-7 rounded-lg"
            onClick={() => setLots((prev) => Math.max(1, prev - 1))}
            disabled={lots <= 1}
          >
            <Minus className="size-3" />
          </Button>
          <div className="w-12 text-center font-black font-mono text-xs">
            {lots}L
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-7 rounded-lg"
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
                "px-2 py-0.5 rounded-md text-[10px] font-mono border transition-all",
                lots === l
                  ? "bg-foreground text-background font-black border-foreground"
                  : "bg-muted/40 border-border/50 text-muted-foreground hover:text-foreground"
              )}
            >
              {l}L
            </button>
          ))}
        </div>

        <div className="text-[10px] font-mono text-muted-foreground font-semibold">
          {totalQty} Qty
        </div>
      </div>

      {/* 6. HERO 1-TAP SCALP PADS (BUY CALL vs BUY PUT) */}
      <div className="grid grid-cols-2 gap-2 my-1">
        {/* 1-TAP BUY CALL (CE) */}
        <button
          type="button"
          disabled={!strike || cePrice == null || !isKotakConnected || actionBusy}
          onClick={() => hitOrder("CE")}
          className="h-24 rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-white p-2.5 flex flex-col justify-between text-left shadow-lg transition-all ring-1 ring-emerald-400/40"
        >
          <div className="flex items-center justify-between w-full">
            <span className="text-xs font-black tracking-wider flex items-center">
              <Zap className="size-3.5 fill-current mr-0.5" />
              BUY CALL
              <ArrowUpRight className="size-3.5 stroke-[3] ml-0.5" />
            </span>
            <span className="text-[10px] opacity-80 font-mono font-bold">{strike} CE</span>
          </div>

          <div>
            <div className="text-2xl font-black font-mono leading-none tracking-tight">
              {cePrice != null ? fmtRs(cePrice) : quoteLoading ? "…" : "—"}
            </div>
            <div className="text-[10px] font-mono mt-1 font-bold bg-black/25 px-1.5 py-0.5 rounded-md inline-block">
              Total Cost: {ceCost != null ? fmtRs(ceCost) : "—"}
            </div>
          </div>
        </button>

        {/* 1-TAP BUY PUT (PE) */}
        <button
          type="button"
          disabled={!strike || pePrice == null || !isKotakConnected || actionBusy}
          onClick={() => hitOrder("PE")}
          className="h-24 rounded-2xl bg-gradient-to-br from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-white p-2.5 flex flex-col justify-between text-left shadow-lg transition-all ring-1 ring-rose-400/40"
        >
          <div className="flex items-center justify-between w-full">
            <span className="text-xs font-black tracking-wider flex items-center">
              <Zap className="size-3.5 fill-current mr-0.5" />
              BUY PUT
              <ArrowDownRight className="size-3.5 stroke-[3] ml-0.5" />
            </span>
            <span className="text-[10px] opacity-80 font-mono font-bold">{strike} PE</span>
          </div>

          <div>
            <div className="text-2xl font-black font-mono leading-none tracking-tight">
              {pePrice != null ? fmtRs(pePrice) : quoteLoading ? "…" : "—"}
            </div>
            <div className="text-[10px] font-mono mt-1 font-bold bg-black/25 px-1.5 py-0.5 rounded-md inline-block">
              Total Cost: {peCost != null ? fmtRs(peCost) : "—"}
            </div>
          </div>
        </button>
      </div>

      {/* 7. ACTIVE POSITION HUD & EMERGENCY KILL BUTTON (Bottom) */}
      <div className="mt-1 pt-1 border-t border-border/40">
        {openPositions.length === 0 ? (
          <div className="flex items-center justify-between py-1 px-2.5 bg-muted/20 rounded-xl border border-border/30 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 text-emerald-500" />
              <span className="font-medium">No open position · Flat</span>
            </div>
            <span className="font-mono text-[10px]">1-Tap Ready</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {openPositions.map((pos) => {
              const isLong = pos.net_qty > 0
              const currentPnl = pos.unrealized_pnl ?? pos.pnl ?? 0
              const entryAvg = pos.buy_avg || pos.average_price || 0
              const ltp = pos.ltp || pos.last_price || 0
              const pnlPercent = entryAvg > 0 ? ((ltp - entryAvg) / entryAvg) * 100 * (isLong ? 1 : -1) : 0

              return (
                <div
                  key={pos.symbol}
                  className="p-2 bg-card border-2 border-primary/50 rounded-2xl shadow-md flex items-center justify-between gap-2"
                >
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1 text-xs font-black font-mono text-foreground">
                      <span className={cn("text-[9px] px-1 rounded font-black", isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400")}>
                        {isLong ? "LONG" : "SHORT"}
                      </span>
                      {pos.symbol}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono">
                      {Math.abs(pos.net_qty)}Q · In: ₹{entryAvg.toFixed(1)} · Now: ₹{ltp.toFixed(1)}
                    </div>
                    {/* Trailing Breakeven Button */}
                    <div className="flex items-center gap-1 mt-0.5">
                      <button
                        type="button"
                        onClick={() => moveToBreakeven(pos)}
                        className="text-[9px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1 py-0.2 rounded hover:bg-amber-500/20"
                        title="Move Stop Loss to Entry Price"
                      >
                        ⚡ Trail to BE
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="text-right">
                      <div
                        className={cn(
                          "text-base font-black font-mono tracking-tight",
                          currentPnl > 0 ? "text-emerald-500" : currentPnl < 0 ? "text-rose-500" : "text-muted-foreground"
                        )}
                      >
                        {currentPnl > 0 ? "+" : ""}
                        {fmtRs(currentPnl)}
                      </div>
                      <div className="text-[10px] font-mono font-bold text-muted-foreground">
                        {pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%
                      </div>
                    </div>

                    {/* 1-TAP INSTANT EXIT BUTTON */}
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={actionBusy}
                      className="h-10 text-xs font-black px-3.5 rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-95 shadow-md"
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
      </div>

      {/* ================= DIALOG: TODAY'S CLOSED TRADES ================= */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-xs rounded-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm font-bold flex items-center justify-between">
              <span>Today's Completed Trades</span>
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

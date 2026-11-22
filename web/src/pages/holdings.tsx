import { useEffect, useMemo, useState } from "react"
import {
  Activity,
  Briefcase,
  Coins,
  ExternalLink,
  FileText,
  LineChart,
  RefreshCw,
  Search,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { SwingerTradeChartModal, type SwingerTradeTarget } from "@/components/swinger-trade-chart-modal"
import { fmtNum, fmtRs, pnlClass, usePoll } from "@/lib/api"
import { cn } from "@/lib/utils"

export interface KotakHolding {
  symbol: string
  display_name: string
  sector: string
  quantity: number
  sellable_quantity: number
  buy_avg: number
  cmp: number
  invested_value: number
  current_value: number
  pnl: number
  pnl_pct: number
  prev_close: number
  day_change: number
  day_change_pct: number
  exchange: string
  tag: string
}

export interface KotakHoldingsResponse {
  ok: boolean
  error?: string
  summary: {
    total_portfolio_value: number
    total_invested: number
    total_unrealized_pnl: number
    total_unrealized_pnl_pct: number
    available_cash: number
    total_holdings_count: number
    gainers_count: number
    losers_count: number
  }
  holdings: KotakHolding[]
}

export interface PaperPosition {
  symbol: string
  name?: string
  entry_date: string
  entry_price: number
  avg_price: number
  cmp: number
  shares: number
  initial_qty?: number
  current_qty?: number
  invested: number
  sl_price: number
  initial_sl_pct?: number
  be_active?: boolean
  be_trigger_price?: number
  tp_hit?: boolean
  tp_target_price?: number
  runner_mode?: boolean
  runner_trail_sl?: number
  status?: string
  unrealized_pnl: number
  unrealized_pnl_pct: number
  pnl?: number
  pnl_pct?: number
  days_held: number
  bars_held?: number
  peak_price?: number
  highest_close?: number
  peak_gain_pct?: number
  entry_type?: string
  strategy_leg?: string
  leg?: number
  pyramided?: boolean
}

export interface PaperTrade {
  trade_id?: string | number
  symbol: string
  name?: string
  entry_date: string
  exit_date: string
  entry_price: number
  avg_price?: number
  exit_price: number
  shares: number
  qty?: number
  invested: number
  capital_invested?: number
  exit_value?: number
  pnl: number
  pnl_pct: number
  days_held: number
  bars_held?: number
  highest_price?: number
  reason?: string
  exit_reason?: string
  status?: string
  entry_type?: string
  leg?: string | number
}

export interface PaperHoldingsResponse {
  ok: boolean
  error?: string
  summary: {
    base_capital: number
    total_portfolio_value: number
    total_invested: number
    free_cash: number
    total_unrealized_pnl: number
    total_unrealized_pnl_pct: number
    total_realized_pnl: number
    total_combined_pnl: number
    active_positions_count: number
    closed_trades_count: number
    gainers_count: number
    losers_count: number
    win_rate: number
    profit_factor: number
    max_slots: number
    slot_size: number
  }
  positions: PaperPosition[]
  closed_trades?: PaperTrade[]
  last_updated?: string
}

type PortfolioMode = "paper" | "demat"
type FilterTab = "ALL" | "GAINERS" | "LOSERS"

export function HoldingsPage() {
  const [portfolioMode, setPortfolioMode] = useState<PortfolioMode>(() => {
    return (localStorage.getItem("holdings_portfolio_mode") as PortfolioMode) || "paper"
  })

  const [filterTab, setFilterTab] = useState<FilterTab>("ALL")
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedSymbol, setSelectedSymbol] = useState<string>("")
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Poll Demat holdings
  const { data: kotakData, loading: kotakLoading, reload: reloadKotak } = usePoll<KotakHoldingsResponse>(
    "/api/kotak/holdings",
    15000
  )

  // Poll Paper holdings (Active Positions & P&L)
  const { data: paperData, loading: paperLoading, reload: reloadPaper } = usePoll<PaperHoldingsResponse>(
    "/api/holdings/paper",
    15000
  )

  const handleModeChange = (mode: PortfolioMode) => {
    setPortfolioMode(mode)
    localStorage.setItem("holdings_portfolio_mode", mode)
    setFilterTab("ALL")
    setSearchQuery("")
    setSelectedSymbol("")
  }

  const handleManualRefresh = async () => {
    setIsRefreshing(true)
    try {
      if (portfolioMode === "demat") {
        await reloadKotak()
        toast.success("Kotak Demat holdings refreshed live!")
      } else {
        await reloadPaper()
        toast.success("Active Paper holdings & P&L refreshed!")
      }
    } catch {
      toast.error("Failed to refresh holdings")
    } finally {
      setIsRefreshing(false)
    }
  }

  // --- KOTAK DEMAT DATA ---
  const kotakHoldings = kotakData?.holdings || []
  const kotakSummary = kotakData?.summary || {
    total_portfolio_value: 0,
    total_invested: 0,
    total_unrealized_pnl: 0,
    total_unrealized_pnl_pct: 0,
    available_cash: 0,
    total_holdings_count: 0,
    gainers_count: 0,
    losers_count: 0,
  }

  // --- SWINGER PAPER DATA ---
  const paperPositions = paperData?.positions || []
  const paperSummary = paperData?.summary || {
    base_capital: 500000,
    total_portfolio_value: 0,
    total_invested: 0,
    free_cash: 0,
    total_unrealized_pnl: 0,
    total_unrealized_pnl_pct: 0,
    total_realized_pnl: 0,
    total_combined_pnl: 0,
    active_positions_count: 0,
    closed_trades_count: 0,
    gainers_count: 0,
    losers_count: 0,
    win_rate: 0,
    profit_factor: 0,
    max_slots: 20,
    slot_size: 25000,
  }

  // Auto-select first stock on load
  useEffect(() => {
    if (!selectedSymbol) {
      if (portfolioMode === "paper" && paperPositions.length > 0) {
        setSelectedSymbol(paperPositions[0].symbol)
      } else if (portfolioMode === "demat" && kotakHoldings.length > 0) {
        setSelectedSymbol(kotakHoldings[0].symbol)
      }
    }
  }, [selectedSymbol, portfolioMode, paperPositions, kotakHoldings])

  // Filtered Kotak Demat Holdings
  const filteredKotakHoldings = useMemo(() => {
    return kotakHoldings.filter((h) => {
      if (filterTab === "GAINERS" && h.pnl < 0) return false
      if (filterTab === "LOSERS" && h.pnl >= 0) return false
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase()
        return (
          h.symbol.toLowerCase().includes(q) ||
          (h.display_name || "").toLowerCase().includes(q) ||
          (h.sector || "").toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [kotakHoldings, filterTab, searchQuery])

  // Filtered Paper Active Positions
  const filteredPaperPositions = useMemo(() => {
    return paperPositions.filter((p) => {
      const pnl = p.unrealized_pnl ?? p.pnl ?? 0
      if (filterTab === "GAINERS" && pnl < 0) return false
      if (filterTab === "LOSERS" && pnl >= 0) return false
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase()
        return (
          p.symbol.toLowerCase().includes(q) ||
          (p.name || "").toLowerCase().includes(q) ||
          (p.strategy_leg || "").toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [paperPositions, filterTab, searchQuery])

  // Active Selected Trade Target for Right Side Chart
  const selectedTradeTarget = useMemo<SwingerTradeTarget | null>(() => {
    if (portfolioMode === "paper") {
      const pos = paperPositions.find((p) => p.symbol === selectedSymbol) || paperPositions[0]
      if (!pos) return null
      const pnl = pos.unrealized_pnl ?? pos.pnl ?? 0
      const pnlPct = pos.unrealized_pnl_pct ?? pos.pnl_pct ?? 0
      return {
        symbol: pos.symbol,
        name: pos.name || pos.symbol,
        entry_date: pos.entry_date,
        entry_price: pos.entry_price,
        avg_price: pos.avg_price,
        cmp: pos.cmp,
        qty: pos.shares || pos.current_qty,
        shares: pos.shares || pos.current_qty,
        pnl,
        pnl_pct: pnlPct,
        pct_return: pnlPct,
        days_held: pos.days_held,
        status: pos.runner_mode ? "RUNNER" : pos.be_active ? "SHIELDED" : "ACTIVE",
        leg: pos.leg,
        strategy_leg: pos.strategy_leg,
        sl_price: pos.sl_price,
        runner_trail_sl: pos.runner_trail_sl,
        be_active: pos.be_active,
        runner_mode: pos.runner_mode,
      } as any
    } else {
      const h = kotakHoldings.find((k) => k.symbol === selectedSymbol) || kotakHoldings[0]
      if (!h) return null
      return {
        symbol: h.symbol,
        name: h.display_name,
        avg_price: h.buy_avg,
        entry_price: h.buy_avg,
        cmp: h.cmp,
        qty: h.quantity,
        shares: h.quantity,
        pnl: h.pnl,
        pnl_pct: h.pnl_pct,
        pct_return: h.pnl_pct,
      } as any
    }
  }, [portfolioMode, paperPositions, kotakHoldings, selectedSymbol])

  const isPaperUnrealizedProfit = paperSummary.total_unrealized_pnl >= 0

  return (
    <div className="w-full flex-1 flex flex-col gap-3 p-2.5 sm:p-4 pb-16 select-none">
      {/* 1. CLEAN EXECUTIVE TITLE & CONTROLS BAR */}
      <div className="flex items-center justify-between gap-3 shrink-0 pb-1 border-b border-border/60">
        <div className="flex items-center gap-2.5">
          <div
            className={cn(
              "size-9 rounded-xl flex items-center justify-center font-bold shadow-2xs transition-colors shrink-0",
              portfolioMode === "paper"
                ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"
                : "bg-primary/10 text-primary border border-primary/20"
            )}
          >
            {portfolioMode === "paper" ? <FileText className="size-4.5" /> : <Briefcase className="size-4.5" />}
          </div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold tracking-tight text-foreground">Holdings</h1>
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] font-mono px-2 py-0.5 uppercase tracking-wide",
                portfolioMode === "paper"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500 font-bold"
                  : "border-blue-500/30 bg-blue-500/10 text-blue-500 font-bold"
              )}
            >
              {portfolioMode === "paper" ? "Paper Active" : "Demat Live"}
            </Badge>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Mode Switcher */}
          <div className="flex items-center p-0.5 bg-muted/70 rounded-lg border border-border/50 shadow-2xs">
            <button
              onClick={() => handleModeChange("paper")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition-all select-none",
                portfolioMode === "paper"
                  ? "bg-background text-emerald-500 shadow-2xs border border-border/60 font-bold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span>Paper</span>
              <span className="px-1.5 py-0 rounded-full text-[10px] bg-emerald-500/15 text-emerald-500 font-mono font-bold">
                {paperPositions.length}
              </span>
            </button>
            <button
              onClick={() => handleModeChange("demat")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition-all select-none",
                portfolioMode === "demat"
                  ? "bg-background text-primary shadow-2xs border border-border/60 font-bold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span>Demat</span>
              <span className="px-1.5 py-0 rounded-full text-[10px] bg-primary/15 text-primary font-mono font-bold">
                {kotakHoldings.length}
              </span>
            </button>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleManualRefresh}
            disabled={isRefreshing || (portfolioMode === "paper" ? paperLoading : kotakLoading)}
            className="text-xs gap-1.5 h-8 font-medium shadow-2xs px-3"
          >
            <RefreshCw
              className={cn(
                "size-3.5",
                (isRefreshing || (portfolioMode === "paper" ? paperLoading : kotakLoading)) && "animate-spin"
              )}
            />
            Sync
          </Button>

          {portfolioMode === "paper" && (
            <a
              href="/swinger"
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground border border-border/60 transition-colors shadow-2xs h-8"
              title="Open Swinger Closed Trades Ledger & Strategy Analytics"
            >
              <LineChart className="size-3.5 text-emerald-500" />
              <span>Closed ({paperSummary.closed_trades_count || 66})</span>
              <ExternalLink className="size-3 opacity-60" />
            </a>
          )}
        </div>
      </div>

      {/* 2. ONE-LINE HORIZONTAL STATS STRIP (CLEAN, POLISHED & COMFORTABLE) */}
      {portfolioMode === "paper" ? (
        <div className="flex items-center justify-between px-3.5 py-2 bg-muted/30 border border-border/50 rounded-xl text-xs gap-3 overflow-x-auto shrink-0 shadow-2xs">
          {/* Item 1: Holdings Value */}
          <div className="flex items-center gap-2 font-mono shrink-0">
            <Wallet className="size-4 text-emerald-500 shrink-0" />
            <span className="text-muted-foreground font-sans">Holdings:</span>
            <span className="font-bold text-foreground text-sm">
              {paperLoading && !paperData ? (
                <Skeleton className="h-4 w-16 inline-block" />
              ) : (
                fmtRs(paperSummary.total_invested + paperSummary.total_unrealized_pnl)
              )}
            </span>
            <span className="text-[11px] text-muted-foreground font-sans">({paperPositions.length} Stocks)</span>
          </div>

          <div className="h-3.5 w-px bg-border/60 shrink-0" />

          {/* Item 2: Invested */}
          <div className="flex items-center gap-2 font-mono shrink-0">
            <Activity className="size-4 text-sky-500 shrink-0" />
            <span className="text-muted-foreground font-sans">Invested:</span>
            <span className="font-semibold text-foreground text-sm">
              {paperLoading && !paperData ? <Skeleton className="h-4 w-16 inline-block" /> : fmtRs(paperSummary.total_invested)}
            </span>
            <span className="text-[11px] text-muted-foreground font-sans">(₹25k slot)</span>
          </div>

          <div className="h-3.5 w-px bg-border/60 shrink-0" />

          {/* Item 3: Unrealized P&L */}
          <div className="flex items-center gap-2 font-mono shrink-0">
            {isPaperUnrealizedProfit ? (
              <TrendingUp className="size-4 text-emerald-500 shrink-0" />
            ) : (
              <TrendingDown className="size-4 text-rose-500 shrink-0" />
            )}
            <span className="text-muted-foreground font-sans">Unrealized P&L:</span>
            <span className={cn("font-bold text-sm", pnlClass(paperSummary.total_unrealized_pnl))}>
              {paperLoading && !paperData ? (
                <Skeleton className="h-4 w-16 inline-block" />
              ) : (
                `${paperSummary.total_unrealized_pnl >= 0 ? "+" : ""}${fmtRs(paperSummary.total_unrealized_pnl)}`
              )}
            </span>
            <span
              className={cn(
                "text-xs font-bold px-1.5 py-0.5 rounded font-mono",
                isPaperUnrealizedProfit ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" : "bg-rose-500/10 text-rose-500 border border-rose-500/20"
              )}
            >
              {paperSummary.total_unrealized_pnl >= 0 ? "+" : ""}
              {paperSummary.total_unrealized_pnl_pct.toFixed(2)}%
            </span>
            <span className="text-[11px] text-muted-foreground font-sans">
              ({paperSummary.gainers_count}G / {paperSummary.losers_count}L)
            </span>
          </div>

          <div className="h-3.5 w-px bg-border/60 shrink-0" />

          {/* Item 4: Available Cash */}
          <div className="flex items-center gap-2 font-mono shrink-0">
            <Coins className="size-4 text-amber-500 shrink-0" />
            <span className="text-muted-foreground font-sans">Cash:</span>
            <span className="font-bold text-foreground text-sm">
              {paperLoading && !paperData ? <Skeleton className="h-4 w-16 inline-block" /> : fmtRs(paperSummary.free_cash)}
            </span>
            <span className="text-xs text-emerald-500 font-bold font-sans">
              ({paperSummary.max_slots - paperPositions.length} Slots Free)
            </span>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between px-3.5 py-2 bg-muted/30 border border-border/50 rounded-xl text-xs gap-3 overflow-x-auto shrink-0 shadow-2xs">
          <div className="flex items-center gap-2 font-mono shrink-0">
            <Wallet className="size-4 text-primary shrink-0" />
            <span className="text-muted-foreground font-sans">Demat Value:</span>
            <span className="font-bold text-foreground text-sm">{fmtRs(kotakSummary.total_portfolio_value)}</span>
            <span className="text-[11px] text-muted-foreground font-sans">({kotakHoldings.length} Stocks)</span>
          </div>
          <div className="h-3.5 w-px bg-border/60 shrink-0" />
          <div className="flex items-center gap-2 font-mono shrink-0">
            <Activity className="size-4 text-sky-500 shrink-0" />
            <span className="text-muted-foreground font-sans">Invested:</span>
            <span className="font-semibold text-foreground text-sm">{fmtRs(kotakSummary.total_invested)}</span>
          </div>
          <div className="h-3.5 w-px bg-border/60 shrink-0" />
          <div className="flex items-center gap-2 font-mono shrink-0">
            <TrendingUp className="size-4 text-emerald-500 shrink-0" />
            <span className="text-muted-foreground font-sans">Total P&L:</span>
            <span className={cn("font-bold text-sm", pnlClass(kotakSummary.total_unrealized_pnl))}>
              {kotakSummary.total_unrealized_pnl >= 0 ? "+" : ""}{fmtRs(kotakSummary.total_unrealized_pnl)} ({kotakSummary.total_unrealized_pnl_pct.toFixed(2)}%)
            </span>
          </div>
          <div className="h-3.5 w-px bg-border/60 shrink-0" />
          <div className="flex items-center gap-2 font-mono shrink-0">
            <Coins className="size-4 text-amber-500 shrink-0" />
            <span className="text-muted-foreground font-sans">Cash Margin:</span>
            <span className="font-bold text-foreground text-sm">{fmtRs(kotakSummary.available_cash)}</span>
          </div>
        </div>
      )}

      {/* 3. MASTER-DETAIL SPLIT LAYOUT (BALANCED TRADES LIST LEFT · CHART RIGHT) */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-3 overflow-hidden">
        {/* ================= LEFT COLUMN: FILTER & TRADES LIST ================= */}
        <div className="lg:col-span-5 xl:col-span-5 flex flex-col gap-2 min-h-0 h-full overflow-hidden">
          {/* Filter Tabs & Search Bar */}
          <div className="flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-1 p-0.5 bg-muted/60 rounded-lg border border-border/50 text-xs font-semibold">
              <button
                onClick={() => setFilterTab("ALL")}
                className={cn(
                  "px-2.5 py-1 rounded-md transition-all",
                  filterTab === "ALL" ? "bg-background text-foreground shadow-2xs font-bold" : "text-muted-foreground hover:text-foreground"
                )}
              >
                All ({portfolioMode === "paper" ? paperPositions.length : kotakHoldings.length})
              </button>
              <button
                onClick={() => setFilterTab("GAINERS")}
                className={cn(
                  "px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 text-emerald-500",
                  filterTab === "GAINERS"
                    ? "bg-emerald-500/10 text-emerald-500 font-bold shadow-2xs border border-emerald-500/20"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <TrendingUp className="size-3.5" />
                {portfolioMode === "paper" ? paperSummary.gainers_count : kotakSummary.gainers_count}
              </button>
              <button
                onClick={() => setFilterTab("LOSERS")}
                className={cn(
                  "px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 text-rose-500",
                  filterTab === "LOSERS"
                    ? "bg-rose-500/10 text-rose-500 font-bold shadow-2xs border border-rose-500/20"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <TrendingDown className="size-3.5" />
                {portfolioMode === "paper" ? paperSummary.losers_count : kotakSummary.losers_count}
              </button>
            </div>

            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search stock..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-muted/40 border border-border/60 rounded-lg pl-8.5 pr-2.5 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary h-8"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* TRADES TABLE (CLICKABLE ROWS · NO EXTRA CHART COLUMN) */}
          <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-border/60 bg-card shadow-2xs">
            {portfolioMode === "paper" ? (
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 bg-muted/95 backdrop-blur-xs z-10 border-b border-border/60 text-muted-foreground font-bold uppercase tracking-wider text-[10px] select-none">
                  <tr>
                    <th className="py-2.5 px-3">Stock / Leg</th>
                    <th className="py-2.5 px-2.5 text-right font-mono">CMP & Avg</th>
                    <th className="py-2.5 px-2.5 text-right font-mono">Unrealized P&L</th>
                    <th className="py-2.5 px-3 text-right font-mono">SL / Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {paperLoading && !paperData ? (
                    <tr>
                      <td colSpan={4} className="py-12 text-center text-muted-foreground">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <RefreshCw className="size-4 animate-spin text-emerald-500" />
                          <span className="text-xs">Loading holdings...</span>
                        </div>
                      </td>
                    </tr>
                  ) : filteredPaperPositions.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-10 text-center text-muted-foreground text-xs">
                        No active positions found.
                      </td>
                    </tr>
                  ) : (
                    filteredPaperPositions.map((pos) => {
                      const pnl = pos.unrealized_pnl ?? pos.pnl ?? 0
                      const pnlPct = pos.unrealized_pnl_pct ?? pos.pnl_pct ?? 0
                      const isProfit = pnl >= 0
                      const isLeg2 = pos.leg === 2 || String(pos.strategy_leg || "").toUpperCase().includes("LEG2")
                      const avgPx = pos.avg_price || pos.entry_price
                      const shares = pos.shares || pos.current_qty || pos.initial_qty || 0
                      const isSelected = selectedSymbol === pos.symbol

                      return (
                        <tr
                          key={pos.symbol}
                          onClick={() => setSelectedSymbol(pos.symbol)}
                          className={cn(
                            "cursor-pointer transition-all group select-none border-l-4",
                            isSelected
                              ? "bg-emerald-500/10 dark:bg-emerald-500/15 border-l-emerald-500 shadow-2xs font-semibold"
                              : "hover:bg-muted/40 border-l-transparent"
                          )}
                        >
                          {/* 1. Stock / Leg */}
                          <td className="py-2.5 px-3">
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className={cn(
                                    "font-bold text-sm tracking-tight transition-colors font-mono",
                                    isSelected ? "text-emerald-500 font-extrabold" : "text-foreground group-hover:text-emerald-500"
                                  )}
                                >
                                  {pos.symbol}
                                </span>
                                {isLeg2 ? (
                                  <span className="px-1.5 py-0.2 rounded text-[9px] font-black bg-amber-500/15 text-amber-500 border border-amber-500/25">
                                    LEG 2
                                  </span>
                                ) : (
                                  <span className="px-1.5 py-0.2 rounded text-[9px] font-black bg-blue-500/15 text-blue-500 border border-blue-500/25">
                                    LEG 1
                                  </span>
                                )}
                                <a
                                  href={`https://in.tradingview.com/chart/?symbol=NSE:${pos.symbol}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="opacity-40 group-hover:opacity-100 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-all"
                                  title="Open on TradingView"
                                >
                                  <ExternalLink className="size-3.5" />
                                </a>
                              </div>
                              <span className="text-[11px] text-muted-foreground">
                                {pos.days_held}d held · {pos.name || pos.symbol}
                              </span>
                            </div>
                          </td>

                          {/* 2. CMP & Avg */}
                          <td className="py-2.5 px-2.5 text-right font-mono">
                            <div className="font-bold text-sm text-foreground">
                              ₹{pos.cmp.toFixed(2)}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              Avg ₹{avgPx.toFixed(1)} · {shares}q
                            </div>
                          </td>

                          {/* 3. P&L */}
                          <td className="py-2.5 px-2.5 text-right font-mono">
                            <div className={cn("font-bold text-sm", pnlClass(pnl))}>
                              {isProfit ? "+" : ""}
                              {fmtRs(pnl)}
                            </div>
                            <div
                              className={cn(
                                "text-[11px] font-bold",
                                isProfit ? "text-emerald-500" : "text-rose-500"
                              )}
                            >
                              {isProfit ? "+" : ""}
                              {pnlPct.toFixed(1)}%
                            </div>
                          </td>

                          {/* 4. SL / Protection */}
                          <td className="py-2.5 px-3 text-right font-mono">
                            {pos.runner_mode ? (
                              <div className="flex flex-col items-end">
                                <span className="text-xs font-bold text-purple-400">
                                  ₹{pos.runner_trail_sl?.toFixed(1)}
                                </span>
                                <span className="text-[10px] text-purple-400/80 font-medium">Runner Trail</span>
                              </div>
                            ) : pos.be_active ? (
                              <div className="flex flex-col items-end">
                                <span className="text-xs font-bold text-emerald-400 flex items-center gap-0.5">
                                  <ShieldCheck className="size-3 inline" /> ₹{pos.sl_price.toFixed(1)}
                                </span>
                                <span className="text-[10px] text-emerald-400/80 font-medium">Cost Shield</span>
                              </div>
                            ) : (
                              <div className="flex flex-col items-end">
                                <span className="text-xs font-semibold text-rose-400">
                                  ₹{pos.sl_price.toFixed(1)}
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  {isLeg2 ? "Base SL -8%" : "SL -15%"}
                                </span>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 bg-muted/95 backdrop-blur-xs z-10 border-b border-border/60 text-muted-foreground font-bold uppercase tracking-wider text-[10px] select-none">
                  <tr>
                    <th className="py-2.5 px-3">Stock Instrument</th>
                    <th className="py-2.5 px-2.5 text-right font-mono">CMP & Avg</th>
                    <th className="py-2.5 px-3 text-right font-mono">Total P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {kotakLoading && !kotakData ? (
                    <tr>
                      <td colSpan={3} className="py-12 text-center text-muted-foreground">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <RefreshCw className="size-4 animate-spin text-primary" />
                          <span className="text-xs">Loading Demat...</span>
                        </div>
                      </td>
                    </tr>
                  ) : filteredKotakHoldings.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-10 text-center text-muted-foreground text-xs">
                        No Demat holdings found.
                      </td>
                    </tr>
                  ) : (
                    filteredKotakHoldings.map((h) => {
                      const isProfit = h.pnl >= 0
                      const isSelected = selectedSymbol === h.symbol

                      return (
                        <tr
                          key={h.symbol}
                          onClick={() => setSelectedSymbol(h.symbol)}
                          className={cn(
                            "cursor-pointer transition-all group select-none border-l-4",
                            isSelected
                              ? "bg-primary/10 border-l-primary shadow-2xs font-semibold"
                              : "hover:bg-muted/40 border-l-transparent"
                          )}
                        >
                          <td className="py-2.5 px-3">
                            <div className="flex flex-col">
                              <span
                                className={cn(
                                  "font-bold text-sm tracking-tight font-mono",
                                  isSelected ? "text-primary font-extrabold" : "text-foreground group-hover:text-primary"
                                )}
                              >
                                {h.symbol}
                              </span>
                              <span className="text-[11px] text-muted-foreground truncate max-w-[140px]">
                                {h.display_name}
                              </span>
                            </div>
                          </td>
                          <td className="py-2.5 px-2.5 text-right font-mono">
                            <div className="font-bold text-sm text-foreground">₹{h.cmp.toFixed(2)}</div>
                            <div className="text-[11px] text-muted-foreground">
                              ₹{h.buy_avg.toFixed(1)} · {fmtNum(h.quantity)}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono">
                            <div className={cn("font-bold text-sm", pnlClass(h.pnl))}>
                              {isProfit ? "+" : ""}
                              {fmtRs(h.pnl)}
                            </div>
                            <div
                              className={cn(
                                "text-[11px] font-bold",
                                isProfit ? "text-emerald-500" : "text-rose-500"
                              )}
                            >
                              {isProfit ? "+" : ""}
                              {h.pnl_pct.toFixed(1)}%
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ================= RIGHT COLUMN: EMBEDDED TECHNICAL CHART ================= */}
        <div className="lg:col-span-7 xl:col-span-7 h-full min-h-0 overflow-hidden flex flex-col rounded-2xl border border-border/70 shadow-2xs bg-white dark:bg-card">
          {selectedTradeTarget ? (
            <div className="w-full h-full min-h-0 flex-1 overflow-hidden">
              <SwingerTradeChartModal
                trade={selectedTradeTarget}
                allTrades={(portfolioMode === "paper" ? paperPositions : kotakHoldings) as any}
                onSelectTrade={(t) => setSelectedSymbol(t.symbol)}
                embedded={true}
              />
            </div>
          ) : (
            <div className="w-full h-full min-h-0 flex-1 flex items-center justify-center text-muted-foreground">
              <div className="flex flex-col items-center gap-2">
                <LineChart className="size-8 opacity-40" />
                <span className="text-xs">Click any stock on the left to view technical candlestick chart</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

import { useMemo, useState } from "react"
import {
  ArrowDownRight,
  ArrowUpRight,
  Briefcase,
  ExternalLink,
  LineChart,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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

type SortField = "current_value" | "invested_value" | "pnl" | "pnl_pct" | "symbol" | "quantity"
type SortOrder = "asc" | "desc"
type FilterTab = "ALL" | "GAINERS" | "LOSERS"

export function HoldingsPage() {
  const [filterTab, setFilterTab] = useState<FilterTab>("ALL")
  const [searchQuery, setSearchQuery] = useState("")
  const [sortField, setSortField] = useState<SortField>("current_value")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")
  const [selectedTrade, setSelectedTrade] = useState<SwingerTradeTarget | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const { data, loading, reload } = usePoll<KotakHoldingsResponse>("/api/kotak/holdings", 15000)

  const handleManualRefresh = async () => {
    setIsRefreshing(true)
    try {
      await reload()
      toast.success("Kotak Demat holdings refreshed live!")
    } catch {
      toast.error("Failed to refresh Kotak holdings")
    } finally {
      setIsRefreshing(false)
    }
  }

  const holdings = data?.holdings || []
  const summary = data?.summary || {
    total_portfolio_value: 0,
    total_invested: 0,
    total_unrealized_pnl: 0,
    total_unrealized_pnl_pct: 0,
    available_cash: 0,
    total_holdings_count: 0,
    gainers_count: 0,
    losers_count: 0,
  }

  const filteredAndSortedHoldings = useMemo(() => {
    return holdings
      .filter((h) => {
        // Tab filter
        if (filterTab === "GAINERS" && h.pnl < 0) return false
        if (filterTab === "LOSERS" && h.pnl >= 0) return false

        // Search query
        if (searchQuery.trim()) {
          const q = searchQuery.trim().toLowerCase()
          const sym = h.symbol.toLowerCase()
          const name = (h.display_name || "").toLowerCase()
          const sec = (h.sector || "").toLowerCase()
          return sym.includes(q) || name.includes(q) || sec.includes(q)
        }
        return true
      })
      .sort((a, b) => {
        let valA = a[sortField]
        let valB = b[sortField]

        if (typeof valA === "string") {
          const comp = (valA as string).localeCompare(valB as string)
          return sortOrder === "asc" ? comp : -comp
        }

        const numA = Number(valA) || 0
        const numB = Number(valB) || 0
        return sortOrder === "asc" ? numA - numB : numB - numA
      })
  }, [holdings, filterTab, searchQuery, sortField, sortOrder])

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortOrder("desc")
    }
  }

  const isNetProfit = summary.total_unrealized_pnl >= 0

  return (
    <div className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col gap-5 pb-20">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="size-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-bold">
              <Briefcase className="size-5" />
            </div>
            <div>
              <h1 className="text-xl md:text-2xl font-bold tracking-tight">Kotak Demat Holdings</h1>
              <p className="text-xs text-muted-foreground">
                Live portfolio · Connected to Kotak Neo Demat Account
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Badge variant="outline" className="gap-1.5 py-1 px-2.5 border-emerald-500/30 bg-emerald-500/5 text-emerald-400 font-mono text-xs">
            <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
            Kotak Neo Live
          </Badge>

          <Button
            variant="outline"
            size="sm"
            onClick={handleManualRefresh}
            disabled={isRefreshing || loading}
            className="text-xs gap-1.5 h-8 font-medium shadow-xs"
          >
            <RefreshCw className={cn("size-3.5", (isRefreshing || loading) && "animate-spin")} />
            Sync Kotak
          </Button>
        </div>
      </div>

      {/* Top Summary KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <Card className="border-border/60 shadow-xs">
          <CardHeader className="pb-1 pt-3.5 px-4">
            <CardDescription className="text-[11px] font-medium text-muted-foreground flex items-center justify-between">
              Current Portfolio Value
              <Wallet className="size-3.5 text-muted-foreground/60" />
            </CardDescription>
            <CardTitle className="text-xl md:text-2xl font-bold font-mono tracking-tight text-foreground">
              {loading && !data ? <Skeleton className="h-7 w-28" /> : fmtRs(summary.total_portfolio_value)}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 pt-0">
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 font-medium">
              Invested: <span className="font-mono text-foreground">{fmtRs(summary.total_invested)}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/60 shadow-xs">
          <CardHeader className="pb-1 pt-3.5 px-4">
            <CardDescription className="text-[11px] font-medium text-muted-foreground flex items-center justify-between">
              Overall Demat P&L
              {isNetProfit ? (
                <ArrowUpRight className="size-3.5 text-emerald-500" />
              ) : (
                <ArrowDownRight className="size-3.5 text-rose-500" />
              )}
            </CardDescription>
            <CardTitle className={cn("text-xl md:text-2xl font-bold font-mono tracking-tight", pnlClass(summary.total_unrealized_pnl))}>
              {loading && !data ? <Skeleton className="h-7 w-24" /> : fmtRs(summary.total_unrealized_pnl)}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 pt-0">
            <div className="text-[11px] flex items-center gap-1.5 font-mono">
              <span className={cn("font-semibold", pnlClass(summary.total_unrealized_pnl))}>
                {summary.total_unrealized_pnl >= 0 ? "+" : ""}
                {summary.total_unrealized_pnl_pct.toFixed(2)}%
              </span>
              <span className="text-muted-foreground text-[10px]">unrealized</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/60 shadow-xs">
          <CardHeader className="pb-1 pt-3.5 px-4">
            <CardDescription className="text-[11px] font-medium text-muted-foreground flex items-center justify-between">
              Available Cash Margin
              <span className="text-[10px] text-muted-foreground font-mono">Kotak Neo</span>
            </CardDescription>
            <CardTitle className="text-xl md:text-2xl font-bold font-mono tracking-tight text-foreground">
              {loading && !data ? <Skeleton className="h-7 w-24" /> : fmtRs(summary.available_cash)}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 pt-0">
            <div className="text-[11px] text-muted-foreground">
              Free cash ready for Swinger deployment
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/60 shadow-xs">
          <CardHeader className="pb-1 pt-3.5 px-4">
            <CardDescription className="text-[11px] font-medium text-muted-foreground flex items-center justify-between">
              Holdings Health
              <span className="text-[10px] text-muted-foreground">{summary.total_holdings_count} stocks</span>
            </CardDescription>
            <CardTitle className="text-xl md:text-2xl font-bold font-mono tracking-tight flex items-center gap-2">
              <span className="text-emerald-500 text-lg md:text-xl font-bold">{summary.gainers_count}</span>
              <span className="text-xs text-muted-foreground font-normal">Profits</span>
              <span className="text-muted-foreground/40">/</span>
              <span className="text-rose-500 text-lg md:text-xl font-bold">{summary.losers_count}</span>
              <span className="text-xs text-muted-foreground font-normal">Losses</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 pt-0">
            <div className="w-full bg-rose-500/20 h-1.5 rounded-full overflow-hidden flex">
              <div
                className="bg-emerald-500 h-full"
                style={{
                  width: `${(summary.gainers_count / (summary.total_holdings_count || 1)) * 100}%`,
                }}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filter, Search & Tabs */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-2">
        <div className="flex items-center gap-1.5 p-1 bg-muted/60 rounded-xl border border-border/50 w-fit">
          <button
            onClick={() => setFilterTab("ALL")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-semibold transition-all",
              filterTab === "ALL"
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            All Holdings ({holdings.length})
          </button>
          <button
            onClick={() => setFilterTab("GAINERS")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5",
              filterTab === "GAINERS"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <TrendingUp className="size-3 text-emerald-500" />
            Gainers ({summary.gainers_count})
          </button>
          <button
            onClick={() => setFilterTab("LOSERS")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5",
              filterTab === "LOSERS"
                ? "bg-rose-500/10 text-rose-400 border border-rose-500/20 shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <TrendingDown className="size-3 text-rose-500" />
            Losers ({summary.losers_count})
          </button>
        </div>

        <div className="flex items-center gap-2.5 w-full md:w-auto">
          <div className="relative flex-1 md:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search symbol, company, sector..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-muted/40 border border-border/60 rounded-lg pl-9 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Holdings Table */}
      <Card className="border-border/60 overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b bg-muted/30 text-muted-foreground font-medium select-none">
                <th
                  onClick={() => toggleSort("symbol")}
                  className="py-3 px-4 cursor-pointer hover:text-foreground transition-colors"
                >
                  <div className="flex items-center gap-1">
                    Stock Instrument
                    {sortField === "symbol" && (sortOrder === "asc" ? " ↑" : " ↓")}
                  </div>
                </th>
                <th
                  onClick={() => toggleSort("quantity")}
                  className="py-3 px-3 text-right cursor-pointer hover:text-foreground transition-colors"
                >
                  <div className="flex items-center justify-end gap-1">
                    Quantity
                    {sortField === "quantity" && (sortOrder === "asc" ? " ↑" : " ↓")}
                  </div>
                </th>
                <th className="py-3 px-3 text-right">Avg Buy Price</th>
                <th className="py-3 px-3 text-right">CMP</th>
                <th
                  onClick={() => toggleSort("invested_value")}
                  className="py-3 px-3 text-right cursor-pointer hover:text-foreground transition-colors"
                >
                  <div className="flex items-center justify-end gap-1">
                    Invested
                    {sortField === "invested_value" && (sortOrder === "asc" ? " ↑" : " ↓")}
                  </div>
                </th>
                <th
                  onClick={() => toggleSort("current_value")}
                  className="py-3 px-3 text-right cursor-pointer hover:text-foreground transition-colors"
                >
                  <div className="flex items-center justify-end gap-1">
                    Current Value
                    {sortField === "current_value" && (sortOrder === "asc" ? " ↑" : " ↓")}
                  </div>
                </th>
                <th
                  onClick={() => toggleSort("pnl")}
                  className="py-3 px-4 text-right cursor-pointer hover:text-foreground transition-colors"
                >
                  <div className="flex items-center justify-end gap-1">
                    Total P&L
                    {sortField === "pnl" && (sortOrder === "asc" ? " ↑" : " ↓")}
                  </div>
                </th>
                <th className="py-3 px-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 font-mono">
              {loading && !data ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <RefreshCw className="size-5 animate-spin text-primary" />
                      <span>Loading Kotak Demat holdings...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredAndSortedHoldings.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-muted-foreground">
                    No holdings match your search criteria.
                  </td>
                </tr>
              ) : (
                filteredAndSortedHoldings.map((h) => {
                  const isProfit = h.pnl >= 0
                  return (
                    <tr
                      key={h.symbol}
                      className="hover:bg-muted/30 transition-colors group"
                    >
                      {/* Symbol & Name */}
                      <td className="py-3 px-4">
                        <div className="flex flex-col">
                          <span className="font-bold text-sm text-foreground tracking-wide font-sans">
                            {h.symbol}
                          </span>
                          <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-muted-foreground font-sans">
                            <span className="truncate max-w-[220px]" title={h.display_name}>
                              {h.display_name}
                            </span>
                            <span className="text-muted-foreground/40">•</span>
                            <span className="text-[10px] text-muted-foreground/80 truncate max-w-[150px]">
                              {h.sector}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Quantity */}
                      <td className="py-3 px-3 text-right">
                        <div className="font-semibold text-foreground">{fmtNum(h.quantity)}</div>
                        {h.sellable_quantity < h.quantity && (
                          <div className="text-[10px] text-amber-500">
                            Sellable: {h.sellable_quantity}
                          </div>
                        )}
                      </td>

                      {/* Avg Price */}
                      <td className="py-3 px-3 text-right text-muted-foreground">
                        ₹{h.buy_avg.toFixed(2)}
                      </td>

                      {/* CMP */}
                      <td className="py-3 px-3 text-right font-semibold text-foreground">
                        ₹{h.cmp.toFixed(2)}
                      </td>

                      {/* Invested */}
                      <td className="py-3 px-3 text-right text-muted-foreground">
                        {fmtRs(h.invested_value)}
                      </td>

                      {/* Current Value */}
                      <td className="py-3 px-3 text-right font-bold text-foreground">
                        {fmtRs(h.current_value)}
                      </td>

                      {/* Total P&L */}
                      <td className="py-3 px-4 text-right">
                        <div className={cn("font-bold", pnlClass(h.pnl))}>
                          {isProfit ? "+" : ""}
                          {fmtRs(h.pnl)}
                        </div>
                        <div
                          className={cn(
                            "text-[10px] font-semibold mt-0.5",
                            isProfit ? "text-emerald-500" : "text-rose-500"
                          )}
                        >
                          {isProfit ? "+" : ""}
                          {h.pnl_pct.toFixed(2)}%
                        </div>
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center gap-1.5 font-sans">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setSelectedTrade({
                                symbol: h.symbol,
                                name: h.display_name,
                                cmp: h.cmp,
                                qty: h.quantity,
                                avg_price: h.buy_avg,
                                pnl: h.pnl,
                                pnl_pct: h.pnl_pct,
                              })
                            }
                            className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
                            title="Open Technical Candlestick Chart"
                          >
                            <LineChart className="size-3.5" />
                            Chart
                          </Button>

                          <a
                            href={`https://in.tradingview.com/chart/?symbol=NSE:${h.symbol}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                            title="Open in TradingView"
                          >
                            <ExternalLink className="size-3.5" />
                          </a>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Candlestick Modal */}
      {selectedTrade && (
        <SwingerTradeChartModal
          trade={selectedTrade}
          onClose={() => setSelectedTrade(null)}
        />
      )}
    </div>
  )
}

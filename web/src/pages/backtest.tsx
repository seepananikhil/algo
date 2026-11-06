import { useMemo, useState } from "react"







import { DayPanel } from "@/components/day-detail"







import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"







import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"







import { Skeleton } from "@/components/ui/skeleton"







import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"







import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"







import { SideBadge, StatCard } from "@/components/common"







import { PnlCalendar } from "@/components/pnl-calendar"







import { StrategyStreakSummary } from "@/components/strategy-streak-summary"







import { cn } from "@/lib/utils"







import { RefreshCw } from "lucide-react"











import { toast } from "sonner"







import { fmtNum, fmtPts, fmtRs, pnlClass, prettyReason, usePoll, type Backtest } from "@/lib/api"















/** Backtest restricted to one year ("all" = everything), with equity/drawdown restarting at 0. */







function forYear(data: Backtest, year: string): Backtest {

  const safeData: Backtest = {

    ...data,

    summary: data.summary ?? {},

    trades: data.trades ?? [],

    daily: data.daily ?? [],

    monthly: data.monthly ?? [],

    exit_reasons: data.exit_reasons ?? [],

  }

  if (year === "all") return safeData

  let equity = 0

  let peak = 0

  const trades = safeData.trades.filter((t) => t.date && t.date.startsWith(year)).map((t) => {

    equity += t.pnl_points

    peak = Math.max(peak, equity)

    return { ...t, equity, drawdown: equity - peak }

  })

  const daily = safeData.daily.filter((d) => d.date && d.date.startsWith(year))

  const reasons = new Map<string, number>()

  trades.forEach((t) => reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1))

  const pts = trades.map((t) => t.pnl_points)

  const wins = pts.filter((p) => p > 0).length

  const total = pts.reduce((a, p) => a + p, 0)

  return {

    summary: {

      ...safeData.summary,

      from: daily[0]?.date ?? "",

      to: daily[daily.length - 1]?.date ?? "",

      days: daily.length,

      trades: trades.length,

      wins,

      losses: pts.filter((p) => p < 0).length,

      win_rate_pct: trades.length ? Math.round((10000 * wins) / trades.length) / 100 : 0,

      total_points: total,

      avg_points: trades.length ? total / trades.length : 0,

      max_drawdown: Math.min(0, ...trades.map((t) => t.drawdown)),

      best: pts.length ? Math.max(...pts) : 0,

      worst: pts.length ? Math.min(...pts) : 0,

    },

    trades,

    daily,

    monthly: safeData.monthly.filter((m) => m.month && m.month.startsWith(year)),

    exit_reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),

  }

}















const axis = { stroke: "var(--muted-foreground)", fontSize: 11, tickLine: false, axisLine: false }







const tooltip = {







  contentStyle: { background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 },







  labelStyle: { color: "var(--muted-foreground)" },







}















type StrategyKey = "trend_runner" | "sensex_runner" | "midpoint" | "dynamic_box" | "vix_divergence" | "sensex_vix_divergence"















export function BacktestPage() {







  const [strategy, setStrategy] = useState<StrategyKey>(() => {







    const saved = localStorage.getItem("backtest_strategy") as StrategyKey







    if (saved === "sensex_runner" || saved === "midpoint" || saved === "dynamic_box" || saved === "vix_divergence" || saved === "sensex_vix_divergence") return saved
    return "trend_runner"







  })







  const handleStrategyChange = (value: StrategyKey) => {







    localStorage.setItem("backtest_strategy", value)







    setStrategy(value)







  }







  const { data: raw, loading, error, reload } = usePoll<Backtest>(
    strategy === "sensex_runner"
      ? "/api/backtest?strategy=sensex_runner"
      : strategy === "midpoint"
      ? "/api/backtest?strategy=midpoint"
      : strategy === "dynamic_box"
      ? "/api/backtest?strategy=dynamic_box"
      : strategy === "vix_divergence"
      ? "/api/backtest?strategy=vix_divergence"
      : strategy === "sensex_vix_divergence"
      ? "/api/backtest?strategy=sensex_vix_divergence"
      
      : "/api/backtest?strategy=trend_runner"
  )







  const [filter, setFilter] = useState("all")
  const [isSyncing, setIsSyncing] = useState(false)

  const handleSyncBacktest = async () => {
    if (isSyncing) return
    setIsSyncing(true)
    toast.info("Syncing latest data & updating 10-year master backtests...")
    try {
      const res = await fetch("/api/backtest/sync")
      const d = await res.json()
      if (!d.ok && !d.running) {
        toast.error("Sync error: " + (d.message || "Failed"))
        setIsSyncing(false)
        return
      }

      const pollInterval = setInterval(async () => {
        try {
          const sRes = await fetch("/api/backtest/sync/status")
          const s = await sRes.json()
          if (s.status === "completed") {
            clearInterval(pollInterval)
            setIsSyncing(false)
            if (reload) await reload()
            toast.success("10-Year Backtests updated successfully with latest data!")
          } else if (s.status === "failed") {
            clearInterval(pollInterval)
            setIsSyncing(false)
            toast.error(s.message || "Backtest update failed")
          }
        } catch {
          // ignore transient poll errors
        }
      }, 3000)
    } catch (e) {
      setIsSyncing(false)
      toast.error("Failed to connect to update service.")
    }
  }







  const [yearPick, setYear] = useState<string | null>(null)







  const [picked, setPicked] = useState<string | null>(null)















  const years = useMemo(() => [...new Set((raw?.daily ?? []).map((d) => d.date.slice(0, 4)))].sort(), [raw])







  const year = yearPick ?? "all"







  const data = useMemo(() => (raw ? forYear(raw, year) : null), [raw, year])















  const trades = useMemo(() => {







    const t = data?.trades ?? []







    if (filter === "wins") return t.filter((x) => x.pnl_points > 0)







    if (filter === "losses") return t.filter((x) => x.pnl_points < 0)







    return t







  }, [data, filter])















  const strategyTabs = (
    <Tabs value={strategy} onValueChange={(val) => { setPicked(null); handleStrategyChange(val as StrategyKey) }}>
      <TabsList className="bg-muted/60 p-1 rounded-lg">
        <TabsTrigger value="trend_runner" className="font-medium text-xs sm:text-sm">
          NIFTY 50
        </TabsTrigger>
        <TabsTrigger value="sensex_runner" className="font-medium text-xs sm:text-sm">
          SENSEX
        </TabsTrigger>
        <TabsTrigger value="midpoint" className="font-medium text-xs sm:text-sm">
          MIDPOINT (NIFTY)
        </TabsTrigger>
        <TabsTrigger value="vix_divergence" className="font-medium text-xs sm:text-sm">
          VIX TRAP (NIFTY)
        </TabsTrigger>
        <TabsTrigger value="sensex_vix_divergence" className="font-medium text-xs sm:text-sm">
          VIX TRAP (SENSEX)
        </TabsTrigger>
        
        

      </TabsList>
    </Tabs>
  )

  if (error) return <div className="flex flex-col gap-4">{strategyTabs}<p className="text-sm text-red-500">Backtest failed: {error}</p></div>







  if (loading || !data) return <div className="flex flex-col gap-4">{strategyTabs}<Skeleton className="h-[600px] w-full" /></div>















  const s = data.summary







  const curve = [{ label: "start", equity: 0, drawdown: 0 }, ...(data?.trades ?? []).map((t) => ({ label: `${t.date} ${t.entry}`, equity: t.equity, drawdown: t.drawdown }))]















  return (
    <div className="flex flex-col gap-4">
      {/* Top Header & Page Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/40">
        <div>
          <h1 className="text-xl font-bold tracking-tight">
            {strategy === "midpoint"
              ? "Midpoint Rejection Backtest"
              : strategy === "vix_divergence"
              ? "VIX Trap (Nifty · Dynamic 2+1 Lots)"
              : strategy === "sensex_vix_divergence"
              ? "VIX Trap (Sensex · Dynamic 2+1 Lots)"
              : "Trend Runner Backtest"}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {strategy === "sensex_runner"
              ? `Sensex · ${s.days} days (${s.from} → ${s.to}) · Lot size ${s.lot_size}`
              : strategy === "midpoint"
              ? `Nifty 50 Midpoint · ${s.days} days (${s.from} → ${s.to}) · Lot size ${s.lot_size || 50}`
              : strategy === "vix_divergence"
              ? `Nifty 50 VIX Trap · ${s.days} days (${s.from} → ${s.to}) · Dynamic 2+1 Lots · Lot size ${s.lot_size}`
              : strategy === "sensex_vix_divergence"
              ? `Sensex VIX Trap · ${s.days} days (${s.from} → ${s.to}) · Dynamic 2+1 Lots · Lot size ${s.lot_size}`
              : `Nifty 50 · ${s.days} days (${s.from} → ${s.to}) · Lot size ${s.lot_size}`}
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-center shrink-0">
          <button
            onClick={handleSyncBacktest}
            disabled={isSyncing}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all cursor-pointer shadow-xs",
              isSyncing
                ? "bg-muted/60 text-muted-foreground border-border cursor-not-allowed opacity-70"
                : "bg-muted/40 hover:bg-muted text-foreground border-border"
            )}
            title="Pull latest historical data and run sync"
          >
            <RefreshCw className={cn("h-3 w-3", isSyncing && "animate-spin text-primary")} />
            <span>{isSyncing ? "Syncing..." : "Sync Data"}</span>
          </button>
        </div>
      </div>

      {/* Controls Row: Strategy Selector (Left) & Period Tabs (Right) */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {strategyTabs}

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <span className="text-xs text-muted-foreground">Period:</span>
          <Tabs value={year} onValueChange={(v) => { setYear(v as string); setPicked(null) }}>
            <TabsList className="bg-muted/60 p-1 rounded-lg">
              <TabsTrigger value="all" className="text-xs font-medium">All</TabsTrigger>
              {years.map((y) => (
                <TabsTrigger key={y} value={y} className="text-xs font-medium">{y}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard
          label={strategy === "vix_divergence" || strategy === "sensex_vix_divergence" ? "Dynamic Points (2+1 Lots)" : strategy === "trend_runner" && s.dynamic_points ? "Total points (1-Lot)" : "Total points"}







          value={fmtPts(s.total_points)}







          className={pnlClass(s.total_points)}







          hint={







            (strategy === "vix_divergence" || strategy === "sensex_vix_divergence") && s.base_points
              ? `1-Lot: ${fmtPts(s.base_points)} · Option: ${fmtRs(s.total_points * s.lot_size * (s.option_delta || 0.6))}`
              : strategy === "trend_runner" && s.dynamic_points







              ? `Dynamic: ${fmtPts(s.dynamic_points)} (≈ ${fmtRs(s.dynamic_rupees || s.dynamic_points * s.lot_size)})`







              : s.option_delta
              ? `Option (≈${Math.round(s.option_delta * 100)}%Δ): ${fmtRs(s.total_points * s.lot_size * s.option_delta)} · Spot: ${fmtRs(s.total_points * s.lot_size)}`
              : `≈ ${fmtRs(s.total_points * s.lot_size)}`







          }







        />







        <StatCard label="Trades" value={s.trades} hint={`${s.wins} W · ${s.losses} L`} />







        <StatCard label="Win rate" value={`${s.win_rate_pct}%`} />







        <StatCard label="Avg / trade" value={fmtPts(s.avg_points)} className={pnlClass(s.avg_points)} />







        <StatCard
          label="Max drawdown"
          value={fmtNum(s.max_drawdown)}
          className="text-red-500"
          hint={
            s.option_delta
              ? `Option (≈${Math.round(s.option_delta * 100)}%Δ): ${fmtRs(s.max_drawdown * s.lot_size * s.option_delta)} · Spot: ${fmtRs(s.max_drawdown * s.lot_size)}`
              : `≈ ${fmtRs(s.max_drawdown * s.lot_size)}`
          }
        />







        <StatCard label="Best / worst" value={<span className="text-lg">{fmtPts(s.best)} / {fmtPts(s.worst)}</span>} />







      </div>















      <StrategyStreakSummary

        title={
          strategy === "sensex_runner"
            ? "Sensex Trend Runner Strategy Streaks & Recovery"
            : strategy === "midpoint"
            ? "Nifty Midpoint Rejection Strategy Streaks & Recovery"
            : "Nifty Trend Runner Strategy Streaks & Recovery"
        }







        description="Consecutive winning/losing days, drawdown recovery duration in days, and daily expectancy across all backtested trading days."







        daily={(data?.daily ?? []).map((d) => ({ date: d.date, value: d.points, trades: d.trades }))}







        unit="pts"







      />















      <Card>







        <CardHeader>







          <CardTitle>Equity curve</CardTitle>







          <CardDescription>Cumulative points and drawdown, trade by trade</CardDescription>







        </CardHeader>







        <CardContent>







          <div className="h-[320px]">







            <ResponsiveContainer width="100%" height="100%">







              <AreaChart data={curve} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>







                <defs>







                  <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">







                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />







                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />







                  </linearGradient>







                  <linearGradient id="dd" x1="0" y1="0" x2="0" y2="1">







                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />







                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />







                  </linearGradient>







                </defs>







                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />







                <XAxis dataKey="label" hide />







                <YAxis {...axis} tickFormatter={(v) => `${v}`} />







                <Tooltip {...tooltip} formatter={(v: any, name: any) => [`${fmtPts(Number(v))}`, name === "equity" ? "Equity" : "Drawdown"]} />







                <Area type="monotone" dataKey="equity" stroke="#10b981" strokeWidth={2} fill="url(#eq)" />







                <Area type="monotone" dataKey="drawdown" stroke="#ef4444" strokeWidth={1} fill="url(#dd)" />







              </AreaChart>







            </ResponsiveContainer>







          </div>







        </CardContent>







      </Card>















      <Card>







        <CardHeader>







          <CardTitle>Monthly P&L (points)</CardTitle>







          <CardDescription>Performance month by month</CardDescription>







        </CardHeader>







        <CardContent>







          <div className="h-[200px]">







            <ResponsiveContainer width="100%" height="100%">







              <BarChart data={data.monthly} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>







                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />







                <XAxis dataKey="month" {...axis} />







                <YAxis {...axis} tickFormatter={(v) => `${v}`} />







                <Tooltip {...tooltip} formatter={(v: any) => [`${fmtPts(Number(v))}`, "Points"]} />







                <Bar dataKey="points" radius={[4, 4, 0, 0]}>







                  {(data?.monthly ?? []).map((m, i) => (







                    <Cell key={i} fill={m.points >= 0 ? "#10b981" : "#ef4444"} />







                  ))}







                </Bar>







              </BarChart>







            </ResponsiveContainer>







          </div>







        </CardContent>







      </Card>















      <Card>







        <CardHeader>







          <CardTitle>Calendar (daily P&L)</CardTitle>







          <CardDescription>Green = profit day, red = loss day, gray = no trade. Click a day to open it.</CardDescription>







        </CardHeader>







        <CardContent>







          <PnlCalendar daily={(data?.daily ?? []).map((d) => ({ ...d, value: d.points }))} format={fmtPts} onPick={setPicked} />







        </CardContent>







      </Card>















      <DayPanel







        date={picked}







        mode="backtest"







        strategy={strategy}







        days={(data?.daily ?? []).map((d) => d.date)}







        onPick={setPicked}







        onClose={() => setPicked(null)}







        allowTimeframeSwitch={true}







      />















      <Card>







        <CardHeader className="flex flex-row items-center justify-between">







          <div>







            <CardTitle>Trades</CardTitle>







            <CardDescription>Click a row to open that day</CardDescription>







          </div>







          <Tabs value={filter} onValueChange={(v) => setFilter(v as string)}>







            <TabsList>







              <TabsTrigger value="all">All</TabsTrigger>







              <TabsTrigger value="wins">Wins</TabsTrigger>







              <TabsTrigger value="losses">Losses</TabsTrigger>







            </TabsList>







          </Tabs>







        </CardHeader>







        <CardContent>







          <Table>







            <TableHeader>







              <TableRow>







                <TableHead>Date</TableHead>







                <TableHead>Side</TableHead>







                <TableHead>Entry</TableHead>







                <TableHead className="text-right">Price</TableHead>







                <TableHead>Exit</TableHead>







                <TableHead className="text-right">Price</TableHead>







                <TableHead>Setup / Reason</TableHead>







                <TableHead className="text-right">Points</TableHead>







                <TableHead className="text-right">Equity</TableHead>







              </TableRow>







            </TableHeader>







            <TableBody>







              {trades.slice().reverse().map((t, i) => (







                <TableRow key={i} className="cursor-pointer" onClick={() => setPicked(t.date)}>







                  <TableCell className="tabular-nums">{t.date}</TableCell>







                  <TableCell><SideBadge side={t.side} /></TableCell>







                  <TableCell className="tabular-nums">{t.entry}</TableCell>







                  <TableCell className="text-right tabular-nums">{fmtNum(t.entry_price)}</TableCell>







                  <TableCell className="tabular-nums">{t.exit}</TableCell>







                  <TableCell className="text-right tabular-nums">{fmtNum(t.exit_price)}</TableCell>







                  <TableCell className="text-xs text-muted-foreground">{t.lots && t.lots > 1 ? `${t.setup || "VIX TRAP"} (${t.lots}L) · ${prettyReason(t.reason)}` : t.setup ? `${t.setup} · ${prettyReason(t.reason)}` : prettyReason(t.reason)}</TableCell>







                  <TableCell className={cn("text-right font-medium tabular-nums", pnlClass(t.pnl_points))}>{fmtPts(t.pnl_points)}</TableCell>







                  <TableCell className="text-right tabular-nums">{fmtNum(t.equity)}</TableCell>







                </TableRow>







              ))}







            </TableBody>







          </Table>







        </CardContent>







      </Card>







    </div>







  )







}








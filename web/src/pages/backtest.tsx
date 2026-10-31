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















type StrategyKey = "trend_runner" | "sensex_runner" | "sensex_key_levels" | "nifty_key_levels" | "midpoint"















export function BacktestPage() {







  const [strategy, setStrategy] = useState<StrategyKey>(() => {







    const saved = localStorage.getItem("backtest_strategy") as StrategyKey







    return (saved && ["trend_runner", "sensex_runner", "sensex_key_levels", "nifty_key_levels", "midpoint"].includes(saved)) ? saved : "trend_runner"







  })







  const handleStrategyChange = (value: StrategyKey) => {







    localStorage.setItem("backtest_strategy", value)







    setStrategy(value)







  }







  const { data: raw, loading, error, reload } = usePoll<Backtest>(

    strategy === "midpoint"

      ? "/api/backtest?strategy=midpoint"

      : strategy === "sensex_runner"

      ? "/api/backtest?strategy=sensex_runner"

      : strategy === "sensex_key_levels"

      ? "/api/backtest?strategy=sensex_key_levels"

      : strategy === "nifty_key_levels"

      ? "/api/backtest?strategy=nifty_key_levels"

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















  const topStrategy: "trend_runner" | "key_levels" | "midpoint" =
    (strategy === "trend_runner" || strategy === "sensex_runner")
      ? "trend_runner"
      : (strategy === "nifty_key_levels" || strategy === "sensex_key_levels")
      ? "key_levels"
      : "midpoint"

  const symbolChoice: "NIFTY" | "SENSEX" =
    (strategy === "sensex_runner" || strategy === "sensex_key_levels")
      ? "SENSEX"
      : "NIFTY"

  const handleTopStrategyChange = (top: "trend_runner" | "key_levels" | "midpoint") => {
    setPicked(null)
    if (top === "midpoint") {
      handleStrategyChange("midpoint")
    } else if (top === "trend_runner") {
      handleStrategyChange(symbolChoice === "SENSEX" ? "sensex_runner" : "trend_runner")
    } else if (top === "key_levels") {
      handleStrategyChange(symbolChoice === "SENSEX" ? "sensex_key_levels" : "nifty_key_levels")
    }
  }

  const handleSymbolChange = (sym: "NIFTY" | "SENSEX") => {
    setPicked(null)
    if (topStrategy === "trend_runner") {
      handleStrategyChange(sym === "SENSEX" ? "sensex_runner" : "trend_runner")
    } else if (topStrategy === "key_levels") {
      handleStrategyChange(sym === "SENSEX" ? "sensex_key_levels" : "nifty_key_levels")
    }
  }

  const strategyTabs = (
    <div className="flex flex-col gap-2.5">
      {/* Top Level: Strategy Category */}
      <Tabs value={topStrategy} onValueChange={(value) => handleTopStrategyChange(value as any)}>
        <TabsList className="flex flex-wrap gap-1 bg-muted/60 p-1 rounded-lg">
          <TabsTrigger value="trend_runner" className="font-medium text-xs sm:text-sm">
            Trend Runner
          </TabsTrigger>
          <TabsTrigger value="key_levels" className="font-medium text-xs sm:text-sm">
            Key Levels S&R
          </TabsTrigger>
          <TabsTrigger value="midpoint" className="font-medium text-xs sm:text-sm">
            Midpoint Equilibrium
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Sub Level: Symbol Selection (NIFTY vs SENSEX) */}
      {topStrategy !== "midpoint" && (
        <div className="flex items-center gap-2 pl-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mr-1">
            Instrument:
          </span>
          <div className="inline-flex items-center rounded-lg bg-muted/50 p-0.5 border border-border/50">
            <button
              type="button"
              onClick={() => handleSymbolChange("NIFTY")}
              className={cn(
                "px-3 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer",
                symbolChoice === "NIFTY"
                  ? "bg-background text-foreground shadow-xs font-bold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              NIFTY 50
            </button>
            <button
              type="button"
              onClick={() => handleSymbolChange("SENSEX")}
              className={cn(
                "px-3 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer",
                symbolChoice === "SENSEX"
                  ? "bg-background text-foreground shadow-xs font-bold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              SENSEX
            </button>
          </div>
        </div>
      )}
    </div>
  )

  if (error) return <div className="flex flex-col gap-4">{strategyTabs}<p className="text-sm text-red-500">Backtest failed: {error}</p></div>







  if (loading || !data) return <div className="flex flex-col gap-4">{strategyTabs}<Skeleton className="h-[600px] w-full" /></div>















  const s = data.summary







  const curve = [{ label: "start", equity: 0, drawdown: 0 }, ...(data?.trades ?? []).map((t) => ({ label: `${t.date} ${t.entry}`, equity: t.equity, drawdown: t.drawdown }))]















  return (







    <div className="flex flex-col gap-4">







      <div className="flex flex-wrap items-end justify-between gap-2">







        <div>







          <h1 className="text-xl font-semibold">

            {strategy === "trend_runner"

              ? "Nifty Trend Runner · Historical Backtest Performance"

              : strategy === "sensex_runner"

              ? "Sensex Trend Runner · Historical Backtest Performance"

              : strategy === "sensex_key_levels"

              ? "Sensex Key Levels S&R · Historical Backtest Performance"

              : strategy === "nifty_key_levels"

              ? "Nifty Key Levels S&R · Historical Backtest Performance"

              : "Midpoint Strategy · Historical Backtest Performance"}

          </h1>

          <p className="text-sm text-muted-foreground">

            {strategy === "trend_runner"

              ? `Full continuous 1-minute backtest across ${s.days} days (${s.from} → ${s.to}) from technovusin/nifty50-historical-data. 30 pt SL, 6-tier ratchets (+20, +60, +110, +165, +220, +270), symmetric T2 re-entries with 30-min cool-off. ₹ ≈ points × ${s.lot_size} (1 lot, 25 qty).`

              : strategy === "sensex_runner"

              ? `Sensex continuous 1-minute backtest across ${s.days} days (${s.from} → ${s.to}). ₹ ≈ points × ${s.lot_size} (1 lot, 10 qty).`

              : strategy === "sensex_key_levels"

              ? `Sensex Key Levels (Fade + Reverse) 1-minute backtest across ${s.days} days (${s.from} → ${s.to}). Fixed 25 pt SL, Fade TP 120 pts, Reverse Retry TP 180 pts at 500-pt strikes. ₹ ≈ points × ${s.lot_size} (1 lot, 10 qty).`

              : strategy === "nifty_key_levels"

              ? `Nifty Key Levels (Fade + Reverse) 1-minute backtest across ${s.days} days (${s.from} → ${s.to}). Fixed 10 pt SL, Fade TP 50 pts, Reverse Retry TP 80 pts at 500-pt & 1,000-pt strikes with Mother Bar Inside-Day filter (skips chop fakeouts). ₹ ≈ points × ${s.lot_size} (1 lot, 25 qty).`

              : `Full continuous 1-minute backtest across ${s.days} days (${s.from} → ${s.to}) from technovusin/nifty50-historical-data. Midpoint Equilibrium rules, 20 pt SL, 50 pt target, trailing stop at +40 pts. ₹ ≈ points × ${s.lot_size} (1 lot, 25 qty).`}







          </p>







        </div>







        <div className="flex flex-wrap items-center gap-2">







          {strategyTabs}













          <button
            onClick={handleSyncBacktest}
            disabled={isSyncing}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border transition-colors",
              isSyncing ? "opacity-60 cursor-not-allowed bg-muted/40" : "hover:bg-muted/50 cursor-pointer"
            )}
            title="Pull latest historical data and recalculate 10-year master backtests"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isSyncing && "animate-spin text-primary")} />
            <span>{isSyncing ? "Updating Backtest..." : "Sync & Update Data"}</span>
          </button>







          <Tabs value={year} onValueChange={(v) => { setYear(v as string); setPicked(null) }}>







            <TabsList><TabsTrigger value="all">All</TabsTrigger>{years.map((y) => <TabsTrigger key={y} value={y}>{y}</TabsTrigger>)}</TabsList>







          </Tabs>







        </div>







      </div>















      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">







        <StatCard







          label={strategy === "trend_runner" && s.dynamic_points ? "Total points (1-Lot)" : "Total points"}







          value={fmtPts(s.total_points)}







          className={pnlClass(s.total_points)}







          hint={







            strategy === "trend_runner" && s.dynamic_points







              ? `Dynamic: ${fmtPts(s.dynamic_points)} (≈ ${fmtRs(s.dynamic_rupees || s.dynamic_points * s.lot_size)})`







              : `≈ ${fmtRs(s.total_points * s.lot_size)}`







          }







        />







        <StatCard label="Trades" value={s.trades} hint={`${s.wins} W · ${s.losses} L`} />







        <StatCard label="Win rate" value={`${s.win_rate_pct}%`} />







        <StatCard label="Avg / trade" value={fmtPts(s.avg_points)} className={pnlClass(s.avg_points)} />







        <StatCard label="Max drawdown" value={fmtNum(s.max_drawdown)} className="text-red-500" hint={`≈ ${fmtRs(s.max_drawdown * s.lot_size)}`} />







        <StatCard label="Best / worst" value={<span className="text-lg">{fmtPts(s.best)} / {fmtPts(s.worst)}</span>} />







      </div>















      <StrategyStreakSummary

        title={

          strategy === "trend_runner"

            ? "Nifty Trend Runner Strategy Streaks & Recovery"

            : strategy === "sensex_runner"

            ? "Sensex Trend Runner Strategy Streaks & Recovery"

            : strategy === "sensex_key_levels"

            ? "Sensex Key Levels Strategy Streaks & Recovery"

            : strategy === "nifty_key_levels"

            ? "Nifty Key Levels Strategy Streaks & Recovery"

            : "Midpoint Strategy Streaks & Recovery"

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







                  <TableCell className="text-xs text-muted-foreground">{t.setup ? `${t.setup} · ${prettyReason(t.reason)}` : prettyReason(t.reason)}</TableCell>







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








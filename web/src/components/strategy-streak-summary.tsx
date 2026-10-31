import { useMemo } from "react"
import { Award, CalendarDays, Flame, RotateCcw, TrendingDown, TrendingUp, Zap } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { fmtNum, fmtPts, fmtRs, pnlClass } from "@/lib/api"
import { cn } from "@/lib/utils"

export type DayInput = {
  date: string
  value: number // net rupee P&L or net points for this trade/day
  trades?: number
}

export type DayAggregatedStats = {
  totalTradingDays: number
  winningDays: number
  losingDays: number
  breakevenDays: number
  winDayPct: number

  longestWinningDays: number // Max consecutive green days
  longestLosingDays: number // Max consecutive red days
  currentDayStreak: { type: "win" | "loss" | "none"; count: number }

  maxDaysToRecover: number // Max trading days to recover from a daily drawdown
  avgDaysToRecover: number // Avg trading days across all recovered drawdowns
  currentDrawdownDays: number // Current trading days since last all-time high
  isAtAllTimeHigh: boolean
  totalDrawdownCycles: number

  bestDay: { date: string; value: number } | null
  worstDay: { date: string; value: number } | null
  avgDailyPnl: number
  dayProfitFactor: number | null

  aggregatedDays: { date: string; value: number; trades: number; cumEquity: number }[]
}

/**
 * Aggregates any day/trade records strictly by calendar trading day (date),
 * ensuring multiple trades on the same day are summed into a single day-end net P&L.
 */
export function computeDayAggregatedStats(records: DayInput[]): DayAggregatedStats {
  // Step 1: Strict day aggregation
  const dayMap = new Map<string, { date: string; value: number; trades: number }>()

  for (const item of records) {
    if (!item.date) continue
    const val = Number(item.value) || 0
    const tr = item.trades != null ? item.trades : 1
    const existing = dayMap.get(item.date) ?? { date: item.date, value: 0, trades: 0 }
    existing.value = Math.round((existing.value + val) * 100) / 100
    existing.trades += tr
    dayMap.set(item.date, existing)
  }

  const sortedDays = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date))

  // Step 2: Compute streaks & day-level distribution
  let longestWinningDays = 0
  let longestLosingDays = 0
  let curWinDays = 0
  let curLossDays = 0

  let winningDays = 0
  let losingDays = 0
  let breakevenDays = 0

  let grossDayWins = 0
  let grossDayLosses = 0

  let bestDay: { date: string; value: number } | null = null
  let worstDay: { date: string; value: number } | null = null

  for (const day of sortedDays) {
    const val = day.value
    if (val > 0) {
      winningDays++
      grossDayWins += val
      curWinDays++
      curLossDays = 0
      if (curWinDays > longestWinningDays) longestWinningDays = curWinDays
    } else if (val < 0) {
      losingDays++
      grossDayLosses += Math.abs(val)
      curLossDays++
      curWinDays = 0
      if (curLossDays > longestLosingDays) longestLosingDays = curLossDays
    } else {
      breakevenDays++
      curWinDays = 0
      curLossDays = 0
    }

    if (!bestDay || val > bestDay.value) {
      bestDay = { date: day.date, value: val }
    }
    if (!worstDay || val < worstDay.value) {
      worstDay = { date: day.date, value: val }
    }
  }

  const currentDayStreak =
    curWinDays > 0
      ? { type: "win" as const, count: curWinDays }
      : curLossDays > 0
      ? { type: "loss" as const, count: curLossDays }
      : { type: "none" as const, count: 0 }

  // Step 3: Drawdown and Days to Recover (strictly calculated on Day-End Equity)
  let cumEquity = 0
  let peakEquity = 0
  let inDrawdown = false
  let drawdownStartDayIdx = 0
  const recoveryDurations: number[] = []

  const aggregatedWithEquity = sortedDays.map((day, idx) => {
    cumEquity = Math.round((cumEquity + day.value) * 100) / 100

    if (cumEquity >= peakEquity && peakEquity > 0) {
      if (inDrawdown) {
        // Recovered back to or above previous peak
        const recoveryDays = idx - drawdownStartDayIdx
        recoveryDurations.push(recoveryDays)
        inDrawdown = false
      }
      peakEquity = cumEquity
      drawdownStartDayIdx = idx
    } else if (cumEquity > peakEquity) {
      peakEquity = cumEquity
      drawdownStartDayIdx = idx
    } else if (cumEquity < peakEquity) {
      if (!inDrawdown) {
        inDrawdown = true
        drawdownStartDayIdx = idx - 1 // Peak occurred on the previous day
      }
    }

    return { ...day, cumEquity }
  })

  const maxDaysToRecover = recoveryDurations.length > 0 ? Math.max(...recoveryDurations) : 0
  const avgDaysToRecover =
    recoveryDurations.length > 0
      ? Math.round((recoveryDurations.reduce((a, b) => a + b, 0) / recoveryDurations.length) * 10) / 10
      : 0

  const currentDrawdownDays = inDrawdown ? sortedDays.length - 1 - drawdownStartDayIdx : 0
  const isAtAllTimeHigh = !inDrawdown
  const totalDays = sortedDays.length
  const totalNet = sortedDays.reduce((sum, d) => sum + d.value, 0)

  return {
    totalTradingDays: totalDays,
    winningDays,
    losingDays,
    breakevenDays,
    winDayPct: totalDays > 0 ? Math.round((winningDays / totalDays) * 1000) / 10 : 0,
    longestWinningDays,
    longestLosingDays,
    currentDayStreak,
    maxDaysToRecover,
    avgDaysToRecover,
    currentDrawdownDays,
    isAtAllTimeHigh,
    totalDrawdownCycles: recoveryDurations.length + (inDrawdown ? 1 : 0),
    bestDay,
    worstDay,
    avgDailyPnl: totalDays > 0 ? Math.round((totalNet / totalDays) * 100) / 100 : 0,
    dayProfitFactor:
      grossDayLosses > 0 ? Math.round((grossDayWins / grossDayLosses) * 100) / 100 : grossDayWins > 0 ? 99.9 : null,
    aggregatedDays: aggregatedWithEquity,
  }
}

type Props = {
  title?: string
  description?: string
  daily: DayInput[]
  unit?: "rs" | "pts"
  className?: string
}

export function StrategyStreakSummary({
  title = "Day-Aggregated Strategy Summary",
  description = "Aggregated purely by trading day: consecutive winning/losing day streaks, days to recover from drawdown, and daily edge.",
  daily,
  unit = "rs",
  className,
}: Props) {
  const stats = useMemo(() => computeDayAggregatedStats(daily), [daily])
  const formatVal = unit === "rs" ? fmtRs : fmtPts

  if (!stats.totalTradingDays) {
    return null
  }

  // Show recent days strip (up to last 10 trading days)
  const recentDays = stats.aggregatedDays.slice(-8)

  return (
    <Card className={cn("overflow-hidden border shadow-sm", className)}>
      <CardHeader className="border-b bg-card/60 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-sm font-semibold tracking-tight">{title}</CardTitle>
              <Badge variant="outline" className="text-[10px] font-sans font-medium px-1.5 py-0">
                Day Aggregated
              </Badge>
            </div>
            <CardDescription className="text-xs mt-0.5">{description}</CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            {stats.isAtAllTimeHigh ? (
              <Badge
                variant="outline"
                className="text-[11px] font-medium border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              >
                ● At All-Time High
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="text-[11px] font-medium border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              >
                In Drawdown: {stats.currentDrawdownDays} day{stats.currentDrawdownDays === 1 ? "" : "s"}
              </Badge>
            )}
            <Badge variant="secondary" className="text-[11px] font-mono">
              {stats.winningDays}W · {stats.losingDays}L ({stats.winDayPct}% Green Days)
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-3 sm:p-4">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          {/* 1. Longest Winning Days */}
          <div className="flex flex-col rounded-lg border bg-card p-3 shadow-2xs">
            <div className="flex items-center justify-between text-muted-foreground mb-1">
              <span className="text-[11px] font-medium">Longest Win Streak</span>
              <Flame className="h-3.5 w-3.5 text-emerald-500" />
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
                {stats.longestWinningDays}
              </span>
              <span className="text-xs text-muted-foreground font-sans">
                day{stats.longestWinningDays === 1 ? "" : "s"}
              </span>
            </div>
            <span className="mt-1 text-[10px] text-muted-foreground">
              {stats.currentDayStreak.type === "win" ? (
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  Active: {stats.currentDayStreak.count} green day{stats.currentDayStreak.count === 1 ? "" : "s"}
                </span>
              ) : (
                `${stats.winningDays} green day${stats.winningDays === 1 ? "" : "s"} total`
              )}
            </span>
          </div>

          {/* 2. Longest Losing Days */}
          <div className="flex flex-col rounded-lg border bg-card p-3 shadow-2xs">
            <div className="flex items-center justify-between text-muted-foreground mb-1">
              <span className="text-[11px] font-medium">Longest Loss Streak</span>
              <TrendingDown className="h-3.5 w-3.5 text-red-500" />
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-bold font-mono text-red-600 dark:text-red-400">
                {stats.longestLosingDays}
              </span>
              <span className="text-xs text-muted-foreground font-sans">
                day{stats.longestLosingDays === 1 ? "" : "s"}
              </span>
            </div>
            <span className="mt-1 text-[10px] text-muted-foreground">
              {stats.currentDayStreak.type === "loss" ? (
                <span className="font-semibold text-red-600 dark:text-red-400">
                  Active: {stats.currentDayStreak.count} red day{stats.currentDayStreak.count === 1 ? "" : "s"}
                </span>
              ) : (
                `${stats.losingDays} red day${stats.losingDays === 1 ? "" : "s"} total`
              )}
            </span>
          </div>

          {/* 3. Days to Recover (Drawdown Duration in Days) */}
          <div className="flex flex-col rounded-lg border bg-card p-3 shadow-2xs">
            <div className="flex items-center justify-between text-muted-foreground mb-1">
              <span className="text-[11px] font-medium">Days to Recover</span>
              <RotateCcw className="h-3.5 w-3.5 text-sky-500" />
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-bold font-mono text-foreground">{stats.maxDaysToRecover}</span>
              <span className="text-xs text-muted-foreground font-sans">
                {stats.maxDaysToRecover === 0 ? "days (No DD)" : `day${stats.maxDaysToRecover === 1 ? "" : "s"} max`}
              </span>
            </div>
            <span
              className="mt-1 text-[10px] text-muted-foreground truncate"
              title={`Avg recovery: ${stats.avgDaysToRecover} days across ${stats.totalDrawdownCycles} cycle(s)`}
            >
              {stats.avgDaysToRecover > 0 ? `Avg recovery: ${stats.avgDaysToRecover} days` : "Always at all-time high"}
            </span>
          </div>

          {/* 4. Best Day */}
          <div className="flex flex-col rounded-lg border bg-card p-3 shadow-2xs">
            <div className="flex items-center justify-between text-muted-foreground mb-1">
              <span className="text-[11px] font-medium">Best Day</span>
              <Award className="h-3.5 w-3.5 text-amber-500" />
            </div>
            <div className="text-base font-bold font-mono truncate text-emerald-600 dark:text-emerald-400">
              {stats.bestDay ? formatVal(stats.bestDay.value) : "—"}
            </div>
            <span className="mt-1 text-[10px] text-muted-foreground flex items-center gap-1">
              <CalendarDays className="h-3 w-3" />
              {stats.bestDay ? stats.bestDay.date : "—"}
            </span>
          </div>

          {/* 5. Worst Day */}
          <div className="flex flex-col rounded-lg border bg-card p-3 shadow-2xs">
            <div className="flex items-center justify-between text-muted-foreground mb-1">
              <span className="text-[11px] font-medium">Worst Day</span>
              <TrendingDown className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div
              className={cn(
                "text-base font-bold font-mono truncate",
                stats.worstDay ? pnlClass(stats.worstDay.value) : ""
              )}
            >
              {stats.worstDay ? formatVal(stats.worstDay.value) : "—"}
            </div>
            <span className="mt-1 text-[10px] text-muted-foreground flex items-center gap-1">
              <CalendarDays className="h-3 w-3" />
              {stats.worstDay ? stats.worstDay.date : "—"}
            </span>
          </div>

          {/* 6. Day Profit Factor & Daily Avg */}
          <div className="flex flex-col rounded-lg border bg-card p-3 shadow-2xs">
            <div className="flex items-center justify-between text-muted-foreground mb-1">
              <span className="text-[11px] font-medium">Day Profit Factor</span>
              <TrendingUp className="h-3.5 w-3.5 text-primary" />
            </div>
            <div className="text-base font-bold font-mono text-foreground">
              {stats.dayProfitFactor != null ? fmtNum(stats.dayProfitFactor) : "∞"}
            </div>
            <span
              className="mt-1 text-[10px] text-muted-foreground truncate"
              title={`Daily average net: ${formatVal(stats.avgDailyPnl)}`}
            >
              Avg:{" "}
              <span className={cn("font-medium", pnlClass(stats.avgDailyPnl))}>{formatVal(stats.avgDailyPnl)}/day</span>
            </span>
          </div>
        </div>

        {/* Day-by-Day Timeline Strip */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground text-[11px]">Recent Daily P&amp;L:</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {recentDays.map((d) => (
                <span
                  key={d.date}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono font-medium",
                    d.value > 0
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                      : d.value < 0
                      ? "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20"
                      : "bg-muted text-muted-foreground"
                  )}
                  title={`${d.date}: ${formatVal(d.value)} (${d.trades} trade${d.trades === 1 ? "" : "s"})`}
                >
                  <span>{d.date.slice(5)}</span>
                  <span>{formatVal(d.value)}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="text-[11px]">
            <span>{stats.totalTradingDays} total session{stats.totalTradingDays === 1 ? "" : "s"} evaluated</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

import { useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { pnlClass } from "@/lib/api"

export type GitCalendarDay = {
  date: string
  value?: number
  pnl?: number
  net_rs?: number
  points?: number
  trades: number
  has_a_plus?: boolean
  a_plus_count?: number
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function toIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function defaultFormat(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "-" : ""
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`
}

export function GitPnlCalendar({
  daily,
  onPick,
  selectedDate,
  format = defaultFormat,
  title = "P&L Activity Heatmap",
  onlyActiveRange = false,
}: {
  daily: GitCalendarDay[]
  onPick: (date: string) => void
  selectedDate?: string | null
  format?: (v: number) => string
  title?: string
  onlyActiveRange?: boolean
}) {
  const years = useMemo(() => {
    const ys = [...new Set(daily.map((d) => d.date.slice(0, 4)).filter(Boolean))].sort().reverse()
    return ys.length > 0 ? ys : [String(new Date().getFullYear())]
  }, [daily])

  const [selectedYear, setSelectedYear] = useState<string>(() => years[0])
  const activeYear = years.includes(selectedYear) ? selectedYear : years[0]
  const [hovered, setHovered] = useState<{ date: string; val: number; trades: number } | null>(null)

  const byDate = useMemo(() => {
    const m = new Map<string, { val: number; trades: number; hasAPlus: boolean }>()
    for (const d of daily) {
      const val = Number(d.value ?? d.net_rs ?? d.pnl ?? 0)
      m.set(d.date, { val: Number.isFinite(val) ? val : 0, trades: Number(d.trades || 0), hasAPlus: Boolean(d.has_a_plus) })
    }
    return m
  }, [daily])

  const { weeks, monthByCol, stats, maxPos, maxNeg } = useMemo(() => {
    const yr = Number(activeYear)
    let rangeStart = new Date(yr, 0, 1)
    let rangeEnd = new Date(yr, 11, 31)

    if (onlyActiveRange) {
      const yearDates = [...byDate.entries()]
        .filter(([dt, info]) => dt.startsWith(`${activeYear}-`) && info.trades > 0)
        .map(([dt]) => dt)
        .sort()
      if (yearDates.length > 0) {
        const firstParts = yearDates[0].split("-").map(Number)
        const lastParts = yearDates[yearDates.length - 1].split("-").map(Number)
        rangeStart = new Date(firstParts[0], firstParts[1] - 1, 1)
        rangeEnd = new Date(lastParts[0], lastParts[1], 0)
      }
    }

    const startOffset = (rangeStart.getDay() + 6) % 7
    const start = new Date(rangeStart)
    start.setDate(rangeStart.getDate() - startOffset)

    const cols: Array<Array<{ date: string; inRange: boolean; val: number; trades: number; hasAPlus: boolean }>> = []
    const mMap = new Map<number, string>()
    let lastMonth = -1

    const cur = new Date(start)
    let colIdx = 0
    while (cur <= rangeEnd || cur.getDay() !== 1) {
      const week: Array<{ date: string; inRange: boolean; val: number; trades: number; hasAPlus: boolean }> = []
      for (let r = 0; r < 7; r++) {
        const iso = toIsoDate(cur)
        const inRange = cur >= rangeStart && cur <= rangeEnd
        const entry = inRange ? byDate.get(iso) : undefined
        if (inRange && cur.getMonth() !== lastMonth && (cur.getDate() <= 7 || colIdx === 0)) {
          mMap.set(colIdx, MONTH_NAMES[cur.getMonth()])
          lastMonth = cur.getMonth()
        }
        week.push({
          date: iso,
          inRange,
          val: entry?.val ?? 0,
          trades: entry?.trades ?? 0,
          hasAPlus: entry?.hasAPlus ?? false,
        })
        cur.setDate(cur.getDate() + 1)
      }
      cols.push(week)
      colIdx++
      if (colIdx > 55) break
    }

    let totalPnl = 0
    let wins = 0
    let losses = 0
    let bestDay = { date: "", val: -Infinity }
    let worstDay = { date: "", val: Infinity }
    let maxP = 0
    let maxN = 0
    for (const [dt, info] of byDate.entries()) {
      if (!dt.startsWith(`${activeYear}-`) || info.trades <= 0) continue
      totalPnl += info.val
      if (info.val > bestDay.val) bestDay = { date: dt, val: info.val }
      if (info.val < worstDay.val) worstDay = { date: dt, val: info.val }
      if (info.val > 0) {
        wins++
        if (info.val > maxP) maxP = info.val
      } else if (info.val < 0) {
        losses++
        if (Math.abs(info.val) > maxN) maxN = Math.abs(info.val)
      }
    }

    return {
      weeks: cols,
      monthByCol: mMap,
      stats: {
        totalPnl,
        wins,
        losses,
        totalDays: wins + losses,
        bestDay: bestDay.val > -Infinity ? bestDay : null,
        worstDay: worstDay.val < Infinity ? worstDay : null,
      },
      maxPos: maxP || 1,
      maxNeg: maxN || 1,
    }
  }, [activeYear, byDate, onlyActiveRange])

  // Compact square size for 53-week view, slightly larger crisp squares when fewer weeks
  const compactSquares = weeks.length > 26
  const cellSizeClass = compactSquares ? "w-[14px] h-[14px]" : "w-[20px] h-[20px]"
  const rowHeightClass = compactSquares ? "h-[14px] leading-[14px]" : "h-[20px] leading-[20px]"

  const getCellClass = (inRange: boolean, trades: number, val: number) => {
    if (!inRange) return "bg-transparent border-transparent pointer-events-none"
    if (trades <= 0) return "bg-muted/45 border-border/35 hover:border-border/70 cursor-default"
    if (val === 0) return "bg-slate-400/40 border-slate-400/50 cursor-pointer"
    if (val > 0) {
      const ratio = val / maxPos
      if (ratio >= 0.7) return "bg-emerald-500 border-emerald-400/80 cursor-pointer"
      if (ratio >= 0.4) return "bg-emerald-500/70 border-emerald-500/60 cursor-pointer"
      if (ratio >= 0.18) return "bg-emerald-500/45 border-emerald-500/40 cursor-pointer"
      return "bg-emerald-500/25 border-emerald-500/30 cursor-pointer"
    }
    const ratio = Math.abs(val) / maxNeg
    if (ratio >= 0.7) return "bg-rose-500 border-rose-400/80 cursor-pointer"
    if (ratio >= 0.4) return "bg-rose-500/70 border-rose-500/60 cursor-pointer"
    if (ratio >= 0.18) return "bg-rose-500/45 border-rose-500/40 cursor-pointer"
    return "bg-rose-500/25 border-rose-500/30 cursor-pointer"
  }

  return (
    <div className="rounded-xl border border-border/70 bg-card/90 p-4 shadow-xs shrink-0 w-full">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-bold uppercase tracking-wider text-foreground">{title}</span>
          <span className={cn("text-sm font-mono font-bold", pnlClass(stats.totalPnl))}>
            {format(stats.totalPnl)}
          </span>
          <span className="text-xs text-muted-foreground font-mono">
            {stats.totalDays}d ({stats.wins}W / {stats.losses}L)
          </span>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          {hovered && hovered.trades > 0 ? (
            <span className="text-xs font-mono px-2.5 py-0.5 rounded-md bg-muted/70 border border-border/60">
              {hovered.date} · {hovered.trades} trade{hovered.trades === 1 ? "" : "s"} ·{" "}
              <span className={cn("font-bold", pnlClass(hovered.val))}>{format(hovered.val)}</span>
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground hidden sm:inline">
              Click any colored day to open that session
            </span>
          )}
          {years.length > 1 && (
            <div className="flex items-center gap-1 bg-muted/50 p-0.5 rounded-md border border-border/50">
              {years.slice(0, 6).map((y) => (
                <button
                  key={y}
                  type="button"
                  onClick={() => setSelectedYear(y)}
                  className={cn(
                    "px-2 py-0.5 text-[11px] font-mono rounded transition-colors cursor-pointer",
                    activeYear === y
                      ? "bg-background text-foreground font-semibold shadow-2xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {y}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="overflow-x-auto pb-1">
          <div className="inline-flex flex-col">
            {/* Month labels */}
            <div className="flex items-end gap-[3px] mb-1 pl-8">
              {weeks.map((_, wIdx) => (
                <div
                  key={wIdx}
                  className={cn(
                    "relative shrink-0 text-[10px] text-muted-foreground font-medium",
                    compactSquares ? "w-[14px]" : "w-[20px]",
                  )}
                >
                  {monthByCol.has(wIdx) && (
                    <span className="whitespace-nowrap">{monthByCol.get(wIdx)}</span>
                  )}
                </div>
              ))}
            </div>

            <div className="flex gap-1.5">
              {/* Weekday axis */}
              <div className="flex flex-col gap-[3px] pr-1 text-[10px] text-muted-foreground select-none w-7 shrink-0">
                <span className={rowHeightClass}>Mon</span>
                <span className={rowHeightClass} />
                <span className={rowHeightClass}>Wed</span>
                <span className={rowHeightClass} />
                <span className={rowHeightClass}>Fri</span>
                <span className={rowHeightClass} />
                <span className={rowHeightClass} />
              </div>

              {/* Crisp square grid */}
              <div className="flex gap-[3px]">
                {weeks.map((week, wIdx) => (
                  <div key={wIdx} className="flex flex-col gap-[3px]">
                    {week.map((cell) => {
                      const isSelected = Boolean(selectedDate && selectedDate === cell.date)
                      const clickable = cell.inRange && cell.trades > 0
                      return (
                        <button
                          key={cell.date}
                          type="button"
                          disabled={!clickable}
                          onClick={() => clickable && onPick(cell.date)}
                          onMouseEnter={() =>
                            cell.inRange && setHovered({ date: cell.date, val: cell.val, trades: cell.trades })
                          }
                          onMouseLeave={() => setHovered(null)}
                          title={
                            cell.inRange
                              ? cell.trades > 0
                                ? `${cell.date}: ${cell.trades} trade(s), ${format(cell.val)}${cell.hasAPlus ? " ⚡ A+ Setup" : ""}`
                                : `${cell.date}: No trades`
                              : undefined
                          }
                          className={cn(
                            cellSizeClass,
                            "shrink-0 rounded-[3px] border transition-transform flex items-center justify-center leading-none",
                            compactSquares ? "text-[8px]" : "text-[10px]",
                            getCellClass(cell.inRange, cell.trades, cell.val),
                            cell.hasAPlus && "ring-1 ring-amber-400/95",
                            clickable && "hover:scale-115 hover:z-10",
                            isSelected && "ring-2 ring-primary ring-offset-1 ring-offset-background z-10",
                          )}
                        >
                          {cell.hasAPlus ? "🔥" : null}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Best/Worst quick summary when compact/trimmed */}
        {!compactSquares && (stats.bestDay || stats.worstDay) && (
          <div className="flex flex-row lg:flex-col gap-2.5 shrink-0 text-xs font-mono border-t lg:border-t-0 lg:border-l border-border/50 pt-3 lg:pt-0 lg:pl-4">
            {stats.bestDay && (
              <button
                type="button"
                onClick={() => onPick(stats.bestDay!.date)}
                className="text-left px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 hover:bg-emerald-500/15 transition-colors cursor-pointer"
              >
                <div className="text-[10px] text-muted-foreground uppercase">Best Day · {stats.bestDay.date}</div>
                <div className="font-bold text-emerald-500">{format(stats.bestDay.val)}</div>
              </button>
            )}
            {stats.worstDay && (
              <button
                type="button"
                onClick={() => onPick(stats.worstDay!.date)}
                className="text-left px-2.5 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/25 hover:bg-rose-500/15 transition-colors cursor-pointer"
              >
                <div className="text-[10px] text-muted-foreground uppercase">Worst Day · {stats.worstDay.date}</div>
                <div className="font-bold text-rose-500">{format(stats.worstDay.val)}</div>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center justify-end gap-1.5 mt-2.5 text-[10px] text-muted-foreground">
        <span>Loss</span>
        <span className="w-3 h-3 rounded-[2px] bg-rose-500 border border-rose-400/70" />
        <span className="w-3 h-3 rounded-[2px] bg-rose-500/45 border border-rose-500/40" />
        <span className="w-3 h-3 rounded-[2px] bg-muted/45 border border-border/40" />
        <span className="w-3 h-3 rounded-[2px] bg-emerald-500/45 border border-emerald-500/40" />
        <span className="w-3 h-3 rounded-[2px] bg-emerald-500 border border-emerald-400/70" />
        <span>Profit</span>
        <span className="ml-2 inline-flex items-center gap-1"><span className="w-3 h-3 rounded-[2px] bg-emerald-500/45 border border-emerald-500/40 ring-1 ring-amber-400/95" />🔥 A+ Setup</span>
      </div>
    </div>
  )
}

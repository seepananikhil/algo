import { cn } from "@/lib/utils"
import { pnlClass } from "@/lib/api"

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

export type CalendarDay = { date: string; value: number; trades: number }

export function PnlCalendar({ daily, format, onPick }: { daily: CalendarDay[]; format: (v: number) => string; onPick: (date: string) => void }) {
  const byDate = new Map(daily.map((d) => [d.date, d]))
  const months = [...new Set(daily.map((d) => d.date.slice(0, 7)))].sort().reverse()
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {months.map((mk) => {
        const [y, m] = mk.split("-").map(Number)
        const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7
        const count = new Date(y, m, 0).getDate()
        const total = daily.filter((d) => d.date.startsWith(mk)).reduce((a, d) => a + d.value, 0)
        return (
          <div key={mk} className="rounded-lg border p-3">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-sm font-medium">{new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" })}</span>
              <span className={cn("text-sm font-semibold tabular-nums", pnlClass(total))}>{format(total)}</span>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground">
              {WEEKDAYS.map((w) => <div key={w}>{w}</div>)}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-1">
              {Array.from({ length: offset }, (_, i) => <div key={`e${i}`} />)}
              {Array.from({ length: count }, (_, i) => {
                const date = `${mk}-${String(i + 1).padStart(2, "0")}`
                const d = byDate.get(date)
                return (
                  <button
                    key={date}
                    type="button"
                    disabled={!d}
                    onClick={() => onPick(date)}
                    title={d ? `${date}: ${d.trades} trade(s), ${format(d.value)}` : undefined}
                    className={cn(
                      "flex h-11 flex-col items-start rounded-md border p-1 text-left text-[11px] transition-colors",
                      !d && "border-transparent text-muted-foreground/40",
                      d && d.trades === 0 && "bg-muted/50 hover:bg-muted",
                      d && d.value > 0 && "border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25",
                      d && d.value < 0 && "border-red-500/40 bg-red-500/15 hover:bg-red-500/25",
                    )}
                  >
                    <span className="font-medium">{i + 1}</span>
                    {d && d.trades > 0 && <span className={cn("truncate text-[10px] tabular-nums", pnlClass(d.value))}>{format(d.value)}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

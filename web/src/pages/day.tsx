import { cn } from "@/lib/utils"
import { useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DayDetail } from "@/components/day-detail"
import { usePoll } from "@/lib/api"

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

export function DayPage() {
  const [params, setParams] = useSearchParams()
  const days = usePoll<string[]>("/api/days")
  const date = params.get("date") ?? days.data?.[0] ?? null
  const strategy = params.get("strategy") ?? "all"
  const list = days.data ?? []
  const idx = date ? list.indexOf(date) : -1
  const go = (d: string | undefined) => d && setParams({ date: d, strategy })
  const setStrategy = (s: string) => date && setParams({ date, strategy: s })
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [calendarMonth, setCalendarMonth] = useState(date?.slice(0, 7) ?? new Date().toISOString().slice(0, 7))
  const calendarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (date) setCalendarMonth(date.slice(0, 7))
  }, [date])

  useEffect(() => {
    if (!calendarOpen) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!calendarRef.current?.contains(event.target as Node)) setCalendarOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCalendarOpen(false)
    }
    document.addEventListener("pointerdown", closeOnOutsideClick)
    document.addEventListener("keydown", closeOnEscape)
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick)
      document.removeEventListener("keydown", closeOnEscape)
    }
  }, [calendarOpen])

  const [year, month] = calendarMonth.split("-").map(Number)
  const monthOffset = (new Date(year, month - 1, 1).getDay() + 6) % 7
  const daysInMonth = new Date(year, month, 0).getDate()
  const availableDates = new Set(list)
  const monthLabel = new Date(year, month - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" })
  const shiftMonth = (delta: number) => {
    const shifted = new Date(year, month - 1 + delta, 1)
    setCalendarMonth(`${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`)
  }

  const dateControls = (
    <div className="flex items-center gap-1.5">
      <span className="font-bold text-sm tracking-tight text-foreground pr-1 whitespace-nowrap">Day viewer</span>
      <Button variant="outline" size="icon-xs" aria-label="Older day" disabled={idx < 0 || idx >= list.length - 1} onClick={() => go(list[idx + 1])} className="h-6.5 w-6.5">
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>
      <div ref={calendarRef} className="relative">
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-haspopup="dialog"
          aria-expanded={calendarOpen}
          onClick={() => setCalendarOpen((open) => !open)}
          className="h-6.5 gap-1.5 px-2 text-xs font-semibold"
        >
          <CalendarDays className="h-3.5 w-3.5 text-primary" />
          {date ?? "Choose date"}
        </Button>
        {calendarOpen && (
          <div role="dialog" aria-label="Choose trading date" className="absolute left-0 top-full z-50 mt-2 w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-xl">
            <div className="mb-2 flex items-center justify-between">
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => shiftMonth(-1)}><ChevronLeft /></Button>
              <span className="text-sm font-medium">{monthLabel}</span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => shiftMonth(1)}><ChevronRight /></Button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
              {WEEKDAYS.map((weekday) => <span key={weekday} className="py-1">{weekday}</span>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: monthOffset }, (_, index) => <span key={`blank-${index}`} />)}
              {Array.from({ length: daysInMonth }, (_, index) => {
                const day = `${calendarMonth}-${String(index + 1).padStart(2, "0")}`
                const hasData = availableDates.has(day)
                const selected = day === date
                return (
                  <button
                    key={day}
                    type="button"
                    disabled={!hasData}
                    aria-pressed={selected}
                    aria-label={`${day}${hasData ? ", captured" : ", no captured data"}`}
                    onClick={() => { go(day); setCalendarOpen(false) }}
                    className={`aspect-square rounded-md text-sm tabular-nums transition-colors disabled:cursor-not-allowed disabled:text-muted-foreground/30 ${selected ? "bg-primary text-primary-foreground" : hasData ? "bg-muted hover:bg-accent hover:text-accent-foreground" : ""}`}
                  >
                    {index + 1}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
      <Button variant="outline" size="icon-xs" aria-label="Newer day" disabled={idx <= 0} onClick={() => go(list[idx - 1])} className="h-6.5 w-6.5">
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
      <div className="flex items-center gap-1 ml-2 border-l border-border/40 pl-2">
        <span className="text-[11px] text-muted-foreground mr-1 hidden md:inline">Strategy:</span>
        {([
          { id: "all", label: "All" },
          { id: "trend_runner", label: "Nifty Trend Runner" },
          { id: "sensex_runner", label: "Sensex Trend Runner" },
        ] as const).map((s) => {
          const active = strategy === s.id
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setStrategy(s.id)}
              className={cn(
                "h-6 px-2 text-[11px] font-semibold rounded-md transition-colors whitespace-nowrap",
                active
                  ? "bg-primary text-primary-foreground shadow-2xs"
                  : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {s.label}
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <DayDetail
      key={`${date ?? "no-date"}-${strategy}`}
      date={date}
      strategy={strategy}
      mode="auto"
      allowTimeframeSwitch
      headerLeading={dateControls}
    />
  )
}

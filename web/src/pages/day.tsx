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
  const list = days.data ?? []
  const idx = date ? list.indexOf(date) : -1
  const go = (d: string | undefined) => d && setParams({ date: d })
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Day viewer</h1>
          <p className="text-sm text-muted-foreground">Paper/live trades for any captured day</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Older day" disabled={idx < 0 || idx >= list.length - 1} onClick={() => go(list[idx + 1])}>
            <ChevronLeft />
          </Button>
          <div ref={calendarRef} className="relative">
            <Button
              type="button"
              variant="outline"
              aria-haspopup="dialog"
              aria-expanded={calendarOpen}
              onClick={() => setCalendarOpen((open) => !open)}
            >
              <CalendarDays />
              {date ?? "Choose date"}
            </Button>
            {calendarOpen && (
              <div role="dialog" aria-label="Choose trading date" className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-xl">
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
          <Button variant="outline" size="icon" aria-label="Newer day" disabled={idx <= 0} onClick={() => go(list[idx - 1])}>
            <ChevronRight />
          </Button>
        </div>
      </div>

      <DayDetail key={date ?? "no-date"} date={date} mode="auto" />
    </div>
  )
}

import React, { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { cn } from "@/lib/utils"

export interface TravelCalendarPopupProps {
  open: boolean
  onClose: () => void
  daily: { date: string; value?: number; points?: number; pnl?: number; trades?: number }[]
  selectedDate?: string | null
  onSelectDate: (date: string) => void
  format?: (v: number) => string
  triggerRef?: React.RefObject<HTMLElement | null>
}

export function TravelCalendarPopup({
  open,
  onClose,
  daily,
  selectedDate,
  onSelectDate,
  format = (v) => `${v}`,
  triggerRef,
}: TravelCalendarPopupProps) {
  const byDate = useMemo(() => {
    const map = new Map<string, any>()
    daily.forEach((d) => map.set(d.date, d))
    return map
  }, [daily])

  const availableYears = useMemo(() => {
    const rawYears = daily.map((d) => d.date.slice(0, 4)).filter(Boolean)
    const yrs = [...new Set(rawYears)].sort()
    const min = yrs.length > 0 ? Math.min(2017, Number(yrs[0])) : 2017
    const max = yrs.length > 0 ? Math.max(new Date().getFullYear(), Number(yrs[yrs.length - 1])) : 2026
    const res: string[] = []
    for (let yr = max; yr >= min; yr--) {
      res.push(String(yr))
    }
    return res
  }, [daily])

  const [activeMonth, setActiveMonth] = useState<string>(() => {
    if (selectedDate) return selectedDate.slice(0, 7)
    if (daily.length > 0) return daily[daily.length - 1].date.slice(0, 7)
    return "2026-11"
  })

  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const updatePos = () => {
      if (triggerRef?.current) {
        const rect = triggerRef.current.getBoundingClientRect()
        setPos({
          top: Math.round(rect.bottom + 6),
          right: Math.max(12, Math.round(window.innerWidth - rect.right)),
        })
      }
    }
    updatePos()
    window.addEventListener("resize", updatePos)
    window.addEventListener("scroll", updatePos, true)
    return () => {
      window.removeEventListener("resize", updatePos)
      window.removeEventListener("scroll", updatePos, true)
    }
  }, [open, triggerRef])

  useEffect(() => {
    if (open && selectedDate) {
      setActiveMonth(selectedDate.slice(0, 7))
    }
  }, [open, selectedDate])

  if (!open) return null

  const [y, m] = (activeMonth || "2026-11").split("-").map(Number)

  // Pure calendar date math for prev/next month
  const prevM = m === 1 ? 12 : m - 1
  const prevY = m === 1 ? y - 1 : y
  const prevMonthStr = `${prevY}-${String(prevM).padStart(2, "0")}`

  const nextM = m === 12 ? 1 : m + 1
  const nextY = m === 12 ? y + 1 : y
  const nextMonthStr = `${nextY}-${String(nextM).padStart(2, "0")}`

  const minYear = Number(availableYears[availableYears.length - 1]) || 2017
  const maxYear = Number(availableYears[0]) || 2026

  const canGoPrev = prevY >= minYear
  const canGoNext = nextY <= maxYear

  const monthDate = new Date(y, m - 1, 1)
  const offset = (monthDate.getDay() + 6) % 7
  const dayCount = new Date(y, m, 0).getDate()

  const monthTrades = daily.filter((d) => d.date.startsWith(activeMonth))
  const monthTotal = monthTrades.reduce((a, d) => a + (d.value ?? d.points ?? d.pnl ?? 0), 0)
  const monthWins = monthTrades.filter((d) => (d.value ?? d.points ?? d.pnl ?? 0) > 0).length
  const monthLosses = monthTrades.filter((d) => (d.value ?? d.points ?? d.pnl ?? 0) < 0).length

  return createPortal(
    <>
      {/* Invisible backdrop captures click-away to close without dimming */}
      <div className="fixed inset-0 z-50 bg-black/15 backdrop-blur-2xs" onClick={onClose} />

      <div
        style={{
          position: "fixed",
          top: pos ? `${pos.top}px` : "54px",
          right: pos ? `${pos.right}px` : "16px",
        }}
        className="z-50 w-[350px] sm:w-[390px] rounded-2xl border border-border/80 bg-popover/95 backdrop-blur-md p-3.5 shadow-2xl animate-in zoom-in-95 duration-150 flex flex-col gap-2.5 max-h-[85vh] overflow-hidden ring-1 ring-border/40"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Pure Calendar Header: Prev | Month Dropdown | Year Dropdown | Next | Close */}
        <div className="flex items-center justify-between pb-2 border-b border-border/50 shrink-0">
          <button
            type="button"
            disabled={!canGoPrev}
            onClick={() => setActiveMonth(prevMonthStr)}
            className="h-7 w-7 rounded-lg border border-border/60 hover:bg-muted/80 flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title={canGoPrev ? `Go to ${prevMonthStr}` : "Earliest month reached"}
          >
            <ChevronLeft className="size-4" />
          </button>

          {/* Month & Year Dropdowns */}
          <div className="flex items-center gap-1.5">
            <select
              value={String(m).padStart(2, "0")}
              onChange={(e) => {
                const newM = e.target.value
                setActiveMonth(`${y}-${newM}`)
              }}
              className="h-7 px-2 text-xs font-bold font-mono rounded-lg border border-border/70 bg-background hover:bg-muted/60 text-foreground cursor-pointer focus:outline-hidden focus:ring-1 focus:ring-primary shadow-2xs"
            >
              {[
                { val: "01", name: "Jan" },
                { val: "02", name: "Feb" },
                { val: "03", name: "Mar" },
                { val: "04", name: "Apr" },
                { val: "05", name: "May" },
                { val: "06", name: "Jun" },
                { val: "07", name: "Jul" },
                { val: "08", name: "Aug" },
                { val: "09", name: "Sep" },
                { val: "10", name: "Oct" },
                { val: "11", name: "Nov" },
                { val: "12", name: "Dec" },
              ].map(({ val, name }) => (
                <option key={val} value={val} className="bg-popover text-popover-foreground">
                  {name}
                </option>
              ))}
            </select>

            <select
              value={String(y)}
              onChange={(e) => {
                const newY = e.target.value
                setActiveMonth(`${newY}-${String(m).padStart(2, "0")}`)
              }}
              className="h-7 px-2 text-xs font-bold font-mono rounded-lg border border-border/70 bg-background hover:bg-muted/60 text-foreground cursor-pointer focus:outline-hidden focus:ring-1 focus:ring-primary shadow-2xs"
            >
              {availableYears.map((yr) => (
                <option key={yr} value={yr} className="bg-popover text-popover-foreground">
                  {yr}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={!canGoNext}
              onClick={() => setActiveMonth(nextMonthStr)}
              className="h-7 w-7 rounded-lg border border-border/60 hover:bg-muted/80 flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title={canGoNext ? `Go to ${nextMonthStr}` : "Latest month reached"}
            >
              <ChevronRight className="size-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-7 w-7 rounded-lg hover:bg-muted/80 flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer transition-colors ml-0.5"
              title="Close"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Month Summary Sub-bar */}
        <div className="flex items-center justify-between px-2.5 py-1 rounded-lg bg-muted/30 border border-border/40 text-[10px] font-mono text-muted-foreground">
          <span>{monthTrades.length} sessions ({monthWins}W · {monthLosses}L)</span>
          <span className={cn("font-bold px-1.5 py-0.2 rounded", monthTotal >= 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400")}>
            Net: {format(monthTotal)}
          </span>
        </div>

        {/* Month Calendar Grid */}
        <div className="flex flex-col gap-1">
          {/* Weekday Labels */}
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-muted-foreground uppercase py-0.5">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => (
              <div key={w} className="py-0.5">{w}</div>
            ))}
          </div>

          {/* Days */}
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: offset }, (_, i) => (
              <div key={`offset-${i}`} className="h-10 rounded-lg opacity-0" />
            ))}
            {Array.from({ length: dayCount }, (_, i) => {
              const dayStr = String(i + 1).padStart(2, "0")
              const date = `${activeMonth}-${dayStr}`
              const d = byDate.get(date)
              const dVal = d ? (d.value ?? d.points ?? d.pnl ?? 0) : 0
              const isSelected = selectedDate === date

              return (
                <button
                  key={date}
                  type="button"
                  disabled={!d}
                  onClick={() => {
                    onSelectDate(date)
                    onClose()
                  }}
                  className={cn(
                    "group relative flex flex-col items-center justify-center h-10 rounded-lg border text-xs font-mono transition-all duration-150 select-none",
                    !d && "border-transparent text-muted-foreground/20 cursor-default opacity-40",
                    d && dVal > 0 && "border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 font-bold shadow-xs cursor-pointer",
                    d && dVal < 0 && "border-rose-500/40 bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 font-bold shadow-xs cursor-pointer",
                    d && dVal === 0 && "border-border/60 bg-muted/40 hover:bg-muted/70 text-foreground cursor-pointer",
                    isSelected && "ring-2 ring-primary ring-offset-1 ring-offset-background border-primary shadow-md font-black scale-105 z-10"
                  )}
                >
                  <span className={cn("text-[11px] leading-tight font-semibold", !d ? "text-muted-foreground/30" : "text-foreground")}>
                    {i + 1}
                  </span>
                  {d && (
                    <span className={cn(
                      "text-[8.5px] font-mono leading-none tracking-tight font-bold mt-0.5",
                      dVal > 0 ? "text-emerald-400" : dVal < 0 ? "text-rose-400" : "text-muted-foreground"
                    )}>
                      {dVal > 0 ? `+${dVal.toFixed(0)}` : dVal < 0 ? `${dVal.toFixed(0)}` : "0"}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between pt-2 border-t border-border/40 text-[10px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 font-medium">
              <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500/30 border border-emerald-400" /> Win Day
            </span>
            <span className="flex items-center gap-1.5 font-medium">
              <span className="h-2.5 w-2.5 rounded-sm bg-rose-500/30 border border-rose-400" /> Loss Day
            </span>
          </div>
          <span className="italic text-[9.5px]">Click any colored session to jump</span>
        </div>
      </div>
    </>,
    document.body
  )
}

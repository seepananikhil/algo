import React, { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { fmtRs } from "@/lib/api"

export interface TravelCalendarPopupProps {
  open: boolean
  onClose: () => void
  daily: {
    date: string
    value?: number
    points?: number
    pnl?: number
    trades?: number
    nifty_points?: number
    sensex_points?: number
  }[]
  selectedDate?: string | null
  onSelectDate: (date: string) => void
  format?: (v: number) => string
  unit?: "rupees" | "points"
  triggerRef?: React.RefObject<HTMLElement | null>
}

const MONTHS = [
  { val: "01", name: "January" },
  { val: "02", name: "February" },
  { val: "03", name: "March" },
  { val: "04", name: "April" },
  { val: "05", name: "May" },
  { val: "06", name: "June" },
  { val: "07", name: "July" },
  { val: "08", name: "August" },
  { val: "09", name: "September" },
  { val: "10", name: "October" },
  { val: "11", name: "November" },
  { val: "12", name: "December" },
]

export function TravelCalendarPopup({
  open,
  onClose,
  daily,
  selectedDate,
  onSelectDate,
  format = (v) => `${v}`,
  unit,
  triggerRef,
}: TravelCalendarPopupProps) {
  const effectiveUnit = unit || (format(100).includes("₹") ? "rupees" : "points")

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

  return createPortal(
    <>
      {/* Invisible backdrop captures click-away to close without dimming */}
      <div className="fixed inset-0 z-50 bg-black/20 backdrop-blur-2xs" onClick={onClose} />

      <div
        style={{
          position: "fixed",
          top: pos ? `${pos.top}px` : "54px",
          right: pos ? `${pos.right}px` : "16px",
        }}
        className="z-50 w-[330px] rounded-2xl border border-border/80 bg-popover/98 backdrop-blur-md p-3.5 shadow-2xl animate-in zoom-in-95 duration-150 flex flex-col gap-2.5 max-h-[85vh] overflow-hidden select-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: Clean Month & Year Selector */}
        <div className="flex items-center justify-between pb-2 border-b border-border/40 shrink-0">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!canGoPrev}
              onClick={() => setActiveMonth(prevMonthStr)}
              className="h-7 w-7 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
              title="Previous month"
            >
              <ChevronLeft className="size-4" />
            </button>

            <div className="flex items-center gap-1 font-bold text-sm text-foreground px-1">
              <select
                value={String(m).padStart(2, "0")}
                onChange={(e) => setActiveMonth(`${y}-${e.target.value}`)}
                className="bg-transparent font-bold text-sm text-foreground hover:text-primary cursor-pointer border-none outline-none focus:outline-none p-0 pr-1"
              >
                {MONTHS.map(({ val, name }) => (
                  <option key={val} value={val} className="bg-popover text-popover-foreground">
                    {name}
                  </option>
                ))}
              </select>

              <select
                value={String(y)}
                onChange={(e) => setActiveMonth(`${e.target.value}-${String(m).padStart(2, "0")}`)}
                className="bg-transparent font-bold text-sm text-foreground hover:text-primary cursor-pointer border-none outline-none focus:outline-none p-0"
              >
                {availableYears.map((yr) => (
                  <option key={yr} value={yr} className="bg-popover text-popover-foreground">
                    {yr}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              disabled={!canGoNext}
              onClick={() => setActiveMonth(nextMonthStr)}
              className="h-7 w-7 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
              title="Next month"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="h-7 w-7 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
            title="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Calendar Grid */}
        <div className="flex flex-col gap-1">
          {/* Weekday Labels */}
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-muted-foreground/70 uppercase py-0.5">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>

          {/* Days Grid */}
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: offset }, (_, i) => (
              <div key={`offset-${i}`} className="h-10 rounded-lg opacity-0 pointer-events-none" />
            ))}
            {Array.from({ length: dayCount }, (_, i) => {
              const dayStr = String(i + 1).padStart(2, "0")
              const date = `${activeMonth}-${dayStr}`
              const d = byDate.get(date)
              const dVal = d ? (d.value ?? d.pnl ?? d.points ?? 0) : 0
              const dNifty = d?.nifty_points ?? 0
              const dSensex = d?.sensex_points ?? 0
              const isSelected = selectedDate === date
              const dayHasBoth = dNifty !== 0 && dSensex !== 0

              const tooltipText = d ? (
                effectiveUnit === "points"
                  ? (dayHasBoth
                      ? `${date}: Nifty ${dNifty >= 0 ? "+" : ""}${dNifty.toFixed(1)} pts · Sensex ${dSensex >= 0 ? "+" : ""}${dSensex.toFixed(1)} pts`
                      : dNifty !== 0
                      ? `${date}: Nifty ${dNifty >= 0 ? "+" : ""}${dNifty.toFixed(1)} pts`
                      : dSensex !== 0
                      ? `${date}: Sensex ${dSensex >= 0 ? "+" : ""}${dSensex.toFixed(1)} pts`
                      : `${date}: ${dVal >= 0 ? "+" : ""}${dVal.toFixed(1)} pts`)
                  : `${date}: ${fmtRs(dVal)}${dNifty ? ` (Nifty: ${dNifty > 0 ? "+" : ""}${dNifty.toFixed(1)}pt)` : ""}${dSensex ? ` (Sensex: ${dSensex > 0 ? "+" : ""}${dSensex.toFixed(1)}pt)` : ""}`
              ) : `${date} (No trades)`

              return (
                <button
                  key={date}
                  type="button"
                  onClick={() => {
                    onSelectDate(date)
                    onClose()
                  }}
                  title={tooltipText}
                  className={cn(
                    "relative flex flex-col items-center justify-center h-10 rounded-lg transition-all cursor-pointer select-none",
                    !d && (
                      isSelected
                        ? "bg-primary/20 text-foreground ring-2 ring-primary ring-offset-1 ring-offset-background font-black"
                        : "text-foreground/80 hover:bg-muted/70 font-medium"
                    ),
                    d && (
                      isSelected
                        ? (dVal > 0
                            ? "bg-emerald-500 text-white font-black shadow-md ring-2 ring-emerald-500 ring-offset-1 ring-offset-background"
                            : dVal < 0
                            ? "bg-rose-500 text-white font-black shadow-md ring-2 ring-rose-500 ring-offset-1 ring-offset-background"
                            : "bg-muted text-foreground font-black shadow-md ring-2 ring-primary ring-offset-1 ring-offset-background")
                        : (dVal > 0
                            ? "bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-500 dark:text-emerald-400 font-bold"
                            : dVal < 0
                            ? "bg-rose-500/15 hover:bg-rose-500/25 text-rose-500 dark:text-rose-400 font-bold"
                            : "bg-muted/50 hover:bg-muted text-foreground font-bold")
                    )
                  )}
                >
                  <span className={cn(
                    "text-xs leading-none",
                    isSelected ? "text-inherit font-black" : !d ? "text-foreground/80 font-medium" : "text-foreground font-bold"
                  )}>
                    {i + 1}
                  </span>
                  {d && (
                    effectiveUnit === "points" ? (
                      dayHasBoth ? (
                        <span className={cn(
                          "text-[8px] font-mono leading-none tracking-tight font-bold mt-0.5",
                          isSelected ? "text-white" : "text-foreground/80"
                        )}>
                          {dNifty >= 0 ? `+${dNifty.toFixed(0)}` : dNifty.toFixed(0)} / {dSensex >= 0 ? `+${dSensex.toFixed(0)}` : dSensex.toFixed(0)}
                        </span>
                      ) : (
                        <span className={cn(
                          "text-[9px] font-mono leading-none tracking-tight font-bold mt-0.5",
                          isSelected ? "text-white" : dVal > 0 ? "text-emerald-500 dark:text-emerald-400" : dVal < 0 ? "text-rose-500 dark:text-rose-400" : "text-muted-foreground"
                        )}>
                          {dVal > 0 ? `+${dVal.toFixed(0)}` : dVal < 0 ? `${dVal.toFixed(0)}` : "0"} pt
                        </span>
                      )
                    ) : (
                      <span className={cn(
                        "text-[9.5px] font-mono leading-none tracking-tight font-bold mt-0.5",
                        isSelected ? "text-white" : dVal > 0 ? "text-emerald-500 dark:text-emerald-400" : dVal < 0 ? "text-rose-500 dark:text-rose-400" : "text-muted-foreground"
                      )}>
                        {dVal > 0
                          ? `+₹${Math.abs(dVal) >= 1000 ? `${Math.round(dVal / 1000)}k` : Math.round(dVal)}`
                          : dVal < 0
                          ? `-₹${Math.abs(dVal) >= 1000 ? `${Math.round(Math.abs(dVal) / 1000)}k` : Math.round(Math.abs(dVal))}`
                          : "₹0"}
                      </span>
                    )
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Minimal Footer */}
        <div className="flex items-center justify-between pt-1.5 border-t border-border/40 text-[10px] text-muted-foreground px-0.5">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 font-medium text-emerald-500">
              <span className="size-2 rounded-full bg-emerald-500 inline-block" /> Profit
            </span>
            <span className="flex items-center gap-1 font-medium text-rose-500">
              <span className="size-2 rounded-full bg-rose-500 inline-block" /> Loss
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground font-mono">
            {effectiveUnit === "points" ? "Points separated" : "Net realized"}
          </span>
        </div>
      </div>
    </>,
    document.body
  )
}

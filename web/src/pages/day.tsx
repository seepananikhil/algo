import { useSearchParams } from "react-router-dom"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DayDetail } from "@/components/day-detail"
import { usePoll } from "@/lib/api"

export function DayPage() {
  const [params, setParams] = useSearchParams()
  const days = usePoll<string[]>("/api/days")
  const date = params.get("date") ?? days.data?.[0] ?? null

  const list = days.data ?? []
  const idx = date ? list.indexOf(date) : -1
  const go = (d: string | undefined) => d && setParams({ date: d })

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
          <Select value={date ?? ""} onValueChange={(v) => go(v as string)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Pick a day" />
            </SelectTrigger>
            <SelectContent>
              {list.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" aria-label="Newer day" disabled={idx <= 0} onClick={() => go(list[idx - 1])}>
            <ChevronRight />
          </Button>
        </div>
      </div>

      <DayDetail date={date} />
    </div>
  )
}

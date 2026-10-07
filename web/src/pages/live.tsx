import { useState } from "react"
import { toast } from "sonner"
import { OctagonX, Play, Radio, Square } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CandleChart } from "@/components/candle-chart"
import { SideBadge, StatCard } from "@/components/common"
import { FillsTable } from "@/components/day-detail"
import { cn } from "@/lib/utils"
import { fmtNum, fmtRs, pnlClass, postJSON, prettyReason, tradesFromSignals, usePoll, type DayData, type OptionTrade, type Signal } from "@/lib/api"
import { useStatus } from "@/lib/status"

export function LivePage() {
  const { status, reload } = useStatus()
  const today = status?.now.slice(0, 10) ?? null
  const day = usePoll<DayData>(today && `/api/day?date=${today}`, 3000)
  const signals = usePoll<Signal[]>(today && `/api/signals?date=${today}`, 3000)
  const trades = usePoll<OptionTrade[]>("/api/trades", 5000)
  const log = usePoll<string[]>("/api/log?lines=150", 5000)
  const [busy, setBusy] = useState(false)

  const todays = (trades.data ?? []).filter((t) => t.date === today)
  const dayPnl = todays.reduce((a, t) => a + t.pnl_rs, 0)
  const setup = day.data?.setup
  const tradeLog = tradesFromSignals(signals.data ?? [])

  async function toggleKill() {
    if (!status) return
    setBusy(true)
    try {
      await postJSON(`/api/kill-switch/${status.kill_switch ? "off" : "on"}`)
      toast.success(status.kill_switch ? "Trading resumed" : "Kill switch ON — no new entries")
      await reload()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function toggleCapture() {
    if (!status) return
    setBusy(true)
    try {
      await postJSON(`/api/capture/${status.capture_running ? "stop" : "start"}`)
      toast.success(status.capture_running ? "Stopping capture (closes any open position first)" : "Capture started")
      setTimeout(reload, 2000)
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Live</h1>
          <p className="text-sm text-muted-foreground">
            Session 09:15–09:50 · entries until 09:40 · {today}
            {status && !status.capture_running && status.auto_start_capture && " · auto-starts weekdays 09:00–09:55"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant={status?.capture_running ? "outline" : "default"} disabled={!status || busy} onClick={toggleCapture}>
            {status?.capture_running ? <Square /> : <Radio />}
            {status?.capture_running ? "Stop capture" : "Start capture"}
          </Button>
          <Button variant={status?.kill_switch ? "default" : "destructive"} disabled={!status || busy} onClick={toggleKill}>
            {status?.kill_switch ? <Play /> : <OctagonX />}
            {status?.kill_switch ? "Resume trading" : "Kill switch"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="NIFTY" value={fmtNum(status?.last_tick?.ltp)} hint={status?.last_tick ? `tick ${status.last_tick.time}` : "no ticks today"} />
        <StatCard label="Today P&L (options)" value={fmtRs(dayPnl)} className={pnlClass(dayPnl)} hint={`${todays.length} trade(s)`} />
        <StatCard
          label="Range / Mid"
          value={setup?.mid != null ? fmtNum(setup.mid) : "—"}
          hint={setup?.range_high != null ? `${fmtNum(setup.range_low)} – ${fmtNum(setup.range_high)} · fixed ${setup.range_fixed_at}` : "range not fixed yet"}
        />
        <StatCard
          label="Armed"
          value={setup?.armed ? <SideBadge side={setup.armed.side} /> : "—"}
          hint={setup?.armed ? `level ${fmtNum(setup.armed.level)} · SL ${fmtNum(setup.armed.stop)}` : "waiting for setup"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>NIFTY 1-min</CardTitle>
          <CardDescription>Range, midpoint and armed level with today's {status?.mode ?? ""} trades. Includes the forming candle.</CardDescription>
        </CardHeader>
        <CardContent>
          {day.data?.candles.length ? (
            <CandleChart date={day.data.date} candles={day.data.candles} forming={day.data.forming} setup={setup} trades={tradeLog} />
          ) : (
            <p className="py-24 text-center text-sm text-muted-foreground">No candles yet today. Capture starts 09:10 on weekdays.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trades today</CardTitle>
          <CardDescription>Option fills ({status?.mode ?? "…"})</CardDescription>
        </CardHeader>
        <CardContent>
          <FillsTable fills={todays} empty="No trades yet today." />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Signals</CardTitle>
          </CardHeader>
          <CardContent>
            {signals.data?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Pts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {signals.data.map((s, i) => (
                    <TableRow key={i}>
                      <TableCell className="tabular-nums">{s.detected_at}</TableCell>
                      <TableCell><Badge variant={s.event === "ENTRY" ? "default" : "secondary"}>{s.event}</Badge></TableCell>
                      <TableCell>{s.side}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.price}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{prettyReason(s.reason ?? "")}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", pnlClass(Number(s.pnl_points || 0)))}>{s.pnl_points}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">No signals today.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Capture log</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-80 rounded-md border bg-muted/30">
              <pre className="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {(log.data ?? []).slice().reverse().join("\n") || "Log is empty."}
              </pre>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

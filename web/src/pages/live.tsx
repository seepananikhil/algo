import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { OctagonX, Play, Radio, RefreshCw, Square } from "lucide-react"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CandleChart } from "@/components/candle-chart"
import { RuleTradesTable, SideBadge, StatCard } from "@/components/common"
import { FillsTable } from "@/components/day-detail"
import {
  chartTradesFromOptionFills,
  fmtNum,
  fmtPts,
  fmtRs,
  optionPaperTradeToFill,
  pnlClass,
  postJSON,
  prettyReason,
  tradesFromSignals,
  usePoll,
  withoutSupersededExitSignals,
  type DayData,
  type FundsStatus,
  type KeyLevelDay,
  type ManualOptionChoices,
  type ManualOptionQuote,
  type ManualOrderResult,
  type ManualTradingSnapshot,
  type OptionPaperTrade,
  type OptionTrade,
  type Signal,
} from "@/lib/api"
import { useStatus } from "@/lib/status"

export function LivePage() {
  const { status, reload } = useStatus()
  const today = status?.now.slice(0, 10) ?? null
  const day = usePoll<DayData>(today && `/api/day?date=${today}&full=1`, 3000)
  const signals = usePoll<Signal[]>(today && `/api/signals?date=${today}`, 3000)
  const trades = usePoll<OptionTrade[]>("/api/trades", 5000)
  const keyLevelPaper = usePoll<OptionPaperTrade[]>(today && `/api/key-level-option-paper?date=${today}`, 5000)
  const keyLevelDay = usePoll<KeyLevelDay>(today && `/api/key-level-day?date=${today}`, 5000)
  const log = usePoll<string[]>("/api/log?lines=150", 5000)
  const manualOptions = usePoll<ManualOptionChoices>(status?.token.valid ? "/api/manual-options" : null)
  const manualBroker = usePoll<ManualTradingSnapshot>(status?.token.valid ? "/api/manual-trading" : null, 10000)
  const manualFunds = usePoll<FundsStatus>(status?.token.valid ? "/api/funds" : null, 15000)
  const [busy, setBusy] = useState(false)
  const [manualAction, setManualAction] = useState<"BUY" | "SELL">("BUY")
  const [optionType, setOptionType] = useState<"CE" | "PE">("CE")
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET")
  const [expiry, setExpiry] = useState("")
  const [strike, setStrike] = useState("")
  const [sellSymbol, setSellSymbol] = useState("")
  const [manualLots, setManualLots] = useState("1")
  const [limitPrice, setLimitPrice] = useState("")
  const [manualBusy, setManualBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmText, setConfirmText] = useState("")
  const [timeframe, setTimeframe] = useState<"1m" | "5m">("1m")
  const seenSignals = useRef(new Set<string>())
  const seededSignalsDate = useRef<string | null>(null)

  const todays = useMemo(() => (trades.data ?? []).filter((trade) => trade.date === today), [trades.data, today])
  const visibleSignals = useMemo(() => withoutSupersededExitSignals(signals.data ?? [], todays), [signals.data, todays])
  const signalTrades = tradesFromSignals(visibleSignals)
  const keyLevelSpotTrades = keyLevelDay.data?.trades ?? []
  const keyLevelFills = useMemo(() => (keyLevelPaper.data ?? []).map(optionPaperTradeToFill), [keyLevelPaper.data])
  const allTodayOptionFills = [...todays, ...keyLevelFills]
  const hasOptionPnl = allTodayOptionFills.length > 0
  const optionPnl = allTodayOptionFills.reduce((sum, trade) => sum + (trade.net_rs ?? trade.pnl_rs), 0)
  const spotTrades = [...signalTrades, ...keyLevelSpotTrades]
  const spotPnl = spotTrades.reduce((sum, trade) => sum + trade.pnl_points, 0)
  const dayPnl = hasOptionPnl ? optionPnl : spotPnl
  const setup = day.data?.setup
  const tradeLog = allTodayOptionFills.length ? chartTradesFromOptionFills(allTodayOptionFills) : spotTrades
  const midpointChartTrades = todays.length ? chartTradesFromOptionFills(todays) : signalTrades
  const fiveMinute = timeframe === "5m"
  const chartCandles = fiveMinute ? keyLevelDay.data?.candles : day.data?.candles
  const chartTrades = fiveMinute ? [...midpointChartTrades, ...keyLevelSpotTrades] : tradeLog
  const selectedExpiry = manualOptions.data?.expiries.find((choice) => choice.expiry === expiry)
  const sellablePositions = (manualBroker.data?.positions ?? []).filter((position) => position.net_qty > 0 && position.lot_size > 0)
  const selectedPosition = sellablePositions.find((position) => position.symbol === sellSymbol)
  const quoteUrl = !status?.token.valid ? null : manualAction === "BUY" && expiry && strike
    ? `/api/manual-quote?expiry=${encodeURIComponent(expiry)}&strike=${encodeURIComponent(strike)}&option_type=${optionType}`
    : manualAction === "SELL" && sellSymbol ? `/api/manual-quote?symbol=${encodeURIComponent(sellSymbol)}` : null
  const manualQuote = usePoll<ManualOptionQuote>(quoteUrl, 0)
  const maxManualLots = manualAction === "BUY"
    ? manualOptions.data?.max_lots ?? 0
    : selectedPosition ? Math.floor(selectedPosition.net_qty / selectedPosition.lot_size) : 0
  const requestedLots = Number(manualLots)
  const limitTickValid = Number(limitPrice) > 0 && Math.abs(Number(limitPrice) * 20 - Math.round(Number(limitPrice) * 20)) < 1e-7
  const referencePrice = orderType === "LIMIT" ? Number(limitPrice) : manualQuote.data?.last_price ?? 0
  const estimatedRequiredFunds = manualAction === "BUY" && selectedExpiry && referencePrice > 0
    ? referencePrice * selectedExpiry.lot_size * requestedLots * 1.05
    : 0
  const availableFunds = manualFunds.data?.ok ? manualFunds.data.available_equity_funds : null
  const fundsSufficient = manualAction === "SELL" || (availableFunds != null && estimatedRequiredFunds > 0 && estimatedRequiredFunds <= availableFunds)
  const manualFormValid = Number.isInteger(requestedLots) && requestedLots >= 1 && requestedLots <= maxManualLots
    && (manualAction === "SELL" ? Boolean(selectedPosition) : Boolean(selectedExpiry && selectedExpiry.strikes.includes(Number(strike))))
    && (orderType === "MARKET" || limitTickValid)
    && fundsSufficient

  useEffect(() => {
    const choices = manualOptions.data?.expiries
    if (!choices?.length) return
    if (!choices.some((choice) => choice.expiry === expiry)) setExpiry(choices[0].expiry)
  }, [manualOptions.data, expiry])

  useEffect(() => {
    const strikes = selectedExpiry?.strikes
    if (!strikes?.length) return
    if (!strikes.includes(Number(strike))) {
      const nearest = strikes.includes(manualOptions.data?.atm ?? -1) ? manualOptions.data?.atm : strikes[0]
      setStrike(String(nearest))
    }
  }, [manualOptions.data, selectedExpiry, strike])

  useEffect(() => {
    if (!sellablePositions.some((position) => position.symbol === sellSymbol)) {
      setSellSymbol(sellablePositions[0]?.symbol ?? "")
    }
  }, [manualBroker.data, sellSymbol, sellablePositions])

  useEffect(() => {
    if (!today || !signals.data) return
    const current = visibleSignals
    if (seededSignalsDate.current !== today) {
      seededSignalsDate.current = today
      seenSignals.current = new Set(current.map((signal) => `${signal.event}|${signal.side}|${signal.entry_time}`))
      return
    }
    for (const signal of current) {
      const key = `${signal.event}|${signal.side}|${signal.entry_time}`
      if (seenSignals.current.has(key)) continue
      seenSignals.current.add(key)
      const side = signal.side === "CALL" ? "CALL" : "PUT"
      const when = signal.candle_time || signal.detected_at || ""
      if (signal.event === "ENTRY") {
        toast.info(`${side} midpoint entry signal`, { description: when })
      } else if (signal.event === "EXIT") {
        const result = Number(signal.pnl_points)
        const description = `${prettyReason(signal.reason ?? "")} · ${when}`
        if (result < 0 || /stop|sl/i.test(signal.reason ?? "")) toast.error(`${side} midpoint exit · loss`, { description })
        else if (result > 0) toast.success(`${side} midpoint exit · profit booked`, { description })
        else toast.info(`${side} midpoint exit signal`, { description })
      }
    }
  }, [signals.data, today, visibleSignals])

  async function toggleKill() {
    if (!status) return
    setBusy(true)
    try {
      await postJSON(`/api/kill-switch/${status.kill_switch ? "off" : "on"}`)
      toast.success(status.kill_switch ? "Trading resumed" : "Kill switch ON — no new entries")
      await reload()
    } catch (error) {
      toast.error(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function toggleCapture() {
    if (!status) return
    setBusy(true)
    try {
      const result = await postJSON<{ market_closed?: boolean }>(`/api/capture/${status.capture_running ? "stop" : "start"}`)
      if (result.market_closed) toast.info("Market is closed; capture does not start on weekends")
      else toast.success(status.capture_running ? "Stopping capture (closes any open position first)" : "Capture started")
      setTimeout(reload, 2000)
    } catch (error) {
      toast.error(String(error))
    } finally {
      setBusy(false)
    }
  }

  function reviewManualOrder() {
    if (!manualFormValid) return
    setConfirmText("")
    setConfirmOpen(true)
  }

  async function submitManualOrder() {
    if (confirmText !== "PLACE LIVE ORDER" || !manualFormValid) return
    setManualBusy(true)
    const body = manualAction === "BUY"
      ? { action: manualAction, order_type: orderType, expiry, strike: Number(strike), option_type: optionType, lots: requestedLots, limit_price: orderType === "LIMIT" ? Number(limitPrice) : undefined, confirm: confirmText }
      : { action: manualAction, order_type: orderType, symbol: sellSymbol, lots: requestedLots, limit_price: orderType === "LIMIT" ? Number(limitPrice) : undefined, confirm: confirmText }
    try {
      const result = await postJSON<ManualOrderResult>("/api/manual-order", body)
      toast.success("Fyers accepted the order", { description: `${result.action} ${result.symbol} · ${result.qty} qty · ${result.order_id}` })
      setConfirmOpen(false)
      setConfirmText("")
      await manualBroker.reload()
    } catch (error) {
      toast.error("Manual order was not accepted", { description: String(error) })
    } finally {
      setManualBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Live</h1>
          <p className="text-sm text-muted-foreground">
            Session 09:15–09:50 · entries until 09:40 · {today}
            {status && !status.capture_running && " · auto-starts weekdays 09:00–15:29"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant={status?.capture_running ? "outline" : "default"} disabled={!status || busy || (status.market_open_day === false && !status.capture_running)} onClick={toggleCapture}>
            {status?.capture_running ? <Square /> : <Radio />}
            {status?.capture_running ? "Stop capture" : status?.market_open_day === false ? "Market closed" : "Start capture"}
          </Button>
          <Button variant={status?.kill_switch ? "default" : "destructive"} disabled={!status || busy} onClick={toggleKill}>
            {status?.kill_switch ? <Play /> : <OctagonX />}
            {status?.kill_switch ? "Resume trading" : "Kill switch"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="NIFTY" value={fmtNum(status?.last_tick?.ltp)} hint={status?.last_tick ? `tick ${status.last_tick.time}` : "no ticks today"} />
        <StatCard label={hasOptionPnl ? "Today P&L (options)" : "Today P&L (points)"} value={hasOptionPnl ? fmtRs(dayPnl) : fmtPts(dayPnl)} className={pnlClass(dayPnl)} hint={`${hasOptionPnl ? allTodayOptionFills.length : spotTrades.length} trade(s)`} />
        <StatCard label="Range / Mid" value={setup?.mid != null ? fmtNum(setup.mid) : "—"} hint={setup?.range_high != null ? `${fmtNum(setup.range_low)} – ${fmtNum(setup.range_high)} · fixed ${setup.range_fixed_at}` : "range not fixed yet"} />
        <StatCard label="Armed" value={setup?.armed ? <SideBadge side={setup.armed.side} /> : "—"} hint={setup?.armed ? `level ${fmtNum(setup.armed.level)} · SL ${fmtNum(setup.armed.stop)}` : "waiting for setup"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.9fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Manual NIFTY options</CardTitle>
            <CardDescription>Real Fyers orders · intraday · up to {manualOptions.data?.max_lots ?? 0} lots · submission only during market hours</CardDescription>
            <CardAction>
              <Button variant="outline" size="icon" aria-label="Refresh broker state" title="Refresh broker state" onClick={() => void manualBroker.reload()} disabled={manualBroker.loading}>
                <RefreshCw />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {manualOptions.error && <p className="text-sm text-red-500">Option choices unavailable: {manualOptions.error}</p>}
            {manualBroker.error && <p className="text-sm text-red-500">Broker state unavailable: {manualBroker.error}</p>}
            <div className="flex flex-wrap items-center gap-3">
              <Tabs value={manualAction} onValueChange={(value) => setManualAction(value as "BUY" | "SELL")}>
                <TabsList><TabsTrigger value="BUY">Buy</TabsTrigger><TabsTrigger value="SELL">Sell</TabsTrigger></TabsList>
              </Tabs>
              <Tabs value={orderType} onValueChange={(value) => setOrderType(value as "MARKET" | "LIMIT")}>
                <TabsList><TabsTrigger value="MARKET">Market</TabsTrigger><TabsTrigger value="LIMIT">Limit</TabsTrigger></TabsList>
              </Tabs>
              {manualAction === "BUY" && (
                <Tabs value={optionType} onValueChange={(value) => setOptionType(value as "CE" | "PE")}>
                  <TabsList><TabsTrigger value="CE">CE</TabsTrigger><TabsTrigger value="PE">PE</TabsTrigger></TabsList>
                </Tabs>
              )}
            </div>

            {manualAction === "BUY" ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="manual-expiry">Expiry</Label>
                  <Select value={expiry} onValueChange={(value) => value && setExpiry(value)}>
                    <SelectTrigger id="manual-expiry" className="w-full"><SelectValue placeholder="Select expiry" /></SelectTrigger>
                    <SelectContent>{(manualOptions.data?.expiries ?? []).map((choice) => <SelectItem key={choice.expiry} value={choice.expiry}>{choice.expiry}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="manual-strike">Strike</Label>
                  <Select value={strike} onValueChange={(value) => value && setStrike(value)}>
                    <SelectTrigger id="manual-strike" className="w-full"><SelectValue placeholder="Select strike" /></SelectTrigger>
                    <SelectContent>{(selectedExpiry?.strikes ?? []).map((value) => <SelectItem key={value} value={String(value)}>{value.toLocaleString("en-IN")}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="manual-lots">Lots (1 lot = {selectedExpiry?.lot_size ?? "—"})</Label>
                  <Input id="manual-lots" type="number" min={1} max={maxManualLots} step={1} value={manualLots} onChange={(event) => setManualLots(event.target.value)} />
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="manual-position">Open NIFTY position</Label>
                  <Select value={sellSymbol} onValueChange={(value) => value && setSellSymbol(value)}>
                    <SelectTrigger id="manual-position" className="w-full"><SelectValue placeholder="Select open position" /></SelectTrigger>
                    <SelectContent>{sellablePositions.map((position) => <SelectItem key={position.symbol} value={position.symbol}>{position.symbol} · {position.net_qty} qty</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="manual-sell-lots">Lots (max {maxManualLots})</Label>
                  <Input id="manual-sell-lots" type="number" min={1} max={maxManualLots} step={1} value={manualLots} onChange={(event) => setManualLots(event.target.value)} disabled={!selectedPosition} />
                </div>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
              {orderType === "LIMIT" ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="manual-limit-price">Limit price (₹)</Label>
                  <Input id="manual-limit-price" type="number" min="0.05" step="0.05" inputMode="decimal" value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} placeholder="0.00" />
                </div>
              ) : (
                <p className="self-end text-sm text-muted-foreground">Market reference LTP: {manualQuote.data ? fmtRs(manualQuote.data.last_price) : manualQuote.error ? "unavailable" : "checking…"}</p>
              )}
              <Button className="self-end" variant="destructive" disabled={!manualFormValid || !manualBroker.data?.order_window_open || (manualAction === "BUY" && manualBroker.data?.kill_switch)} onClick={reviewManualOrder}>
                Review {manualAction.toLowerCase()}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {manualBroker.data?.order_window_open ? "Market is open. Every order requires a second confirmation." : "Market closed · manual live order submission is disabled."}
              {manualBroker.data?.kill_switch && " Kill switch is on; buys are blocked."}
            </p>
            <div className="grid gap-2 rounded-md border bg-muted/20 p-3 text-sm sm:grid-cols-2">
              <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">Available funds</span><strong>{availableFunds == null ? "Unavailable" : fmtRs(availableFunds)}</strong></div>
              <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">Estimated buy requirement</span><strong>{manualAction === "SELL" ? "No new buy reserve" : estimatedRequiredFunds > 0 ? fmtRs(estimatedRequiredFunds) : "Select a valid price"}</strong></div>
              <p className="text-xs text-muted-foreground sm:col-span-2">Buy estimate uses {orderType === "LIMIT" ? "your limit price" : "the option’s reference LTP"} × quantity with a 5% reserve. Fyers performs the final funds check.</p>
              {manualFunds.error && <p className="text-xs text-red-500 sm:col-span-2">Funds lookup failed: {manualFunds.error}</p>}
              {manualQuote.error && <p className="text-xs text-red-500 sm:col-span-2">Option quote failed: {manualQuote.error}</p>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Fyers account P&amp;L</CardTitle>
            <CardDescription>Broker-reported totals · updated {manualBroker.data?.updated_at ?? "—"}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Realized" value={fmtRs(manualBroker.data?.account_pnl.realized ?? 0)} className={pnlClass(manualBroker.data?.account_pnl.realized ?? 0)} />
              <StatCard label="Unrealized" value={fmtRs(manualBroker.data?.account_pnl.unrealized ?? 0)} className={pnlClass(manualBroker.data?.account_pnl.unrealized ?? 0)} />
              <StatCard label="Total" value={fmtRs(manualBroker.data?.account_pnl.total ?? 0)} className={pnlClass(manualBroker.data?.account_pnl.total ?? 0)} />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">Open NIFTY options</h3>
              {sellablePositions.length ? <div className="divide-y rounded-md border">
                {sellablePositions.map((position) => <div key={position.symbol} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div><div className="font-medium">{position.symbol}</div><div className="text-xs text-muted-foreground">{position.net_qty} qty · avg ₹{fmtNum(position.average_price)} · P&amp;L {fmtRs(position.pnl)}</div></div>
                  <Button variant="outline" size="sm" onClick={() => { setManualAction("SELL"); setSellSymbol(position.symbol); setManualLots(String(Math.max(1, Math.floor(position.net_qty / position.lot_size)))) }}>Sell position</Button>
                </div>)}
              </div> : <p className="rounded-md border px-3 py-4 text-sm text-muted-foreground">No open long NIFTY option positions.</p>}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">Recent NIFTY orders</h3>
              {manualBroker.data?.orders.length ? <div className="max-h-52 overflow-auto rounded-md border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground"><tr><th className="px-2 py-2">Time</th><th className="px-2 py-2">Contract</th><th className="px-2 py-2">Side / qty</th><th className="px-2 py-2">Status</th><th className="px-2 py-2 text-right">Avg fill</th></tr></thead>
                  <tbody className="divide-y">{manualBroker.data.orders.slice().reverse().map((order) => <tr key={order.id}><td className="px-2 py-2 whitespace-nowrap">{order.time}</td><td className="px-2 py-2 whitespace-nowrap">{order.symbol}</td><td className="px-2 py-2 whitespace-nowrap">{order.side === 1 ? "Buy" : "Sell"} {order.filled_qty || order.qty}</td><td className="px-2 py-2">{order.status}</td><td className="px-2 py-2 text-right">{order.traded_price ? `₹${fmtNum(order.traded_price)}` : "—"}</td></tr>)}</tbody>
                </table>
              </div> : <p className="rounded-md border px-3 py-4 text-sm text-muted-foreground">No NIFTY option orders today.</p>}
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(open) => { setConfirmOpen(open); if (!open) setConfirmText("") }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm live {manualAction.toLowerCase()}</DialogTitle>
            <DialogDescription>
              {manualAction === "BUY"
                ? `${expiry} NIFTY ${strike} ${optionType} · ${requestedLots} lot(s) · ${orderType}${orderType === "LIMIT" ? ` at ₹${limitPrice}` : ""}.`
                : `${sellSymbol} · sell ${requestedLots} lot(s) · ${orderType}${orderType === "LIMIT" ? ` at ₹${limitPrice}` : ""}. This can only reduce the open long position.`}
              {" "}This submits a real INTRADAY order to Fyers.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="manual-order-confirm">Type PLACE LIVE ORDER to confirm</Label>
            <Input id="manual-order-confirm" autoComplete="off" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={manualBusy}>Back</Button>
            <Button variant="destructive" disabled={manualBusy || confirmText !== "PLACE LIVE ORDER"} onClick={submitManualOrder}>{manualBusy ? "Submitting…" : "Submit live order"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>NIFTY intraday chart</CardTitle>
          <CardDescription>Midpoint buffer zone (amber) and Key Levels zone (cyan) with paper/live entries and exits. Scroll or drag to zoom, or pick a time window.</CardDescription>
          <CardAction>
            <Tabs value={timeframe} onValueChange={(value) => setTimeframe(value as "1m" | "5m")}>
              <TabsList><TabsTrigger value="1m">1 min</TabsTrigger><TabsTrigger value="5m">5 min</TabsTrigger></TabsList>
            </Tabs>
          </CardAction>
        </CardHeader>
        <CardContent>
          {chartCandles?.length ? (
            <CandleChart
              date={day.data?.date ?? today ?? ""}
              candles={chartCandles}
              forming={fiveMinute ? undefined : day.data?.forming}
              setup={setup}
              trades={chartTrades}
              keyLevelZone={keyLevelDay.data?.key_level_zone}
              showTradeLevels={fiveMinute}
              zoomable
              resetKey={timeframe}
            />
          ) : <p className="py-24 text-center text-sm text-muted-foreground">No candles yet today. Capture starts on weekdays.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trades today</CardTitle>
          <CardDescription>Option fills and paper simulations · P&amp;L uses option prices when available</CardDescription>
        </CardHeader>
        <CardContent>
          {keyLevelPaper.error
            ? <p className="text-sm text-red-500">Key Levels paper fills failed to load: {keyLevelPaper.error}</p>
            : hasOptionPnl
              ? <FillsTable fills={allTodayOptionFills} signals={visibleSignals} empty="No trades yet today." />
              : <RuleTradesTable trades={spotTrades} empty="No trades yet today." />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Capture log</CardTitle></CardHeader>
        <CardContent>
          <ScrollArea className="h-80 rounded-md border bg-muted/30">
            <pre className="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{(log.data ?? []).slice().reverse().join("\n") || "Log is empty."}</pre>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}
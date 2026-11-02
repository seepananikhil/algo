import { useEffect, useState } from "react"
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  fmtNum,
  fmtRs,
  pnlClass,
  postJSON,
  usePoll,
  type FundsStatus,
  type ManualOptionChoices,
  type ManualOptionQuote,
  type ManualOrderResult,
  type ManualTradingSnapshot,
} from "@/lib/api"
import { useStatus } from "@/lib/status"

export function ManualTradingPage() {
  const { status } = useStatus()
  const manualOptions = usePoll<ManualOptionChoices>(status?.token.valid ? "/api/manual-options" : null)
  const manualBroker = usePoll<ManualTradingSnapshot>(status?.token.valid ? "/api/manual-trading" : null, 2000)
  const manualFunds = usePoll<FundsStatus>(status?.token.valid ? "/api/funds" : null, 15000)

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

  const selectedExpiry = manualOptions.data?.expiries.find((choice) => choice.expiry === expiry)
  const sellablePositions = (manualBroker.data?.positions ?? []).filter((position: any) => position.net_qty > 0 && position.lot_size > 0)
  const selectedPosition = sellablePositions.find((position: any) => position.symbol === sellSymbol)
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
    if (!sellablePositions.some((position: any) => position.symbol === sellSymbol)) {
      setSellSymbol(sellablePositions[0]?.symbol ?? "")
    }
  }, [manualBroker.data, sellSymbol, sellablePositions])

  function reviewManualOrder() {
    if (!manualFormValid) return
    setConfirmText("")
    setConfirmOpen(true)
  }

  function reviewPositionExit(position: ManualTradingSnapshot["positions"][number]) {
    setManualAction("SELL")
    setOrderType("MARKET")
    setSellSymbol(position.symbol)
    setManualLots(String(Math.max(1, Math.floor(position.net_qty / position.lot_size))))
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
      void manualBroker.reload()
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
          <h1 className="text-xl font-semibold">Manual Option Terminal</h1>
          <p className="text-sm text-muted-foreground">
            Execute manual NIFTY options directly on broker · separate from automated algorithm
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void manualBroker.reload()} disabled={manualBroker.loading}>
            <RefreshCw className="mr-1.5 size-3.5" /> Refresh broker state
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(22rem,0.9fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Order Entry</CardTitle>
            <CardDescription>
              Real Fyers orders · intraday · up to {manualOptions.data?.max_lots ?? 0} lots · submission during market hours
            </CardDescription>
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
                  <TabsList><TabsTrigger value="CE">CE (Call)</TabsTrigger><TabsTrigger value="PE">PE (Put)</TabsTrigger></TabsList>
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
                    <SelectContent>{sellablePositions.map((position: any) => <SelectItem key={position.symbol} value={position.symbol}>{position.symbol} · {position.net_qty} qty</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="manual-sell-lots">Lots to sell</Label>
                  <Input id="manual-sell-lots" type="number" min={1} max={maxManualLots || 1} step={1} value={manualLots} onChange={(event) => setManualLots(event.target.value)} disabled={!selectedPosition} />
                </div>
              </div>
            )}

            {orderType === "LIMIT" && (
              <div className="flex flex-col gap-2 sm:max-w-xs">
                <Label htmlFor="manual-limit">Limit price (0.05 tick)</Label>
                <Input id="manual-limit" type="number" min={0.05} step={0.05} placeholder={manualQuote.data?.last_price ? String(manualQuote.data.last_price) : "Enter limit"} value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} />
              </div>
            )}

            <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <span className="text-muted-foreground">Contract:</span>
                <div className="font-mono font-medium truncate">{manualQuote.data?.symbol || (manualAction === "BUY" ? "Choose contract" : sellSymbol || "Choose position")}</div>
              </div>
              <div>
                <span className="text-muted-foreground">Live quote:</span>
                <div className="font-medium">{manualQuote.loading ? "Fetching…" : manualQuote.data?.last_price ? fmtRs(manualQuote.data.last_price) : "Quote unavailable"}</div>
              </div>
              <div>
                <span className="text-muted-foreground">Estimated debit:</span>
                <div className="font-medium">{estimatedRequiredFunds > 0 ? fmtRs(estimatedRequiredFunds) : manualAction === "SELL" ? "Sell to close" : "—"}</div>
              </div>
              <div>
                <span className="text-muted-foreground">Available funds:</span>
                <div className="font-medium">{availableFunds != null ? fmtRs(availableFunds) : "Unavailable"}</div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <span className="text-xs text-muted-foreground">
                {!status?.token.valid ? "Login required on Fyers" : !manualBroker.data?.order_window_open ? "Market closed (09:15–15:30 weekdays only)" : manualBroker.data?.kill_switch && manualAction === "BUY" ? "Kill switch is active" : !fundsSufficient ? "Insufficient equity margin" : "Ready to place order"}
              </span>
              <Button variant={manualAction === "BUY" ? "default" : "destructive"} disabled={!manualFormValid || manualBusy || !status?.token.valid} onClick={reviewManualOrder}>
                {manualAction === "BUY" ? "Review Buy Order" : "Review Sell Order"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Open Positions &amp; P&amp;L</CardTitle>
            <CardDescription>
              Realized: <strong className={pnlClass(manualBroker.data?.account_pnl.realized ?? 0)}>{fmtRs(manualBroker.data?.account_pnl.realized ?? 0)}</strong> · Unrealized: <strong className={pnlClass(manualBroker.data?.account_pnl.unrealized ?? 0)}>{fmtRs(manualBroker.data?.account_pnl.unrealized ?? 0)}</strong>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {manualBroker.data?.positions.length ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Avg</TableHead>
                      <TableHead className="text-right">P&amp;L</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {manualBroker.data.positions.map((position: any) => (
                      <TableRow key={position.symbol}>
                        <TableCell className="font-mono text-xs truncate max-w-[140px]">{position.symbol.replace("NSE:", "")}</TableCell>
                        <TableCell className="text-right tabular-nums">{position.net_qty}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(position.average_price)}</TableCell>
                        <TableCell className={`text-right font-medium tabular-nums ${pnlClass(position.pnl)}`}>{fmtRs(position.pnl)}</TableCell>
                        <TableCell className="text-right">
                          <Button size="xs" variant="destructive" onClick={() => reviewPositionExit(position)}>Exit</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">No open NIFTY option positions.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Manual Orders</CardTitle>
          <CardDescription>Last 50 orders on Fyers broker</CardDescription>
        </CardHeader>
        <CardContent>
          {manualBroker.data?.orders.length ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Symbol</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {manualBroker.data.orders.slice().reverse().map((order: any) => (
                    <TableRow key={order.id}>
                      <TableCell className="text-xs text-muted-foreground">{order.time.slice(11, 19)}</TableCell>
                      <TableCell className="font-medium">{order.side === 1 ? <span className="text-emerald-500">BUY</span> : <span className="text-rose-500">SELL</span>}</TableCell>
                      <TableCell className="font-mono text-xs truncate max-w-[160px]">{order.symbol.replace("NSE:", "")}</TableCell>
                      <TableCell className="text-right tabular-nums">{order.filled_qty} / {order.qty}</TableCell>
                      <TableCell className="text-right tabular-nums">{order.traded_price ? fmtNum(order.traded_price) : order.limit_price ? fmtNum(order.limit_price) : "MKT"}</TableCell>
                      <TableCell className="text-xs">{order.status === 2 ? <span className="text-emerald-500 font-medium">FILLED</span> : order.status === 5 ? <span className="text-rose-500">REJECTED</span> : order.status === 1 ? <span className="text-amber-500">CANCELLED</span> : `Status ${order.status}`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">No recent orders recorded.</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={(open) => !manualBusy && setConfirmOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm {manualAction === "BUY" ? "Buy" : "Sell"} Order</DialogTitle>
            <DialogDescription>
              {manualAction === "BUY" ? "Buy" : "Sell"} {requestedLots} lot(s) of {manualQuote.data?.symbol || sellSymbol} at {orderType === "LIMIT" ? `Limit Rs ${limitPrice}` : "Market Price"}.
              {" "}This submits a real order to your broker.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="manual-order-confirm">Type PLACE LIVE ORDER to confirm</Label>
            <Input id="manual-order-confirm" autoComplete="off" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={manualBusy}>Cancel</Button>
            <Button variant="destructive" disabled={manualBusy || !manualFormValid || confirmText !== "PLACE LIVE ORDER"} onClick={submitManualOrder}>
              {manualBusy ? "Submitting…" : "Submit live order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

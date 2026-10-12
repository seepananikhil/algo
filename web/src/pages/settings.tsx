import { useEffect, useState } from "react"
import { toast } from "sonner"
import { AlertTriangle, Banknote, Save } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getJSON, postJSON, usePoll, type FundsStatus, type Settings } from "@/lib/api"
import { useStatus } from "@/lib/status"

type Form = { lots: string; daily_loss_limit: string; strike_offset: string; option_target_pct: string; minimum_live_funds: string }

export function SettingsPage() {
  const { data, reload } = usePoll<Settings>("/api/settings")
  const status = useStatus()
  const [form, setForm] = useState<Form | null>(null)
  const [tab, setTab] = useState("midpoint")
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmStrategy, setConfirmStrategy] = useState<"midpoint" | "hero_zero" | null>(null)
  const [typed, setTyped] = useState("")
  const [restart, setRestart] = useState(false)
  const [funds, setFunds] = useState<FundsStatus | null>(null)
  const [fundsLoading, setFundsLoading] = useState(false)

  useEffect(() => {
    if (data && !form) {
      setForm({
        lots: String(data.lots),
        daily_loss_limit: String(data.daily_loss_limit),
        strike_offset: String(data.strike_offset),
        option_target_pct: String(data.option_target_pct ?? 10),
        minimum_live_funds: String(data.minimum_live_funds ?? 25000),
      })
    }
  }, [data, form])

  async function save(body: Record<string, unknown>, message: string) {
    try {
      const result = await postJSON<Settings>("/api/settings", body)
      setRestart(Boolean(result.restart_required))
      toast.success(message)
      await Promise.all([reload(), status.reload()])
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  function saveMidpoint() {
    if (!form) return
    save({
      lots: Number(form.lots),
      daily_loss_limit: Number(form.daily_loss_limit),
      strike_offset: Number(form.strike_offset),
      option_target_pct: Number(form.option_target_pct),
      minimum_live_funds: Number(form.minimum_live_funds),
    }, "Midpoint settings saved")
  }

  async function checkFunds() {
    setFundsLoading(true)
    try {
      setFunds(await getJSON<FundsStatus>("/api/funds"))
    } catch (error) {
      setFunds({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setFundsLoading(false)
    }
  }

  async function confirmLive() {
    if (!confirmStrategy || typed !== "LIVE") return
    const midpoint = confirmStrategy === "midpoint"
    const body = midpoint
      ? { midpoint_live_trading: true, confirm: typed }
      : { hero_zero_live_trading: true, confirm: typed }
    if (await save(body, `${midpoint ? "Midpoint" : "HeroZero"} LIVE enabled`)) {
      setConfirmOpen(false)
      setConfirmStrategy(null)
      setTyped("")
    }
  }

  if (!data || !form) return null
  const midpointLive = data.midpoint_live_trading ?? data.live_trading
  const heroZeroLive = data.hero_zero_live_trading
  const minimumFunds = Number(form.minimum_live_funds).toLocaleString("en-IN")

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Settings</h1>

      {restart && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Restart capture to apply</AlertTitle>
          <AlertDescription>Strategy and risk settings apply after a restart or next session.</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Fyers balance</CardTitle>
          <CardDescription>Available equity funds from your authenticated account.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {funds?.ok ? (
              <div className="text-lg font-semibold tabular-nums">₹{funds.available_equity_funds.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</div>
            ) : funds ? (
              <p className="max-w-md text-sm text-red-500">{funds.error}</p>
            ) : (
              <p className="text-sm text-muted-foreground">Balance not checked</p>
            )}
          </div>
          <Button variant="outline" onClick={checkFunds} disabled={fundsLoading}>
            <Banknote /> {fundsLoading ? "Checking…" : "Check balance"}
          </Button>
        </CardContent>
      </Card>

      <Card className={midpointLive || heroZeroLive ? "border-red-600/60" : undefined}>
        <CardHeader>
          <CardTitle>Strategy modes</CardTitle>
          <CardDescription>Always visible. LIVE submits real Fyers orders.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <div className={midpointLive ? "font-semibold text-red-500" : "font-semibold text-sky-500"}>Midpoint · {midpointLive ? "LIVE" : "PAPER"}</div>
              <p className="text-xs text-muted-foreground">{data.lots} lot{data.lots === 1 ? "" : "s"} per LIVE signal</p>
            </div>
            <Switch
              checked={midpointLive}
              onCheckedChange={(enabled) => {
                if (enabled) {
                  setConfirmStrategy("midpoint")
                  setConfirmOpen(true)
                } else {
                  save({ midpoint_live_trading: false }, "Midpoint switched to PAPER")
                }
              }}
              aria-label="Midpoint live trading"
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <div className={heroZeroLive ? "font-semibold text-red-500" : "font-semibold text-sky-500"}>HeroZero · {heroZeroLive ? "LIVE" : "PAPER"}</div>
              <p className="text-xs text-muted-foreground">1 PE + 1 CE maximum</p>
            </div>
            <Switch
              checked={heroZeroLive}
              onCheckedChange={(enabled) => {
                if (enabled) {
                  setConfirmStrategy("hero_zero")
                  setConfirmOpen(true)
                } else {
                  save({ hero_zero_live_trading: false }, "HeroZero switched to PAPER")
                }
              }}
              aria-label="HeroZero live trading"
            />
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="midpoint">Midpoint</TabsTrigger>
          <TabsTrigger value="hero_zero">HeroZero</TabsTrigger>
        </TabsList>

        <TabsContent value="midpoint" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Midpoint settings</CardTitle>
              <CardDescription>Paper size stays at 2 lots. LIVE size uses the lot count below.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">Estimated LIVE funds: max of ₹{minimumFunds} minimum balance or option LTP × exchange lot size × selected lots × 1.05.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="live-lots">LIVE lots per signal</Label>
                  <Input id="live-lots" type="number" min={1} max={2} step={1} value={form.lots} onChange={(event) => setForm({ ...form, lots: event.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="min-live-funds">Minimum LIVE balance (₹)</Label>
                  <Input id="min-live-funds" type="number" min={10000} max={10000000} step={1000} value={form.minimum_live_funds} onChange={(event) => setForm({ ...form, minimum_live_funds: event.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="dll">Daily loss limit (₹)</Label>
                  <Input id="dll" type="number" min={100} step={100} value={form.daily_loss_limit} onChange={(event) => setForm({ ...form, daily_loss_limit: event.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="so">Strike offset (points from ATM)</Label>
                  <Input id="so" type="number" min={0} max={500} step={50} value={form.strike_offset} onChange={(event) => setForm({ ...form, strike_offset: event.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="otp">Option profit target (% of premium, 0 = off)</Label>
                  <Input id="otp" type="number" min={0} max={200} step={5} value={form.option_target_pct} onChange={(event) => setForm({ ...form, option_target_pct: event.target.value })} />
                </div>
              </div>
            </CardContent>
            <CardFooter className="justify-end">
              <Button onClick={saveMidpoint}><Save /> Save Midpoint</Button>
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="hero_zero" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>HeroZero settings</CardTitle>
              <CardDescription>One lot each · at most one PE and one CE per expiry session, closest to spot.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Estimated PE + CE entry reserve is about ₹1,700. LIVE orders check actual quotes and require the Midpoint LIVE balance threshold.
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={confirmOpen} onOpenChange={(open) => { setConfirmOpen(open); if (!open) { setConfirmStrategy(null); setTyped("") } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable {confirmStrategy === "hero_zero" ? "HeroZero" : "Midpoint"} LIVE?</DialogTitle>
            <DialogDescription>
              {confirmStrategy === "hero_zero"
                ? "HeroZero will place one live order for the selected PE and CE (one lot each), then attempt the expiry exit. Type LIVE to confirm."
                : `Midpoint will place real Fyers orders at ${data.lots} lot${data.lots === 1 ? "" : "s"} per signal after the funds check. Type LIVE to confirm.`}
            </DialogDescription>
          </DialogHeader>
          <Input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="LIVE" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={typed !== "LIVE"} onClick={confirmLive}>Enable LIVE</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
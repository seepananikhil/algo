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

type Form = {
  lots: string
  daily_loss_limit: string
  strike_offset: string
  option_target_pct: string
  minimum_live_funds: string
  key_levels_lots: string
  hero_zero_lots: string
  scalper_lots: string
  scalper_sl_pts: string
  scalper_target_pts: string
  scalper_max_trades: string
  hourly_trend_lots: string
}

type StrategyId = "midpoint" | "hero_zero" | "key_levels" | "scalper" | "hourly_trend"

const LIVE_MODE = {
  midpoint: { field: "midpoint_live_trading", label: "Midpoint" },
  hero_zero: { field: "hero_zero_live_trading", label: "HeroZero" },
  key_levels: { field: "key_levels_live_trading", label: "Key Levels" },
  scalper: { field: "scalper_live_trading", label: "Micro Scalper" },
  hourly_trend: { field: "hourly_trend_live_trading", label: "Hourly Trend" },
} as const

type KotakForm = {
  consumer_key: string
  mobile_number: string
  ucc: string
  mpin: string
  totp_secret: string
}

export function SettingsPage() {
  const { data, reload } = usePoll<Settings>("/api/settings")
  const status = useStatus()
  const [form, setForm] = useState<Form | null>(null)
  const [kotakForm, setKotakForm] = useState<KotakForm>({
    consumer_key: "",
    mobile_number: "",
    ucc: "",
    mpin: "",
    totp_secret: "",
  })
  const [kotakTotp, setKotakTotp] = useState("")
  const [kotakLoggingIn, setKotakLoggingIn] = useState(false)
  const [tab, setTab] = useState("scalper")
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmStrategy, setConfirmStrategy] = useState<StrategyId | null>(null)
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
        key_levels_lots: String(data.key_levels_lots),
        hero_zero_lots: String(data.hero_zero_lots),
        scalper_lots: String(data.scalper_lots ?? 1),
        scalper_sl_pts: String(data.scalper_sl_pts ?? 9.0),
        scalper_target_pts: String(data.scalper_target_pts ?? 25.0),
        scalper_max_trades: String(data.scalper_max_trades ?? 1),
        hourly_trend_lots: String(data.hourly_trend_lots ?? 1),
      })
      setKotakForm({
        consumer_key: "",
        mobile_number: data.kotak_mobile_number ?? "",
        ucc: data.kotak_ucc ?? "",
        mpin: "",
        totp_secret: "",
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

  function saveHeroZero() {
    if (!form) return
    save({ hero_zero_lots: Number(form.hero_zero_lots) }, "HeroZero settings saved")
  }

  function saveScalper() {
    if (!form) return
    save({
      scalper_lots: Number(form.scalper_lots),
      scalper_sl_pts: Number(form.scalper_sl_pts),
      scalper_target_pts: Number(form.scalper_target_pts),
      scalper_max_trades: Number(form.scalper_max_trades),
    }, "Micro Scalper settings saved")
  }

  function saveKotakCredentials() {
    const payload: Record<string, string> = {}
    if (kotakForm.consumer_key) payload.kotak_consumer_key = kotakForm.consumer_key
    if (kotakForm.mobile_number) payload.kotak_mobile_number = kotakForm.mobile_number
    if (kotakForm.ucc) payload.kotak_ucc = kotakForm.ucc
    if (kotakForm.mpin) payload.kotak_mpin = kotakForm.mpin
    if (kotakForm.totp_secret) payload.kotak_totp_secret = kotakForm.totp_secret

    save(payload, "Kotak Neo credentials saved")
  }

  async function loginKotak() {
    setKotakLoggingIn(true)
    try {
      const res = await postJSON<{ ok: boolean; greeting_name?: string; error?: string }>("/api/kotak/login", {
        totp: kotakTotp || undefined,
        mpin: kotakForm.mpin || undefined,
      })
      if (res.ok) {
        toast.success(`Kotak Neo authenticated for ${res.greeting_name ?? "User"}`)
        setKotakTotp("")
        await Promise.all([reload(), status.reload(), checkFunds()])
      } else {
        toast.error(res.error || "Kotak Neo login failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setKotakLoggingIn(false)
    }
  }

  function setLiveMode(strategy: StrategyId, enabled: boolean) {
    const { field, label } = LIVE_MODE[strategy]
    if (enabled) {
      setConfirmStrategy(strategy)
      setConfirmOpen(true)
    } else {
      save({ [field]: false }, `${label} switched to PAPER`)
    }
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
    const { field, label } = LIVE_MODE[confirmStrategy]
    if (await save({ [field]: true, confirm: typed }, `${label} LIVE enabled`)) {
      setConfirmOpen(false)
      setConfirmStrategy(null)
      setTyped("")
    }
  }

  if (!data || !form) return null
  const activeBroker = data.broker ?? "FYERS"
  const midpointLive = data.midpoint_live_trading ?? data.live_trading
  const heroZeroLive = data.hero_zero_live_trading
  const scalperLive = data.scalper_live_trading
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

      {/* Broker Selection Card */}
      <Card>
        <CardHeader>
          <CardTitle>Active Broker</CardTitle>
          <CardDescription>Select which broker receives your automated live orders.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant={activeBroker === "FYERS" ? "default" : "outline"}
              className="flex flex-col h-auto py-3 items-start"
              onClick={() => save({ broker: "FYERS" }, "Active broker set to Fyers")}
            >
              <span className="font-semibold text-base">Fyers</span>
              <span className="text-xs font-normal opacity-80">Full tick capture + browser OAuth login</span>
            </Button>
            <Button
              type="button"
              variant={activeBroker === "KOTAK_NEO" ? "default" : "outline"}
              className="flex flex-col h-auto py-3 items-start"
              onClick={() => save({ broker: "KOTAK_NEO" }, "Active broker set to Kotak Neo")}
            >
              <span className="font-semibold text-base">Kotak Neo</span>
              <span className="text-xs font-normal opacity-80">Zero brokerage on F&O (Trade Free Plan)</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Balance Card */}
      <Card>
        <CardHeader>
          <CardTitle>{activeBroker === "KOTAK_NEO" ? "Kotak Neo balance" : "Fyers balance"}</CardTitle>
          <CardDescription>Available equity margin from your active {activeBroker === "KOTAK_NEO" ? "Kotak Neo" : "Fyers"} account.</CardDescription>
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

      {/* Kotak Neo Setup Card (visible when Kotak Neo is selected) */}
      {activeBroker === "KOTAK_NEO" && (
        <Card className="border-sky-500/50">
          <CardHeader>
            <CardTitle>Kotak Neo API Setup</CardTitle>
            <CardDescription>
              Enter credentials from Kotak Neo Portal (More &rarr; Trade API). Free F&O execution.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="kotak-ck">Consumer Key (API Token) {data.kotak_consumer_key_set && <span className="text-emerald-500 text-xs">(Configured)</span>}</Label>
                <Input
                  id="kotak-ck"
                  type="password"
                  placeholder={data.kotak_consumer_key_set ? "••••••••••••••••" : "From Kotak Trade API"}
                  value={kotakForm.consumer_key}
                  onChange={(e) => setKotakForm({ ...kotakForm, consumer_key: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="kotak-mob">Registered Mobile Number</Label>
                <Input
                  id="kotak-mob"
                  placeholder="+919876543210"
                  value={kotakForm.mobile_number}
                  onChange={(e) => setKotakForm({ ...kotakForm, mobile_number: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="kotak-ucc">Client Code (UCC)</Label>
                <Input
                  id="kotak-ucc"
                  placeholder="e.g. ABC123"
                  value={kotakForm.ucc}
                  onChange={(e) => setKotakForm({ ...kotakForm, ucc: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="kotak-mpin">6-Digit MPIN {data.kotak_mpin_set && <span className="text-emerald-500 text-xs">(Configured)</span>}</Label>
                <Input
                  id="kotak-mpin"
                  type="password"
                  maxLength={6}
                  placeholder={data.kotak_mpin_set ? "••••••" : "Your mobile app PIN"}
                  value={kotakForm.mpin}
                  onChange={(e) => setKotakForm({ ...kotakForm, mpin: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="kotak-totp-sec">TOTP Secret Key (Optional - Auto Login) {data.kotak_totp_secret_set && <span className="text-emerald-500 text-xs">(Configured)</span>}</Label>
                <Input
                  id="kotak-totp-sec"
                  type="password"
                  placeholder="Base32 key from TOTP QR code"
                  value={kotakForm.totp_secret}
                  onChange={(e) => setKotakForm({ ...kotakForm, totp_secret: e.target.value })}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button onClick={saveKotakCredentials}>
                <Save /> Save Credentials
              </Button>
            </div>

            <div className="border-t pt-4">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="w-full sm:w-auto">
                  <div className="font-medium text-sm">Authenticate Session</div>
                  <p className="text-xs text-muted-foreground">Log in with MPIN and TOTP for today's trading session.</p>
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  {!data.kotak_totp_secret_set && (
                    <Input
                      placeholder="6-digit TOTP"
                      maxLength={6}
                      className="w-32"
                      value={kotakTotp}
                      onChange={(e) => setKotakTotp(e.target.value)}
                    />
                  )}
                  <Button onClick={loginKotak} disabled={kotakLoggingIn}>
                    {kotakLoggingIn ? "Logging in…" : "Log in to Kotak Neo"}
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className={midpointLive || heroZeroLive || scalperLive ? "border-red-600/60" : undefined}>
        <CardHeader>
          <CardTitle>Strategy modes</CardTitle>
          <CardDescription>Always visible. LIVE submits real orders to active broker.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <div className={scalperLive ? "font-semibold text-red-500" : "font-semibold text-sky-500"}>Micro Scalper · {scalperLive ? "LIVE" : "PAPER"}</div>
              <p className="text-xs text-muted-foreground">{data.scalper_lots ?? 1} lot · {Number(data.scalper_max_trades) >= 999 ? "Unlimited" : (data.scalper_max_trades ?? 1)} trade{(data.scalper_max_trades ?? 1) === 1 ? "" : "s"}/day</p>
            </div>
            <Switch
              checked={scalperLive}
              onCheckedChange={(enabled) => setLiveMode("scalper", enabled)}
              aria-label="Micro Scalper live trading"
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <div className={midpointLive ? "font-semibold text-red-500" : "font-semibold text-sky-500"}>Midpoint · {midpointLive ? "LIVE" : "PAPER"}</div>
              <p className="text-xs text-muted-foreground">{data.lots} lot{data.lots === 1 ? "" : "s"} per LIVE signal</p>
            </div>
            <Switch
              checked={midpointLive}
              onCheckedChange={(enabled) => setLiveMode("midpoint", enabled)}
              aria-label="Midpoint live trading"
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <div className={heroZeroLive ? "font-semibold text-red-500" : "font-semibold text-sky-500"}>HeroZero · {heroZeroLive ? "LIVE" : "PAPER"}</div>
              <p className="text-xs text-muted-foreground">1 PE + 1 CE maximum · {data.hero_zero_lots} lot{data.hero_zero_lots === 1 ? "" : "s"} each</p>
            </div>
            <Switch
              checked={heroZeroLive}
              onCheckedChange={(enabled) => setLiveMode("hero_zero", enabled)}
              aria-label="HeroZero live trading"
            />
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="scalper">Micro Scalper</TabsTrigger>
          <TabsTrigger value="midpoint">Midpoint</TabsTrigger>
          <TabsTrigger value="hero_zero">HeroZero</TabsTrigger>
        </TabsList>

        <TabsContent value="scalper" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Micro-Compression Scalper settings</CardTitle>
              <CardDescription>
                1-minute coiling breakout after 5-minute trend &amp; VWAP confirmation. Zero brokerage with Kotak Neo Trade API.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-muted-foreground">
                <span className="font-semibold text-emerald-500">Sniper Mode (1 trade/day):</span> Slashes max drawdown to only <span className="font-medium text-foreground">-₹1,265</span> (-96 pts) while winning 9 out of 10 months (+689.4 pts net). Planned RR is 1 : 2.78.
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="scalper-lots">Lots per trade (65 qty / lot · ~₹5k–8k margin)</Label>
                  <Input id="scalper-lots" type="number" min={1} max={5} step={1} value={form.scalper_lots} onChange={(event) => setForm({ ...form, scalper_lots: event.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="scalper-sl">Stop Loss (Nifty spot points)</Label>
                  <Input id="scalper-sl" type="number" min={3} max={30} step={0.5} value={form.scalper_sl_pts} onChange={(event) => setForm({ ...form, scalper_sl_pts: event.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="scalper-tgt">Profit Target (Nifty spot points)</Label>
                  <Input id="scalper-tgt" type="number" min={10} max={60} step={0.5} value={form.scalper_target_pts} onChange={(event) => setForm({ ...form, scalper_target_pts: event.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="scalper-max-tr">Max trades per day (1 = Sniper Mode, 999 = Unlimited)</Label>
                  <Input id="scalper-max-tr" type="number" min={1} max={999} step={1} value={form.scalper_max_trades} onChange={(event) => setForm({ ...form, scalper_max_trades: event.target.value })} />
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Trades active liquid windows (09:20–11:30 &amp; 13:15–15:05 IST). Automatic 10-minute time exit closes stalling trades to conserve capital.
              </p>
            </CardContent>
            <CardFooter className="justify-end">
              <Button onClick={saveScalper}><Save /> Save Micro Scalper</Button>
            </CardFooter>
          </Card>
        </TabsContent>

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
              <CardDescription>One PE and one CE per expiry session, closest to spot.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="hero-zero-lots">Lots per leg</Label>
                  <Input id="hero-zero-lots" type="number" min={1} max={2} step={1} value={form.hero_zero_lots} onChange={(event) => setForm({ ...form, hero_zero_lots: event.target.value })} />
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Estimated PE + CE entry reserve is about ₹{(1700 * Number(form.hero_zero_lots || 1)).toLocaleString("en-IN")}. LIVE orders check actual quotes and require the Midpoint LIVE balance threshold.
              </p>
            </CardContent>
            <CardFooter className="justify-end">
              <Button onClick={saveHeroZero}><Save /> Save HeroZero</Button>
            </CardFooter>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={confirmOpen} onOpenChange={(open) => { setConfirmOpen(open); if (!open) { setConfirmStrategy(null); setTyped("") } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable {confirmStrategy === "hero_zero" ? "HeroZero" : confirmStrategy === "scalper" ? "Micro Scalper" : "Midpoint"} LIVE?</DialogTitle>
            <DialogDescription>
              {confirmStrategy === "hero_zero"
                ? `HeroZero will place one live order for the selected PE and CE (${data.hero_zero_lots} lot${data.hero_zero_lots === 1 ? "" : "s"} each), then attempt the expiry exit. Type LIVE to confirm.`
                : confirmStrategy === "scalper"
                ? `Micro Scalper will place live ATM option orders (${data.scalper_lots ?? 1} lot, ${data.scalper_max_trades ?? 1} max trade/day) via active broker (${activeBroker}) on 1-min coiling breakouts. Type LIVE to confirm.`
                : `Midpoint will place real orders at ${data.lots} lot${data.lots === 1 ? "" : "s"} per signal after the funds check. Type LIVE to confirm.`}
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
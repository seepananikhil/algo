import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { AlertTriangle, Banknote, Save, Sliders, ArrowRight, ShieldAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { getJSON, postJSON, usePoll, type FundsStatus, type Settings } from "@/lib/api"
import { useStatus } from "@/lib/status"

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
  const [kotakForm, setKotakForm] = useState<KotakForm>({
    consumer_key: "",
    mobile_number: "",
    ucc: "",
    mpin: "",
    totp_secret: "",
  })
  const [kotakTotp, setKotakTotp] = useState("")
  const [kotakLoggingIn, setKotakLoggingIn] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const [restart, setRestart] = useState(false)
  const [funds, setFunds] = useState<FundsStatus | null>(null)
  const [fundsLoading, setFundsLoading] = useState(false)

  useEffect(() => {
    if (data) {
      setKotakForm({
        consumer_key: "",
        mobile_number: data.kotak_mobile_number ?? "",
        ucc: data.kotak_ucc ?? "",
        mpin: "",
        totp_secret: "",
      })
    }
  }, [data])

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

  function toggleLiveMode(enabled: boolean) {
    if (enabled) {
      setConfirmOpen(true)
    } else {
      save({ trend_runner_live_trading: false, midpoint_live_trading: false }, "Switched to PAPER trading")
    }
  }

  async function confirmLive() {
    if (typed !== "LIVE") return
    if (await save({ trend_runner_live_trading: true, midpoint_live_trading: true, confirm: typed }, "LIVE trading enabled!")) {
      setConfirmOpen(false)
      setTyped("")
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

  if (!data) return null
  const activeBroker = "KOTAK_NEO"
  const isLiveTrading = Boolean(data.trend_runner_live_trading || data.midpoint_live_trading || data.live_trading)

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 md:p-8 pt-6">
      {/* Top Title Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">System Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Broker connectivity, capital limits, risk parameters, and live trading safeguards.
          </p>
        </div>
        <Link to="/config">
          <Button variant="outline" size="sm" className="gap-2">
            <Sliders className="size-3.5 text-sky-400" />
            Configure Strategy Setups &rarr;
          </Button>
        </Link>
      </div>

      {restart && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Restart Required</AlertTitle>
          <AlertDescription>Strategy and risk changes will apply after restarting the live daemon.</AlertDescription>
        </Alert>
      )}

      {/* Broker Card (Kotak Neo Only) */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Active Broker</CardTitle>
              <CardDescription>Execution engine is connected exclusively to Kotak Neo.</CardDescription>
            </div>
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 bg-emerald-500/10 font-mono">
              Kotak Neo
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between p-3.5 rounded-xl border border-border/60 bg-muted/20">
            <div className="flex flex-col">
              <span className="font-semibold text-base text-foreground">Kotak Neo (Zero Brokerage)</span>
              <span className="text-xs text-muted-foreground">Trade Free Youth / Trade Free Plan · Direct high-speed API execution</span>
            </div>
            <Badge className="bg-emerald-600 text-white font-medium text-xs">Active</Badge>
          </div>
        </CardContent>
      </Card>

      {/* Balance Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Kotak Neo Balance</CardTitle>
          <CardDescription>Available equity margin from your Kotak Neo account.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {funds?.ok ? (
              <div className="text-xl font-bold tabular-nums text-emerald-400">
                ₹{funds.available_equity_funds.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
              </div>
            ) : funds ? (
              <p className="max-w-md text-sm text-red-500">{funds.error}</p>
            ) : (
              <p className="text-sm text-muted-foreground">Click below to check current broker balance</p>
            )}
          </div>
          <Button variant="outline" onClick={checkFunds} disabled={fundsLoading} className="gap-2">
            <Banknote className="size-4" /> {fundsLoading ? "Checking…" : "Check Balance"}
          </Button>
        </CardContent>
      </Card>

      {/* Kotak Neo Setup Card (visible when Kotak Neo is selected) */}
      {activeBroker === "KOTAK_NEO" && (
        <Card className="border-sky-500/50">
          <CardHeader>
            <CardTitle className="text-lg">Kotak Neo API Credentials</CardTitle>
            <CardDescription>
              Enter credentials from Kotak Neo Portal (More &rarr; Trade API). Free F&O execution.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="kotak-ck">Consumer Key {data.kotak_consumer_key_set && <span className="text-emerald-500 text-xs">(Configured)</span>}</Label>
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
              <div className="grid gap-1.5 sm:col-span-2">
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
              <Button onClick={saveKotakCredentials} size="sm">
                <Save className="size-3.5 mr-1.5" /> Save Credentials
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
                      className="w-32 h-9 text-sm"
                      value={kotakTotp}
                      onChange={(e) => setKotakTotp(e.target.value)}
                    />
                  )}
                  <Button onClick={loginKotak} disabled={kotakLoggingIn} size="sm">
                    {kotakLoggingIn ? "Logging in…" : "Log in to Kotak Neo"}
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Trading Mode & Live Switch Card */}
      <Card className={isLiveTrading ? "border-red-600/70 bg-red-950/10" : undefined}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Execution Mode</CardTitle>
              <CardDescription>
                Toggle between simulated Paper trading and Real Live order placement.
              </CardDescription>
            </div>
            <Badge variant={isLiveTrading ? "destructive" : "secondary"}>
              {isLiveTrading ? "🔥 LIVE TRADING" : "🛡️ PAPER SIMULATION"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4 rounded-lg border p-4 bg-card">
            <div className="space-y-0.5">
              <div className={isLiveTrading ? "font-bold text-red-500 text-base" : "font-semibold text-foreground text-base"}>
                Apex Duo · {isLiveTrading ? "LIVE (Real Money)" : "PAPER (Simulated)"}
              </div>
              <p className="text-xs text-muted-foreground">
                Routes automated signals directly to your active Kotak Neo broker account.
              </p>
            </div>
            <Switch
              checked={isLiveTrading}
              onCheckedChange={toggleLiveMode}
              aria-label="Apex Duo live trading switch"
            />
          </div>
        </CardContent>
      </Card>

      {/* Strategy, Lot Sizing & Capital Guardian Link Card */}
      <Card className="border-sky-500/30 bg-sky-500/5">
        <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="font-semibold text-base text-foreground flex items-center gap-2">
              <Sliders className="size-4 text-sky-400" />
              Strategy Setups, Lot Sizing &amp; Capital Guardian
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Configure Nifty lot sizing (65 shares/lot), Daily Loss Limits (₹2,500), and Spot Ratchet profit locking milestones on the Strategy Config page.
            </p>
          </div>
          <Link to="/config">
            <Button className="gap-2 bg-sky-500 hover:bg-sky-600 text-white font-medium shrink-0">
              Open Strategy Config <ArrowRight className="size-4" />
            </Button>
          </Link>
        </CardContent>
      </Card>

      {/* Confirmation Dialog for LIVE Trading */}
      <Dialog open={confirmOpen} onOpenChange={(open) => { setConfirmOpen(open); if (!open) setTyped("") }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-red-500 flex items-center gap-2">
              <ShieldAlert className="size-5" />
              Enable LIVE Trading with Real Capital?
            </DialogTitle>
            <DialogDescription>
              This will route all incoming automated strategy signals directly to your active Kotak Neo account with real capital.
              Type <strong>LIVE</strong> below to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type LIVE to confirm"
            className="font-mono tracking-wider text-center font-bold"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={typed !== "LIVE"} onClick={confirmLive}>
              Enable LIVE Trading
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

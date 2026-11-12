import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { ConfigPage } from "./config"
import { toast } from "sonner"
import {
  AlertTriangle,
  Save,
  Sliders,
  ArrowRight,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Eye,
  EyeOff,
  Zap,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
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
  const [searchParams, setSearchParams] = useSearchParams()
  const currentTab = searchParams.get("tab") === "strategy" ? "strategy" : "broker"
  const handleTabChange = (t: "broker" | "strategy") => {
    setSearchParams({ tab: t })
  }
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
  const [showSecrets, setShowSecrets] = useState(false)
  const [kotakLoggingIn, setKotakLoggingIn] = useState(false)
  const [savingAndLoggingIn, setSavingAndLoggingIn] = useState(false)
  const [restart, setRestart] = useState(false)
  const [funds, setFunds] = useState<FundsStatus | null>(null)
  const [fundsLoading, setFundsLoading] = useState(false)
  const [resettingGuardian, setResettingGuardian] = useState(false)

  async function handleResetGuardian() {
    if (!window.confirm("Reset Risk Guardian circuit breaker and resume trading for today?")) return
    setResettingGuardian(true)
    try {
      const res = await postJSON<{ ok: boolean; message?: string }>("/api/risk-guardian/reset", {})
      if (res.ok) {
        toast.success(res.message || "Risk Guardian lock reset! Trading resumed.")
        await Promise.all([reload(), status.reload()])
      } else {
        toast.error("Failed to reset Risk Guardian lock")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setResettingGuardian(false)
    }
  }

  useEffect(() => {
    if (data) {
      setKotakForm((prev) => ({
        consumer_key: prev.consumer_key || data.kotak_consumer_key || "",
        mobile_number: prev.mobile_number || data.kotak_mobile_number || "",
        ucc: prev.ucc || data.kotak_ucc || "",
        mpin: prev.mpin || "",
        totp_secret: prev.totp_secret || "",
      }))
      if (data.kotak_session_valid) {
        checkFunds()
      }
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

    save(payload, "Kotak Neo credentials saved to neo_config.json")
  }

  async function saveAndLogin() {
    setSavingAndLoggingIn(true)
    try {
      const payload: Record<string, string> = {}
      if (kotakForm.consumer_key) payload.consumer_key = kotakForm.consumer_key
      if (kotakForm.mobile_number) payload.mobile_number = kotakForm.mobile_number
      if (kotakForm.ucc) payload.ucc = kotakForm.ucc
      if (kotakForm.mpin) payload.mpin = kotakForm.mpin
      if (kotakForm.totp_secret) payload.totp_secret = kotakForm.totp_secret
      if (kotakTotp) payload.totp = kotakTotp

      const res = await postJSON<{
        ok: boolean
        greeting_name?: string
        ucc?: string
        funds?: number
        error?: string
      }>("/api/kotak/save-and-login", payload)

      if (res.ok) {
        toast.success(
          `Connected as ${res.greeting_name || "User"} (UCC: ${res.ucc || "Y4KQT"})`
        )
        if (typeof res.funds === "number") {
          setFunds({ ok: true, available_equity_funds: res.funds })
        }
        setKotakTotp("")
        await Promise.all([reload(), status.reload(), checkFunds()])
      } else {
        toast.error(res.error || "Kotak Neo login failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingAndLoggingIn(false)
    }
  }

  async function loginKotak() {
    setKotakLoggingIn(true)
    try {
      const res = await postJSON<{
        ok: boolean
        greeting_name?: string
        ucc?: string
        funds?: number
        error?: string
      }>("/api/kotak/login", {
        totp: kotakTotp || undefined,
        mpin: kotakForm.mpin || undefined,
      })
      if (res.ok) {
        toast.success(
          `Kotak Neo authenticated for ${res.greeting_name || "User"} (UCC: ${res.ucc || "Y4KQT"})`
        )
        if (typeof res.funds === "number") {
          setFunds({ ok: true, available_equity_funds: res.funds })
        }
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
  const isValid = Boolean(data.kotak_session_valid)

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4 md:p-8 pt-6">
      {/* Top Title Banner & Tab Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Settings &amp; Configuration</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Manage Kotak Neo broker login, margin balances, and Apex Duo strategy setups in one place.
          </p>
        </div>

        {/* Tab Switcher: Broker vs Strategy */}
        <div className="flex items-center p-1 bg-muted/80 rounded-xl border border-border/60 shrink-0 shadow-2xs">
          <button
            type="button"
            onClick={() => handleTabChange("broker")}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              currentTab === "broker"
                ? "bg-background text-foreground shadow-xs font-bold"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <ShieldCheck className="size-4 text-emerald-400" />
            <span>Broker &amp; Account</span>
          </button>
          <button
            type="button"
            onClick={() => handleTabChange("strategy")}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              currentTab === "strategy"
                ? "bg-background text-foreground shadow-xs font-bold"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Sliders className="size-4 text-sky-400" />
            <span>Strategy Setups</span>
          </button>
        </div>
      </div>

      {currentTab === "strategy" ? (
        <ConfigPage embedded />
      ) : (
        <>
        {restart && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Restart Required</AlertTitle>
          <AlertDescription>Strategy and risk changes will apply after restarting the live daemon.</AlertDescription>
        </Alert>
      )}

      {/* Kotak Neo Live Session Status Banner */}
      <Card className={isValid ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5"}>
        <CardContent className="p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            {isValid ? (
              <CheckCircle2 className="size-6 text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <XCircle className="size-6 text-amber-400 shrink-0 mt-0.5" />
            )}
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-base text-foreground">
                  {isValid ? "Kotak Neo Session: Active & Connected" : "Kotak Neo Session: Offline"}
                </span>
                <Badge
                  variant="outline"
                  className={isValid ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10 text-[11px]" : "border-amber-500/40 text-amber-400 bg-amber-500/10 text-[11px]"}
                >
                  {isValid ? "LIVE TOKEN" : "REQUIRES LOGIN"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isValid
                  ? `Authenticated as ${data.kotak_greeting_name || "NIKHILCHANDRA"} (UCC: ${data.kotak_ucc || "Y4KQT"}) · Session logged in at ${data.kotak_logged_in_at || "Today"}`
                  : (data.kotak_reason || "Daily session expired. Click 'Log In to Kotak Neo' below to authenticate today's trading session.")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
            <Button
              onClick={loginKotak}
              disabled={kotakLoggingIn || savingAndLoggingIn}
              size="sm"
              className={isValid ? "bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5 w-full sm:w-auto" : "bg-amber-600 hover:bg-amber-700 text-white gap-1.5 w-full sm:w-auto"}
            >
              <RefreshCw className={cn("size-3.5", (kotakLoggingIn || savingAndLoggingIn) && "animate-spin")} />
              {kotakLoggingIn ? "Logging in…" : isValid ? "Re-Authenticate" : "Log In to Kotak"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Available Balance Card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Trading Margin Balance</CardTitle>
              <CardDescription>Available equity margin fetched live from your Kotak Neo account.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={checkFunds} disabled={fundsLoading} className="gap-2">
              <RefreshCw className={cn("size-3.5", fundsLoading && "animate-spin")} />
              {fundsLoading ? "Checking…" : "Refresh Margin"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {funds?.ok ? (
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold tabular-nums tracking-tight text-emerald-400">
                ₹{funds.available_equity_funds.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className="text-xs text-muted-foreground font-mono">Available Equity Margin</span>
            </div>
          ) : funds ? (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 p-2.5 rounded-lg font-mono text-xs">
              {funds.error}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Log in to Kotak Neo to view live available funds.</p>
          )}
        </CardContent>
      </Card>

      {/* Kotak Neo Setup Card */}
      <Card className="border-sky-500/40">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <ShieldCheck className="size-5 text-sky-400" />
                Kotak Neo API Credentials
              </CardTitle>
              <CardDescription>
                Credentials saved here are written directly to <code className="text-xs text-sky-400">neo_config.json</code> on your server.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowSecrets(!showSecrets)}
              className="text-xs text-muted-foreground gap-1.5 self-start sm:self-auto"
            >
              {showSecrets ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {showSecrets ? "Hide Secrets" : "Reveal Secrets"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3.5 sm:grid-cols-2">
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="kotak-ck" className="flex items-center justify-between">
                <span>Consumer Key</span>
                {data.kotak_consumer_key_set && (
                  <span className="text-emerald-500 text-xs font-medium">✓ Configured</span>
                )}
              </Label>
              <Input
                id="kotak-ck"
                type={showSecrets ? "text" : "password"}
                placeholder="From Kotak Neo Developer Portal (e.g. 1deb9014-...)"
                value={kotakForm.consumer_key}
                onChange={(e) => setKotakForm({ ...kotakForm, consumer_key: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kotak-mob">Registered Mobile Number</Label>
              <Input
                id="kotak-mob"
                placeholder="+918142036003"
                value={kotakForm.mobile_number}
                onChange={(e) => setKotakForm({ ...kotakForm, mobile_number: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kotak-ucc">Client Code (UCC)</Label>
              <Input
                id="kotak-ucc"
                placeholder="e.g. Y4KQT"
                value={kotakForm.ucc}
                onChange={(e) => setKotakForm({ ...kotakForm, ucc: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kotak-mpin" className="flex items-center justify-between">
                <span>6-Digit MPIN</span>
                {data.kotak_mpin_set && (
                  <span className="text-emerald-500 text-xs font-medium">✓ Configured</span>
                )}
              </Label>
              <Input
                id="kotak-mpin"
                type={showSecrets ? "text" : "password"}
                maxLength={6}
                placeholder={data.kotak_mpin_set ? "•••••• (Configured)" : "Your 6-digit App PIN"}
                value={kotakForm.mpin}
                onChange={(e) => setKotakForm({ ...kotakForm, mpin: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kotak-totp-sec" className="flex items-center justify-between">
                <span>TOTP Secret Key (Auto-Login)</span>
                {data.kotak_totp_secret_set && (
                  <span className="text-emerald-500 text-xs font-medium">✓ Configured</span>
                )}
              </Label>
              <Input
                id="kotak-totp-sec"
                type={showSecrets ? "text" : "password"}
                placeholder={data.kotak_totp_secret_set ? "•••••••••••• (Configured)" : "Base32 Authenticator Secret"}
                value={kotakForm.totp_secret}
                onChange={(e) => setKotakForm({ ...kotakForm, totp_secret: e.target.value })}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground bg-muted/30 p-2.5 rounded-lg border border-border/50">
            💡 <strong>Auto-Authentication:</strong> With MPIN and TOTP Secret configured, AlgoNeo automatically generates your daily session tokens silently at 09:14 IST before the market opens without requiring any manual intervention.
          </p>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2 border-t">
            <div className="flex items-center gap-2">
              {!data.kotak_totp_secret_set && !kotakForm.totp_secret && (
                <Input
                  placeholder="6-digit TOTP code"
                  maxLength={6}
                  className="w-36 h-9 text-sm"
                  value={kotakTotp}
                  onChange={(e) => setKotakTotp(e.target.value)}
                />
              )}
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <Button
                variant="outline"
                onClick={saveKotakCredentials}
                size="sm"
                className="gap-1.5"
              >
                <Save className="size-3.5" /> Save Only
              </Button>
              <Button
                onClick={saveAndLogin}
                disabled={savingAndLoggingIn || kotakLoggingIn}
                size="sm"
                className="bg-sky-500 hover:bg-sky-600 text-white gap-2 font-medium"
              >
                <Zap className={cn("size-3.5", savingAndLoggingIn && "animate-spin")} />
                {savingAndLoggingIn ? "Authenticating…" : "Save & Log In Now"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Capital Guardian & Circuit Breaker Card */}
      <Card className={status.status?.risk_guardian?.is_locked ? "border-rose-500/50 bg-rose-500/5" : "border-emerald-500/30"}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert className={cn("size-5", status.status?.risk_guardian?.is_locked ? "text-rose-500 animate-pulse" : "text-emerald-500")} />
              <CardTitle className="text-lg">Risk Guardian Circuit Breaker</CardTitle>
            </div>
            <Badge
              variant="outline"
              className={status.status?.risk_guardian?.is_locked ? "border-rose-500/40 text-rose-400 bg-rose-500/10 font-bold" : "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"}
            >
              {status.status?.risk_guardian?.is_locked ? "CIRCUIT BREAKER LOCKED" : "ACTIVE MONITORING"}
            </Badge>
          </div>
          <CardDescription>
            Two-tier automated capital defense: Per-trade max loss auto-cut and daily portfolio circuit breaker.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/* Rules Summary Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div className="p-2.5 rounded-lg border border-border/60 bg-muted/20 flex flex-col justify-between">
              <span className="text-muted-foreground text-[11px]">Daily Account Circuit Breaker</span>
              <span className="font-mono font-semibold text-foreground mt-0.5">
                -₹{(status.status?.risk_guardian?.daily_loss_limit || data?.daily_loss_limit || 2000).toLocaleString('en-IN')}
              </span>
              <span className="text-[10px] text-muted-foreground mt-0.5">
                Buffer: ₹{Math.max(0, status.status?.risk_guardian?.remaining_buffer || 0).toLocaleString('en-IN')}
              </span>
            </div>
            <div className="p-2.5 rounded-lg border border-border/60 bg-muted/20 flex flex-col justify-between">
              <span className="text-muted-foreground text-[11px]">Per-Trade Max Loss Auto-Cut</span>
              <span className="font-mono font-semibold text-amber-400 mt-0.5">
                -₹{(status.status?.risk_guardian?.per_trade_loss_limit || 650).toLocaleString('en-IN')}/lot (-{status.status?.risk_guardian?.per_trade_loss_pct || 20}%)
              </span>
              <span className="text-[10px] text-muted-foreground mt-0.5">
                {status.status?.risk_guardian?.per_trade_auto_cut !== false ? "Dynamic: Scales automatically by position lots (~10 pts SL)" : "Alert only"}
              </span>
            </div>
          </div>

          {status.status?.risk_guardian?.is_locked ? (
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-400">
              <div className="text-xs">
                <div className="font-bold">⚠️ Trading Halted: Daily Loss Limit Breached</div>
                <div className="text-[11px] opacity-85 mt-0.5">{status.status?.risk_guardian?.lock_info?.reason || "Max daily loss limit reached. Positions squared off."}</div>
              </div>
              <Button
                onClick={handleResetGuardian}
                disabled={resettingGuardian}
                size="sm"
                className="bg-rose-600 hover:bg-rose-700 text-white font-bold shrink-0 gap-1.5"
              >
                <RefreshCw className={cn("size-3.5", resettingGuardian && "animate-spin")} />
                {resettingGuardian ? "Resetting…" : "Reset Guardian Lock"}
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between p-3 rounded-lg border border-border/60 bg-muted/20 text-xs">
              <div>
                <span className="font-semibold text-foreground">Current Status: Safe</span>
                <span className="text-muted-foreground block text-[11px] mt-0.5">
                  Remaining loss buffer: ₹{Math.max(0, status.status?.risk_guardian?.remaining_buffer || 0).toLocaleString('en-IN')}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="text-xs cursor-pointer"
                onClick={() => handleTabChange("strategy")}
              >
                Change Limit in Strategy &rarr;
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Strategy Setups Link Card */}
      <Card className="border-sky-500/30 bg-sky-500/5">
        <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="font-semibold text-base text-foreground flex items-center gap-2">
              <Sliders className="size-4 text-sky-400" />
              Apex Duo Strategy Setups, Lot Sizing &amp; Spot Ratchet
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Configure Nifty lot sizing, Daily Loss Limits (₹2,500), and Spot Ratchet profit locking milestones in Strategy Setups.
            </p>
          </div>
          <Button
            onClick={() => handleTabChange("strategy")}
            className="gap-2 bg-sky-500 hover:bg-sky-600 text-white font-medium shrink-0 cursor-pointer"
          >
            Open Strategy Setups <ArrowRight className="size-4" />
          </Button>
        </CardContent>
      </Card>
        </>
      )}
    </div>
  )
}

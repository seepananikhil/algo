import { useEffect, useState } from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
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
  TrendingUp,
  Sparkles,
  Lock,
  Bell,
  Send,
  Users,
  Plus,
  Trash2,
  Wallet,
  UserCheck,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
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

type TabType = "broker" | "strategy" | "swinger"

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get("tab")
  const currentTab: TabType = rawTab === "strategy" ? "strategy" : rawTab === "swinger" ? "swinger" : "broker"
  const handleTabChange = (t: TabType) => {
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
  const [telegramConfig, setTelegramConfig] = useState<{
    ok: boolean
    enabled: boolean
    auto_enable_deployed: boolean
    is_deployed: boolean
    is_active: boolean
    bot_token_set: boolean
    chat_id: string
  } | null>(null)
  const [telegramTesting, setTelegramTesting] = useState(false)
  const [telegramSaving, setTelegramSaving] = useState(false)

  const loadTelegramConfig = async () => {
    try {
      const res = await getJSON<any>("/api/telegram/config")
      if (res) setTelegramConfig(res)
    } catch {}
  }

  useEffect(() => {
    loadTelegramConfig()
  }, [])

  const handleToggleTelegram = async (newVal: boolean) => {
    setTelegramSaving(true)
    try {
      const res = await postJSON<any>("/api/telegram/config", { enabled: newVal })
      if (res?.ok) {
        setTelegramConfig((prev) => (prev ? { ...prev, enabled: res.enabled, is_active: res.is_active } : null))
        toast.success(newVal ? "Telegram alerts enabled" : "Telegram alerts turned off (silenced)")
      }
    } catch (e: any) {
      toast.error(e?.message || "Failed to update Telegram setting")
    } finally {
      setTelegramSaving(false)
    }
  }

  const handleToggleAutoDeploy = async (newVal: boolean) => {
    setTelegramSaving(true)
    try {
      const res = await postJSON<any>("/api/telegram/config", { auto_enable_deployed: newVal })
      if (res?.ok) {
        setTelegramConfig((prev) => (prev ? { ...prev, auto_enable_deployed: res.auto_enable_deployed, is_active: res.is_active } : null))
        toast.success(newVal ? "Auto-enable on deployed version active" : "Auto-enable on deploy disabled")
      }
    } catch (e: any) {
      toast.error(e?.message || "Failed to update setting")
    } finally {
      setTelegramSaving(false)
    }
  }

  const handleSendTestAlert = async () => {
    setTelegramTesting(true)
    try {
      const res = await postJSON<any>("/api/telegram/config", { action: "test" })
      if (res?.ok) {
        toast.success(res.message || "Test alert sent to Telegram!")
      } else {
        toast.error(res?.message || "Failed to send test alert")
      }
    } catch (e: any) {
      toast.error(e?.message || "Failed to dispatch test alert")
    } finally {
      setTelegramTesting(false)
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
    <div className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col gap-5 pb-20">
      {/* Top Title Banner & Tab Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Settings &amp; Configuration</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Manage Kotak Neo broker login, margin balances, and Apex Duo strategy setups in one place.
          </p>
        </div>

        {/* Tab Switcher: Broker vs Strategy vs Swinger */}
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
            <span>Sensex &amp; Nifty</span>
          </button>
          <button
            type="button"
            onClick={() => handleTabChange("swinger")}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              currentTab === "swinger"
                ? "bg-background text-foreground shadow-xs font-bold"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <TrendingUp className="size-4 text-amber-500" />
            <span>Swinger &amp; Leg 2</span>
          </button>
        </div>
      </div>

      {currentTab === "strategy" ? (
        <ConfigPage embedded />
      ) : currentTab === "swinger" ? (
        <SwingerSettingsSection />
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

      {/* Multi-Account & Client Manager (SQLite Engine + Automated TOTP 2FA) */}
      <AccountsManagerSection />

      {/* Main 2-Column Responsive Grid on Desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {/* Left Column: Kotak Neo API Credentials */}
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

        {/* Right Column: Margin Balance & Capital Guardian */}
        <div className="flex flex-col gap-5">
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
                    <div className="text-[11px] opacity-85 mt-0.5">{status.status?.risk_guardian?.lock_info?.reason || "Max daily loss limit reached. All trades squared off."}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="destructive"
                      size="sm"
                      className="text-xs font-bold cursor-pointer bg-rose-600 hover:bg-rose-700 text-white shadow-xs"
                      onClick={async () => {
                        if (confirm("Reset Risk Guardian? This will unlock trading and anchor your current P&L as the baseline with a fresh buffer.")) {
                          try {
                            const res = await postJSON<{ ok: boolean; message: string }>("/api/risk-guardian/reset", {})
                            toast.success(res.message || "Risk Guardian reset successfully!")
                            status.reload()
                          } catch (err: any) {
                            toast.error(err?.message || "Failed to reset Risk Guardian")
                          }
                        }
                      }}
                    >
                      Reset & Unlock
                    </Button>
                  </div>
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

          {/* Telegram Trade Alerts Card */}
          <Card className={telegramConfig?.is_active ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/60"}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bell className={cn("size-5", telegramConfig?.is_active ? "text-emerald-400" : "text-muted-foreground")} />
                  <CardTitle className="text-lg">Telegram Trade Alerts</CardTitle>
                </div>
                <Badge
                  variant="outline"
                  className={
                    telegramConfig?.is_active
                      ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10 font-bold"
                      : telegramConfig?.is_deployed
                      ? "border-sky-500/40 text-sky-400 bg-sky-500/10 font-medium"
                      : "border-border/60 text-muted-foreground bg-muted/30 font-medium"
                  }
                >
                  {telegramConfig?.is_active
                    ? "ACTIVE & BROADCASTING"
                    : telegramConfig?.is_deployed
                    ? "DEPLOYED (OFF)"
                    : "LOCAL (SILENCED / OFF)"}
                </Badge>
              </div>
              <CardDescription>
                Real-time alerts for entries, dynamic SL ratchets, pyramiding, and trade exits with realized P&L.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3.5">
              <div className="flex items-center justify-between p-3 rounded-lg border border-border/60 bg-muted/20">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold text-foreground">Telegram Alerts</span>
                  <span className="text-xs text-muted-foreground">
                    {telegramConfig?.enabled
                      ? "Notifications will be dispatched for all live trade events."
                      : "Notifications are silenced on this local machine to avoid spam during development."}
                  </span>
                </div>
                <Switch
                  checked={Boolean(telegramConfig?.enabled)}
                  onCheckedChange={handleToggleTelegram}
                  disabled={telegramSaving}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border/60 bg-muted/20">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold text-foreground">Auto-Enable in Deployed Environment</span>
                  <span className="text-xs text-muted-foreground">
                    Automatically activate Telegram notifications when deployed on cloud or production (<code className="text-[11px] font-mono text-primary">DEPLOYED=1</code>).
                  </span>
                </div>
                <Switch
                  checked={Boolean(telegramConfig?.auto_enable_deployed)}
                  onCheckedChange={handleToggleAutoDeploy}
                  disabled={telegramSaving}
                />
              </div>

              <div className="flex items-center justify-between p-2.5 px-3 rounded-lg border border-border/40 bg-card/60 text-xs">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-muted-foreground">
                    Chat ID: <span className="text-foreground font-semibold">{telegramConfig?.chat_id || "Not Set"}</span>
                  </span>
                  <span className="font-mono text-muted-foreground">
                    Bot: <span className={telegramConfig?.bot_token_set ? "text-emerald-400 font-semibold" : "text-amber-400 font-semibold"}>{telegramConfig?.bot_token_set ? "✓ Connected" : "Missing Token"}</span>
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSendTestAlert}
                  disabled={telegramTesting || !telegramConfig?.bot_token_set}
                  className="text-xs gap-1.5 cursor-pointer"
                >
                  <Send className={cn("size-3.5", telegramTesting && "animate-pulse")} />
                  {telegramTesting ? "Sending…" : "Send Test Alert"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

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

interface ClientAccount {
  id: number
  account_name: string
  is_primary: number
  consumer_key: string
  mobile_number: string
  ucc: string
  totp_set: boolean
  mpin_set: boolean
  telegram_chat_id: string
  lot_multiplier: number
  max_daily_loss: number
  is_active: number
  session_valid: number
  session_auth_time: string | null
  available_funds: number | null
}

function AccountsManagerSection() {
  const navigate = useNavigate()
  const { data: accountsData, reload } = usePoll<{ ok: boolean; accounts: ClientAccount[] }>("/api/accounts", 6000)
  const [authenticatingId, setAuthenticatingId] = useState<number | null>(null)
  const [authAllLoading, setAuthAllLoading] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const accounts = accountsData?.accounts || []

  const handleAuth = async (acc: ClientAccount) => {
    setAuthenticatingId(acc.id)
    try {
      const res = await postJSON<{
        ok: boolean
        error?: string
        available_funds?: number
        ucc?: string
        account_name?: string
      }>(`/api/accounts/${acc.id}/auth`, {})
      if (res.ok) {
        toast.success(`Authenticated ${acc.account_name}! Margin: ₹${(res.available_funds ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}. Telegram alert sent.`)
        reload()
      } else {
        toast.error(`Auth failed for ${acc.account_name}: ${res.error || "Unknown error"}`)
      }
    } catch (e: any) {
      toast.error(`Error authenticating: ${e.message || e}`)
    } finally {
      setAuthenticatingId(null)
    }
  }

  const handleAuthAll = async () => {
    setAuthAllLoading(true)
    try {
      const res = await postJSON<{ ok: boolean; results?: any[] }>("/api/accounts/auth-all", {})
      if (res.ok) {
        const successes = res.results?.filter(r => r.ok).length || 0
        const fails = (res.results?.length || 0) - successes
        toast.success(`Morning Auth Done: ${successes} successful, ${fails} failed. Telegram alerts dispatched.`)
        reload()
      } else {
        toast.error("Failed to run morning authentication.")
      }
    } catch (e: any) {
      toast.error(`Error: ${e.message || e}`)
    } finally {
      setAuthAllLoading(false)
    }
  }

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`Are you sure you want to remove account "${name}"?`)) return
    setDeletingId(id)
    try {
      const res = await postJSON<{ ok: boolean; error?: string }>(`/api/accounts/${id}/delete`, {})
      if (res.ok) {
        toast.success(`Account "${name}" removed.`)
        reload()
      } else {
        toast.error(res.error || "Failed to remove account")
      }
    } catch (e: any) {
      toast.error(`Error: ${e.message || e}`)
    } finally {
      setDeletingId(null)
    }
  }

  const totalFunds = accounts.reduce((acc, a) => acc + (a.available_funds || 0), 0)

  return (
    <Card className="border-indigo-500/40 bg-gradient-to-br from-indigo-950/20 via-card to-background">
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Users className="size-5 text-indigo-400" />
              <CardTitle className="text-lg">Multi-Account &amp; Customer Portfolios</CardTitle>
              <Badge variant="outline" className="text-[10px] border-indigo-500/40 text-indigo-300">
                SQLite Engine
              </Badge>
            </div>
            <CardDescription className="mt-1">
              Connect customer accounts with Option B automated TOTP 2FA. Morning auth inspects live broker margin and sends 1-on-1 private Telegram DM alerts.
            </CardDescription>
            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
              <a
                href="https://t.me/NikhilAlgoAlertSBot"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/30 text-xs font-medium transition-colors"
              >
                <Send className="size-3" />
                <span>Client Onboarding Bot: <strong>@NikhilAlgoAlertSBot</strong></span>
              </a>
              <span className="text-[11px] text-muted-foreground">
                Zero static IP exposure · Clients onboard directly in Telegram DM via /onboard
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAuthAll}
              disabled={authAllLoading || accounts.length === 0}
              className="border-indigo-500/50 hover:bg-indigo-950/40 text-indigo-200 text-xs gap-1.5 cursor-pointer"
            >
              <Zap className={cn("size-3.5 text-amber-400", authAllLoading && "animate-spin")} />
              {authAllLoading ? "Authenticating All..." : "Auth All Accounts"}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => navigate("/onboard")}
              className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs gap-1.5 cursor-pointer"
            >
              <Plus className="size-3.5" />
              Onboard Client
            </Button>
          </div>
        </div>

        {/* Aggregate Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-3 border-t border-border/40 text-xs">
          <div className="p-2.5 rounded-lg bg-card/60 border border-border/50">
            <span className="text-muted-foreground block text-[11px]">Total Accounts</span>
            <span className="font-semibold text-foreground text-sm">{accounts.length} ({accounts.filter(a => a.is_active).length} Active)</span>
          </div>
          <div className="p-2.5 rounded-lg bg-card/60 border border-border/50">
            <span className="text-muted-foreground block text-[11px]">Primary Master</span>
            <span className="font-semibold text-amber-400 text-sm truncate block">
              {accounts.find(a => a.is_primary)?.account_name || "Nikhil (Primary)"}
            </span>
          </div>
          <div className="p-2.5 rounded-lg bg-card/60 border border-border/50">
            <span className="text-muted-foreground block text-[11px]">Total Live Margin</span>
            <span className="font-semibold text-emerald-400 text-sm">
              ₹{totalFunds > 0 ? totalFunds.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00"}
            </span>
          </div>
          <div className="p-2.5 rounded-lg bg-card/60 border border-border/50">
            <span className="text-muted-foreground block text-[11px]">2FA TOTP Mode</span>
            <span className="font-semibold text-sky-400 text-sm">Option B (Auto-Seed)</span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {accounts.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm">
            <p>No trading accounts configured in database yet.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/onboard")}
              className="mt-3 gap-1.5"
            >
              <Plus className="size-3.5" /> Onboard First Client
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            {accounts.map((acc) => (
              <div
                key={acc.id}
                className={cn(
                  "p-3.5 rounded-xl border transition-all flex flex-col md:flex-row md:items-center justify-between gap-3",
                  acc.is_primary
                    ? "bg-amber-500/5 border-amber-500/30"
                    : "bg-card/40 border-border/60 hover:border-indigo-500/30"
                )}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    className={cn(
                      "size-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5",
                      acc.is_primary ? "bg-amber-500/20 text-amber-400" : "bg-indigo-500/20 text-indigo-400"
                    )}
                  >
                    {acc.is_primary ? <ShieldCheck className="size-5" /> : <UserCheck className="size-5" />}
                  </div>
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-foreground">{acc.account_name}</span>
                      {acc.is_primary ? (
                        <Badge variant="outline" className="border-amber-500/50 text-amber-400 bg-amber-500/10 text-[10px]">
                          Primary Master
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-indigo-500/40 text-indigo-400 bg-indigo-500/10 text-[10px]">
                          Client #{acc.id}
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[10px] font-mono">
                        UCC: {acc.ucc || "N/A"}
                      </Badge>
                      {acc.session_valid ? (
                        <Badge className="bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-[10px]">
                          ● Token Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-amber-400 border-amber-500/40 text-[10px]">
                          ○ Auth Needed
                        </Badge>
                      )}
                    </div>

                    <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                      <span className="flex items-center gap-1 font-mono">
                        <Wallet className="size-3 text-emerald-400" />
                        Margin:{" "}
                        <strong className="text-emerald-400">
                          {acc.available_funds !== null && acc.available_funds !== undefined
                            ? `₹${acc.available_funds.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                            : "Not checked"}
                        </strong>
                      </span>
                      <span>•</span>
                      <span>Multiplier: <strong className="text-foreground">{acc.lot_multiplier}x</strong></span>
                      <span>•</span>
                      <span>Max Loss: <strong className="text-foreground">₹{acc.max_daily_loss.toLocaleString("en-IN")}</strong></span>
                      {acc.telegram_chat_id && (
                        <>
                          <span>•</span>
                          <span className="text-sky-400 font-mono text-[11px] truncate max-w-[140px]">
                            TG: {acc.telegram_chat_id}
                          </span>
                        </>
                      )}
                      {acc.session_auth_time && (
                        <>
                          <span>•</span>
                          <span className="text-muted-foreground text-[10px]">
                            Auth: {acc.session_auth_time.split("T")[1]?.split(".")[0] || acc.session_auth_time}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={authenticatingId === acc.id}
                    onClick={() => handleAuth(acc)}
                    className="border-emerald-500/40 hover:bg-emerald-500/10 text-emerald-400 text-xs gap-1.5 h-8 cursor-pointer"
                  >
                    <RefreshCw className={cn("size-3", authenticatingId === acc.id && "animate-spin")} />
                    {authenticatingId === acc.id ? "Authenticating..." : "Auth & Check Margin"}
                  </Button>

                  {!acc.is_primary && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={deletingId === acc.id}
                      onClick={() => handleDelete(acc.id, acc.account_name)}
                      className="text-red-400 hover:text-red-300 hover:bg-red-500/10 text-xs h-8 px-2 cursor-pointer"
                      title="Remove Client"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SwingerSettingsSection() {
  const [cfg, setCfg] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const loadConfig = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/swinger/config")
      const d = await res.json()
      setCfg(d)
    } catch (e: any) {
      toast.error("Failed to load Swinger configuration: " + e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadConfig()
  }, [])

  const handleSave = async () => {
    if (!cfg) return
    setSaving(true)
    try {
      const res = await fetch("/api/swinger/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      })
      const d = await res.json()
      if (d.ok) {
        toast.success("Swinger & Leg 2 settings saved successfully!")
      } else {
        toast.error("Save failed: " + (d.error || "Unknown error"))
      }
    } catch (e: any) {
      toast.error("Save error: " + e.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading || !cfg) {
    return (
      <div className="p-8 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
        <RefreshCw className="size-4 animate-spin text-amber-500" />
        <span>Loading Swinger &amp; Leg 2 settings...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 max-w-6xl pb-12">
      {/* Top Controls Bar */}
      <div className="flex items-center justify-between flex-wrap gap-3 p-4 rounded-2xl bg-card border shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-foreground">Phoenix Swinger Strategy Configuration</h2>
            <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/30 font-bold">
              Paper Mode
            </Badge>
            <Badge variant="outline" className={cfg.leg2_enabled ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/30 font-bold" : "bg-muted text-muted-foreground"}>
              {cfg.leg2_enabled ? "Leg 1 + Leg 2 Active" : "Leg 1 Only"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Backtest-calibrated parameters (4-Year Sim: 40%–60% WR, 1.8–2.3 PF). Strategy rules are pre-locked for maximum profitability.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadConfig}
            disabled={saving}
            className="text-xs gap-1.5 cursor-pointer"
          >
            <RefreshCw className="size-3.5" />
            Reload
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
            className="text-xs gap-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold cursor-pointer shadow-xs"
          >
            <Save className="size-3.5" />
            {saving ? "Saving..." : "Save Settings"}
          </Button>
        </div>
      </div>

      {/* 1. Portfolio & Risk Allocation */}
      <Card className="border-border/60 shadow-xs">
        <CardHeader className="pb-3 border-b">
          <div className="flex items-center gap-2">
            <Sliders className="size-4 text-amber-500" />
            <CardTitle className="text-base font-bold">Portfolio &amp; Capital Allocation</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Manage capital sizing and slot distribution. The strategy automatically caps allocation per stock to protect total capital.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
          <div className="space-y-1.5 p-3 rounded-xl border bg-muted/20">
            <Label className="text-xs font-bold">Total Capital Allocated (₹)</Label>
            <Input
              type="number"
              step="10000"
              value={cfg.capital_allocated ?? 500000.0}
              onChange={(e) => setCfg({ ...cfg, capital_allocated: parseFloat(e.target.value) || 500000.0 })}
              className="h-8 text-xs font-mono font-bold"
            />
            <p className="text-[10px] text-muted-foreground">Total strategy budget</p>
          </div>

          <div className="space-y-1.5 p-3 rounded-xl border bg-muted/20">
            <Label className="text-xs font-bold">Base Slot Size (₹)</Label>
            <Input
              type="number"
              step="5000"
              value={cfg.base_position_size ?? 25000.0}
              onChange={(e) => setCfg({ ...cfg, base_position_size: parseFloat(e.target.value) || 25000.0 })}
              className="h-8 text-xs font-mono font-bold"
            />
            <p className="text-[10px] text-muted-foreground">Capital per trade slot</p>
          </div>

          <div className="space-y-1.5 p-3 rounded-xl border bg-muted/20">
            <Label className="text-xs font-bold">Max Open Positions</Label>
            <Input
              type="number"
              value={cfg.max_open_positions ?? 20}
              onChange={(e) => setCfg({ ...cfg, max_open_positions: parseInt(e.target.value) || 20 })}
              className="h-8 text-xs font-mono font-bold"
            />
            <p className="text-[10px] text-muted-foreground">
              {Math.floor((cfg.capital_allocated || 500000) / (cfg.base_position_size || 25000))} slots mathematically available
            </p>
          </div>

          <div className="space-y-1.5 p-3 rounded-xl border bg-muted/20">
            <Label className="text-xs font-bold">Min Market Cap (₹ Cr)</Label>
            <Input
              type="number"
              step="500"
              value={cfg.min_market_cap_cr ?? 2000.0}
              onChange={(e) => setCfg({ ...cfg, min_market_cap_cr: parseFloat(e.target.value) || 2000.0 })}
              className="h-8 text-xs font-mono font-bold"
            />
            <p className="text-[10px] text-muted-foreground">Filters out microcaps &amp; illiquid stocks</p>
          </div>

          <div className="space-y-1.5 p-3 rounded-xl border bg-muted/20">
            <Label className="text-xs font-bold">Min Stock Price (₹)</Label>
            <Input
              type="number"
              step="5"
              value={cfg.min_stock_price ?? 20.0}
              onChange={(e) => setCfg({ ...cfg, min_stock_price: parseFloat(e.target.value) || 20.0 })}
              className="h-8 text-xs font-mono font-bold"
            />
            <p className="text-[10px] text-muted-foreground">Prevents sub-₹20 penny stocks</p>
          </div>

          <div className="space-y-1.5 p-3 rounded-xl border bg-muted/20">
            <Label className="text-xs font-bold">Max Direct Entry Gain (%)</Label>
            <Input
              type="number"
              step="1"
              value={cfg.max_direct_entry_gain_pct ?? 10.0}
              onChange={(e) => setCfg({ ...cfg, max_direct_entry_gain_pct: parseFloat(e.target.value) || 10.0 })}
              className="h-8 text-xs font-mono font-bold"
            />
            <p className="text-[10px] text-muted-foreground">&gt;10% blasts route to Radar for retracement</p>
          </div>

          <div className="space-y-1.5 p-3 rounded-xl border bg-muted/20">
            <Label className="text-xs font-bold">Blacklisted Symbols</Label>
            <Input
              type="text"
              value={Array.isArray(cfg.blacklist) ? cfg.blacklist.join(", ") : (cfg.blacklist || "")}
              onChange={(e) => setCfg({
                ...cfg,
                blacklist: e.target.value.split(",").map((s: string) => s.trim().toUpperCase()).filter(Boolean)
              })}
              placeholder="e.g. V2RETAIL, YESBANK"
              className="h-8 text-xs font-mono font-bold"
            />
            <p className="text-[10px] text-muted-foreground">Comma-separated excluded tickers</p>
          </div>
        </CardContent>
      </Card>

      {/* 2. Backtest Calibrated Strategy Blueprint (Locked Proven Rules) */}
      <Card className="border-border/60 shadow-xs">
        <CardHeader className="pb-3 border-b">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-emerald-500" />
              <CardTitle className="text-base font-bold">Strategy Blueprint (Backtest Calibrated &amp; Locked)</CardTitle>
            </div>
            <Badge variant="secondary" className="text-[11px] font-mono gap-1 text-emerald-600 bg-emerald-500/10 border-emerald-500/30">
              <Lock className="size-3" />
              Proven 4-Year Sim Rules
            </Badge>
          </div>
          <CardDescription className="text-xs">
            These core parameters were rigorously optimized across the entire NSE universe over 4 years. Daily candle close evaluation prevents intraday wick shakeouts.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          {/* Leg 1 Column */}
          <div className="p-4 rounded-xl border bg-emerald-500/[0.03] border-emerald-500/20 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-foreground">
                <TrendingUp className="size-4 text-emerald-500" />
                <span>Leg 1: Phoenix Turnaround</span>
              </div>
              <Badge className="bg-emerald-600 text-white text-[10px]">Deep Value Reversal</Badge>
            </div>
            
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between p-2 rounded-lg bg-background/80 border">
                <span className="text-muted-foreground font-medium">Setup Filter:</span>
                <span className="font-mono font-bold text-foreground">≥60% Crash from ATH + Below 200 EMA</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg bg-background/80 border">
                <span className="text-muted-foreground font-medium">Entry Trigger:</span>
                <span className="font-mono font-bold text-foreground">Close &gt; 20 EMA (≤10% Direct · &gt;10% Retrace Radar)</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg bg-background/80 border">
                <span className="text-muted-foreground font-medium">Initial Stop Loss:</span>
                <span className="font-mono font-bold text-rose-500 bg-rose-500/10 px-1.5 py-0.5 rounded">
                  {cfg.initial_sl_pct ?? -15.0}% (Daily Close)
                </span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg bg-background/80 border">
                <span className="text-muted-foreground font-medium">Break-Even Shield:</span>
                <span className="font-mono font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
                  +{cfg.be_shield_trigger_pct ?? 15.0}% (Moves SL to Cost + 0.5%)
                </span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg bg-background/80 border">
                <span className="text-muted-foreground font-medium">Runner Trailing Stop:</span>
                <span className="font-mono font-bold text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                  {cfg.runner_trailing_stop_pct ?? 25.0}% from Peak Close
                </span>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Backtest demonstrated 25% trailing stop captures massive multibaggers (e.g. Manyavar, Sanghvimov) while -15% close SL cuts false starts cleanly.
            </p>
          </div>

          {/* Leg 2 Column */}
          <div className="p-4 rounded-xl border bg-amber-500/[0.03] border-amber-500/20 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-foreground">
                <Sparkles className="size-4 text-amber-500" />
                <span>Leg 2: Stage-2 High-Base Breakout</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold">Enable:</span>
                <Switch
                  checked={Boolean(cfg.leg2_enabled)}
                  onCheckedChange={(val) => setCfg({ ...cfg, leg2_enabled: val })}
                />
              </div>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between p-2 rounded-lg bg-background/80 border">
                <span className="text-muted-foreground font-medium">Setup Filter:</span>
                <span className="font-mono font-bold text-foreground">12–150 Days Coiled Base above 20/50 EMA</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg bg-background/80 border">
                <span className="text-muted-foreground font-medium">Entry Trigger:</span>
                <span className="font-mono font-bold text-foreground">Base Breakout + ≥1.4x Volume Surge</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg bg-background/80 border">
                <span className="text-muted-foreground font-medium">Initial Stop Loss:</span>
                <span className="font-mono font-bold text-rose-500 bg-rose-500/10 px-1.5 py-0.5 rounded">
                  {cfg.leg2_initial_sl_pct ?? -8.0}% (Tight Base Risk)
                </span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg bg-background/80 border">
                <span className="text-muted-foreground font-medium">Break-Even Shield:</span>
                <span className="font-mono font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
                  +{cfg.leg2_be_trigger_pct ?? 10.0}% (Quick De-risk)
                </span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg bg-background/80 border">
                <span className="text-muted-foreground font-medium">Runner Trailing Stop:</span>
                <span className="font-mono font-bold text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                  {cfg.leg2_trail_sl_pct ?? 20.0}% from Peak Close
                </span>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Enters stocks that already established a Phoenix bottom and are now coiling in a high-and-tight consolidation (e.g. SPARC at 20 EMA).
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 3. Automated Scanner Queries */}
      <Card className="border-border/60 shadow-xs">
        <CardHeader className="pb-3 border-b">
          <div className="flex items-center gap-2">
            <Zap className="size-4 text-amber-500" />
            <CardTitle className="text-base font-bold">Chartink Scanner Queries (Automated EOD Execution)</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Direct screener clauses sent to Chartink API. Only edit if you wish to adjust technical indicator syntax.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="space-y-1.5 p-3 rounded-xl border bg-muted/10">
            <Label className="text-xs font-bold flex items-center justify-between">
              <span>Unified Turnaround Scanner Clause</span>
              <span className="text-[10px] font-mono text-muted-foreground">Auto-sorts: Direct Buy (≤10%) vs Radar (&gt;10%)</span>
            </Label>
            <textarea
              rows={4}
              value={cfg.scan_clause ?? ""}
              onChange={(e) => setCfg({ ...cfg, scan_clause: e.target.value })}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-[11px] font-mono shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-1.5 p-3 rounded-xl border bg-muted/10">
            <Label className="text-xs font-bold flex items-center justify-between">
              <span>Leg 2 Base Breakout Clause</span>
              <span className="text-[10px] font-mono text-muted-foreground">Stage-2 High Base + 1.4x Vol</span>
            </Label>
            <textarea
              rows={4}
              value={cfg.leg2_clause ?? ""}
              onChange={(e) => setCfg({ ...cfg, leg2_clause: e.target.value })}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-[11px] font-mono shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

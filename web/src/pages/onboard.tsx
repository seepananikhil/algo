import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  HelpCircle,
  Key,
  Phone,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  User,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { postJSON } from "@/lib/api"

export function OnboardingPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [createdAccountId, setCreatedAccountId] = useState<number | null>(null)
  const [authResult, setAuthResult] = useState<{
    ok: boolean
    available_funds?: number
    ucc?: string
    auth_time?: string
    error?: string
  } | null>(null)

  const [form, setForm] = useState({
    account_name: "",
    ucc: "",
    mobile_number: "",
    consumer_key: "",
    mpin: "",
    totp_key: "",
    telegram_chat_id: "",
    lot_multiplier: 1,
    max_daily_loss: 2000,
  })

  const [showTotpGuide, setShowTotpGuide] = useState(false)
  const [showTelegramGuide, setShowTelegramGuide] = useState(false)

  const handleNext = () => {
    if (step === 1) {
      if (!form.account_name.trim()) return toast.error("Please enter a client/account name")
      if (!form.ucc.trim()) return toast.error("Please enter Kotak UCC / Client Code")
      if (!form.mobile_number.trim()) return toast.error("Please enter registered mobile number")
    }
    if (step === 2) {
      if (!form.consumer_key.trim()) return toast.error("Please enter Kotak Neo Consumer Key")
      if (!form.mpin.trim()) return toast.error("Please enter 6-digit Kotak Neo MPIN")
    }
    if (step === 3) {
      if (!form.totp_key.trim()) {
        return toast.error("Please enter 32-character TOTP Secret Key for automated morning login")
      }
    }
    setStep((s) => Math.min(s + 1, 5))
  }

  const handleBack = () => {
    setStep((s) => Math.max(s - 1, 1))
  }

  const handleSaveAndVerify = async () => {
    setLoading(true)
    setAuthResult(null)
    try {
      // 1. Create or update account in SQLite database
      const saveRes = await postJSON<{ ok: boolean; id: number; error?: string }>("/api/accounts", form)
      if (!saveRes.ok || !saveRes.id) {
        throw new Error(saveRes.error || "Failed to save account details")
      }

      const accId = saveRes.id
      setCreatedAccountId(accId)

      // 2. Trigger instant Option B Auth + Live Funds + Telegram Alert
      const authRes = await postJSON<{
        ok: boolean
        available_funds?: number
        ucc?: string
        auth_time?: string
        error?: string
      }>(`/api/accounts/${accId}/auth`, {})

      setAuthResult(authRes)
      if (authRes.ok) {
        toast.success(`Connected successfully! Live margin: ₹${(authRes.available_funds || 0).toLocaleString("en-IN")}`)
        setStep(5)
      } else {
        toast.error(`Authentication failed: ${authRes.error || "Unknown error"}`)
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to onboard account")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
      {/* Back button */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/settings?tab=broker")}
          className="text-xs text-muted-foreground hover:text-foreground gap-1.5 cursor-pointer"
        >
          <ArrowLeft className="size-3.5" />
          <span>Back to Settings</span>
        </Button>
      </div>

      {/* Hero Header */}
      <div className="text-center space-y-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-bold">
          <Sparkles className="size-3.5" />
          <span>Multi-Tenant Client Onboarding</span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-foreground">
          Connect Kotak Neo Account
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground max-w-md mx-auto">
          Setup automated daily TOTP authentication. Your proprietary strategies and code remain 100% private.
        </p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between relative px-2">
        <div className="absolute left-6 right-6 top-1/2 -translate-y-1/2 h-0.5 bg-border/60 -z-0" />
        {[
          { num: 1, label: "Identity" },
          { num: 2, label: "Neo API" },
          { num: 3, label: "TOTP 2FA" },
          { num: 4, label: "Alerts & Risk" },
          { num: 5, label: "Verified" },
        ].map((s) => (
          <div key={s.num} className="flex flex-col items-center gap-1.5 z-10">
            <div
              className={`size-8 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                step === s.num
                  ? "bg-primary text-primary-foreground ring-4 ring-primary/20 shadow-xs"
                  : step > s.num
                  ? "bg-emerald-500 text-white"
                  : "bg-muted text-muted-foreground border border-border"
              }`}
            >
              {step > s.num ? <CheckCircle2 className="size-4" /> : s.num}
            </div>
            <span className={`text-[10px] font-medium hidden sm:inline ${step === s.num ? "text-foreground font-bold" : "text-muted-foreground"}`}>
              {s.label}
            </span>
          </div>
        ))}
      </div>

      {/* Step Content */}
      <Card className="border-border/70 shadow-sm bg-card/95">
        <CardContent className="p-6">
          {/* STEP 1: IDENTITY */}
          {step === 1 && (
            <div className="space-y-4 animate-in fade-in duration-150">
              <div className="border-b pb-3">
                <h2 className="text-base font-bold text-foreground flex items-center gap-2">
                  <User className="size-4 text-emerald-400" />
                  <span>Step 1: Client &amp; Account Details</span>
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Enter the customer name and registered Kotak Neo details.
                </p>
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-bold">Client / Display Name *</Label>
                  <Input
                    placeholder="e.g. Rahul Sharma"
                    value={form.account_name}
                    onChange={(e) => setForm({ ...form, account_name: e.target.value })}
                    className="text-xs h-9 font-medium"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold">Kotak Neo UCC (Client Code) *</Label>
                    <Input
                      placeholder="e.g. Y4KQT"
                      value={form.ucc}
                      onChange={(e) => setForm({ ...form, ucc: e.target.value.toUpperCase() })}
                      className="text-xs h-9 font-mono font-bold"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold">Registered Mobile Number *</Label>
                    <div className="relative">
                      <Phone className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        placeholder="e.g. 9876543210"
                        value={form.mobile_number}
                        onChange={(e) => setForm({ ...form, mobile_number: e.target.value })}
                        className="text-xs h-9 pl-9 font-mono"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: NEO API CREDENTIALS */}
          {step === 2 && (
            <div className="space-y-4 animate-in fade-in duration-150">
              <div className="border-b pb-3">
                <h2 className="text-base font-bold text-foreground flex items-center gap-2">
                  <Key className="size-4 text-sky-400" />
                  <span>Step 2: Kotak Neo API Credentials</span>
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Generated via Kotak Neo Trade API Developer Portal (tradeapi.kotak.com).
                </p>
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-bold">Consumer Key *</Label>
                  <Input
                    placeholder="paste consumer key from neo portal"
                    value={form.consumer_key}
                    onChange={(e) => setForm({ ...form, consumer_key: e.target.value.trim() })}
                    className="text-xs h-9 font-mono"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Available in Kotak Neo API dashboard under your registered App.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-bold">6-Digit Trading MPIN *</Label>
                  <Input
                    type="password"
                    maxLength={6}
                    placeholder="••••••"
                    value={form.mpin}
                    onChange={(e) => setForm({ ...form, mpin: e.target.value })}
                    className="text-xs h-9 font-mono tracking-widest text-center max-w-[200px]"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    The 6-digit MPIN the client uses to unlock Kotak Neo app.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: 2FA TOTP SECRET KEY (OPTION B) */}
          {step === 3 && (
            <div className="space-y-4 animate-in fade-in duration-150">
              <div className="border-b pb-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-bold text-foreground flex items-center gap-2">
                    <ShieldCheck className="size-4 text-amber-400" />
                    <span>Step 3: Automated Daily TOTP Key</span>
                  </h2>
                  <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-[10px]">
                    Automated · Hands-Free
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Enables zero-touch morning session authorization so the client never has to wake up early to type OTPs.
                </p>
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-bold">32-Character TOTP Secret Seed *</Label>
                    <button
                      type="button"
                      onClick={() => setShowTotpGuide(!showTotpGuide)}
                      className="text-[11px] text-primary hover:underline flex items-center gap-1 cursor-pointer font-medium"
                    >
                      <HelpCircle className="size-3" />
                      <span>Where to find this?</span>
                    </button>
                  </div>

                  <Input
                    placeholder="e.g. JBSWY3DPEHPK3PXP..."
                    value={form.totp_key}
                    onChange={(e) => setForm({ ...form, totp_key: e.target.value.replace(/\s+/g, "").toUpperCase() })}
                    className="text-xs h-9 font-mono uppercase tracking-wider"
                  />
                </div>

                {/* Guide Accordion */}
                {showTotpGuide && (
                  <div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/5 text-xs text-muted-foreground space-y-2">
                    <div className="font-bold text-foreground text-xs flex items-center gap-1.5">
                      <span>📱 How to get your Kotak TOTP Secret:</span>
                    </div>
                    <ol className="list-decimal pl-4 space-y-1 text-[11px] leading-relaxed">
                      <li>Open the Kotak Neo mobile app &amp; go to <b>Profile → Security &amp; 2FA</b>.</li>
                      <li>Select <b>Enable External Authenticator (TOTP)</b>.</li>
                      <li>Kotak will display a QR code and a <b>32-character text key</b> below it.</li>
                      <li>Copy that 32-character key and paste it here.</li>
                      <li>You can also scan the QR in Google Authenticator as your backup.</li>
                    </ol>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP 4: TELEGRAM & RISK MULTIPLIER */}
          {step === 4 && (
            <div className="space-y-4 animate-in fade-in duration-150">
              <div className="border-b pb-3">
                <h2 className="text-base font-bold text-foreground flex items-center gap-2">
                  <Send className="size-4 text-sky-400" />
                  <span>Step 4: Telegram Alerts &amp; Risk Settings</span>
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Sends personalized morning session login alerts and available margin reports.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-bold">Personal Telegram Chat ID (Optional)</Label>
                    <button
                      type="button"
                      onClick={() => setShowTelegramGuide(!showTelegramGuide)}
                      className="text-[11px] text-primary hover:underline flex items-center gap-1 cursor-pointer font-medium"
                    >
                      <HelpCircle className="size-3" />
                      <span>How to get Chat ID?</span>
                    </button>
                  </div>

                  <Input
                    placeholder="e.g. 182746193"
                    value={form.telegram_chat_id}
                    onChange={(e) => setForm({ ...form, telegram_chat_id: e.target.value.trim() })}
                    className="text-xs h-9 font-mono"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Enables 1-on-1 private alerts for morning auth confirmation and live margin updates.
                  </p>
                </div>

                {showTelegramGuide && (
                  <div className="p-3.5 rounded-xl border border-sky-500/30 bg-sky-500/5 text-xs text-muted-foreground space-y-1.5">
                    <p className="font-bold text-foreground text-xs">📲 How to link Telegram:</p>
                    <p className="text-[11px]">
                      1. Open Telegram and search for your bot: <a href="https://t.me/NikhilAlgoAlertSBot" target="_blank" rel="noreferrer" className="text-sky-400 underline font-bold">@NikhilAlgoAlertSBot</a>.
                    </p>
                    <p className="text-[11px]">
                      2. Send <code>/start</code>. The bot will reply with your private numeric Chat ID. Paste it here!
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold">Lot Multiplier</Label>
                    <select
                      value={form.lot_multiplier}
                      onChange={(e) => setForm({ ...form, lot_multiplier: Number(e.target.value) })}
                      className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs font-bold font-mono focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
                    >
                      <option value={1}>1 Lot (Base Sizing)</option>
                      <option value={2}>2 Lots</option>
                      <option value={3}>3 Lots</option>
                      <option value={4}>4 Lots</option>
                      <option value={5}>5 Lots</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold">Max Daily Loss Buffer (₹)</Label>
                    <Input
                      type="number"
                      step={500}
                      value={form.max_daily_loss}
                      onChange={(e) => setForm({ ...form, max_daily_loss: Number(e.target.value) })}
                      className="text-xs h-9 font-mono font-bold"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: VERIFIED & LIVE FUNDS CONFIRMATION */}
          {step === 5 && (
            <div className="text-center py-6 space-y-5 animate-in fade-in duration-150">
              <div className="size-16 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 mx-auto flex items-center justify-center shadow-lg">
                <CheckCircle2 className="size-8" />
              </div>

              <div className="space-y-1">
                <h2 className="text-xl font-black text-foreground">
                  Account Successfully Connected!
                </h2>
                <p className="text-xs text-muted-foreground">
                  Kotak Neo authenticated and live trading margin detected.
                </p>
              </div>

              {/* Funds Card */}
              <div className="max-w-md mx-auto p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground font-medium">Account / Client:</span>
                  <span className="font-bold text-foreground font-mono">
                    {form.account_name} ({form.ucc}){createdAccountId ? ` · Client #${createdAccountId}` : ""}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground font-medium">Available Margin Balance:</span>
                  <span className="text-base font-black font-mono text-emerald-400">
                    ₹{(authResult?.available_funds || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs border-t border-emerald-500/20 pt-2">
                  <span className="text-muted-foreground font-medium">Morning Auto-Auth:</span>
                  <span className="font-bold text-emerald-500 flex items-center gap-1">
                    <CheckCircle2 className="size-3" />
                    <span>Enabled (08:45 AM Auto-Auth)</span>
                  </span>
                </div>
              </div>

              <div className="pt-2 flex items-center justify-center gap-3">
                <Button
                  onClick={() => navigate("/settings?tab=broker")}
                  className="bg-primary text-primary-foreground font-bold text-xs gap-1.5 h-9 px-5 shadow-xs"
                >
                  <span>Go to Accounts Manager</span>
                  <ArrowRight className="size-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Navigation Controls */}
          {step < 5 && (
            <div className="flex items-center justify-between pt-6 border-t mt-6">
              {step > 1 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBack}
                  disabled={loading}
                  className="text-xs gap-1.5 h-9"
                >
                  <ArrowLeft className="size-3.5" />
                  <span>Back</span>
                </Button>
              ) : (
                <div />
              )}

              {step < 4 ? (
                <Button
                  size="sm"
                  onClick={handleNext}
                  className="text-xs gap-1.5 h-9 bg-primary text-primary-foreground font-bold px-4"
                >
                  <span>Continue</span>
                  <ArrowRight className="size-3.5" />
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleSaveAndVerify}
                  disabled={loading}
                  className="text-xs gap-1.5 h-9 bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-5 shadow-xs"
                >
                  {loading ? (
                    <>
                      <RefreshCw className="size-3.5 animate-spin" />
                      <span>Verifying &amp; Fetching Funds...</span>
                    </>
                  ) : (
                    <>
                      <Zap className="size-3.5" />
                      <span>Verify Connection &amp; Check Funds</span>
                    </>
                  )}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

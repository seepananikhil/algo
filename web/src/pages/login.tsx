import { useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { CheckCircle2, RefreshCw, XCircle, ShieldCheck, Settings, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { postJSON } from "@/lib/api"
import { useStatus } from "@/lib/status"

export function LoginPage() {
  const { status, reload } = useStatus()
  const [loggingIn, setLoggingIn] = useState(false)
  const [totp, setTotp] = useState("")
  const [mpin, setMpin] = useState("")

  const valid = status?.token.valid ?? false
  const greeting = status?.token.greeting_name || "User"
  const ucc = status?.token.ucc || "Y4KQT"
  const generated = status?.token.generated_at_utc || "Not logged in today"

  async function login() {
    setLoggingIn(true)
    try {
      const res = await postJSON<{
        ok: boolean
        greeting_name?: string
        ucc?: string
        funds?: number
        error?: string
      }>("/api/kotak/login", {
        totp: totp || undefined,
        mpin: mpin || undefined,
      })

      if (res.ok) {
        toast.success(
          `Connected as ${res.greeting_name || "User"} (UCC: ${res.ucc || ucc})`
        )
        setTotp("")
        setMpin("")
        await reload()
      } else {
        toast.error(res.error || "Kotak Neo authentication failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setLoggingIn(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 pt-8 px-4">
      <Card className={valid ? "border-emerald-500/40" : "border-sky-500/40"}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl flex items-center gap-2">
              <ShieldCheck className="size-5 text-sky-400" />
              Kotak Neo Authentication
            </CardTitle>
            <Badge
              variant="outline"
              className={valid ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10" : "border-amber-500/40 text-amber-400 bg-amber-500/10"}
            >
              {valid ? "SESSION ACTIVE" : "OFFLINE"}
            </Badge>
          </div>
          <CardDescription>
            Authenticate your Kotak Neo Trade API session for automated execution.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex items-center gap-3.5 rounded-xl border p-4 bg-muted/20">
            {valid ? (
              <CheckCircle2 className="size-8 text-emerald-400 shrink-0" />
            ) : (
              <XCircle className="size-8 text-amber-400 shrink-0" />
            )}
            <div className="flex-1">
              <div className="font-semibold text-base">
                {valid ? `Logged In as ${greeting}` : "Daily Token Required"}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {valid
                  ? `UCC: ${ucc} · Session logged in at ${generated}`
                  : "Daily session is offline. Click authenticate to connect with Kotak Neo."}
              </div>
            </div>
          </div>

          {!valid && (
            <div className="grid gap-3 pt-1">
              <div className="grid gap-1.5">
                <Label htmlFor="quick-mpin" className="text-xs">
                  6-Digit MPIN (Optional if saved in config)
                </Label>
                <Input
                  id="quick-mpin"
                  type="password"
                  maxLength={6}
                  placeholder="••••••"
                  value={mpin}
                  onChange={(e) => setMpin(e.target.value)}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="quick-totp" className="text-xs">
                  TOTP Code (Optional if TOTP Secret is configured)
                </Label>
                <Input
                  id="quick-totp"
                  placeholder="6-digit Authenticator Code"
                  maxLength={6}
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                />
              </div>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-col sm:flex-row items-center justify-between gap-3 border-t pt-4">
          <Link to="/settings" className="w-full sm:w-auto">
            <Button variant="ghost" size="sm" className="gap-1.5 w-full text-muted-foreground">
              <Settings className="size-3.5" /> Broker Settings
            </Button>
          </Link>
          <Button
            onClick={login}
            disabled={loggingIn}
            className={valid ? "w-full sm:w-auto gap-2 bg-emerald-600 hover:bg-emerald-700 text-white" : "w-full sm:w-auto gap-2 bg-sky-500 hover:bg-sky-600 text-white"}
          >
            {loggingIn ? (
              <RefreshCw className="size-4 animate-spin" />
            ) : (
              <Zap className="size-4" />
            )}
            {loggingIn ? "Authenticating…" : valid ? "Re-Authenticate Session" : "Log In to Kotak Neo"}
          </Button>
        </CardFooter>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        💡 Automated headless authentication occurs daily at 09:14 IST when TOTP Secret is configured in Broker Settings.
      </p>
    </div>
  )
}

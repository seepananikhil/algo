import { useState } from "react"
import { toast } from "sonner"
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { postJSON } from "@/lib/api"
import { useStatus } from "@/lib/status"

export function LoginPage() {
  const { status } = useStatus()
  const [waiting, setWaiting] = useState(false)
  const valid = status?.token.valid ?? false
  const generated = status?.token.generated_at_utc
    ? new Date(status.token.generated_at_utc).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    : "never"

  async function login() {
    // Open the tab synchronously so the browser doesn't block it as a popup.
    const tab = window.open("about:blank", "_blank")
    try {
      const r = await postJSON<{ login_url: string; listener: string }>("/api/login/start")
      if (tab) tab.location.href = r.login_url
      else window.location.href = r.login_url
      setWaiting(true)
      toast.info("Complete the Fyers login in the new tab. This page updates automatically.")
    } catch (e) {
      tab?.close()
      toast.error(String(e))
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 pt-6">
      <Card>
        <CardHeader>
          <CardTitle>Fyers connection</CardTitle>
          <CardDescription>Fyers tokens expire daily. Log in once each trading morning.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-lg border p-4">
            {valid ? <CheckCircle2 className="size-8 text-emerald-500" /> : <XCircle className="size-8 text-red-500" />}
            <div>
              <div className="font-medium">{valid ? "Access token is valid" : "Not logged in / token expired"}</div>
              <div className="text-sm text-muted-foreground">Last login: {generated}</div>
            </div>
          </div>
          {waiting && !valid && (
            <Alert>
              <Loader2 className="animate-spin" />
              <AlertTitle>Waiting for Fyers login…</AlertTitle>
              <AlertDescription>After you sign in, Fyers redirects to 127.0.0.1:8080 and the token is saved.</AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter>
          <Button onClick={login} variant={valid ? "outline" : "default"} className="w-full">
            <ExternalLink />
            {valid ? "Log in again" : "Log in with Fyers"}
          </Button>
        </CardFooter>
      </Card>
      <p className="text-center text-xs text-muted-foreground">
        A scheduled job also opens the login at 08:30 on weekdays. Capture starts at 09:10 and waits for a valid token.
      </p>
    </div>
  )
}

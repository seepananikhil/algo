import { useEffect, useState } from "react"
import { toast } from "sonner"
import { AlertTriangle, Save } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { postJSON, usePoll, type Settings } from "@/lib/api"
import { useStatus } from "@/lib/status"

type Form = { lots: string; daily_loss_limit: string; strike_offset: string; skip_expiry_day: boolean }

export function SettingsPage() {
  const { data, reload } = usePoll<Settings>("/api/settings")
  const status = useStatus()
  const [form, setForm] = useState<Form | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const [restart, setRestart] = useState(false)

  useEffect(() => {
    if (data && !form)
      setForm({
        lots: String(data.lots),
        daily_loss_limit: String(data.daily_loss_limit),
        strike_offset: String(data.strike_offset),
        skip_expiry_day: data.skip_expiry_day,
      })
  }, [data, form])

  async function save(body: Record<string, unknown>, msg: string) {
    try {
      const r = await postJSON<Settings>("/api/settings", body)
      setRestart(Boolean(r.restart_required))
      toast.success(msg)
      await Promise.all([reload(), status.reload()])
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      return false
    }
  }

  function saveRisk() {
    if (!form) return
    save(
      {
        lots: Number(form.lots),
        daily_loss_limit: Number(form.daily_loss_limit),
        strike_offset: Number(form.strike_offset),
        skip_expiry_day: form.skip_expiry_day,
      },
      "Settings saved",
    )
  }

  async function goLive() {
    if (await save({ live_trading: true, confirm: typed }, "LIVE trading enabled")) {
      setConfirmOpen(false)
      setTyped("")
    }
  }

  if (!data || !form) return null
  const live = data.live_trading

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Settings</h1>

      {restart && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Restart capture to apply</AlertTitle>
          <AlertDescription>The capture process reads settings at startup. Changes apply from the next session (09:10) or after a restart.</AlertDescription>
        </Alert>
      )}

      <Card className={live ? "border-red-600/60" : undefined}>
        <CardHeader>
          <CardTitle>Trading mode</CardTitle>
          <CardDescription>PAPER logs simulated fills only. LIVE places real market orders on Fyers.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <div>
            <div className={live ? "text-lg font-semibold text-red-500" : "text-lg font-semibold text-sky-500"}>{live ? "LIVE — real money" : "PAPER"}</div>
            <div className="text-sm text-muted-foreground">Kill switch: {status.status?.kill_switch ? "ON (no new entries)" : "off"}</div>
          </div>
          <Switch
            checked={live}
            onCheckedChange={(on) => (on ? setConfirmOpen(true) : save({ live_trading: false }, "Switched to PAPER"))}
            aria-label="Live trading"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Risk & orders</CardTitle>
          <CardDescription>Used by the option order module</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="lots">Lots (1 lot = 65 qty)</Label>
            <Input id="lots" type="number" min={1} max={20} value={form.lots} onChange={(e) => setForm({ ...form, lots: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dll">Daily loss limit (₹)</Label>
            <Input id="dll" type="number" min={100} step={100} value={form.daily_loss_limit} onChange={(e) => setForm({ ...form, daily_loss_limit: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="so">Strike offset (points from ATM)</Label>
            <Input id="so" type="number" min={0} max={500} step={50} value={form.strike_offset} onChange={(e) => setForm({ ...form, strike_offset: e.target.value })} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <Label htmlFor="exp">Skip expiry day</Label>
            <Switch id="exp" checked={form.skip_expiry_day} onCheckedChange={(v) => setForm({ ...form, skip_expiry_day: v })} />
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button onClick={saveRisk}>
            <Save /> Save
          </Button>
        </CardFooter>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={(o) => { setConfirmOpen(o); if (!o) setTyped("") }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable LIVE trading?</DialogTitle>
            <DialogDescription>
              Real market orders for {data.lots} lot(s) will be placed on Fyers from the next session. Make sure the account is funded. Type <b>LIVE</b> to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="LIVE" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={typed !== "LIVE"} onClick={goLive}>Enable LIVE</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Sliders,
  ShieldCheck,
  ShieldAlert,
  Save,
  RotateCcw,
  Layers,
  Target,
  Info,
  TrendingUp,
  Zap,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { getJSON, postJSON, type Settings } from "@/lib/api"
import { StrategyInfoPage } from "./strategy-info"

type SpotRatchetSettings = {
  initial_sl_pts: number
  tier0a_trigger_pts: number
  tier0a_lock_pts: number
  tier0b_breakeven_trigger_pts: number
  tier0b_breakeven_lock_pts: number
  tier1_trigger_pts: number
  tier1_lock_pts: number
  tier2_trigger_pts: number
  tier2_lock_pts: number
  tier3_trigger_pts: number
  tier3_lock_pts: number
  tier4_trigger_pts: number
  tier4_lock_pts: number
  tier5_trigger_pts?: number
  tier5_lock_pts?: number
  tier6_trigger_pts?: number
  tier6_lock_pts?: number
}

type PortfolioConfig = {
  symbol: string
  mode: "priority" | "concurrent"
  max_trades_per_day: number
  max_concurrent_positions: number
  setups: {
    trend_runner: boolean
    vix_trap: boolean
    williams_fractal?: boolean
    // backward compatibility
    vix_master_morning?: boolean
    williams_afternoon?: boolean
    vix_master_afternoon?: boolean
    gap_and_go_morning?: boolean
  }
  spot_ratchet_settings: SpotRatchetSettings
  sensex_spot_ratchet_settings?: SpotRatchetSettings
}

const DEFAULT_NIFTY_RATCHET: SpotRatchetSettings = {
  initial_sl_pts: 28.0,
  tier0a_trigger_pts: 40.0,
  tier0a_lock_pts: -15.0,
  tier0b_breakeven_trigger_pts: 55.0,
  tier0b_breakeven_lock_pts: 5.0,
  tier1_trigger_pts: 70.0,
  tier1_lock_pts: 20.0,
  tier2_trigger_pts: 130.0,
  tier2_lock_pts: 60.0,
  tier3_trigger_pts: 180.0,
  tier3_lock_pts: 110.0,
  tier4_trigger_pts: 230.0,
  tier4_lock_pts: 165.0,
  tier5_trigger_pts: 280.0,
  tier5_lock_pts: 220.0,
  tier6_trigger_pts: 340.0,
  tier6_lock_pts: 270.0,
}

const DEFAULT_SENSEX_RATCHET: SpotRatchetSettings = {
  initial_sl_pts: 100.0,
  tier0a_trigger_pts: 115.0,
  tier0a_lock_pts: -40.0,
  tier0b_breakeven_trigger_pts: 180.0,
  tier0b_breakeven_lock_pts: 15.0,
  tier1_trigger_pts: 240.0,
  tier1_lock_pts: 80.0,
  tier2_trigger_pts: 400.0,
  tier2_lock_pts: 200.0,
  tier3_trigger_pts: 600.0,
  tier3_lock_pts: 360.0,
  tier4_trigger_pts: 850.0,
  tier4_lock_pts: 550.0,
  tier5_trigger_pts: 1200.0,
  tier5_lock_pts: 850.0,
  tier6_trigger_pts: 1500.0,
  tier6_lock_pts: 1100.0,
}

const DEFAULT_CONFIG: PortfolioConfig = {
  symbol: "NIFTY",
  mode: "priority",
  max_trades_per_day: 2,
  max_concurrent_positions: 1,
  setups: {
    trend_runner: true,
    vix_trap: true,
  },
  spot_ratchet_settings: DEFAULT_NIFTY_RATCHET,
  sensex_spot_ratchet_settings: DEFAULT_SENSEX_RATCHET,
}

export function ConfigPage() {
  const [config, setConfig] = useState<PortfolioConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState("portfolio")
  const [capitalSettings, setCapitalSettings] = useState({
    lots: 1,
    daily_loss_limit: 2500,
    minimum_live_funds: 10000,
    sizing_mode: "fixed",
  })
  const [isLiveTrading, setIsLiveTrading] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [typed, setTyped] = useState("")

  useEffect(() => {
    fetchConfig()
  }, [])

  async function fetchConfig() {
    setLoading(true)
    try {
      const data = await getJSON<PortfolioConfig>("/api/portfolio/config")
      // Normalize setups if old keys were present
      const setups = {
        trend_runner: data.setups?.trend_runner ?? data.setups?.vix_master_morning ?? true,
        vix_trap: data.setups?.vix_trap ?? true,
      }
      setConfig({
        ...data,
        setups,
      })
      try {
        const sData = await getJSON<Settings>("/api/settings")
        setCapitalSettings({
          lots: sData.trend_runner_lots ?? sData.lots ?? 1,
          daily_loss_limit: sData.daily_loss_limit ?? 2500,
          minimum_live_funds: sData.minimum_live_funds ?? 10000,
          sizing_mode: sData.sizing_mode || "fixed",
        })
        const live = Boolean(sData.trend_runner_live_trading || sData.midpoint_live_trading || sData.live_trading)
        setIsLiveTrading(live)
      } catch {}
    } catch {
      toast.error("Failed to load portfolio configuration. Using defaults.")
      setConfig(DEFAULT_CONFIG)
    } finally {
      setLoading(false)
    }
  }

  async function saveConfig() {
    if (!config) return
    setSaving(true)
    try {
      const [res] = await Promise.all([
        postJSON<{ ok: boolean; config: PortfolioConfig }>("/api/portfolio/config", config),
        postJSON("/api/settings", {
          lots: Number(capitalSettings.lots),
          trend_runner_lots: Number(capitalSettings.lots),
          daily_loss_limit: Number(capitalSettings.daily_loss_limit),
          minimum_live_funds: Number(capitalSettings.minimum_live_funds),
          sizing_mode: capitalSettings.sizing_mode,
        }),
      ])
      if (res.ok) {
        toast.success("Apex Duo strategy & capital configuration saved!")
        const setups = {
          trend_runner: res.config.setups?.trend_runner ?? true,
          vix_trap: res.config.setups?.vix_trap ?? true,
        }
        setConfig({
          ...res.config,
          setups,
        })
      } else {
        toast.error("Failed to save configuration.")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error saving configuration")
    } finally {
      setSaving(false)
    }
  }

  function toggleLiveMode(enabled: boolean) {
    if (enabled) {
      setConfirmOpen(true)
    } else {
      postJSON("/api/settings", { trend_runner_live_trading: false, midpoint_live_trading: false })
        .then(() => {
          setIsLiveTrading(false)
          toast.success("Switched to PAPER simulation mode")
        })
        .catch((err) => toast.error(String(err)))
    }
  }

  async function confirmLive() {
    if (typed !== "LIVE") return
    try {
      await postJSON("/api/settings", {
        trend_runner_live_trading: true,
        midpoint_live_trading: true,
        confirm: typed,
      })
      setIsLiveTrading(true)
      setConfirmOpen(false)
      setTyped("")
      toast.success("🔥 LIVE TRADING ENABLED - Real orders active on Kotak Neo")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  function resetToDefaults() {
    setConfig(DEFAULT_CONFIG)
    toast.info("Reset to production recommended parameters. Click Save to persist.")
  }

  if (loading || !config) {
    return (
      <div className="flex h-96 w-full items-center justify-center text-sm text-muted-foreground animate-pulse">
        Loading Apex Duo Configuration...
      </div>
    )
  }

  const isSx = config.symbol === "SENSEX"
  const currentRatchet: SpotRatchetSettings = isSx
    ? (config.sensex_spot_ratchet_settings || DEFAULT_SENSEX_RATCHET)
    : (config.spot_ratchet_settings || DEFAULT_NIFTY_RATCHET)

  const updateRatchetField = (field: keyof SpotRatchetSettings, val: number) => {
    if (isSx) {
      const prev = config.sensex_spot_ratchet_settings || { ...DEFAULT_SENSEX_RATCHET }
      setConfig({
        ...config,
        sensex_spot_ratchet_settings: {
          ...prev,
          [field]: val,
        },
      })
    } else {
      const prev = config.spot_ratchet_settings || { ...DEFAULT_NIFTY_RATCHET }
      setConfig({
        ...config,
        spot_ratchet_settings: {
          ...prev,
          [field]: val,
        },
      })
    }
  }

  const activeSetupsCount = [
    config.setups.trend_runner,
    config.setups.vix_trap,
  ].filter(Boolean).length

  return (
    <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <Badge variant="outline" className="border-sky-500/40 text-sky-400 bg-sky-500/10 gap-1 text-xs">
              <Sliders className="size-3" /> AlgoNeo Apex Duo
            </Badge>
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 bg-emerald-500/10 gap-1 text-xs">
              <ShieldCheck className="size-3" /> {isSx ? "4-Year Verified Sensex" : "10-Year Verified Nifty"}
            </Badge>
            <Badge variant="outline" className="border-amber-500/40 text-amber-400 bg-amber-500/10 gap-1 text-xs">
              {activeSetupsCount} / 2 Strategy Engines Active
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {isSx ? "BSE SENSEX (~80,000 Index | Lot 10)" : "NSE NIFTY (~24,500 Index | Lot 65)"}
            </Badge>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Strategy Controls &amp; Portfolio</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure execution mode (Paper/Live), Nifty lot sizing, Daily Loss circuit breakers, active strategy engines, and spot ratchet profit locking milestones.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={resetToDefaults}>
            <RotateCcw className="size-3.5 mr-1.5" /> Reset Defaults
          </Button>
          <Button size="sm" onClick={saveConfig} disabled={saving} className="bg-primary text-primary-foreground font-semibold">
            <Save className="size-3.5 mr-1.5" /> {saving ? "Saving..." : "Save Configuration"}
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-5">
        <TabsList className="bg-muted/50 p-1 rounded-xl border border-border/50 h-auto">
          <TabsTrigger value="portfolio" className="gap-2 rounded-lg py-2 px-4 text-xs font-medium data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Sliders className="size-4 text-sky-400" /> Strategy Controls &amp; Sizing
          </TabsTrigger>
          <TabsTrigger value="strategy_info" className="gap-2 rounded-lg py-2 px-4 text-xs font-medium data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Info className="size-4 text-emerald-400" /> Strategy Handbook &amp; Edge Playbook
          </TabsTrigger>
        </TabsList>

        <TabsContent value="portfolio" className="space-y-5">
          {/* Section 0: Execution Mode (Paper vs Live Switch) */}
          <Card className={isLiveTrading ? "border-red-600/70 bg-red-950/10 shadow-lg" : undefined}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Zap className={cn("size-4", isLiveTrading ? "text-red-500" : "text-sky-400")} />
                    Strategy Execution Mode
                  </CardTitle>
                  <CardDescription>
                    Toggle between risk-free Paper Simulation and Real Money Execution on Kotak Neo.
                  </CardDescription>
                </div>
                <Badge variant={isLiveTrading ? "destructive" : "secondary"} className="font-mono text-xs">
                  {isLiveTrading ? "🔥 LIVE TRADING" : "🛡️ PAPER SIMULATION"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-4 rounded-lg border p-4 bg-card/60">
                <div className="space-y-0.5">
                  <div className={isLiveTrading ? "font-bold text-red-500 text-base" : "font-semibold text-foreground text-base"}>
                    Apex Duo · {isLiveTrading ? "LIVE (Real Money Orders Active)" : "PAPER (Simulated Forward Testing)"}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {isLiveTrading
                      ? "Routes automated trade signals directly to your active Kotak Neo account."
                      : "Simulates orders with zero financial risk. Perfect for forward verification."}
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

          {/* Section 1: Portfolio Orchestration Controls */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Layers className="size-4 text-sky-400" />
                    Portfolio Orchestration Controls
                  </CardTitle>
                  <CardDescription>
                    Unified master portfolio dispatcher rules across both active strategy engines.
                  </CardDescription>
                </div>
                <Badge variant="secondary" className="text-xs">
                  {config.mode.toUpperCase()} MODE
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Symbol */}
                <div className="space-y-2 rounded-lg border p-3">
                  <Label className="text-xs text-muted-foreground">Index Symbol</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={config.symbol === "NIFTY" ? "default" : "outline"}
                      size="sm"
                      className="flex-1"
                      onClick={() => setConfig({ ...config, symbol: "NIFTY" })}
                    >
                      NIFTY
                    </Button>
                    <Button
                      type="button"
                      variant={config.symbol === "SENSEX" ? "default" : "outline"}
                      size="sm"
                      className="flex-1"
                      onClick={() => setConfig({ ...config, symbol: "SENSEX" })}
                    >
                      SENSEX
                    </Button>
                  </div>
                </div>

                {/* Mode */}
                <div className="space-y-2 rounded-lg border p-3">
                  <Label className="text-xs text-muted-foreground">Execution Mode</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={config.mode === "priority" ? "default" : "outline"}
                      size="sm"
                      className="flex-1"
                      onClick={() => setConfig({ ...config, mode: "priority" })}
                    >
                      Priority
                    </Button>
                    <Button
                      type="button"
                      variant={config.mode === "concurrent" ? "default" : "outline"}
                      size="sm"
                      className="flex-1"
                      onClick={() => setConfig({ ...config, mode: "concurrent" })}
                    >
                      Concurrent
                    </Button>
                  </div>
                </div>

                {/* Max Trades Per Day */}
                <div className="space-y-2 rounded-lg border p-3">
                  <Label htmlFor="max-trades" className="text-xs text-muted-foreground">Max Trades / Day</Label>
                  <Input
                    id="max-trades"
                    type="number"
                    min={1}
                    max={6}
                    value={config.max_trades_per_day}
                    onChange={(e) =>
                      setConfig({ ...config, max_trades_per_day: parseInt(e.target.value) || 2 })
                    }
                    className="h-9 text-sm font-semibold"
                  />
                </div>

                {/* Max Concurrent Positions */}
                <div className="space-y-2 rounded-lg border p-3">
                  <Label htmlFor="max-concurrent" className="text-xs text-muted-foreground">Max Concurrent</Label>
                  <Input
                    id="max-concurrent"
                    type="number"
                    min={1}
                    max={3}
                    value={config.max_concurrent_positions}
                    onChange={(e) =>
                      setConfig({ ...config, max_concurrent_positions: parseInt(e.target.value) || 1 })
                    }
                    className="h-9 text-sm font-semibold"
                  />
                </div>
              </div>

              <div className="text-xs text-muted-foreground bg-muted/40 p-3 rounded-md flex items-center gap-2">
                <Info className="size-4 shrink-0 text-sky-400" />
                <span>
                  <strong>Priority Orchestration:</strong> In Priority mode, the {config.symbol} portfolio caps daily risk at 1-2 morning trades (Trend Runner or VIX Trap), delivering{" "}
                  <strong>{isSx ? "+31,332.3 pts" : "+26,872.4 pts"}</strong> with an ultra-low{" "}
                  <strong>{isSx ? "1,460.4 pt Max Drawdown" : "475.0 pt Max Drawdown"}</strong> and{" "}
                  <strong>{isSx ? "1.72 Profit Factor" : "2.12 Profit Factor"}</strong> across {isSx ? "716 trades" : "1,439 trades"}.
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Capital Guardian & Loss Limits Card */}
          <Card className="border-emerald-500/30 bg-emerald-500/[0.015] shadow-xs">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <ShieldAlert className="size-4 text-emerald-400" />
                    Capital Guardian &amp; Loss Limits
                  </CardTitle>
                  <CardDescription>
                    Account-level circuit breakers, lot sizing, and broker liquid balance protection.
                  </CardDescription>
                </div>
                <Badge variant="outline" className="text-xs font-mono border-emerald-500/40 text-emerald-400">
                  Active Protection
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5 rounded-lg border p-3">
                  <Label htmlFor="lots" className="text-xs text-muted-foreground font-medium">
                    Nifty Lots (65 Qty/Lot)
                  </Label>
                  <Input
                    id="lots"
                    type="number"
                    min={1}
                    max={10}
                    value={capitalSettings.lots}
                    onChange={(e) =>
                      setCapitalSettings({ ...capitalSettings, lots: parseInt(e.target.value) || 1 })
                    }
                    className="h-9 text-sm font-semibold"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Base trade sizing (1 lot = 65 shares)
                  </p>
                </div>

                <div className="space-y-1.5 rounded-lg border p-3">
                  <Label htmlFor="dll" className="text-xs text-muted-foreground font-medium">
                    Daily Loss Limit (₹)
                  </Label>
                  <Input
                    id="dll"
                    type="number"
                    min={500}
                    step={500}
                    value={capitalSettings.daily_loss_limit}
                    onChange={(e) =>
                      setCapitalSettings({ ...capitalSettings, daily_loss_limit: parseFloat(e.target.value) || 2500 })
                    }
                    className="h-9 text-sm font-semibold"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Circuit breaker: locks trading if day loss reaches ₹{capitalSettings.daily_loss_limit.toLocaleString('en-IN')}
                  </p>
                </div>

                <div className="space-y-1.5 rounded-lg border p-3">
                  <Label htmlFor="min-funds" className="text-xs text-muted-foreground font-medium">
                    Minimum LIVE Balance (₹)
                  </Label>
                  <Input
                    id="min-funds"
                    type="number"
                    min={5000}
                    max={10000000}
                    step={5000}
                    value={capitalSettings.minimum_live_funds}
                    onChange={(e) =>
                      setCapitalSettings({ ...capitalSettings, minimum_live_funds: parseFloat(e.target.value) || 10000 })
                    }
                    className="h-9 text-sm font-semibold"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Orders reject if broker cash is below ₹{capitalSettings.minimum_live_funds.toLocaleString('en-IN')}
                  </p>
                </div>
              </div>

              {/* High Conviction Sizing Mode Selector */}
              <div className="rounded-lg border p-3.5 bg-muted/20 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <Zap className="size-3.5 text-amber-400" />
                      High-Conviction Sizing Strategy (1 vs 2 Lots)
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {capitalSettings.sizing_mode === "dynamic"
                        ? "Dynamic sizing active: Enters 1 lot by default, but automatically scales to 2 lots on A+ institutional confluence (India VIX surge ≥ +2.0% with candle body ≥ 80%)."
                        : "Fixed sizing active: Strictly enters 1 lot on every trade regardless of conviction."}
                    </p>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Button
                      type="button"
                      size="sm"
                      variant={capitalSettings.sizing_mode === "fixed" ? "default" : "outline"}
                      className="h-8 text-xs font-medium"
                      onClick={() => {
                        setCapitalSettings({
                          ...capitalSettings,
                          sizing_mode: "fixed",
                          daily_loss_limit: 2500,
                        })
                        toast.info("Fixed Sizing: Daily Loss Limit calibrated to ₹2,500. Click 'Save Configuration' to persist.")
                      }}
                    >
                      Fixed (1 Lot Always)
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={capitalSettings.sizing_mode === "dynamic" ? "default" : "outline"}
                      className="h-8 text-xs font-medium"
                      onClick={() => {
                        setCapitalSettings({
                          ...capitalSettings,
                          sizing_mode: "dynamic",
                          daily_loss_limit: 4500,
                        })
                        toast.info("Dynamic Sizing: Daily Loss Limit calibrated to ₹4,500 for 2-lot coverage. Click 'Save Configuration' to persist.")
                      }}
                    >
                      Dynamic (1 → 2 Lots)
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Section 2: The 2 Core Strategy Engines (Apex Duo) */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">The 2 Core Strategy Engines (Apex Duo)</h2>
                <p className="text-xs text-muted-foreground">
                  Each engine fires independently with explicit signal attribution on charts and trade logs.
                </p>
              </div>
              <Badge variant="secondary" className="text-xs w-fit">
                Decoupled Apex Architecture
              </Badge>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Engine 1: Trend Runner */}
              <Card className={config.setups.trend_runner ? "border-emerald-500/40 bg-card" : "opacity-60"}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <Badge variant="outline" className="border-emerald-500/50 text-emerald-400 bg-emerald-500/10 text-[10px] gap-1">
                      <TrendingUp className="size-3" /> Morning Momentum
                    </Badge>
                    <Switch
                      checked={config.setups.trend_runner}
                      onCheckedChange={(checked) =>
                        setConfig({
                          ...config,
                          setups: { ...config.setups, trend_runner: checked },
                        })
                      }
                    />
                  </div>
                  <CardTitle className="text-base mt-2 flex items-center gap-1.5">
                    <span>⚡ Trend Runner</span>
                  </CardTitle>
                  <CardDescription className="text-xs">
                    15m Opening Range Breakout confirmed by India VIX momentum bias.
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-xs space-y-2 text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Window:</span>
                    <span className="font-mono text-foreground font-medium">09:30 – 11:00 IST</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Trigger:</span>
                    <span className="text-foreground">Break of 15m ORB + VIX Bias</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Attribution:</span>
                    <span className="font-mono text-emerald-400 font-semibold">[Trend Runner] 15m ORB</span>
                  </div>
                  <div className="border-t pt-2 space-y-1">
                    <div className="flex justify-between">
                      <span>Portfolio Trades:</span>
                      <span className="text-foreground font-medium">{isSx ? "472 trades" : "977 trades"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Net Contribution:</span>
                      <span className="text-emerald-400 font-bold">{isSx ? "+24,249.3 pts" : "+15,712.5 pts"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Profit Factor:</span>
                      <span className="text-foreground font-medium">{isSx ? "1.68" : "1.98"}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Engine 2: VIX Trap */}
              <Card className={config.setups.vix_trap ? "border-amber-500/40 bg-card" : "opacity-60"}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <Badge variant="outline" className="border-amber-500/50 text-amber-400 bg-amber-500/10 text-[10px] gap-1">
                      <Zap className="size-3" /> Contrarian Trap
                    </Badge>
                    <Switch
                      checked={config.setups.vix_trap}
                      onCheckedChange={(checked) =>
                        setConfig({
                          ...config,
                          setups: { ...config.setups, vix_trap: checked },
                        })
                      }
                    />
                  </div>
                  <CardTitle className="text-base mt-2 flex items-center gap-1.5">
                    <span>🪤 VIX Trap</span>
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Volatility divergence & liquidity trap reversal when spot breaks out falsely.
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-xs space-y-2 text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Window:</span>
                    <span className="font-mono text-foreground font-medium">09:30 – 11:00 IST</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Trigger:</span>
                    <span className="text-foreground">Extreme Divergence Trap</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Attribution:</span>
                    <span className="font-mono text-amber-400 font-semibold">[VIX Trap] Divergence</span>
                  </div>
                  <div className="border-t pt-2 space-y-1">
                    <div className="flex justify-between">
                      <span>Portfolio Trades:</span>
                      <span className="text-foreground font-medium">{isSx ? "244 trades" : "462 trades"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Win Rate:</span>
                      <span className="text-amber-400 font-bold">{isSx ? "61.5% (Elite Accuracy)" : "54.3% (Elite Accuracy)"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Net Contribution:</span>
                      <span className="text-amber-400 font-bold">{isSx ? "+7,083.0 pts" : "+11,159.9 pts"}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Section 3: Spot Points Ratchet Ladder Editor */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Target className="size-4 text-emerald-400" />
                    Spot Points Profit Ratchet Ladder ({config.symbol})
                  </CardTitle>
                  <CardDescription>
                    {isSx
                      ? "Sensex Index (~80,000 pt scale, 10 qty/lot). Fixed spot point ladder calibrated to Sensex intraday volatility."
                      : "Nifty Index (~24,500 pt scale, 65 qty/lot). Fixed spot point ladder locking verified milestones."}
                  </CardDescription>
                </div>
                <Badge variant="outline" className="text-xs border-emerald-500/40 text-emerald-400 bg-emerald-500/10">
                  {isSx ? "Sensex Scaled (100pt SL / 115pt T0A / 1500pt T6)" : "Nifty Scaled (28pt SL / 40pt T0A / 340pt T6)"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Initial SL */}
                <div className="space-y-1.5 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                  <Label htmlFor="initial-sl" className="text-xs font-semibold text-red-400">Initial Stop Loss (pts)</Label>
                  <Input
                    id="initial-sl"
                    type="number"
                    step={0.5}
                    value={currentRatchet.initial_sl_pts}
                    onChange={(e) => updateRatchetField("initial_sl_pts", parseFloat(e.target.value) || (isSx ? 100.0 : 28.0))}
                    className="h-8 text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {isSx ? "Fixed spot loss cutoff on entry (~100 pts)" : "Fixed spot loss cutoff on entry (28 pts)"}
                  </p>
                </div>

                {/* Tier 0A Guard */}
                <div className="space-y-1.5 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
                  <Label className="text-xs font-semibold text-orange-400">Tier 0A Guard (Trigger / Cut)</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier0a_trigger_pts}
                      onChange={(e) => updateRatchetField("tier0a_trigger_pts", parseFloat(e.target.value) || (isSx ? 115.0 : 40.0))}
                      className="h-8 text-sm flex-1"
                      placeholder="Trigger"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier0a_lock_pts}
                      onChange={(e) => updateRatchetField("tier0a_lock_pts", parseFloat(e.target.value) || (isSx ? -40.0 : -15.0))}
                      className="h-8 text-sm w-20"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {isSx ? "At +115 pt peak, cuts SL to -40 pt" : "At +40 pt peak, cuts SL to -15 pt"}
                  </p>
                </div>

                {/* Tier 0B Breakeven */}
                <div className="space-y-1.5 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3">
                  <Label className="text-xs font-semibold text-yellow-400">Tier 0B Breakeven (pts)</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier0b_breakeven_trigger_pts}
                      onChange={(e) => updateRatchetField("tier0b_breakeven_trigger_pts", parseFloat(e.target.value) || (isSx ? 180.0 : 55.0))}
                      className="h-8 text-sm flex-1"
                      placeholder="Trigger"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier0b_breakeven_lock_pts}
                      onChange={(e) => updateRatchetField("tier0b_breakeven_lock_pts", parseFloat(e.target.value) || (isSx ? 15.0 : 5.0))}
                      className="h-8 text-sm w-20"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {isSx ? "At +180 pt peak, locks +15 pt profit" : "At +55 pt peak, locks +5 pt profit"}
                  </p>
                </div>

                {/* Tier 1 Lock */}
                <div className="space-y-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                  <Label className="text-xs font-semibold text-emerald-400">Tier 1 Lock (pts)</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier1_trigger_pts}
                      onChange={(e) => updateRatchetField("tier1_trigger_pts", parseFloat(e.target.value) || (isSx ? 240.0 : 70.0))}
                      className="h-8 text-sm flex-1"
                      placeholder="Trigger"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier1_lock_pts}
                      onChange={(e) => updateRatchetField("tier1_lock_pts", parseFloat(e.target.value) || (isSx ? 80.0 : 20.0))}
                      className="h-8 text-sm w-20"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {isSx ? "At +240 pt peak, locks +80 pt profit" : "At +70 pt peak, locks +20 pt profit"}
                  </p>
                </div>
              </div>

              {/* Higher Expansion Tiers */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 border-t pt-4">
                {/* Tier 2 */}
                <div className="space-y-1.5 rounded-lg border p-3">
                  <Label className="text-xs font-semibold text-sky-400">Tier 2 Expansion</Label>
                  <div className="flex gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier2_trigger_pts}
                      onChange={(e) => updateRatchetField("tier2_trigger_pts", parseFloat(e.target.value) || (isSx ? 400.0 : 130.0))}
                      className="h-8 text-xs flex-1"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier2_lock_pts}
                      onChange={(e) => updateRatchetField("tier2_lock_pts", parseFloat(e.target.value) || (isSx ? 200.0 : 60.0))}
                      className="h-8 text-xs w-16"
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {isSx ? "At +400 pt → +200 pt" : "At +130 pt → +60 pt"}
                  </p>
                </div>

                {/* Tier 3 */}
                <div className="space-y-1.5 rounded-lg border p-3">
                  <Label className="text-xs font-semibold text-indigo-400">Tier 3 Super-Runner</Label>
                  <div className="flex gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier3_trigger_pts}
                      onChange={(e) => updateRatchetField("tier3_trigger_pts", parseFloat(e.target.value) || (isSx ? 600.0 : 180.0))}
                      className="h-8 text-xs flex-1"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier3_lock_pts}
                      onChange={(e) => updateRatchetField("tier3_lock_pts", parseFloat(e.target.value) || (isSx ? 360.0 : 110.0))}
                      className="h-8 text-xs w-16"
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {isSx ? "At +600 pt → +360 pt" : "At +180 pt → +110 pt"}
                  </p>
                </div>

                {/* Tier 4 */}
                <div className="space-y-1.5 rounded-lg border p-3">
                  <Label className="text-xs font-semibold text-purple-400">Tier 4 Exhaustion</Label>
                  <div className="flex gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier4_trigger_pts}
                      onChange={(e) => updateRatchetField("tier4_trigger_pts", parseFloat(e.target.value) || (isSx ? 850.0 : 230.0))}
                      className="h-8 text-xs flex-1"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier4_lock_pts}
                      onChange={(e) => updateRatchetField("tier4_lock_pts", parseFloat(e.target.value) || (isSx ? 550.0 : 165.0))}
                      className="h-8 text-xs w-16"
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {isSx ? "At +850 pt → +550 pt" : "At +230 pt → +165 pt"}
                  </p>
                </div>

                {/* Tier 5 */}
                <div className="space-y-1.5 rounded-lg border p-3 border-emerald-500/30 bg-emerald-500/5">
                  <Label className="text-xs font-semibold text-emerald-400">Tier 5 Mega-Runner</Label>
                  <div className="flex gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier5_trigger_pts ?? (isSx ? 1200.0 : 280.0)}
                      onChange={(e) => updateRatchetField("tier5_trigger_pts", parseFloat(e.target.value) || (isSx ? 1200.0 : 280.0))}
                      className="h-8 text-xs flex-1"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier5_lock_pts ?? (isSx ? 850.0 : 220.0)}
                      onChange={(e) => updateRatchetField("tier5_lock_pts", parseFloat(e.target.value) || (isSx ? 850.0 : 220.0))}
                      className="h-8 text-xs w-16"
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {isSx ? "At +1,200 pt → +850 pt" : "At +280 pt → +220 pt"}
                  </p>
                </div>

                {/* Tier 6 Extreme Runner */}
                <div className="space-y-1.5 rounded-lg border p-3 border-cyan-500/30 bg-cyan-500/5">
                  <Label className="text-xs font-semibold text-cyan-400">Tier 6 Extreme</Label>
                  <div className="flex gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier6_trigger_pts ?? (isSx ? 1500.0 : 340.0)}
                      onChange={(e) => updateRatchetField("tier6_trigger_pts", parseFloat(e.target.value) || (isSx ? 1500.0 : 340.0))}
                      className="h-8 text-xs flex-1"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={currentRatchet.tier6_lock_pts ?? (isSx ? 1100.0 : 270.0)}
                      onChange={(e) => updateRatchetField("tier6_lock_pts", parseFloat(e.target.value) || (isSx ? 1100.0 : 270.0))}
                      className="h-8 text-xs w-16"
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {isSx ? "At +1,500 pt → +1,100 pt" : "At +340 pt → +270 pt"}
                  </p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="bg-muted/20 border-t py-3 flex justify-between items-center text-xs text-muted-foreground">
              <span>Changes apply immediately to live position manager and backtesting engines upon saving.</span>
              <Button size="sm" onClick={saveConfig} disabled={saving} className="h-7 text-xs font-semibold">
                <Save className="size-3 mr-1" /> Save Ratchet Parameters
              </Button>
            </CardFooter>
          </Card>

          {/* Section 4: Verified Performance Matrix */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldCheck className="size-4 text-emerald-400" />
                10-Year Verified Apex Duo Performance Matrix (1,439 Trades)
              </CardTitle>
              <CardDescription>
                Clean Apex Duo architecture: Trend Runner + VIX Trap under strict 1-lot fixed spot points ratchet discipline.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Strategy Engine</TableHead>
                      <TableHead>Session Window</TableHead>
                      <TableHead className="text-center">Trades</TableHead>
                      <TableHead className="text-center">Win Rate</TableHead>
                      <TableHead className="text-right">Net Spot Pts</TableHead>
                      <TableHead className="text-center">Profit Factor</TableHead>
                      <TableHead className="text-right">1-Lot Rupee PnL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="text-xs">
                    <TableRow>
                      <TableCell className="font-semibold flex items-center gap-2">
                        <span className="size-2 rounded-full bg-emerald-500 inline-block" />
                        Trend Runner (15m ORB)
                      </TableCell>
                      <TableCell className="text-muted-foreground">09:30 – 11:00</TableCell>
                      <TableCell className="text-center tabular-nums">977</TableCell>
                      <TableCell className="text-center tabular-nums">41.8%</TableCell>
                      <TableCell className="text-right tabular-nums font-semibold text-emerald-400">+15,712.5 pt</TableCell>
                      <TableCell className="text-center tabular-nums">1.98</TableCell>
                      <TableCell className="text-right tabular-nums">Rs. 10,37,138</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-semibold flex items-center gap-2">
                        <span className="size-2 rounded-full bg-amber-500 inline-block" />
                        VIX Trap (Divergence Reversal)
                      </TableCell>
                      <TableCell className="text-muted-foreground">09:30 – 11:00</TableCell>
                      <TableCell className="text-center tabular-nums">462</TableCell>
                      <TableCell className="text-center tabular-nums font-bold text-amber-400">54.3%</TableCell>
                      <TableCell className="text-right tabular-nums font-semibold text-amber-400">+11,059.9 pt</TableCell>
                      <TableCell className="text-center tabular-nums font-bold text-amber-400">2.38</TableCell>
                      <TableCell className="text-right tabular-nums">Rs. 4,41,602</TableCell>
                    </TableRow>
                    <TableRow className="bg-muted/30 font-bold border-t-2">
                      <TableCell className="text-foreground">Total Combined Apex Duo (Priority 1-Lot)</TableCell>
                      <TableCell className="text-muted-foreground">Morning Session</TableCell>
                      <TableCell className="text-center tabular-nums">1,439</TableCell>
                      <TableCell className="text-center tabular-nums">45.8%</TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-400 text-sm">+26,772.4 pt</TableCell>
                      <TableCell className="text-center tabular-nums text-emerald-400">2.12</TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-400">Rs. 14,78,741</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="strategy_info" className="mt-3">
          <StrategyInfoPage />
        </TabsContent>
      </Tabs>
      {/* Safety Confirmation Dialog for Live Trading */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable LIVE Trading?</DialogTitle>
            <DialogDescription>
              Orders will execute with REAL CAPITAL on Kotak Neo. Ensure API credentials and margin are active.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="confirm-live">Type "LIVE" to confirm:</Label>
            <Input id="confirm-live" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmLive} disabled={typed !== "LIVE"}>
              Enable LIVE Trading
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

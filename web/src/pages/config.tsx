import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Sliders,
  ShieldCheck,
  Save,
  RotateCcw,
  Zap,
  ChevronDown,
  ChevronUp,
  Layers,
  AlertTriangle,
  Flame,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { getJSON, postJSON, type Settings } from "@/lib/api"

export type SpotRatchetSettings = {
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

export type PortfolioConfig = {
  symbol: string
  trading_instruments?: "BOTH" | "NIFTY_ONLY" | "SENSEX_ONLY"
  cross_instrument_concurrency?: "FIRST_TRIGGERED" | "CONCURRENT"
  mode: "priority" | "concurrent"
  max_trades_per_day: number
  max_concurrent_positions: number
  setups: {
    trend_runner: boolean
    vix_trap: boolean
    williams_fractal?: boolean
  }
  spot_ratchet_settings: SpotRatchetSettings
  sensex_spot_ratchet_settings?: SpotRatchetSettings
}

export const DEFAULT_NIFTY_RATCHET: SpotRatchetSettings = {
  initial_sl_pts: 30.0,
  tier0a_trigger_pts: 40.0,
  tier0a_lock_pts: -15.0,
  tier0b_breakeven_trigger_pts: 55.0,
  tier0b_breakeven_lock_pts: 5.0,
  tier1_trigger_pts: 70.0,
  tier1_lock_pts: 20.0,
  tier2_trigger_pts: 110.0,
  tier2_lock_pts: 50.0,
  tier3_trigger_pts: 180.0,
  tier3_lock_pts: 110.0,
  tier4_trigger_pts: 230.0,
  tier4_lock_pts: 165.0,
  tier5_trigger_pts: 280.0,
  tier5_lock_pts: 220.0,
  tier6_trigger_pts: 330.0,
  tier6_lock_pts: 270.0,
}

export const DEFAULT_SENSEX_RATCHET: SpotRatchetSettings = {
  initial_sl_pts: 120.0,
  tier0a_trigger_pts: 115.0,
  tier0a_lock_pts: -40.0,
  tier0b_breakeven_trigger_pts: 180.0,
  tier0b_breakeven_lock_pts: 15.0,
  tier1_trigger_pts: 240.0,
  tier1_lock_pts: 80.0,
  tier2_trigger_pts: 340.0,
  tier2_lock_pts: 180.0,
  tier3_trigger_pts: 480.0,
  tier3_lock_pts: 280.0,
  tier4_trigger_pts: 650.0,
  tier4_lock_pts: 420.0,
  tier5_trigger_pts: 850.0,
  tier5_lock_pts: 600.0,
  tier6_trigger_pts: 1100.0,
  tier6_lock_pts: 850.0,
}

const DEFAULT_CONFIG: PortfolioConfig = {
  symbol: "NIFTY",
  trading_instruments: "BOTH",
  cross_instrument_concurrency: "FIRST_TRIGGERED",
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

export function ConfigPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [config, setConfig] = useState<PortfolioConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showAdvancedRatchets, setShowAdvancedRatchets] = useState(false)

  const [capitalSettings, setCapitalSettings] = useState({
    lots: 1,
    sensex_lots: 1,
    daily_loss_limit: 2500,
    per_trade_loss_limit: 650,
  })

  const [isLiveTrading, setIsLiveTrading] = useState(false)
  const [isSensexLiveTrading, setIsSensexLiveTrading] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<"NIFTY" | "SENSEX" | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [typed, setTyped] = useState("")

  useEffect(() => {
    fetchConfig()
  }, [])

  async function fetchConfig() {
    setLoading(true)
    try {
      const data = await getJSON<PortfolioConfig>("/api/portfolio/config")
      setConfig({
        ...data,
        trading_instruments: data.trading_instruments || "BOTH",
        cross_instrument_concurrency: data.cross_instrument_concurrency || "FIRST_TRIGGERED",
        spot_ratchet_settings: data.spot_ratchet_settings || DEFAULT_NIFTY_RATCHET,
        sensex_spot_ratchet_settings: data.sensex_spot_ratchet_settings || DEFAULT_SENSEX_RATCHET,
        setups: {
          trend_runner: data.setups?.trend_runner ?? true,
          vix_trap: data.setups?.vix_trap ?? true,
        },
      })
      try {
        const sData = await getJSON<Settings>("/api/settings")
        setCapitalSettings({
          lots: Math.max(1, Number(sData.lots || 1)),
          sensex_lots: Math.max(1, Number((sData as any).sensex_runner_lots || 1)),
          daily_loss_limit: sData.daily_loss_limit ?? 2500,
          per_trade_loss_limit: sData.per_trade_loss_limit ?? 650,
        })
        const live = Boolean(sData.trend_runner_live_trading || sData.midpoint_live_trading || sData.live_trading)
        setIsLiveTrading(live)
        setIsSensexLiveTrading(Boolean((sData as any).sensex_runner_live_trading))
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
          sensex_runner_lots: Number(capitalSettings.sensex_lots || 1),
          sensex_runner_live_trading: Boolean(isSensexLiveTrading),
          trend_runner_live_trading: Boolean(isLiveTrading),
          daily_loss_limit: Number(capitalSettings.daily_loss_limit),
          per_trade_loss_limit: Number(capitalSettings.per_trade_loss_limit),
        }),
      ])
      if (res.ok) {
        toast.success("Strategy settings saved successfully!")
      } else {
        toast.error("Failed to save configuration.")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error saving configuration")
    } finally {
      setSaving(false)
    }
  }

  function handleToggleLive(target: "NIFTY" | "SENSEX", enabled: boolean) {
    if (enabled) {
      setConfirmTarget(target)
      setConfirmOpen(true)
    } else {
      const payload = target === "NIFTY" 
        ? { trend_runner_live_trading: false, midpoint_live_trading: false }
        : { sensex_runner_live_trading: false }
      postJSON("/api/settings", payload)
        .then(() => {
          if (target === "NIFTY") setIsLiveTrading(false)
          else setIsSensexLiveTrading(false)
          toast.success(`${target} switched to PAPER simulation mode`)
        })
        .catch((err) => toast.error(String(err)))
    }
  }

  async function confirmLiveAction() {
    if (typed !== "LIVE" || !confirmTarget) return
    try {
      if (confirmTarget === "SENSEX") {
        await postJSON("/api/settings", { sensex_runner_live_trading: true, confirm: typed })
        setIsSensexLiveTrading(true)
        toast.success("🔥 LIVE TRADING ENABLED for SENSEX")
      } else {
        await postJSON("/api/settings", { trend_runner_live_trading: true, midpoint_live_trading: true, confirm: typed })
        setIsLiveTrading(true)
        toast.success("🔥 LIVE TRADING ENABLED for NIFTY")
      }
      setConfirmOpen(false)
      setTyped("")
      setConfirmTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  function resetToDefaults() {
    setConfig(DEFAULT_CONFIG)
    toast.info("Reset to 10-year verified defaults. Click Save to persist.")
  }

  const updateNiftyRatchet = (field: keyof SpotRatchetSettings, val: number) => {
    if (!config) return
    setConfig({
      ...config,
      spot_ratchet_settings: {
        ...(config.spot_ratchet_settings || DEFAULT_NIFTY_RATCHET),
        [field]: val,
      },
    })
  }

  const updateSensexRatchet = (field: keyof SpotRatchetSettings, val: number) => {
    if (!config) return
    setConfig({
      ...config,
      sensex_spot_ratchet_settings: {
        ...(config.sensex_spot_ratchet_settings || DEFAULT_SENSEX_RATCHET),
        [field]: val,
      },
    })
  }

  if (loading || !config) {
    return (
      <div className="flex h-72 w-full items-center justify-center text-xs font-mono text-muted-foreground animate-pulse">
        Loading strategy configuration...
      </div>
    )
  }

  const activeInst = config.trading_instruments || "BOTH"
  const isParallelRace = activeInst === "BOTH" && config.cross_instrument_concurrency !== "CONCURRENT"
  const isConcurrent = activeInst === "BOTH" && config.cross_instrument_concurrency === "CONCURRENT"

  return (
    <div className={cn("space-y-4 max-w-5xl mx-auto", embedded ? "w-full" : "p-3 sm:p-5")}>
      {/* Top Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="outline" className="border-sky-500/40 text-sky-400 bg-sky-500/10 gap-1 text-[11px]">
              <Sliders className="size-3" /> Strategy Control Center
            </Badge>
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 bg-emerald-500/10 gap-1 text-[11px]">
              <ShieldCheck className="size-3" /> +30,699 pts Verified
            </Badge>
          </div>
          <h2 className="text-xl font-bold tracking-tight">Strategy &amp; Instrument Configuration</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure index trading modes, risk rules, and execution policy in one streamlined view.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={resetToDefaults} className="text-xs h-8">
            <RotateCcw className="size-3 mr-1.5" /> Defaults
          </Button>
          <Button size="sm" onClick={saveConfig} disabled={saving} className="bg-primary text-primary-foreground font-semibold text-xs h-8">
            <Save className="size-3 mr-1.5" /> {saving ? "Saving..." : "Save Configuration"}
          </Button>
        </div>
      </div>

      {/* 1. INSTRUMENT & EXECUTION MODE SELECTOR */}
      <Card className="border-border bg-card shadow-xs">
        <CardHeader className="pb-3 pt-4 px-4 sm:px-5">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Zap className="size-4 text-amber-400" />
                Trading Instrument &amp; Execution Mode
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Select how the strategy executes across Nifty and Sensex.
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-xs font-mono font-semibold">
              {isParallelRace
                ? "⚡ First-Triggered Race"
                : isConcurrent
                ? "👥 Dual Concurrent"
                : activeInst === "NIFTY_ONLY"
                ? "🟢 Nifty 50 Only"
                : "🔵 Sensex Only"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="px-4 sm:px-5 pb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            {/* Mode 1: Parallel Race (Whichever Triggers First) */}
            <button
              type="button"
              onClick={() =>
                setConfig({
                  ...config,
                  trading_instruments: "BOTH",
                  cross_instrument_concurrency: "FIRST_TRIGGERED",
                  max_concurrent_positions: 1,
                })
              }
              className={cn(
                "p-3 rounded-xl border text-left transition-all flex flex-col justify-between cursor-pointer space-y-2",
                isParallelRace
                  ? "border-amber-500 bg-amber-500/10 ring-1 ring-amber-500/30 shadow-xs"
                  : "border-border/70 hover:border-border bg-muted/20 hover:bg-muted/40"
              )}
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs flex items-center gap-1.5 text-foreground">
                    <Zap className="size-3.5 text-amber-400" /> Parallel Race
                  </span>
                  <Badge variant="outline" className="text-[10px] bg-amber-500/20 text-amber-400 border-amber-500/30 px-1 py-0">
                    Recommended
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                  Whichever index triggers first takes the trade. Locks out the other index while trade is active (strictly 1 position).
                </p>
              </div>
              <span className="text-[10px] font-mono text-amber-400 font-semibold block pt-1 border-t border-border/40">
                Max 1 Active Trade
              </span>
            </button>

            {/* Mode 2: Both Concurrent */}
            <button
              type="button"
              onClick={() =>
                setConfig({
                  ...config,
                  trading_instruments: "BOTH",
                  cross_instrument_concurrency: "CONCURRENT",
                  max_concurrent_positions: 2,
                })
              }
              className={cn(
                "p-3 rounded-xl border text-left transition-all flex flex-col justify-between cursor-pointer space-y-2",
                isConcurrent
                  ? "border-sky-500 bg-sky-500/10 ring-1 ring-sky-500/30 shadow-xs"
                  : "border-border/70 hover:border-border bg-muted/20 hover:bg-muted/40"
              )}
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs flex items-center gap-1.5 text-foreground">
                    <Layers className="size-3.5 text-sky-400" /> Dual Concurrent
                  </span>
                  <Badge variant="secondary" className="text-[10px] px-1 py-0">
                    Dual
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                  Both Nifty and Sensex can hold open trades simultaneously if both setups trigger. Requires margin for both.
                </p>
              </div>
              <span className="text-[10px] font-mono text-sky-400 font-semibold block pt-1 border-t border-border/40">
                Up to 2 Active Trades
              </span>
            </button>

            {/* Mode 3: Nifty Only */}
            <button
              type="button"
              onClick={() =>
                setConfig({
                  ...config,
                  trading_instruments: "NIFTY_ONLY",
                  max_concurrent_positions: 1,
                })
              }
              className={cn(
                "p-3 rounded-xl border text-left transition-all flex flex-col justify-between cursor-pointer space-y-2",
                activeInst === "NIFTY_ONLY"
                  ? "border-emerald-500 bg-emerald-500/10 ring-1 ring-emerald-500/30 shadow-xs"
                  : "border-border/70 hover:border-border bg-muted/20 hover:bg-muted/40"
              )}
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs flex items-center gap-1.5 text-foreground">
                    <span className="size-2 rounded-full bg-emerald-400" /> Nifty 50 Only
                  </span>
                  <Badge variant="secondary" className="text-[10px] px-1 py-0">
                    NSE
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                  Trades exclusively NSE Nifty 50. Lowest slippage, tight 0.05 bid-ask spread, 25 qty lot size.
                </p>
              </div>
              <span className="text-[10px] font-mono text-emerald-400 font-semibold block pt-1 border-t border-border/40">
                1 Trade at a Time
              </span>
            </button>

            {/* Mode 4: Sensex Only */}
            <button
              type="button"
              onClick={() =>
                setConfig({
                  ...config,
                  trading_instruments: "SENSEX_ONLY",
                  max_concurrent_positions: 1,
                })
              }
              className={cn(
                "p-3 rounded-xl border text-left transition-all flex flex-col justify-between cursor-pointer space-y-2",
                activeInst === "SENSEX_ONLY"
                  ? "border-purple-500 bg-purple-500/10 ring-1 ring-purple-500/30 shadow-xs"
                  : "border-border/70 hover:border-border bg-muted/20 hover:bg-muted/40"
              )}
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs flex items-center gap-1.5 text-foreground">
                    <span className="size-2 rounded-full bg-purple-400" /> Sensex Only
                  </span>
                  <Badge variant="secondary" className="text-[10px] px-1 py-0">
                    BSE
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                  Trades exclusively BSE Sensex. High point ATR (+300 to +800 pts) with 20 qty lot size.
                </p>
              </div>
              <span className="text-[10px] font-mono text-purple-400 font-semibold block pt-1 border-t border-border/40">
                1 Trade at a Time
              </span>
            </button>
          </div>
        </CardContent>
      </Card>

      {/* 2. CORE STRATEGY & RISK CONTROLS */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Setups Card */}
        <Card className="border-border bg-card shadow-xs">
          <CardHeader className="pb-3 pt-4 px-4 sm:px-5">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Sliders className="size-4 text-sky-400" /> Strategy Setups
            </CardTitle>
            <CardDescription className="text-xs">
              Enable or disable the strategy breakout &amp; reversal engines.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4 sm:px-5 pb-4 space-y-3">
            <div className="p-3 rounded-xl border bg-muted/15 flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <Label className="text-xs font-bold text-foreground">Trend Runner (15m ORB)</Label>
                <p className="text-[11px] text-muted-foreground">
                  Opening range breakout with VIX momentum confirmation. Cutoff: 10:45 AM.
                </p>
              </div>
              <Switch
                checked={config.setups.trend_runner}
                onCheckedChange={(val) =>
                  setConfig({ ...config, setups: { ...config.setups, trend_runner: val } })
                }
              />
            </div>

            <div className="p-3 rounded-xl border bg-muted/15 flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <Label className="text-xs font-bold text-foreground">VIX Trap Reversal</Label>
                <p className="text-[11px] text-muted-foreground">
                  Sniper reversal against false morning breakouts using VIX divergence.
                </p>
              </div>
              <Switch
                checked={config.setups.vix_trap}
                onCheckedChange={(val) =>
                  setConfig({ ...config, setups: { ...config.setups, vix_trap: val } })
                }
              />
            </div>
          </CardContent>
        </Card>

        {/* Risk & Limits Card */}
        <Card className="border-border bg-card shadow-xs">
          <CardHeader className="pb-3 pt-4 px-4 sm:px-5">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <ShieldCheck className="size-4 text-emerald-400" /> Risk &amp; Sizing Controls
            </CardTitle>
            <CardDescription className="text-xs">
              Daily trade frequency, lot size, and circuit breaker.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4 sm:px-5 pb-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Max Trades / Day</Label>
                <Input
                  type="number"
                  min={1}
                  max={4}
                  value={config.max_trades_per_day}
                  onChange={(e) =>
                    setConfig({ ...config, max_trades_per_day: parseInt(e.target.value) || 2 })
                  }
                  className="h-8 text-xs font-mono font-bold"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Daily Loss Limit (₹)</Label>
                <Input
                  type="number"
                  step={250}
                  value={capitalSettings.daily_loss_limit}
                  onChange={(e) =>
                    setCapitalSettings({ ...capitalSettings, daily_loss_limit: parseFloat(e.target.value) || 2500 })
                  }
                  className="h-8 text-xs font-mono font-bold text-rose-400"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Nifty Lots (25 Qty)</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={capitalSettings.lots}
                  onChange={(e) =>
                    setCapitalSettings({ ...capitalSettings, lots: Math.max(1, parseInt(e.target.value) || 1) })
                  }
                  className="h-8 text-xs font-mono font-bold"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Sensex Lots (20 Qty)</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={capitalSettings.sensex_lots}
                  onChange={(e) =>
                    setCapitalSettings({ ...capitalSettings, sensex_lots: Math.max(1, parseInt(e.target.value) || 1) })
                  }
                  className="h-8 text-xs font-mono font-bold"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 3. EXECUTION STATUS: PAPER vs LIVE */}
      <Card className="border-border bg-card shadow-xs">
        <CardHeader className="pb-2 pt-3 px-4 sm:px-5">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Flame className="size-4 text-orange-400" /> Execution Mode (Paper vs Live Broker)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 sm:px-5 pb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Nifty Execution Toggle */}
            <div className={cn(
              "p-3 rounded-xl border flex items-center justify-between gap-3 transition-colors",
              isLiveTrading ? "border-rose-500/60 bg-rose-500/10" : "border-border/60 bg-muted/15"
            )}>
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-foreground">NSE Nifty 50</span>
                  <Badge variant={isLiveTrading ? "destructive" : "secondary"} className="text-[10px] px-1 py-0">
                    {isLiveTrading ? "🔥 LIVE TRADING" : "PAPER SIMULATION"}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {isLiveTrading ? "Real orders routed to Kotak Neo" : "Simulated fills based on 1-min live stream"}
                </p>
              </div>
              <Switch
                checked={isLiveTrading}
                onCheckedChange={(val) => handleToggleLive("NIFTY", val)}
              />
            </div>

            {/* Sensex Execution Toggle */}
            <div className={cn(
              "p-3 rounded-xl border flex items-center justify-between gap-3 transition-colors",
              isSensexLiveTrading ? "border-rose-500/60 bg-rose-500/10" : "border-border/60 bg-muted/15"
            )}>
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-foreground">BSE Sensex</span>
                  <Badge variant={isSensexLiveTrading ? "destructive" : "secondary"} className="text-[10px] px-1 py-0">
                    {isSensexLiveTrading ? "🔥 LIVE TRADING" : "PAPER SIMULATION"}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {isSensexLiveTrading ? "Real orders routed to Kotak Neo" : "Simulated fills based on 1-min live stream"}
                </p>
              </div>
              <Switch
                checked={isSensexLiveTrading}
                onCheckedChange={(val) => handleToggleLive("SENSEX", val)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 4. ADVANCED RATCHET LADDERS (COLLAPSIBLE / ACCORDION) */}
      <Card className="border-border bg-card shadow-xs">
        <CardHeader
          onClick={() => setShowAdvancedRatchets(!showAdvancedRatchets)}
          className="py-3 px-4 sm:px-5 cursor-pointer flex flex-row items-center justify-between hover:bg-muted/10 transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="size-4 text-emerald-400" />
            <div>
              <CardTitle className="text-xs font-bold text-foreground">
                Advanced Spot Ratchet Ladders (10-Year Verified Combo B)
              </CardTitle>
              <CardDescription className="text-[11px]">
                Nifty: 30pt SL | R1: +70/20 | R2: +110/50 | R3: +180/110 · Sensex: 120pt SL | R1: +240/80 | R2: +340/180
              </CardDescription>
            </div>
          </div>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0 text-muted-foreground">
            {showAdvancedRatchets ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
        </CardHeader>

        {showAdvancedRatchets && (
          <CardContent className="px-4 sm:px-5 pb-4 pt-2 border-t border-border/40 space-y-4">
            <p className="text-xs text-muted-foreground">
              These ladders were calibrated across 2,107 trading days. It is recommended to keep these verified defaults.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Nifty Ladder */}
              <div className="p-3 rounded-xl border bg-muted/15 space-y-2.5">
                <span className="text-xs font-bold text-emerald-400 block border-b pb-1">
                  🟢 NIFTY Ratchet Ladder
                </span>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Initial SL (pts)</Label>
                    <Input
                      type="number"
                      value={config.spot_ratchet_settings?.initial_sl_pts ?? 30.0}
                      onChange={(e) => updateNiftyRatchet("initial_sl_pts", parseFloat(e.target.value) || 30.0)}
                      className="h-7 text-xs font-mono font-bold"
                    />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Tier 1 (+Trigger / Lock)</Label>
                    <div className="flex gap-1">
                      <Input
                        type="number"
                        value={config.spot_ratchet_settings?.tier1_trigger_pts ?? 70.0}
                        onChange={(e) => updateNiftyRatchet("tier1_trigger_pts", parseFloat(e.target.value) || 70.0)}
                        className="h-7 text-xs font-mono font-bold"
                      />
                      <Input
                        type="number"
                        value={config.spot_ratchet_settings?.tier1_lock_pts ?? 20.0}
                        onChange={(e) => updateNiftyRatchet("tier1_lock_pts", parseFloat(e.target.value) || 20.0)}
                        className="h-7 text-xs font-mono font-bold"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Tier 2 (+Trigger / Lock)</Label>
                    <div className="flex gap-1">
                      <Input
                        type="number"
                        value={config.spot_ratchet_settings?.tier2_trigger_pts ?? 110.0}
                        onChange={(e) => updateNiftyRatchet("tier2_trigger_pts", parseFloat(e.target.value) || 110.0)}
                        className="h-7 text-xs font-mono font-bold"
                      />
                      <Input
                        type="number"
                        value={config.spot_ratchet_settings?.tier2_lock_pts ?? 50.0}
                        onChange={(e) => updateNiftyRatchet("tier2_lock_pts", parseFloat(e.target.value) || 50.0)}
                        className="h-7 text-xs font-mono font-bold"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Tier 3 (+Trigger / Lock)</Label>
                    <div className="flex gap-1">
                      <Input
                        type="number"
                        value={config.spot_ratchet_settings?.tier3_trigger_pts ?? 180.0}
                        onChange={(e) => updateNiftyRatchet("tier3_trigger_pts", parseFloat(e.target.value) || 180.0)}
                        className="h-7 text-xs font-mono font-bold"
                      />
                      <Input
                        type="number"
                        value={config.spot_ratchet_settings?.tier3_lock_pts ?? 110.0}
                        onChange={(e) => updateNiftyRatchet("tier3_lock_pts", parseFloat(e.target.value) || 110.0)}
                        className="h-7 text-xs font-mono font-bold"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Sensex Ladder */}
              <div className="p-3 rounded-xl border bg-muted/15 space-y-2.5">
                <span className="text-xs font-bold text-sky-400 block border-b pb-1">
                  🔵 SENSEX Ratchet Ladder
                </span>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Initial SL (pts)</Label>
                    <Input
                      type="number"
                      value={config.sensex_spot_ratchet_settings?.initial_sl_pts ?? 120.0}
                      onChange={(e) => updateSensexRatchet("initial_sl_pts", parseFloat(e.target.value) || 120.0)}
                      className="h-7 text-xs font-mono font-bold"
                    />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Tier 1 (+Trigger / Lock)</Label>
                    <div className="flex gap-1">
                      <Input
                        type="number"
                        value={config.sensex_spot_ratchet_settings?.tier1_trigger_pts ?? 240.0}
                        onChange={(e) => updateSensexRatchet("tier1_trigger_pts", parseFloat(e.target.value) || 240.0)}
                        className="h-7 text-xs font-mono font-bold"
                      />
                      <Input
                        type="number"
                        value={config.sensex_spot_ratchet_settings?.tier1_lock_pts ?? 80.0}
                        onChange={(e) => updateSensexRatchet("tier1_lock_pts", parseFloat(e.target.value) || 80.0)}
                        className="h-7 text-xs font-mono font-bold"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Tier 2 (+Trigger / Lock)</Label>
                    <div className="flex gap-1">
                      <Input
                        type="number"
                        value={config.sensex_spot_ratchet_settings?.tier2_trigger_pts ?? 340.0}
                        onChange={(e) => updateSensexRatchet("tier2_trigger_pts", parseFloat(e.target.value) || 340.0)}
                        className="h-7 text-xs font-mono font-bold"
                      />
                      <Input
                        type="number"
                        value={config.sensex_spot_ratchet_settings?.tier2_lock_pts ?? 180.0}
                        onChange={(e) => updateSensexRatchet("tier2_lock_pts", parseFloat(e.target.value) || 180.0)}
                        className="h-7 text-xs font-mono font-bold"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Tier 3 (+Trigger / Lock)</Label>
                    <div className="flex gap-1">
                      <Input
                        type="number"
                        value={config.sensex_spot_ratchet_settings?.tier3_trigger_pts ?? 480.0}
                        onChange={(e) => updateSensexRatchet("tier3_trigger_pts", parseFloat(e.target.value) || 480.0)}
                        className="h-7 text-xs font-mono font-bold"
                      />
                      <Input
                        type="number"
                        value={config.sensex_spot_ratchet_settings?.tier3_lock_pts ?? 280.0}
                        onChange={(e) => updateSensexRatchet("tier3_lock_pts", parseFloat(e.target.value) || 280.0)}
                        className="h-7 text-xs font-mono font-bold"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Safety Confirmation Modal for Live Trading */}
      <Dialog open={confirmOpen} onOpenChange={(o) => { if (!o) { setConfirmOpen(false); setTyped(""); setConfirmTarget(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-500 text-base">
              <AlertTriangle className="size-5 shrink-0" />
              Confirm LIVE Trading Mode ({confirmTarget})
            </DialogTitle>
            <DialogDescription className="text-xs pt-1.5 leading-relaxed">
              You are about to activate real live orders routed to Kotak Neo. Real capital is at risk. Type <strong className="text-foreground">LIVE</strong> below to confirm.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2">
            <Label htmlFor="live-confirm" className="text-xs text-muted-foreground">Type LIVE to proceed:</Label>
            <Input
              id="live-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value.toUpperCase())}
              placeholder="LIVE"
              className="text-xs font-mono font-bold"
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => { setConfirmOpen(false); setTyped(""); setConfirmTarget(null); }}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={typed !== "LIVE"}
              onClick={confirmLiveAction}
              className="font-semibold text-xs"
            >
              Activate Live Trading
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

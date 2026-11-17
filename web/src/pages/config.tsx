import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Sliders,
  ShieldCheck,
  Save,
  RotateCcw,
  Layers,
  Info,
  TrendingUp,
  Zap,
  Target,
  ChevronDown,
  ChevronUp,
  Scale,
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
import { StrategyInfoPage } from "./strategy-info"

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
  mode: "priority" | "concurrent"
  max_trades_per_day: number
  max_concurrent_positions: number
  setups: {
    trend_runner: boolean
    vix_trap: boolean
    williams_fractal?: boolean
    vix_master_morning?: boolean
    williams_afternoon?: boolean
    vix_master_afternoon?: boolean
    gap_and_go_morning?: boolean
  }
  spot_ratchet_settings: SpotRatchetSettings
  sensex_spot_ratchet_settings?: SpotRatchetSettings
}

export const DEFAULT_NIFTY_RATCHET: SpotRatchetSettings = {
  initial_sl_pts: 28.0,
  tier0a_trigger_pts: 35.0,
  tier0a_lock_pts: -12.0,
  tier0b_breakeven_trigger_pts: 50.0,
  tier0b_breakeven_lock_pts: 5.0,
  tier1_trigger_pts: 70.0,
  tier1_lock_pts: 25.0,
  tier2_trigger_pts: 95.0,
  tier2_lock_pts: 50.0,
  tier3_trigger_pts: 135.0,
  tier3_lock_pts: 85.0,
  tier4_trigger_pts: 180.0,
  tier4_lock_pts: 125.0,
  tier5_trigger_pts: 230.0,
  tier5_lock_pts: 175.0,
  tier6_trigger_pts: 290.0,
  tier6_lock_pts: 230.0,
}

export const DEFAULT_SENSEX_RATCHET: SpotRatchetSettings = {
  initial_sl_pts: 100.0,
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
  const [showHandbook, setShowHandbook] = useState(false)

  const [capitalSettings, setCapitalSettings] = useState({
    lots: 1,
    sensex_lots: 1,
    daily_loss_limit: 2500,
    per_trade_loss_limit: 650,
    per_trade_loss_pct: 20,
    per_trade_auto_cut: true,
    minimum_live_funds: 10000,
    sizing_mode: "fixed",
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
      const setups = {
        trend_runner: data.setups?.trend_runner ?? true,
        vix_trap: data.setups?.vix_trap ?? true,
      }
      setConfig({
        ...data,
        trading_instruments: data.trading_instruments || "BOTH",
        spot_ratchet_settings: data.spot_ratchet_settings || DEFAULT_NIFTY_RATCHET,
        sensex_spot_ratchet_settings: data.sensex_spot_ratchet_settings || DEFAULT_SENSEX_RATCHET,
        setups,
      })
      try {
        const sData = await getJSON<Settings>("/api/settings")
        setCapitalSettings({
          lots: sData.sizing_mode === "fixed" ? 1 : Math.max(1, Number(sData.lots || 1)),
          sensex_lots: Math.max(1, Number((sData as any).sensex_runner_lots || 1)),
          daily_loss_limit: sData.daily_loss_limit ?? 2500,
          per_trade_loss_limit: sData.per_trade_loss_limit ?? 650,
          per_trade_loss_pct: sData.per_trade_loss_pct ?? 20,
          per_trade_auto_cut: sData.per_trade_auto_cut ?? true,
          minimum_live_funds: sData.minimum_live_funds ?? 10000,
          sizing_mode: sData.sizing_mode || "fixed",
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
          per_trade_loss_pct: Number(capitalSettings.per_trade_loss_pct),
          per_trade_auto_cut: Boolean(capitalSettings.per_trade_auto_cut),
          minimum_live_funds: Number(capitalSettings.minimum_live_funds),
          sizing_mode: capitalSettings.sizing_mode,
        }),
      ])
      if (res.ok) {
        toast.success("Apex Duo strategy & multi-index configuration saved!")
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

  function handleToggleNiftyLive(enabled: boolean) {
    if (enabled) {
      setConfirmTarget("NIFTY")
      setConfirmOpen(true)
    } else {
      postJSON("/api/settings", { trend_runner_live_trading: false, midpoint_live_trading: false })
        .then(() => {
          setIsLiveTrading(false)
          toast.success("NSE Nifty switched to PAPER simulation mode")
        })
        .catch((err) => toast.error(String(err)))
    }
  }

  function handleToggleSensexLive(enabled: boolean) {
    if (enabled) {
      setConfirmTarget("SENSEX")
      setConfirmOpen(true)
    } else {
      postJSON("/api/settings", { sensex_runner_live_trading: false })
        .then(() => {
          setIsSensexLiveTrading(false)
          toast.success("BSE Sensex switched to PAPER simulation mode")
        })
        .catch((err) => toast.error(String(err)))
    }
  }

  async function confirmLiveAction() {
    if (typed !== "LIVE" || !confirmTarget) return
    try {
      if (confirmTarget === "SENSEX") {
        await postJSON("/api/settings", {
          sensex_runner_live_trading: true,
          confirm: typed,
        })
        setIsSensexLiveTrading(true)
        toast.success("🔥 LIVE TRADING ENABLED for BSE SENSEX - Real orders active on Kotak Neo")
      } else {
        await postJSON("/api/settings", {
          trend_runner_live_trading: true,
          midpoint_live_trading: true,
          confirm: typed,
        })
        setIsLiveTrading(true)
        toast.success("🔥 LIVE TRADING ENABLED for NSE NIFTY - Real orders active on Kotak Neo")
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
    toast.info("Reset to production recommended parameters. Click Save to persist.")
  }

  const updateNiftyRatchet = (field: keyof SpotRatchetSettings, val: number) => {
    if (!config) return
    const prev = config.spot_ratchet_settings || { ...DEFAULT_NIFTY_RATCHET }
    setConfig({
      ...config,
      spot_ratchet_settings: {
        ...prev,
        [field]: val,
      },
    })
  }

  const updateSensexRatchet = (field: keyof SpotRatchetSettings, val: number) => {
    if (!config) return
    const prev = config.sensex_spot_ratchet_settings || { ...DEFAULT_SENSEX_RATCHET }
    setConfig({
      ...config,
      sensex_spot_ratchet_settings: {
        ...prev,
        [field]: val,
      },
    })
  }

  if (loading || !config) {
    return (
      <div className="flex h-96 w-full items-center justify-center text-sm text-muted-foreground animate-pulse">
        Loading Unified Multi-Index Strategy Settings...
      </div>
    )
  }

  const activeInstruments = config.trading_instruments || "BOTH"
  const activeSetupsCount = [config.setups.trend_runner, config.setups.vix_trap].filter(Boolean).length

  const niftyRatchet = config.spot_ratchet_settings || DEFAULT_NIFTY_RATCHET
  const sensexRatchet = config.sensex_spot_ratchet_settings || DEFAULT_SENSEX_RATCHET

  return (
    <div className={embedded ? "w-full space-y-5" : "w-full flex-1 space-y-5 p-1 sm:p-2 md:p-3"}>
      {/* Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <Badge variant="outline" className="border-sky-500/40 text-sky-400 bg-sky-500/10 gap-1 text-xs">
              <Sliders className="size-3" /> Apex Duo Multi-Index
            </Badge>
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 bg-emerald-500/10 gap-1 text-xs">
              <ShieldCheck className="size-3" /> 10-Year Verified Engine
            </Badge>
            <Badge variant="outline" className="border-amber-500/40 text-amber-400 bg-amber-500/10 gap-1 text-xs">
              {activeSetupsCount} / 2 Setups Active
            </Badge>
            <Badge variant="secondary" className="text-xs font-mono">
              Active: {activeInstruments === "BOTH" ? "NIFTY & SENSEX (DUAL)" : activeInstruments}
            </Badge>
          </div>
          <h2 className="text-xl md:text-2xl font-bold tracking-tight">Strategy Configuration &amp; Instrument Control</h2>
          <p className="text-xs md:text-sm text-muted-foreground mt-1">
            Universal core strategy engine for NSE Nifty 50 and BSE Sensex. Engine rules apply globally; instrument-specific lot sizes, execution modes, and spot ratchet ladders are displayed together without tabs.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={resetToDefaults}>
            <RotateCcw className="size-3.5 mr-1.5" /> Reset Defaults
          </Button>
          <Button size="sm" onClick={saveConfig} disabled={saving} className="bg-primary text-primary-foreground font-semibold shadow-xs">
            <Save className="size-3.5 mr-1.5" /> {saving ? "Saving..." : "Save Configuration"}
          </Button>
        </div>
      </div>

      {/* TOP SECTION 1: WHICH INSTRUMENT IS RIGHT FOR TRADING? */}
      <Card className="border-border bg-card shadow-xs">
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Target className="size-4 text-sky-400" />
                Active Trading Instrument Selection
              </CardTitle>
              <CardDescription>
                Choose which index the engine should trade: Trade Both simultaneously (Apex Duo) or focus strictly on one.
              </CardDescription>
            </div>
            <Badge
              variant="outline"
              className={
                activeInstruments === "BOTH"
                  ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10 font-bold text-xs"
                  : activeInstruments === "NIFTY_ONLY"
                  ? "border-teal-500/40 text-teal-400 bg-teal-500/10 font-bold text-xs"
                  : "border-sky-500/40 text-sky-400 bg-sky-500/10 font-bold text-xs"
              }
            >
              {activeInstruments === "BOTH"
                ? "🟢 & 🔵 DUAL INDEX ACTIVE (BOTH)"
                : activeInstruments === "NIFTY_ONLY"
                ? "🟢 NSE NIFTY 50 ONLY"
                : "🔵 BSE SENSEX ONLY"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Main 3-Option Button Switcher */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Option 1: Trade BOTH */}
            <button
              type="button"
              onClick={() => setConfig({ ...config, trading_instruments: "BOTH" })}
              className={cn(
                "p-3.5 rounded-xl border text-left transition-all relative flex flex-col justify-between cursor-pointer",
                activeInstruments === "BOTH"
                  ? "border-emerald-500 bg-emerald-500/10 shadow-sm ring-1 ring-emerald-500/30"
                  : "border-border/70 hover:border-border bg-muted/20 hover:bg-muted/40"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex -space-x-1">
                    <span className="size-2.5 rounded-full bg-emerald-400 inline-block ring-2 ring-background" />
                    <span className="size-2.5 rounded-full bg-sky-400 inline-block ring-2 ring-background" />
                  </div>
                  <span className="font-extrabold text-sm text-foreground">Trade BOTH (Dual Index)</span>
                </div>
                <Badge variant="outline" className="text-[10px] bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                  Recommended
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                Runs simultaneous 15m OR breakout + VIX confluence on both Nifty &amp; Sensex. You capture the trend whichever exchange leads.
              </p>
              <div className="mt-3 pt-2 border-t border-border/40 flex items-center justify-between text-[11px] font-mono text-muted-foreground">
                <span>Capital: ≥ ₹1.5L</span>
                <span className="text-emerald-400 font-bold">Max Edge</span>
              </div>
            </button>

            {/* Option 2: NIFTY 50 Only */}
            <button
              type="button"
              onClick={() => setConfig({ ...config, trading_instruments: "NIFTY_ONLY" })}
              className={cn(
                "p-3.5 rounded-xl border text-left transition-all relative flex flex-col justify-between cursor-pointer",
                activeInstruments === "NIFTY_ONLY"
                  ? "border-emerald-500 bg-emerald-500/10 shadow-sm ring-1 ring-emerald-500/30"
                  : "border-border/70 hover:border-border bg-muted/20 hover:bg-muted/40"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full bg-emerald-400 inline-block" />
                  <span className="font-extrabold text-sm text-foreground">Trade NIFTY 50 Only</span>
                </div>
                <Badge variant="secondary" className="text-[10px]">
                  NSE Focus
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                Trades only NSE Nifty 50. Ideal for lower capital, ultra-tight 0.05 bid-ask spread, and minimal option slippage.
              </p>
              <div className="mt-3 pt-2 border-t border-border/40 flex items-center justify-between text-[11px] font-mono text-muted-foreground">
                <span>Capital: ~₹65k / Lot</span>
                <span className="text-sky-400 font-bold">High Liquidity</span>
              </div>
            </button>

            {/* Option 3: SENSEX Only */}
            <button
              type="button"
              onClick={() => setConfig({ ...config, trading_instruments: "SENSEX_ONLY" })}
              className={cn(
                "p-3.5 rounded-xl border text-left transition-all relative flex flex-col justify-between cursor-pointer",
                activeInstruments === "SENSEX_ONLY"
                  ? "border-sky-500 bg-sky-500/10 shadow-sm ring-1 ring-sky-500/30"
                  : "border-border/70 hover:border-border bg-muted/20 hover:bg-muted/40"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full bg-sky-400 inline-block" />
                  <span className="font-extrabold text-sm text-foreground">Trade BSE SENSEX Only</span>
                </div>
                <Badge variant="secondary" className="text-[10px]">
                  BSE Focus
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                Trades only BSE Sensex. High point ATR (+300 to +800 pt runs) with 20 qty lot size. Ideal for Tuesday/Friday trending days.
              </p>
              <div className="mt-3 pt-2 border-t border-border/40 flex items-center justify-between text-[11px] font-mono text-muted-foreground">
                <span>Capital: ~₹60k / Lot</span>
                <span className="text-purple-400 font-bold">Explosive Moves</span>
              </div>
            </button>
          </div>

          {/* Regime Decision Matrix: Which is right for you? */}
          <div className="rounded-xl border border-border/70 bg-muted/30 p-3.5 space-y-2.5">
            <div className="flex items-center gap-2 text-xs font-bold text-foreground">
              <Scale className="size-4 text-sky-400" />
              <span>Which Instrument Is Right For You? (Decision Guide)</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-xs">
              <div className="p-2.5 rounded-lg bg-card/60 border border-border/50">
                <span className="font-bold text-foreground block">When to choose BOTH:</span>
                <p className="text-muted-foreground mt-1 text-[11px]">
                  Recommended default. If you have ₹1.5L+ capital, running both gives highest statistical consistency because Sensex and Nifty rotate market leadership.
                </p>
              </div>
              <div className="p-2.5 rounded-lg bg-card/60 border border-border/50">
                <span className="font-bold text-foreground block">When to choose NIFTY ONLY:</span>
                <p className="text-muted-foreground mt-1 text-[11px]">
                  Best when capital is ~₹65k–₹1L, or during tight, range-bound regimes (India VIX 11–13) where narrow option bid-ask spreads keep slippage virtually zero.
                </p>
              </div>
              <div className="p-2.5 rounded-lg bg-card/60 border border-border/50">
                <span className="font-bold text-foreground block">When to choose SENSEX ONLY:</span>
                <p className="text-muted-foreground mt-1 text-[11px]">
                  Best on high-volatility sessions (VIX &gt; 14) and Sensex weekly expiry days. Offers enormous +400 to +600 pt excursions with 20 qty lot size.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* TOP SECTION 2: GLOBAL STRATEGY & RISK GUARDIAN (APPLIES TO BOTH) */}
      <Card className="border-border bg-card shadow-xs">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Layers className="size-4 text-sky-400" />
                Universal Strategy Engine &amp; Capital Guardian
              </CardTitle>
              <CardDescription>
                Core strategy setups and risk limits applied universally across both Nifty and Sensex.
              </CardDescription>
            </div>
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 bg-emerald-500/10 text-xs font-mono">
              Universal Engine
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Setup 1: Trend Runner */}
            <div className="p-3 rounded-lg border bg-card/60 flex items-center justify-between gap-3">
              <div className="space-y-0.5 min-w-0">
                <Label className="text-xs font-bold text-foreground block truncate">Trend Runner ORB</Label>
                <p className="text-[11px] text-muted-foreground truncate">15m OR breakout + VWAP</p>
              </div>
              <Switch
                checked={config.setups.trend_runner}
                onCheckedChange={(val) =>
                  setConfig({
                    ...config,
                    setups: { ...config.setups, trend_runner: val },
                  })
                }
              />
            </div>

            {/* Setup 2: VIX Trap */}
            <div className="p-3 rounded-lg border bg-card/60 flex items-center justify-between gap-3">
              <div className="space-y-0.5 min-w-0">
                <Label className="text-xs font-bold text-foreground block truncate">VIX Trap Reversal</Label>
                <p className="text-[11px] text-muted-foreground truncate">Fade false breakouts</p>
              </div>
              <Switch
                checked={config.setups.vix_trap}
                onCheckedChange={(val) =>
                  setConfig({
                    ...config,
                    setups: { ...config.setups, vix_trap: val },
                  })
                }
              />
            </div>

            {/* Daily Loss Circuit Breaker */}
            <div className="p-3 rounded-lg border bg-card/60 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <Label htmlFor="daily-loss" className="text-muted-foreground font-medium">Daily Loss Limit</Label>
                <span className="text-[10px] text-rose-400 font-mono font-bold">Auto-Halt</span>
              </div>
              <Input
                id="daily-loss"
                type="number"
                step={250}
                value={capitalSettings.daily_loss_limit}
                onChange={(e) =>
                  setCapitalSettings({ ...capitalSettings, daily_loss_limit: parseFloat(e.target.value) || 2500 })
                }
                className="h-8 text-xs font-mono font-bold"
              />
              <p className="text-[10px] text-muted-foreground">Hard daily account circuit breaker</p>
            </div>

            {/* Max Trades Per Day */}
            <div className="p-3 rounded-lg border bg-card/60 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <Label htmlFor="max-trades" className="text-muted-foreground font-medium">Max Trades / Day</Label>
                <span className="text-[10px] text-sky-400 font-mono font-bold">{config.mode.toUpperCase()}</span>
              </div>
              <Input
                id="max-trades"
                type="number"
                min={1}
                max={4}
                value={config.max_trades_per_day}
                onChange={(e) =>
                  setConfig({ ...config, max_trades_per_day: parseInt(e.target.value) || 2 })
                }
                className="h-8 text-xs font-mono font-bold"
              />
              <p className="text-[10px] text-muted-foreground">Maximum trades per index session</p>
            </div>
          </div>

          {/* Sizing & Mode Info Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
            <div className="p-2.5 rounded-lg border bg-muted/20 text-xs space-y-1">
              <span className="text-muted-foreground text-[10px] font-bold uppercase tracking-wider block">Target Philosophy</span>
              <span className="font-semibold text-foreground">Uncapped Pure Ride to 15:15</span>
              <p className="text-[10px] text-muted-foreground">Trailing SL locks profit sequentially; runner rides full extension</p>
            </div>
            <div className="p-2.5 rounded-lg border bg-muted/20 text-xs space-y-1">
              <span className="text-muted-foreground text-[10px] font-bold uppercase tracking-wider block">Risk-Free Pyramiding</span>
              <span className="font-semibold text-foreground">Tier 1 Automatic Lot 2 Add</span>
              <p className="text-[10px] text-muted-foreground">Adds Lot 2 once profit is locked, keeping net risk strictly at zero</p>
            </div>
            <div className="p-2.5 rounded-lg border bg-muted/20 text-xs space-y-1">
              <span className="text-muted-foreground text-[10px] font-bold uppercase tracking-wider block">Sizing Mode</span>
              <span className="font-semibold text-foreground">Fixed Base Sizing (Conservative)</span>
              <p className="text-[10px] text-muted-foreground">Each instrument trades its configured lot count independently</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* SECTION 3: BOTH CONFIGURATIONS DIRECTLY VISIBLE (NO TABS!) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ========================================================= */}
        {/* PANEL A: 🟢 NSE NIFTY 50 CONFIGURATION */}
        {/* ========================================================= */}
        <Card className={cn(
          "border-emerald-500/40 bg-emerald-500/[0.015] shadow-xs flex flex-col justify-between transition-all",
          isLiveTrading && "border-red-600/70 bg-red-950/5"
        )}>
          <CardHeader className="pb-3 border-b border-border/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="size-3 rounded-full bg-emerald-400 shrink-0" />
                <div>
                  <CardTitle className="text-base font-bold text-foreground">
                    NSE NIFTY 50 Configuration
                  </CardTitle>
                  <CardDescription className="text-xs">
                    ~24,500 Index · 65 Qty/Lot · 0.05 pt Tick Size
                  </CardDescription>
                </div>
              </div>
              <Badge variant={isLiveTrading ? "destructive" : "secondary"} className="font-mono text-xs">
                {isLiveTrading ? "🔥 NIFTY LIVE" : "🛡️ NIFTY PAPER"}
              </Badge>
            </div>
          </CardHeader>

          <CardContent className="space-y-4 pt-4 flex-1">
            {/* Nifty Live/Paper Switch & Lot Sizing Strip */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="p-3 rounded-lg border bg-card/60 flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <span className="text-xs font-bold text-foreground block">Execution Mode</span>
                  <span className={cn("text-[11px] font-mono", isLiveTrading ? "text-red-500 font-bold" : "text-muted-foreground")}>
                    {isLiveTrading ? "LIVE (Real Kotak Orders)" : "PAPER (Simulation)"}
                  </span>
                </div>
                <Switch
                  checked={isLiveTrading}
                  onCheckedChange={handleToggleNiftyLive}
                  aria-label="Nifty Live Trading Switch"
                />
              </div>

              <div className="p-3 rounded-lg border bg-card/60 space-y-1">
                <div className="flex justify-between items-center text-xs">
                  <Label htmlFor="nifty-lots" className="font-semibold text-foreground">Nifty Lots (65 Qty/Lot)</Label>
                  <span className="text-[10px] font-mono text-muted-foreground">{capitalSettings.lots * 65} Qty</span>
                </div>
                <Input
                  id="nifty-lots"
                  type="number"
                  min={1}
                  max={10}
                  value={capitalSettings.lots}
                  onChange={(e) => setCapitalSettings({ ...capitalSettings, lots: parseInt(e.target.value) || 1 })}
                  className="h-8 text-xs font-mono font-bold"
                />
              </div>
            </div>

            {/* Initial Stop Loss */}
            <div className="p-2.5 rounded-lg border bg-muted/20 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs font-mono">
              <span className="text-muted-foreground">Initial Fixed Stop Loss:</span>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-foreground">{niftyRatchet.initial_sl_pts} pts spot</span>
                <span className="text-emerald-400 font-semibold text-[11px]">
                  ~₹{Math.round(niftyRatchet.initial_sl_pts * 0.5 * 65 * capitalSettings.lots)}/lot
                </span>
                <span className="text-muted-foreground text-[10px]">
                  (ATM Opt Δ~0.5 · Fut: ₹{niftyRatchet.initial_sl_pts * 65 * capitalSettings.lots})
                </span>
              </div>
            </div>

            {/* NIFTY Spot Ratchet Ladder */}
            <div className="space-y-2.5 pt-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-emerald-400 flex items-center gap-1.5">
                  <TrendingUp className="size-3.5" />
                  NIFTY Spot Ratchet Ladder (Tiers 0A – 6)
                </span>
                <span className="text-[10px] text-muted-foreground font-mono">Trigger → Lock Pts</span>
              </div>

              {/* Pre-Ratchet Guards (Tiers 0A & 0B) */}
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 rounded-lg border border-border/70 bg-card/40 space-y-1">
                  <div className="text-[11px] font-semibold text-foreground">Tier 0A (Retention)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier0a_trigger_pts}
                      onChange={(e) => updateNiftyRatchet("tier0a_trigger_pts", parseFloat(e.target.value) || 35.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier0a_lock_pts}
                      onChange={(e) => updateNiftyRatchet("tier0a_lock_pts", parseFloat(e.target.value) || -12.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points (Entry offset)"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">Reach +{niftyRatchet.tier0a_trigger_pts}pt → SL entry - 12pt</p>
                </div>

                <div className="p-2 rounded-lg border border-border/70 bg-card/40 space-y-1">
                  <div className="text-[11px] font-semibold text-foreground">Tier 0B (Breakeven)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier0b_breakeven_trigger_pts}
                      onChange={(e) => updateNiftyRatchet("tier0b_breakeven_trigger_pts", parseFloat(e.target.value) || 50.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier0b_breakeven_lock_pts}
                      onChange={(e) => updateNiftyRatchet("tier0b_breakeven_lock_pts", parseFloat(e.target.value) || 5.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">Reach +{niftyRatchet.tier0b_breakeven_trigger_pts}pt → Lock +{niftyRatchet.tier0b_breakeven_lock_pts}pt</p>
                </div>
              </div>

              {/* Expansion Tiers 1-6 Grid */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                {/* Tier 1 */}
                <div className="p-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 space-y-1">
                  <div className="text-[11px] font-bold text-emerald-400">Tier 1 (+Pyramid)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier1_trigger_pts}
                      onChange={(e) => updateNiftyRatchet("tier1_trigger_pts", parseFloat(e.target.value) || 70.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier1_lock_pts}
                      onChange={(e) => updateNiftyRatchet("tier1_lock_pts", parseFloat(e.target.value) || 25.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">At +{niftyRatchet.tier1_trigger_pts}pt → Lock +{niftyRatchet.tier1_lock_pts}pt</p>
                </div>

                {/* Tier 2 */}
                <div className="p-2 rounded-lg border border-sky-500/30 bg-sky-500/5 space-y-1">
                  <div className="text-[11px] font-bold text-sky-400">Tier 2 (Momentum)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier2_trigger_pts}
                      onChange={(e) => updateNiftyRatchet("tier2_trigger_pts", parseFloat(e.target.value) || 95.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier2_lock_pts}
                      onChange={(e) => updateNiftyRatchet("tier2_lock_pts", parseFloat(e.target.value) || 50.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">At +{niftyRatchet.tier2_trigger_pts}pt → Lock +{niftyRatchet.tier2_lock_pts}pt</p>
                </div>

                {/* Tier 3 */}
                <div className="p-2 rounded-lg border border-indigo-500/30 bg-indigo-500/5 space-y-1">
                  <div className="text-[11px] font-bold text-indigo-400">Tier 3 (Super Runner)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier3_trigger_pts}
                      onChange={(e) => updateNiftyRatchet("tier3_trigger_pts", parseFloat(e.target.value) || 135.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier3_lock_pts}
                      onChange={(e) => updateNiftyRatchet("tier3_lock_pts", parseFloat(e.target.value) || 85.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">At +{niftyRatchet.tier3_trigger_pts}pt → Lock +{niftyRatchet.tier3_lock_pts}pt</p>
                </div>

                {/* Tier 4 */}
                <div className="p-2 rounded-lg border border-purple-500/30 bg-purple-500/5 space-y-1">
                  <div className="text-[11px] font-bold text-purple-400">Tier 4 (Exhaustion)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier4_trigger_pts}
                      onChange={(e) => updateNiftyRatchet("tier4_trigger_pts", parseFloat(e.target.value) || 180.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier4_lock_pts}
                      onChange={(e) => updateNiftyRatchet("tier4_lock_pts", parseFloat(e.target.value) || 125.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">At +{niftyRatchet.tier4_trigger_pts}pt → Lock +{niftyRatchet.tier4_lock_pts}pt</p>
                </div>

                {/* Tier 5 */}
                <div className="p-2 rounded-lg border border-border/70 bg-card/40 space-y-1">
                  <div className="text-[11px] font-bold text-foreground">Tier 5 (Mega Runner)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier5_trigger_pts ?? 230.0}
                      onChange={(e) => updateNiftyRatchet("tier5_trigger_pts", parseFloat(e.target.value) || 230.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier5_lock_pts ?? 175.0}
                      onChange={(e) => updateNiftyRatchet("tier5_lock_pts", parseFloat(e.target.value) || 175.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">At +{niftyRatchet.tier5_trigger_pts ?? 230}pt → Lock +{niftyRatchet.tier5_lock_pts ?? 175}pt</p>
                </div>

                {/* Tier 6 */}
                <div className="p-2 rounded-lg border border-border/70 bg-card/40 space-y-1">
                  <div className="text-[11px] font-bold text-foreground">Tier 6 (Extreme)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier6_trigger_pts ?? 290.0}
                      onChange={(e) => updateNiftyRatchet("tier6_trigger_pts", parseFloat(e.target.value) || 290.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={niftyRatchet.tier6_lock_pts ?? 230.0}
                      onChange={(e) => updateNiftyRatchet("tier6_lock_pts", parseFloat(e.target.value) || 230.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">At +{niftyRatchet.tier6_trigger_pts ?? 290}pt → Lock +{niftyRatchet.tier6_lock_pts ?? 230}pt</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ========================================================= */}
        {/* PANEL B: 🔵 BSE SENSEX CONFIGURATION */}
        {/* ========================================================= */}
        <Card className={cn(
          "border-sky-500/40 bg-sky-500/[0.015] shadow-xs flex flex-col justify-between transition-all",
          isSensexLiveTrading && "border-red-600/70 bg-red-950/5"
        )}>
          <CardHeader className="pb-3 border-b border-border/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="size-3 rounded-full bg-sky-400 shrink-0" />
                <div>
                  <CardTitle className="text-base font-bold text-foreground">
                    BSE SENSEX Configuration
                  </CardTitle>
                  <CardDescription className="text-xs">
                    ~82,500 Index · 20 Qty/Lot · 0.05 pt Tick Size
                  </CardDescription>
                </div>
              </div>
              <Badge variant={isSensexLiveTrading ? "destructive" : "secondary"} className="font-mono text-xs">
                {isSensexLiveTrading ? "🔥 SENSEX LIVE" : "🛡️ SENSEX PAPER"}
              </Badge>
            </div>
          </CardHeader>

          <CardContent className="space-y-4 pt-4 flex-1">
            {/* Sensex Live/Paper Switch & Lot Sizing Strip */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="p-3 rounded-lg border bg-card/60 flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <span className="text-xs font-bold text-foreground block">Execution Mode</span>
                  <span className={cn("text-[11px] font-mono", isSensexLiveTrading ? "text-red-500 font-bold" : "text-muted-foreground")}>
                    {isSensexLiveTrading ? "LIVE (Real Kotak Orders)" : "PAPER (Simulation)"}
                  </span>
                </div>
                <Switch
                  checked={isSensexLiveTrading}
                  onCheckedChange={handleToggleSensexLive}
                  aria-label="Sensex Live Trading Switch"
                />
              </div>

              <div className="p-3 rounded-lg border border-sky-500/30 bg-sky-500/5 space-y-1">
                <div className="flex justify-between items-center text-xs">
                  <Label htmlFor="sensex-lots" className="font-semibold text-sky-400">Sensex Lots (20 Qty/Lot)</Label>
                  <span className="text-[10px] font-mono text-muted-foreground">{(capitalSettings.sensex_lots || 1) * 20} Qty</span>
                </div>
                <Input
                  id="sensex-lots"
                  type="number"
                  min={1}
                  max={10}
                  value={capitalSettings.sensex_lots || 1}
                  onChange={(e) => setCapitalSettings({ ...capitalSettings, sensex_lots: parseInt(e.target.value) || 1 })}
                  className="h-8 text-xs font-mono font-bold"
                />
              </div>
            </div>

            {/* Initial Stop Loss */}
            <div className="p-2.5 rounded-lg border bg-muted/20 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs font-mono">
              <span className="text-muted-foreground">Initial Fixed Stop Loss:</span>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-foreground">{sensexRatchet.initial_sl_pts} pts spot</span>
                <span className="text-sky-400 font-semibold text-[11px]">
                  ~₹{Math.round(sensexRatchet.initial_sl_pts * 0.5 * 20 * (capitalSettings.sensex_lots || 1))}/lot
                </span>
                <span className="text-muted-foreground text-[10px]">
                  (ATM Opt Δ~0.5 · Fut: ₹{sensexRatchet.initial_sl_pts * 20 * (capitalSettings.sensex_lots || 1)})
                </span>
              </div>
            </div>

            {/* SENSEX Spot Ratchet Ladder */}
            <div className="space-y-2.5 pt-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-sky-400 flex items-center gap-1.5">
                  <TrendingUp className="size-3.5" />
                  SENSEX Spot Ratchet Ladder (Tiers 0A – 6)
                </span>
                <span className="text-[10px] text-muted-foreground font-mono">Trigger → Lock Pts</span>
              </div>

              {/* Pre-Ratchet Guards (Tiers 0A & 0B) */}
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 rounded-lg border border-border/70 bg-card/40 space-y-1">
                  <div className="text-[11px] font-semibold text-foreground">Tier 0A (Retention)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier0a_trigger_pts}
                      onChange={(e) => updateSensexRatchet("tier0a_trigger_pts", parseFloat(e.target.value) || 115.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier0a_lock_pts}
                      onChange={(e) => updateSensexRatchet("tier0a_lock_pts", parseFloat(e.target.value) || -40.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points (Entry offset)"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">Reach +{sensexRatchet.tier0a_trigger_pts}pt → SL entry - 40pt</p>
                </div>

                <div className="p-2 rounded-lg border border-border/70 bg-card/40 space-y-1">
                  <div className="text-[11px] font-semibold text-foreground">Tier 0B (Breakeven)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier0b_breakeven_trigger_pts}
                      onChange={(e) => updateSensexRatchet("tier0b_breakeven_trigger_pts", parseFloat(e.target.value) || 180.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier0b_breakeven_lock_pts}
                      onChange={(e) => updateSensexRatchet("tier0b_breakeven_lock_pts", parseFloat(e.target.value) || 15.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">Reach +{sensexRatchet.tier0b_breakeven_trigger_pts}pt → Lock +{sensexRatchet.tier0b_breakeven_lock_pts}pt</p>
                </div>
              </div>

              {/* Expansion Tiers 1-6 Grid */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                {/* Tier 1 */}
                <div className="p-2 rounded-lg border border-sky-500/30 bg-sky-500/5 space-y-1">
                  <div className="text-[11px] font-bold text-sky-400">Tier 1 (+Pyramid)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier1_trigger_pts}
                      onChange={(e) => updateSensexRatchet("tier1_trigger_pts", parseFloat(e.target.value) || 240.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier1_lock_pts}
                      onChange={(e) => updateSensexRatchet("tier1_lock_pts", parseFloat(e.target.value) || 80.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">At +{sensexRatchet.tier1_trigger_pts}pt → Lock +{sensexRatchet.tier1_lock_pts}pt</p>
                </div>

                {/* Tier 2 */}
                <div className="p-2 rounded-lg border border-indigo-500/30 bg-indigo-500/5 space-y-1">
                  <div className="text-[11px] font-bold text-indigo-400">Tier 2 (Momentum)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier2_trigger_pts}
                      onChange={(e) => updateSensexRatchet("tier2_trigger_pts", parseFloat(e.target.value) || 340.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier2_lock_pts}
                      onChange={(e) => updateSensexRatchet("tier2_lock_pts", parseFloat(e.target.value) || 180.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">At +{sensexRatchet.tier2_trigger_pts}pt → Lock +{sensexRatchet.tier2_lock_pts}pt</p>
                </div>

                {/* Tier 3 */}
                <div className="p-2 rounded-lg border border-purple-500/30 bg-purple-500/5 space-y-1">
                  <div className="text-[11px] font-bold text-purple-400">Tier 3 (Super Runner)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier3_trigger_pts}
                      onChange={(e) => updateSensexRatchet("tier3_trigger_pts", parseFloat(e.target.value) || 480.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier3_lock_pts}
                      onChange={(e) => updateSensexRatchet("tier3_lock_pts", parseFloat(e.target.value) || 280.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">At +{sensexRatchet.tier3_trigger_pts}pt → Lock +{sensexRatchet.tier3_lock_pts}pt</p>
                </div>

                {/* Tier 4 */}
                <div className="p-2 rounded-lg border border-border/70 bg-card/40 space-y-1">
                  <div className="text-[11px] font-bold text-foreground">Tier 4 (Exhaustion)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier4_trigger_pts}
                      onChange={(e) => updateSensexRatchet("tier4_trigger_pts", parseFloat(e.target.value) || 650.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier4_lock_pts}
                      onChange={(e) => updateSensexRatchet("tier4_lock_pts", parseFloat(e.target.value) || 420.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">At +{sensexRatchet.tier4_trigger_pts}pt → Lock +{sensexRatchet.tier4_lock_pts}pt</p>
                </div>

                {/* Tier 5 */}
                <div className="p-2 rounded-lg border border-border/70 bg-card/40 space-y-1">
                  <div className="text-[11px] font-bold text-foreground">Tier 5 (Mega Runner)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier5_trigger_pts ?? 850.0}
                      onChange={(e) => updateSensexRatchet("tier5_trigger_pts", parseFloat(e.target.value) || 850.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier5_lock_pts ?? 600.0}
                      onChange={(e) => updateSensexRatchet("tier5_lock_pts", parseFloat(e.target.value) || 600.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">At +{sensexRatchet.tier5_trigger_pts ?? 850}pt → Lock +{sensexRatchet.tier5_lock_pts ?? 600}pt</p>
                </div>

                {/* Tier 6 */}
                <div className="p-2 rounded-lg border border-border/70 bg-card/40 space-y-1">
                  <div className="text-[11px] font-bold text-foreground">Tier 6 (Extreme)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier6_trigger_pts ?? 1100.0}
                      onChange={(e) => updateSensexRatchet("tier6_trigger_pts", parseFloat(e.target.value) || 1100.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Trigger"
                      title="Trigger Points"
                    />
                    <Input
                      type="number"
                      step={0.5}
                      value={sensexRatchet.tier6_lock_pts ?? 850.0}
                      onChange={(e) => updateSensexRatchet("tier6_lock_pts", parseFloat(e.target.value) || 850.0)}
                      className="h-7 text-xs font-mono w-full"
                      placeholder="Lock"
                      title="Lock Points"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">At +{sensexRatchet.tier6_trigger_pts ?? 1100}pt → Lock +{sensexRatchet.tier6_lock_pts ?? 850}pt</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* STRATEGY HANDBOOK COLLAPSIBLE DRAWER */}
      <Card className="border-border/70 bg-card/60 shadow-xs">
        <CardHeader
          className="py-3 cursor-pointer hover:bg-muted/20 transition-all select-none"
          onClick={() => setShowHandbook(!showHandbook)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Info className="size-4 text-emerald-400" />
              <CardTitle className="text-sm font-semibold">Strategy Edge Playbook &amp; Multi-Index Rules Documentation</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px]">
                {showHandbook ? "Click to Collapse" : "Click to View Details"}
              </Badge>
              {showHandbook ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
            </div>
          </div>
        </CardHeader>
        {showHandbook && (
          <CardContent className="pt-2 border-t border-border/50">
            <StrategyInfoPage />
          </CardContent>
        )}
      </Card>

      {/* LIVE TRADING ACTIVATION CONFIRMATION DIALOG */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-500 font-extrabold text-lg">
              <Zap className="size-5" /> Enable Live Money Trading for {confirmTarget}
            </DialogTitle>
            <DialogDescription className="text-xs pt-1 space-y-2">
              <span className="block text-foreground font-semibold">
                You are about to switch automated execution from PAPER simulation to REAL MONEY execution on your connected Kotak Neo account.
              </span>
              <span className="block text-muted-foreground">
                Automated buy and sell market orders will be placed for {confirmTarget} whenever Trend Runner or VIX Trap generates high-conviction signals.
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 space-y-2">
            <div className="text-xs font-bold text-red-400">Confirmation Required</div>
            <p className="text-[11px] text-muted-foreground">
              To confirm that you understand real capital is at risk, type <strong className="text-foreground font-mono">LIVE</strong> in the box below:
            </p>
            <Input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value.toUpperCase())}
              placeholder="Type LIVE to enable"
              className="h-8 text-xs font-mono tracking-widest uppercase border-red-500/50"
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setConfirmOpen(false)
                setTyped("")
                setConfirmTarget(null)
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={typed !== "LIVE"}
              onClick={confirmLiveAction}
              className="font-bold"
            >
              Activate Live Trading
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

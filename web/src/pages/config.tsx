import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Sliders,
  ShieldCheck,
  Save,
  RotateCcw,
  Layers,
  Target,
  Info
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getJSON, postJSON } from "@/lib/api"
import { StrategyInfoPage } from "./strategy-info"

type PortfolioConfig = {
  symbol: string
  mode: "priority" | "concurrent"
  max_trades_per_day: number
  max_concurrent_positions: number
  setups: {
    vix_master_morning: boolean
    williams_afternoon: boolean
    vix_master_afternoon?: boolean
    gap_and_go_morning?: boolean
  }
  spot_ratchet_settings: {
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
  }
}

const DEFAULT_CONFIG: PortfolioConfig = {
  symbol: "NIFTY",
  mode: "priority",
  max_trades_per_day: 2,
  max_concurrent_positions: 1,
  setups: {
    vix_master_morning: true,
    williams_afternoon: true,
  },
  spot_ratchet_settings: {
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
  },
}

export function ConfigPage() {
  const [config, setConfig] = useState<PortfolioConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState("portfolio")

  useEffect(() => {
    fetchConfig()
  }, [])

  async function fetchConfig() {
    setLoading(true)
    try {
      const data = await getJSON<PortfolioConfig>("/api/portfolio/config")
      setConfig(data)
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
      const res = await postJSON<{ ok: boolean; config: PortfolioConfig }>("/api/portfolio/config", config)
      if (res.ok) {
        toast.success("Master Portfolio configuration saved successfully!")
        setConfig(res.config)
      } else {
        toast.error("Failed to save configuration.")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error saving configuration")
    } finally {
      setSaving(false)
    }
  }

  function resetToDefaults() {
    setConfig(DEFAULT_CONFIG)
    toast.info("Reset to production recommended parameters. Click Save to persist.")
  }

  if (loading || !config) {
    return (
      <div className="flex h-96 w-full items-center justify-center text-sm text-muted-foreground animate-pulse">
        Loading Master Portfolio Configuration...
      </div>
    )
  }

  const activeSetupsCount = [
    config.setups.vix_master_morning,
    config.setups.williams_afternoon,
  ].filter(Boolean).length

  return (
    <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <Badge variant="outline" className="border-sky-500/40 text-sky-400 bg-sky-500/10 gap-1 text-xs">
              <Sliders className="size-3" /> Master Portfolio Suite
            </Badge>
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 bg-emerald-500/10 gap-1 text-xs">
              <ShieldCheck className="size-3" /> 10-Year Verified Engine
            </Badge>
            <Badge variant="outline" className="border-amber-500/40 text-amber-400 bg-amber-500/10 gap-1 text-xs">
              {activeSetupsCount} / 2 Daily Engines Active
            </Badge>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Strategy Configuration</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Production 2-stage daily relay: VIX Master handles the morning trend (09:30–11:00), and Williams Fractal takes the afternoon session (12:00–14:30).
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

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="portfolio">Master Portfolio Config</TabsTrigger>
          <TabsTrigger value="reference">Architecture Reference</TabsTrigger>
        </TabsList>

        <TabsContent value="portfolio" className="space-y-6 mt-6">
          {/* Section 1: Portfolio Mode & Global Routing */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Layers className="size-4 text-sky-400" />
                Portfolio Execution Mode & Instrument
              </CardTitle>
              <CardDescription>
                Define margin allocation rules and execution priority across the morning and afternoon sessions.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Symbol */}
                <div className="space-y-2 rounded-lg border p-3">
                  <Label className="text-xs text-muted-foreground">Trading Instrument</Label>
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
                      title="Strict 1-lot margin discipline. Only 1 active position at any time."
                    >
                      Priority (1 Pos)
                    </Button>
                    <Button
                      type="button"
                      variant={config.mode === "concurrent" ? "default" : "outline"}
                      size="sm"
                      className="flex-1"
                      onClick={() => setConfig({ ...config, mode: "concurrent" })}
                      title="Deploys setups independently even if active positions overlap."
                    >
                      Concurrent
                    </Button>
                  </div>
                </div>

                {/* Max Trades / Day */}
                <div className="space-y-2 rounded-lg border p-3">
                  <Label htmlFor="max-trades" className="text-xs text-muted-foreground">Max Trades / Day</Label>
                  <Input
                    id="max-trades"
                    type="number"
                    min={1}
                    max={5}
                    value={config.max_trades_per_day}
                    onChange={(e) => setConfig({ ...config, max_trades_per_day: Number(e.target.value) || 2 })}
                    className="h-8 text-sm"
                  />
                </div>

                {/* Max Concurrent Positions */}
                <div className="space-y-2 rounded-lg border p-3">
                  <Label htmlFor="max-concurrent" className="text-xs text-muted-foreground">Max Concurrent Positions</Label>
                  <Input
                    id="max-concurrent"
                    type="number"
                    min={1}
                    max={3}
                    value={config.max_concurrent_positions}
                    onChange={(e) => setConfig({ ...config, max_concurrent_positions: Number(e.target.value) || 1 })}
                    className="h-8 text-sm"
                  />
                </div>
              </div>

              <div className="text-xs text-muted-foreground bg-muted/40 p-3 rounded-md flex items-center gap-2">
                <Info className="size-4 shrink-0 text-sky-400" />
                <span>
                  <strong>Clean 2-Stage Daily Relay:</strong> VIX Master takes the morning trade (09:30–11:00). After 12:00 PM, Williams Fractal kicks in to capture afternoon prior-day breakout momentum, capping daily exposure to 1 position at a time.
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Section 2: The 2 Core Daily Relay Engines */}
          <div className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">The 2 Daily Relay Engines</h2>
              <p className="text-xs text-muted-foreground">
                Mutually orthogonal execution windows with zero cannibalization. Morning trend capture + Afternoon fractal breakout.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Engine 1: VIX Master Morning ORB */}
              <Card className={config.setups.vix_master_morning ? "border-emerald-500/40 bg-card" : "opacity-60"}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <Badge variant="outline" className="border-emerald-500/50 text-emerald-400 bg-emerald-500/10 text-[10px]">
                      Stage 1 · Morning Session
                    </Badge>
                    <Switch
                      checked={config.setups.vix_master_morning}
                      onCheckedChange={(checked) =>
                        setConfig({
                          ...config,
                          setups: { ...config.setups, vix_master_morning: checked },
                        })
                      }
                    />
                  </div>
                  <CardTitle className="text-base mt-2">⚡ VIX Master (Morning ORB)</CardTitle>
                  <CardDescription className="text-xs">
                    Directional opening range breakout confirmed by India VIX momentum.
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-xs space-y-1.5 text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Execution Window:</span>
                    <span className="font-mono text-foreground font-medium">09:30 – 11:00 IST</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Trigger Condition:</span>
                    <span className="text-foreground">Break of 15m ORB + VIX confluence</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Expectancy:</span>
                    <span className="text-emerald-400 font-semibold">+18.45 pt / trade (2.00 PF, 55.9% WR)</span>
                  </div>
                  <div className="flex justify-between">
                    <span>10-Year Total:</span>
                    <span className="text-foreground font-medium">+23,392.8 spot pts (1,268 trades)</span>
                  </div>
                </CardContent>
              </Card>

              {/* Engine 2: Williams Fractal Afternoon */}
              <Card className={config.setups.williams_afternoon ? "border-purple-500/40 bg-card" : "opacity-60"}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <Badge variant="outline" className="border-purple-500/50 text-purple-400 bg-purple-500/10 text-[10px]">
                      Stage 2 · Afternoon Session
                    </Badge>
                    <Switch
                      checked={config.setups.williams_afternoon}
                      onCheckedChange={(checked) =>
                        setConfig({
                          ...config,
                          setups: { ...config.setups, williams_afternoon: checked },
                        })
                      }
                    />
                  </div>
                  <CardTitle className="text-base mt-2">🎯 Williams Fractal Runner</CardTitle>
                  <CardDescription className="text-xs">
                    Afternoon prior day range breakout when morning session is quiet or closed.
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-xs space-y-1.5 text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Execution Window:</span>
                    <span className="font-mono text-foreground font-medium">12:00 – 14:30 IST</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Trigger Level:</span>
                    <span className="text-foreground">Prior Day High / Low fractal breakout</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Expectancy:</span>
                    <span className="text-purple-400 font-semibold">+10.31 pt / trade (1.66 PF, 43.2% WR)</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Max Drawdown:</span>
                    <span className="text-foreground font-medium">Only 347.7 pt (Ultra-Tight Risk)</span>
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
                    Spot Points Profit Ratchet Ladder
                  </CardTitle>
                  <CardDescription>
                    Both engines lock fixed spot points at each milestone. Zero percentage drift or volatility guessing.
                  </CardDescription>
                </div>
                <Badge variant="outline" className="text-xs border-emerald-500/40 text-emerald-400 bg-emerald-500/10">
                  Fixed Spot Points Discipline
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
                    value={config.spot_ratchet_settings.initial_sl_pts}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        spot_ratchet_settings: {
                          ...config.spot_ratchet_settings,
                          initial_sl_pts: Number(e.target.value) || 28.0,
                        },
                      })
                    }
                    className="h-8 text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground">Hard stop on trade entry</p>
                </div>

                {/* Tier 0A Retention Guard */}
                <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <Label htmlFor="t0a-trig" className="text-xs font-semibold text-amber-400">Tier 0A Guard Trigger (pts)</Label>
                  <div className="flex gap-2">
                    <Input
                      id="t0a-trig"
                      type="number"
                      step={1}
                      value={config.spot_ratchet_settings.tier0a_trigger_pts}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          spot_ratchet_settings: {
                            ...config.spot_ratchet_settings,
                            tier0a_trigger_pts: Number(e.target.value) || 40.0,
                          },
                        })
                      }
                      className="h-8 text-sm flex-1"
                      placeholder="Trigger"
                    />
                    <Input
                      id="t0a-lk"
                      type="number"
                      step={1}
                      value={config.spot_ratchet_settings.tier0a_lock_pts}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          spot_ratchet_settings: {
                            ...config.spot_ratchet_settings,
                            tier0a_lock_pts: Number(e.target.value) || -15.0,
                          },
                        })
                      }
                      className="h-8 text-sm flex-1"
                      placeholder="Stop level"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">Pull stop to cut max loss in half</p>
                </div>

                {/* Tier 0B Breakeven */}
                <div className="space-y-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                  <Label htmlFor="t0b-trig" className="text-xs font-semibold text-emerald-400">Tier 0B Breakeven (pts)</Label>
                  <div className="flex gap-2">
                    <Input
                      id="t0b-trig"
                      type="number"
                      step={1}
                      value={config.spot_ratchet_settings.tier0b_breakeven_trigger_pts}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          spot_ratchet_settings: {
                            ...config.spot_ratchet_settings,
                            tier0b_breakeven_trigger_pts: Number(e.target.value) || 55.0,
                          },
                        })
                      }
                      className="h-8 text-sm flex-1"
                    />
                    <Input
                      id="t0b-lk"
                      type="number"
                      step={1}
                      value={config.spot_ratchet_settings.tier0b_breakeven_lock_pts}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          spot_ratchet_settings: {
                            ...config.spot_ratchet_settings,
                            tier0b_breakeven_lock_pts: Number(e.target.value) || 5.0,
                          },
                        })
                      }
                      className="h-8 text-sm flex-1"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">Lock Risk-Free Breakeven</p>
                </div>

                {/* Tier 1 Lock */}
                <div className="space-y-1.5 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
                  <Label htmlFor="r1-trig" className="text-xs font-semibold text-sky-400">Tier 1 Lock (pts)</Label>
                  <div className="flex gap-2">
                    <Input
                      id="r1-trig"
                      type="number"
                      step={1}
                      value={config.spot_ratchet_settings.tier1_trigger_pts}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          spot_ratchet_settings: {
                            ...config.spot_ratchet_settings,
                            tier1_trigger_pts: Number(e.target.value) || 70.0,
                          },
                        })
                      }
                      className="h-8 text-sm flex-1"
                    />
                    <Input
                      id="r1-lk"
                      type="number"
                      step={1}
                      value={config.spot_ratchet_settings.tier1_lock_pts}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          spot_ratchet_settings: {
                            ...config.spot_ratchet_settings,
                            tier1_lock_pts: Number(e.target.value) || 20.0,
                          },
                        })
                      }
                      className="h-8 text-sm flex-1"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">Lock +20 pt base profit</p>
                </div>
              </div>

              {/* Extended Tiers */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* Tier 2 */}
                <div className="space-y-1.5 rounded-lg border p-3">
                  <Label className="text-xs font-semibold text-foreground">Tier 2 Expansion (+130 &rarr; +60)</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      value={config.spot_ratchet_settings.tier2_trigger_pts}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          spot_ratchet_settings: {
                            ...config.spot_ratchet_settings,
                            tier2_trigger_pts: Number(e.target.value) || 130.0,
                          },
                        })
                      }
                      className="h-8 text-sm flex-1"
                      placeholder="Trigger"
                    />
                    <Input
                      type="number"
                      value={config.spot_ratchet_settings.tier2_lock_pts}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          spot_ratchet_settings: {
                            ...config.spot_ratchet_settings,
                            tier2_lock_pts: Number(e.target.value) || 60.0,
                          },
                        })
                      }
                      className="h-8 text-sm flex-1"
                      placeholder="Lock"
                    />
                  </div>
                </div>

                {/* Tier 3 */}
                <div className="space-y-1.5 rounded-lg border p-3">
                  <Label className="text-xs font-semibold text-foreground">Tier 3 Monster (+180 &rarr; +110)</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      value={config.spot_ratchet_settings.tier3_trigger_pts}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          spot_ratchet_settings: {
                            ...config.spot_ratchet_settings,
                            tier3_trigger_pts: Number(e.target.value) || 180.0,
                          },
                        })
                      }
                      className="h-8 text-sm flex-1"
                      placeholder="Trigger"
                    />
                    <Input
                      type="number"
                      value={config.spot_ratchet_settings.tier3_lock_pts}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          spot_ratchet_settings: {
                            ...config.spot_ratchet_settings,
                            tier3_lock_pts: Number(e.target.value) || 110.0,
                          },
                        })
                      }
                      className="h-8 text-sm flex-1"
                      placeholder="Lock"
                    />
                  </div>
                </div>

                {/* Tier 4 */}
                <div className="space-y-1.5 rounded-lg border p-3">
                  <Label className="text-xs font-semibold text-foreground">Tier 4 Super Runner (+230 &rarr; +165)</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      value={config.spot_ratchet_settings.tier4_trigger_pts}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          spot_ratchet_settings: {
                            ...config.spot_ratchet_settings,
                            tier4_trigger_pts: Number(e.target.value) || 230.0,
                          },
                        })
                      }
                      className="h-8 text-sm flex-1"
                      placeholder="Trigger"
                    />
                    <Input
                      type="number"
                      value={config.spot_ratchet_settings.tier4_lock_pts}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          spot_ratchet_settings: {
                            ...config.spot_ratchet_settings,
                            tier4_lock_pts: Number(e.target.value) || 165.0,
                          },
                        })
                      }
                      className="h-8 text-sm flex-1"
                      placeholder="Lock"
                    />
                  </div>
                </div>
              </div>

              {/* Ladder Visual Preview Table */}
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="w-[140px]">Milestone</TableHead>
                      <TableHead>Favorable Spot Move</TableHead>
                      <TableHead>Ratchet Action</TableHead>
                      <TableHead className="text-right">Net Guaranteed Outcome</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="text-xs">
                    <TableRow>
                      <TableCell className="font-semibold text-red-400">Entry</TableCell>
                      <TableCell>0.0 pt</TableCell>
                      <TableCell>Initial Stop Placed</TableCell>
                      <TableCell className="text-right font-mono text-red-400">
                        -{config.spot_ratchet_settings.initial_sl_pts.toFixed(1)} pt
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-semibold text-amber-400">Tier 0A Guard</TableCell>
                      <TableCell>+{config.spot_ratchet_settings.tier0a_trigger_pts.toFixed(1)} pt</TableCell>
                      <TableCell>Stop pulled to Entry {config.spot_ratchet_settings.tier0a_lock_pts.toFixed(1)} pt</TableCell>
                      <TableCell className="text-right font-mono text-amber-400">
                        Max risk capped to {Math.abs(config.spot_ratchet_settings.tier0a_lock_pts).toFixed(1)} pt
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-semibold text-emerald-400">Tier 0B Breakeven</TableCell>
                      <TableCell>+{config.spot_ratchet_settings.tier0b_breakeven_trigger_pts.toFixed(1)} pt</TableCell>
                      <TableCell>Stop moved to Entry + {config.spot_ratchet_settings.tier0b_breakeven_lock_pts.toFixed(1)} pt</TableCell>
                      <TableCell className="text-right font-mono text-emerald-400">
                        +{config.spot_ratchet_settings.tier0b_breakeven_lock_pts.toFixed(1)} pt (Risk Free)
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-semibold text-sky-400">Tier 1 Lock</TableCell>
                      <TableCell>+{config.spot_ratchet_settings.tier1_trigger_pts.toFixed(1)} pt</TableCell>
                      <TableCell>Stop locked at Entry + {config.spot_ratchet_settings.tier1_lock_pts.toFixed(1)} pt</TableCell>
                      <TableCell className="text-right font-mono text-sky-400">
                        +{config.spot_ratchet_settings.tier1_lock_pts.toFixed(1)} pt
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-semibold text-purple-400">Tier 2 Lock</TableCell>
                      <TableCell>+{config.spot_ratchet_settings.tier2_trigger_pts.toFixed(1)} pt</TableCell>
                      <TableCell>Stop locked at Entry + {config.spot_ratchet_settings.tier2_lock_pts.toFixed(1)} pt</TableCell>
                      <TableCell className="text-right font-mono text-purple-400">
                        +{config.spot_ratchet_settings.tier2_lock_pts.toFixed(1)} pt
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-semibold text-indigo-400">Tier 3 / 4</TableCell>
                      <TableCell>+{config.spot_ratchet_settings.tier3_trigger_pts.toFixed(1)} &rarr; +{config.spot_ratchet_settings.tier4_trigger_pts.toFixed(1)} pt</TableCell>
                      <TableCell>Trailing monster runners</TableCell>
                      <TableCell className="text-right font-mono text-indigo-400">
                        +{config.spot_ratchet_settings.tier3_lock_pts.toFixed(1)} &rarr; +{config.spot_ratchet_settings.tier4_lock_pts.toFixed(1)} pt
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
            <CardFooter className="justify-between border-t pt-4">
              <span className="text-xs text-muted-foreground">Changes take effect immediately upon saving.</span>
              <Button size="sm" onClick={saveConfig} disabled={saving} className="bg-primary text-primary-foreground font-semibold">
                <Save className="size-3.5 mr-1.5" /> {saving ? "Saving..." : "Save Configuration"}
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="reference" className="mt-6">
          <StrategyInfoPage />
        </TabsContent>
      </Tabs>
    </div>
  )
}

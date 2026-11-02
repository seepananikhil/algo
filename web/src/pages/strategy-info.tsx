import { useState } from "react"
import {
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  Layers,
  Lock,
  Scale,
  Clock,
  Target,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Calendar,
  Sparkles,
  BookOpen,
  Info,
  Percent,
  Activity,
  Sliders,
  Flame,
  Award,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export function StrategyInfoPage() {
  const [activeTab, setActiveTab] = useState("overview")

  return (
    <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 max-w-7xl mx-auto">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 bg-emerald-500/10 gap-1 text-xs">
              <Sparkles className="size-3" /> Locked Production Architecture
            </Badge>
            <Badge variant="outline" className="border-blue-500/40 text-blue-400 bg-blue-500/10 gap-1 text-xs">
              <ShieldCheck className="size-3" /> 10-Year Verified (2017–2026)
            </Badge>
            <Badge variant="outline" className="border-purple-500/40 text-purple-400 bg-purple-500/10 gap-1 text-xs">
              <Award className="size-3" /> 10/10 Green Years
            </Badge>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Trend Runner Master Strategy</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Systematic institutional breakout engine with India VIX directional confluence, symmetric Trade 2 continuation, 6-tier ratchet locks, and dynamic 4-factor sizing.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Default Instrument</div>
            <div className="text-sm font-semibold text-foreground">NIFTY 50 / SENSEX</div>
          </div>
          <div className="h-8 w-px bg-border" />
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Execution Strike</div>
            <div className="text-sm font-semibold text-emerald-400">ITM-150 (Delta ~0.72)</div>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card className="bg-card/70 border-border/80">
          <CardContent className="p-4">
            <div className="text-xs font-medium text-muted-foreground flex items-center justify-between">
              Total 10Y Return
              <TrendingUp className="size-3.5 text-emerald-400" />
            </div>
            <div className="text-xl font-bold text-emerald-400 mt-1.5">+34,000+ pts</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">₹8.5+ Lakhs (Dynamic)</div>
          </CardContent>
        </Card>

        <Card className="bg-card/70 border-border/80">
          <CardContent className="p-4">
            <div className="text-xs font-medium text-muted-foreground flex items-center justify-between">
              High Conviction WR
              <Award className="size-3.5 text-purple-400" />
            </div>
            <div className="text-xl font-bold text-purple-400 mt-1.5">51.8% – 57.5%</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">3.18 Profit Factor</div>
          </CardContent>
        </Card>

        <Card className="bg-card/70 border-border/80">
          <CardContent className="p-4">
            <div className="text-xs font-medium text-muted-foreground flex items-center justify-between">
              Baseline Win Rate
              <Percent className="size-3.5 text-blue-400" />
            </div>
            <div className="text-xl font-bold text-foreground mt-1.5">42.2%</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">Standard 1-Lot baseline</div>
          </CardContent>
        </Card>

        <Card className="bg-card/70 border-border/80">
          <CardContent className="p-4">
            <div className="text-xs font-medium text-muted-foreground flex items-center justify-between">
              Profit Factor
              <Scale className="size-3.5 text-amber-400" />
            </div>
            <div className="text-xl font-bold text-amber-400 mt-1.5">2.20 – 3.20</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">Gross Win / Gross Loss</div>
          </CardContent>
        </Card>

        <Card className="bg-card/70 border-border/80">
          <CardContent className="p-4">
            <div className="text-xs font-medium text-muted-foreground flex items-center justify-between">
              Max Drawdown
              <ShieldCheck className="size-3.5 text-teal-400" />
            </div>
            <div className="text-xl font-bold text-muted-foreground mt-1.5">-461 pts</div>
            <div className="text-[11px] text-emerald-400 mt-0.5">Swift recovery in all regimes</div>
          </CardContent>
        </Card>

        <Card className="bg-card/70 border-border/80">
          <CardContent className="p-4">
            <div className="text-xs font-medium text-muted-foreground flex items-center justify-between">
              Yearly Consistency
              <Flame className="size-3.5 text-orange-400" />
            </div>
            <div className="text-xl font-bold text-emerald-400 mt-1.5">10 / 10 Years</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">100% Profitable Calendar Years</div>
          </CardContent>
        </Card>
      </div>

      {/* Main Tabs Navigation */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid grid-cols-2 md:grid-cols-4 w-full md:w-auto h-auto p-1 bg-muted/60">
          <TabsTrigger value="overview" className="gap-2 py-2">
            <BookOpen className="size-4" /> Strategy Blueprint
          </TabsTrigger>
          <TabsTrigger value="dynamic-sizing" className="gap-2 py-2">
            <Sliders className="size-4" /> Dynamic Sizing (1 vs 2 Lots)
          </TabsTrigger>
          <TabsTrigger value="ratchet" className="gap-2 py-2">
            <Lock className="size-4" /> 6-Tier Ratchet Locks
          </TabsTrigger>
          <TabsTrigger value="execution" className="gap-2 py-2">
            <Zap className="size-4" /> Strike & Execution Delta
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: STRATEGY BLUEPRINT */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Trade 1 Morning Setup Card */}
            <Card className="border-border/80 bg-card/60">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="border-blue-500/40 text-blue-400 bg-blue-500/10">Stage 1</Badge>
                  <span className="text-xs text-muted-foreground font-mono">Max 1 Trade / Morning</span>
                </div>
                <CardTitle className="text-lg flex items-center gap-2 mt-1">
                  <Activity className="size-5 text-blue-400" /> Morning Trend Breakout Rules
                </CardTitle>
                <CardDescription>
                  Captures institutional opening expansion while filtering low-liquidity whipsaws.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3.5 text-sm">
                <div className="p-3 rounded-lg bg-muted/40 border border-border/50 space-y-2">
                  <div className="font-semibold text-xs text-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Clock className="size-3.5 text-blue-400" /> Time Windows & Asymmetric Cutoffs
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground pl-1">
                    <li className="flex items-start gap-2">
                      <span className="font-semibold text-emerald-400 shrink-0">CALL Window:</span>
                      <span><strong>09:30 to 10:15 IST</strong>. Hard cutoff at 10:15 AM eliminates the late-morning chop trap (-321.5 pts avoided).</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="font-semibold text-rose-400 shrink-0">PUT Window:</span>
                      <span><strong>09:30 to 13:00 IST</strong>. Short entries remain highly profitable into midday (84% of 10Y profits).</span>
                    </li>
                  </ul>
                </div>

                <div className="p-3 rounded-lg bg-muted/40 border border-border/50 space-y-2">
                  <div className="font-semibold text-xs text-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Layers className="size-3.5 text-purple-400" /> Opening Range (OR) & Dynamic Expansion
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Opening Range is established from <strong>09:15 to 09:30 IST</strong>. Must satisfy <code className="text-foreground font-semibold">OR Range ≥ 30 pts</code>.
                    If price wicks beyond OR High/Low prior to breakout without closing outside, the boundary dynamically expands to prevent wick-trap entries.
                  </p>
                </div>

                <div className="p-3 rounded-lg bg-muted/40 border border-border/50 space-y-2">
                  <div className="font-semibold text-xs text-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <CheckCircle2 className="size-3.5 text-emerald-400" /> Candle Conviction & VWAP Alignment
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground pl-1">
                    <li>• <strong>Solid Body Ratio:</strong> Breakout candle body must be <code className="text-foreground">≥ 60%</code> of total range.</li>
                    <li>• <strong>VWAP Confirmation:</strong> CALL must close &gt; VWAP; PUT must close &lt; VWAP.</li>
                    <li>• <strong>India VIX Confluence:</strong> CALL requires VIX change ≤ -2.5% (or ≤ 0.0% if body ≥ 80%); PUT requires VIX change ≥ +2.5% (or ≥ 0.0% if body ≥ 80%).</li>
                  </ul>
                </div>
              </CardContent>
            </Card>

            {/* Trade 2 Re-entry Rules Card */}
            <Card className="border-border/80 bg-card/60">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="border-purple-500/40 text-purple-400 bg-purple-500/10">Stage 2</Badge>
                  <span className="text-xs text-muted-foreground font-mono">Max 1 Re-entry / Day</span>
                </div>
                <CardTitle className="text-lg flex items-center gap-2 mt-1">
                  <TrendingUp className="size-5 text-purple-400" /> Symmetric Trade 2 Re-entry Gates
                </CardTitle>
                <CardDescription>
                  Capitalizes on sustained afternoon runaway trends while strictly preventing revenge trades.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3.5 text-sm">
                <div className="p-3 rounded-lg bg-muted/40 border border-border/50 space-y-2">
                  <div className="font-semibold text-xs text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Clock className="size-3.5" /> Gate 1: Strict 30-Minute Cool-off
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    After Trade 1 is closed (whether by stop loss or target), the algorithm enters a <strong>mandatory 30-minute quiet period</strong> (30 1-minute bars).
                    No orders can trigger during this cooldown, completely eliminating rapid revenge trades.
                  </p>
                </div>

                <div className="p-3 rounded-lg bg-muted/40 border border-border/50 space-y-2">
                  <div className="font-semibold text-xs text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                    <ShieldCheck className="size-3.5" /> Gate 2: Matured Trend Protection
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    If Trade 1 achieved a gain of <code className="text-emerald-400 font-semibold">≥ +60.0 pts</code> (Tier 2 Ratchet triggered), the day&apos;s trend is deemed mature.
                    <strong>Trade 2 is locked and disabled for the remainder of the day</strong>. This single gate locks in morning gains and saved -180 pts of drawdown.
                  </p>
                </div>

                <div className="p-3 rounded-lg bg-muted/40 border border-border/50 space-y-2">
                  <div className="font-semibold text-xs text-blue-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Target className="size-3.5" /> Gate 3: Day Extreme Breakout Continuation
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    If Trade 1 stopped out or made &lt; +60 pts, Trade 2 will only enter if the index price breaks beyond the <strong>entire Day&apos;s High (for CALL)</strong> or <strong>Day&apos;s Low (for PUT)</strong> with VWAP agreement between 09:30 and 13:00 IST.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Hard Rules & Session Filters Banner */}
          <Card className="border-border/80 bg-gradient-to-r from-muted/30 via-muted/50 to-muted/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="size-4 text-amber-400" /> Mandatory Production Filters & Constraints
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div className="flex items-start gap-2.5">
                  <div className="size-6 rounded-full bg-rose-500/10 text-rose-400 flex items-center justify-center shrink-0 mt-0.5">✕</div>
                  <div>
                    <span className="font-semibold text-foreground">Weekend Session Filter:</span>
                    <p className="text-muted-foreground mt-0.5">Saturday/Sunday special trading sessions (Muhurat / disaster recovery mocks) have 0% win rate (5 trades, 5 losses, -180 pts). They are completely bypassed.</p>
                  </div>
                </div>

                <div className="flex items-start gap-2.5">
                  <div className="size-6 rounded-full bg-blue-500/10 text-blue-400 flex items-center justify-center shrink-0 mt-0.5">✓</div>
                  <div>
                    <span className="font-semibold text-foreground">15:15 IST EOD Auto-Close:</span>
                    <p className="text-muted-foreground mt-0.5">All positions are automatically closed at 15:15 IST. Zero overnight exposure or gap risk. Pure intraday trend capture.</p>
                  </div>
                </div>

                <div className="flex items-start gap-2.5">
                  <div className="size-6 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center shrink-0 mt-0.5">2x</div>
                  <div>
                    <span className="font-semibold text-foreground">Max 2 Trades Per Day:</span>
                    <p className="text-muted-foreground mt-0.5">Strict daily budget of at most 2 trades. Prevents overtrading on choppy sideways days, capping daily risk.</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 2: DYNAMIC CONFLUENCE SIZING */}
        <TabsContent value="dynamic-sizing" className="space-y-6">
          <Card className="border-border/80 bg-card/60">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <Badge variant="outline" className="border-purple-500/40 text-purple-400 bg-purple-500/10">4-Factor Edge Confluence</Badge>
                <span className="text-xs text-muted-foreground">Dynamic Lot Sizing (1 vs 2 Lots)</span>
              </div>
              <CardTitle className="text-lg flex items-center gap-2 mt-1">
                <Sliders className="size-5 text-purple-400" /> Sizing Matrix: Scaling Where the Statistical Edge is Proven
              </CardTitle>
              <CardDescription>
                Rather than trading a static 1 lot every day, the engine evaluates 4 statistical confluence factors. If score ≥ 3, it scales to 2 lots.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Factor Breakdown Grid */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="p-3.5 rounded-lg border bg-muted/30 border-border/60">
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                    <span>Factor 1</span>
                    <Badge variant="secondary" className="text-[10px] bg-rose-500/10 text-rose-400">+1 Point</Badge>
                  </div>
                  <div className="font-semibold text-sm text-foreground flex items-center gap-1.5 mt-1">
                    <TrendingDown className="size-4 text-rose-400" /> SHORT Direction
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    10-year data shows SHORT setups deliver an extraordinary <strong>2.54 Profit Factor</strong> and generate <strong>84%</strong> of total cumulative profits (+18,085 pts).
                  </p>
                </div>

                <div className="p-3.5 rounded-lg border bg-muted/30 border-border/60">
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                    <span>Factor 2</span>
                    <Badge variant="secondary" className="text-[10px] bg-blue-500/10 text-blue-400">+1 Point</Badge>
                  </div>
                  <div className="font-semibold text-sm text-foreground flex items-center gap-1.5 mt-1">
                    <Calendar className="size-4 text-blue-400" /> Expiry / Monday Open
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    Weekly Expiry (<strong>Tuesday for NIFTY</strong>, <strong>Thursday for SENSEX</strong>) or <strong>Monday Weekly Open</strong> possess highest directional range expansion (2.65 PF).
                  </p>
                </div>

                <div className="p-3.5 rounded-lg border bg-muted/30 border-border/60">
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                    <span>Factor 3</span>
                    <Badge variant="secondary" className="text-[10px] bg-emerald-500/10 text-emerald-400">+1 Point</Badge>
                  </div>
                  <div className="font-semibold text-sm text-foreground flex items-center gap-1.5 mt-1">
                    <Activity className="size-4 text-emerald-400" /> VIX Sweet Spot (13–22)
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    India VIX between <strong>13.0 and 22.0</strong> avoids sub-13 range complacency (&lt;33% WR) and &gt;22 panic whipsaws, producing clean directional continuation.
                  </p>
                </div>

                <div className="p-3.5 rounded-lg border bg-muted/30 border-border/60">
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                    <span>Factor 4</span>
                    <Badge variant="secondary" className="text-[10px] bg-purple-500/10 text-purple-400">+1 Point</Badge>
                  </div>
                  <div className="font-semibold text-sm text-foreground flex items-center gap-1.5 mt-1">
                    <Layers className="size-4 text-purple-400" /> Compressed OR (≤ 60 pts)
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    Opening Range <strong>≤ 60 pts</strong> leaves ample daily ATR headroom for massive multi-tier ratchet runs, avoiding early morning exhaustion.
                  </p>
                </div>
              </div>

              {/* Comparison Table */}
              <div className="rounded-lg border border-border/70 overflow-hidden">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="w-[180px]">Confluence Score</TableHead>
                      <TableHead>Lot Sizing</TableHead>
                      <TableHead>Historical Win Rate</TableHead>
                      <TableHead>Profit Factor</TableHead>
                      <TableHead>Avg Return / Trade</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow className="bg-purple-500/5 font-medium">
                      <TableCell className="font-bold flex items-center gap-1.5 text-purple-400">
                        <Sparkles className="size-4" /> Score ≥ 3 (High Edge)
                      </TableCell>
                      <TableCell>
                        <Badge className="bg-purple-600 text-white font-bold">2 Lots (50 Qty)</Badge>
                      </TableCell>
                      <TableCell className="text-emerald-400 font-bold">51.81% – 57.5%</TableCell>
                      <TableCell className="text-purple-400 font-bold">3.18 PF</TableCell>
                      <TableCell className="text-emerald-400 font-semibold">+30.2 pts / trade</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">Aggressive Size on Verified Edge</TableCell>
                    </TableRow>

                    <TableRow>
                      <TableCell className="font-semibold text-muted-foreground">
                        Score &lt; 3 (Standard)
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">1 Lot (25 Qty)</Badge>
                      </TableCell>
                      <TableCell className="text-foreground">37.4% – 41.2%</TableCell>
                      <TableCell className="text-foreground">1.63 PF</TableCell>
                      <TableCell className="text-foreground font-medium">+10.8 pts / trade</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">Standard Baseline Position</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>

              {/* Impact Callout */}
              <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-start gap-3">
                <Award className="size-5 text-emerald-400 shrink-0 mt-0.5" />
                <div className="text-xs text-emerald-200 leading-relaxed">
                  <strong>The Power of Dynamic Sizing:</strong> In 10-year backtests, High-Conviction setups alone generated over <strong>+₹6,27,500 net profit</strong> with a 51.8% win rate and 3.18 PF. By doubling size only when 3 or more edges align, cumulative returns increase from ~₹5.3 Lakhs to <strong>over ₹8.5 Lakhs</strong> while keeping drawdowns virtually unchanged.
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 3: 6-TIER RATCHET LOCK ENGINE */}
        <TabsContent value="ratchet" className="space-y-6">
          <Card className="border-border/80 bg-card/60">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 bg-emerald-500/10">Empirically Verified Optimal</Badge>
                <span className="text-xs text-muted-foreground">Tested across 9 variations</span>
              </div>
              <CardTitle className="text-lg flex items-center gap-2 mt-1">
                <Lock className="size-5 text-emerald-400" /> The 6-Tier Ratchet Profit Lock Structure
              </CardTitle>
              <CardDescription>
                Wide progressive ratchets give winners breathing room while securing locked profits at institutional milestone levels.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="rounded-lg border border-border/70 overflow-hidden">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Ratchet Tier</TableHead>
                      <TableHead>Trigger Threshold</TableHead>
                      <TableHead>Stop Loss Moved To</TableHead>
                      <TableHead>Locked Net Points</TableHead>
                      <TableHead>Guaranteed P&L (1 Lot)</TableHead>
                      <TableHead>Guaranteed P&L (2 Lots)</TableHead>
                      <TableHead className="text-right">Strategy Purpose</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="font-semibold text-rose-400">Initial Stop</TableCell>
                      <TableCell>Entry Price</TableCell>
                      <TableCell className="font-mono text-rose-400">-30.0 pts</TableCell>
                      <TableCell className="font-mono text-rose-400">-30.0 pts (Risk)</TableCell>
                      <TableCell className="text-rose-400">-₹750</TableCell>
                      <TableCell className="text-rose-400">-₹1,500</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">Initial trade risk boundary</TableCell>
                    </TableRow>

                    <TableRow className="bg-muted/20">
                      <TableCell className="font-semibold text-emerald-400">Tier 1 Lock</TableCell>
                      <TableCell className="font-mono font-bold text-emerald-400">+70.0 pts</TableCell>
                      <TableCell className="font-mono text-emerald-400">+20.0 pts</TableCell>
                      <TableCell className="font-mono font-bold text-emerald-400">+20.0 pts</TableCell>
                      <TableCell className="text-emerald-400 font-semibold">+₹500</TableCell>
                      <TableCell className="text-emerald-400 font-semibold">+₹1,000</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">Breakeven+ buffer; absorbs pullback</TableCell>
                    </TableRow>

                    <TableRow>
                      <TableCell className="font-semibold text-emerald-400">Tier 2 Lock</TableCell>
                      <TableCell className="font-mono font-bold text-emerald-400">+130.0 pts</TableCell>
                      <TableCell className="font-mono text-emerald-400">+60.0 pts</TableCell>
                      <TableCell className="font-mono font-bold text-emerald-400">+60.0 pts</TableCell>
                      <TableCell className="text-emerald-400 font-semibold">+₹1,500</TableCell>
                      <TableCell className="text-emerald-400 font-semibold">+₹3,000</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">Secures day; locks Stage 2 re-entry</TableCell>
                    </TableRow>

                    <TableRow className="bg-muted/20">
                      <TableCell className="font-semibold text-emerald-400">Tier 3 Lock</TableCell>
                      <TableCell className="font-mono font-bold text-emerald-400">+180.0 pts</TableCell>
                      <TableCell className="font-mono text-emerald-400">+110.0 pts</TableCell>
                      <TableCell className="font-mono font-bold text-emerald-400">+110.0 pts</TableCell>
                      <TableCell className="text-emerald-400 font-semibold">+₹2,750</TableCell>
                      <TableCell className="text-emerald-400 font-semibold">+₹5,500</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">Century profit lock</TableCell>
                    </TableRow>

                    <TableRow>
                      <TableCell className="font-semibold text-emerald-400">Tier 4 Lock</TableCell>
                      <TableCell className="font-mono font-bold text-emerald-400">+230.0 pts</TableCell>
                      <TableCell className="font-mono text-emerald-400">+165.0 pts</TableCell>
                      <TableCell className="font-mono font-bold text-emerald-400">+165.0 pts</TableCell>
                      <TableCell className="text-emerald-400 font-semibold">+₹4,125</TableCell>
                      <TableCell className="text-emerald-400 font-semibold">+₹8,250</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">Major trend runner lock</TableCell>
                    </TableRow>

                    <TableRow className="bg-muted/20">
                      <TableCell className="font-semibold text-emerald-400">Tier 5 Lock</TableCell>
                      <TableCell className="font-mono font-bold text-emerald-400">+280.0 pts</TableCell>
                      <TableCell className="font-mono text-emerald-400">+220.0 pts</TableCell>
                      <TableCell className="font-mono font-bold text-emerald-400">+220.0 pts</TableCell>
                      <TableCell className="text-emerald-400 font-semibold">+₹5,500</TableCell>
                      <TableCell className="text-emerald-400 font-semibold">+₹11,000</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">Super-trend runner lock</TableCell>
                    </TableRow>

                    <TableRow>
                      <TableCell className="font-semibold text-purple-400">Tier 6 Lock</TableCell>
                      <TableCell className="font-mono font-bold text-purple-400">+330.0 pts</TableCell>
                      <TableCell className="font-mono text-purple-400">+270.0 pts</TableCell>
                      <TableCell className="font-mono font-bold text-purple-400">+270.0 pts</TableCell>
                      <TableCell className="text-purple-400 font-bold">+₹6,750</TableCell>
                      <TableCell className="text-purple-400 font-bold">+₹13,500</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">Uncapped monster trend lock</TableCell>
                    </TableRow>

                    <TableRow className="bg-blue-500/10 font-medium">
                      <TableCell className="font-semibold text-blue-400">EOD Market Close</TableCell>
                      <TableCell className="font-mono text-blue-400">15:15 IST</TableCell>
                      <TableCell className="text-foreground">Market Price</TableCell>
                      <TableCell className="text-foreground font-semibold">Uncapped (Ride to Close)</TableCell>
                      <TableCell colSpan={2} className="text-blue-400 text-center font-bold">Square-off at 15:15 IST Close</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">Zero overnight risk</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>

              {/* Research Insights Card */}
              <div className="p-4 rounded-lg bg-muted/40 border border-border/60 space-y-2">
                <div className="font-semibold text-xs text-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <Info className="size-3.5 text-blue-400" /> Empirical Optimization Findings (Why Tighter Stops Fail)
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  In systematic 10-year testing of 9 alternative trailing models (including chandelier ATR trailing, 15-pt fixed breakeven locks, and fixed 100-pt targets):
                </p>
                <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-5 mt-1">
                  <li><strong>Tighter Trailing Stops (+40/+10, +80/+40):</strong> Slashed overall profits by over <strong>-5,800 points</strong> because normal index consolidations prematurely choked mega runners.</li>
                  <li><strong>Fixed Targets (100–150 pts):</strong> Deprived the system of monster 200–400+ point trends, destroying between <strong>-1,100 and -3,000 points</strong> of net edge.</li>
                  <li><strong>The 6-Tier Ratchet</strong> achieved the optimal balance: giving healthy pullbacks 50–70 pts of breathing room while aggressively locking in 50–80% of peak gains as the trend accelerates.</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 4: STRIKE & EXECUTION DELTA */}
        <TabsContent value="execution" className="space-y-6">
          <Card className="border-border/80 bg-card/60">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <Badge variant="outline" className="border-blue-500/40 text-blue-400 bg-blue-500/10">Deep Synthetic Futures</Badge>
                <span className="text-xs text-muted-foreground">Zero Theta Bleed</span>
              </div>
              <CardTitle className="text-lg flex items-center gap-2 mt-1">
                <Zap className="size-5 text-blue-400" /> Strike Selection: In-The-Money 150 (ITM-150)
              </CardTitle>
              <CardDescription>
                Deep ITM options behave like synthetic futures contracts, maximizing directional delta and eliminating time decay.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 rounded-lg border bg-muted/30 border-border/60">
                  <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Delta ~0.72 – 0.75</div>
                  <div className="font-bold text-base mt-1 text-foreground">Near-Linear Movement</div>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    A 100-point move in NIFTY spot translates to <strong>+72 to +75 points</strong> in the option contract. You capture the overwhelming majority of futures expansion without futures margin requirements.
                  </p>
                </div>

                <div className="p-4 rounded-lg border bg-muted/30 border-border/60">
                  <div className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Zero Theta Bleed</div>
                  <div className="font-bold text-base mt-1 text-foreground">Intrinsic Value Dominance</div>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    With 150 points of intrinsic depth, extrinsic time value comprises only 5–10% of premium. Sideways midday consolidations do not erode contract value.
                  </p>
                </div>

                <div className="p-4 rounded-lg border bg-muted/30 border-border/60">
                  <div className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Controlled Asymmetric Risk</div>
                  <div className="font-bold text-base mt-1 text-foreground">Definitive Stop Loss</div>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    With an initial 30-point spot stop, option loss is strictly capped at ~21–22.5 points (~₹530 to ₹560 / lot), providing institutional-grade risk-to-reward ratios.
                  </p>
                </div>
              </div>

              {/* Execution Workflow Details */}
              <div className="rounded-lg border border-border/70 p-4 space-y-3">
                <div className="font-semibold text-sm text-foreground flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-emerald-400" /> Automated Live & Paper Execution Engine
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-muted-foreground">
                  <div>
                    <strong className="text-foreground">1. Continuous 1-Minute Candle Evaluation:</strong>
                    <p className="mt-0.5">The strategy operates on completed 1-minute bars aggregated directly from broker WebSocket feeds or historical CSV archives. Signals execute on the immediate next tick.</p>
                  </div>
                  <div>
                    <strong className="text-foreground">2. Live Option Pricing & Quotation:</strong>
                    <p className="mt-0.5">When running live paper monitoring, real-time bid/ask quotes from Kotak Neo / Breeze / Shoonya are dynamically retrieved for realistic option P&L tracking.</p>
                  </div>
                  <div>
                    <strong className="text-foreground">3. Trailing Precision:</strong>
                    <p className="mt-0.5">High watermarks and favorable excursion are calculated on every tick. The moment a ratchet threshold is tagged, the stop loss order is automatically updated in real-time.</p>
                  </div>
                  <div>
                    <strong className="text-foreground">4. Contract Spec:</strong>
                    <p className="mt-0.5">Standard NIFTY 50 lot size is <strong>25 quantity</strong>. SENSEX lot size is <strong>10 quantity</strong>. ITM-150 strikes round to the nearest 50-point strike interval.</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

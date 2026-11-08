import type { ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { fmtNum, fmtPts, pnlClass, prettyReason, type RuleTrade } from "@/lib/api"

export function StatCard({ label, value, hint, className }: { label: string; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-xs font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn("text-2xl font-semibold tabular-nums", className)}>{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
}

export function SideBadge({ side }: { side: string }) {
  const isBullish = side === "CALL" || side === "LONG" || side === "CE" || side === "BUY"
  return <Badge className={isBullish ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}>{side}</Badge>
}

export function RuleTradesTable({ trades, empty = "No trades." }: { trades: RuleTrade[]; empty?: string }) {
  if (!trades.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
  const hasEngineLabels = trades.some(t => Boolean((t as any).strategy_label || (t as any).engine || (t as any).stage))
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {hasEngineLabels && <TableHead>Engine / Signal</TableHead>}
          <TableHead>Side</TableHead>
          <TableHead>In</TableHead>
          <TableHead>Out</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead className="text-right">Points</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((t, i) => {
          const label = (t as any).strategy_label || (t as any).engine || (t as any).stage || "Master"
          return (
            <TableRow key={i} className="bg-transparent hover:bg-muted/20">
              {hasEngineLabels && (
                <TableCell>
                  <div className="font-semibold text-xs text-foreground flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block shrink-0" />
                    <span>{label}</span>
                  </div>
                </TableCell>
              )}
              <TableCell><SideBadge side={t.side} /></TableCell>
              <TableCell className="tabular-nums">
                <div>{t.entry}</div>
                <div className="text-xs text-muted-foreground">{fmtNum(t.entry_price)} · SL {fmtNum(t.sl)}</div>
              </TableCell>
              <TableCell className="tabular-nums">
                <div>{t.exit || "—"}</div>
                <div className="text-xs text-muted-foreground">{fmtNum(t.exit_price)} · TGT {fmtNum(t.target)}</div>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {t.reason === "open" ? <Badge variant="outline">OPEN</Badge> : prettyReason(t.reason)}
              </TableCell>
              <TableCell className={cn("text-right tabular-nums font-medium", pnlClass(t.pnl_points))}>{fmtPts(t.pnl_points)}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

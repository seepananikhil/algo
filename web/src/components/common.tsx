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
  return <Badge className={side === "CALL" ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}>{side}</Badge>
}

export function RuleTradesTable({ trades, empty = "No trades." }: { trades: RuleTrade[]; empty?: string }) {
  if (!trades.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Side</TableHead>
          <TableHead>In</TableHead>
          <TableHead>Out</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead className="text-right">Points</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((t, i) => (
          <TableRow key={i} className="bg-transparent hover:bg-muted/20">
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
        ))}
      </TableBody>
    </Table>
  )
}

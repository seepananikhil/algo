import { NavLink, Outlet } from "react-router-dom"
import { useTheme } from "next-themes"
import { Activity, CalendarDays, KeyRound, LineChart, Moon, Settings as SettingsIcon, ShieldAlert, Sun } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useStatus } from "@/lib/status"

const nav = [
  { to: "/", label: "Live", icon: Activity },
  { to: "/day", label: "Day viewer", icon: CalendarDays },
  { to: "/backtest", label: "Backtest", icon: LineChart },
  { to: "/login", label: "Fyers login", icon: KeyRound },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
]

function Dot({ ok }: { ok: boolean }) {
  return <span className={cn("size-2 rounded-full", ok ? "bg-emerald-500" : "bg-red-500")} />
}

export function Layout() {
  const { status, error } = useStatus()
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme !== "light"

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <aside className="sticky top-0 hidden h-svh w-16 shrink-0 flex-col items-center border-r bg-sidebar py-3 md:flex">
        <div className="mb-4 grid size-8 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground" title="AlgoNeo · NIFTY midpoint">A</div>
        <nav className="flex flex-col gap-1">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              title={label}
              className={({ isActive }) =>
                cn(
                  "flex w-14 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground",
                  isActive && "bg-sidebar-accent text-foreground font-medium",
                )
              }
            >
              <Icon className="size-4" />
              {label.split(" ")[0]}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background/80 px-4 py-3 backdrop-blur md:px-6">
          <nav className="flex gap-1 md:hidden">
            {nav.map(({ to, icon: Icon, label }) => (
              <NavLink key={to} to={to} end={to === "/"} aria-label={label} className={({ isActive }) => cn("rounded-md p-2", isActive && "bg-muted")}>
                <Icon className="size-4" />
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">{status?.now.slice(11) ?? "…"} IST</span>
            {error && <Badge variant="destructive">Backend offline</Badge>}
            {status && (
              <>
                <Badge variant="outline" className="gap-1.5">
                  <Dot ok={status.token.valid} /> Token {status.token.valid ? "valid" : "expired"}
                </Badge>
                <Badge variant="outline" className="gap-1.5">
                  <Dot ok={status.capture_running} /> Capture {status.capture_running ? "running" : "stopped"}
                </Badge>
                <Badge
                  className={cn(
                    status.mode === "LIVE" ? "bg-red-600 text-white" : "bg-sky-600 text-white",
                  )}
                >
                  {status.mode}
                </Badge>
                {status.kill_switch && (
                  <Badge variant="destructive" className="gap-1">
                    <ShieldAlert /> Kill switch ON
                  </Badge>
                )}
              </>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
              onClick={() => setTheme(dark ? "light" : "dark")}
            >
              {dark ? <Sun /> : <Moon />}
            </Button>
          </div>
        </header>
        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

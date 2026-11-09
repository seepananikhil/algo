import { NavLink, Outlet, useLocation } from "react-router-dom"
import { useTheme } from "next-themes"
import { Activity, CalendarDays, LineChart, Lock, Moon, Settings as SettingsIcon, ShieldAlert, Sliders, Sun, Wallet } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useStatus } from "@/lib/status"
import { postJSON } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const nav = [
  { to: "/", label: "Live Algo", icon: Activity },
  { to: "/day", label: "Day viewer", icon: CalendarDays },
  { to: "/paper", label: "Paper P&L", icon: Wallet },
  { to: "/backtest", label: "Backtest", icon: LineChart },
  { to: "/config", label: "Config", icon: Sliders },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
]

function Dot({ ok }: { ok: boolean }) {
  return <span className={cn("size-2 rounded-full", ok ? "bg-emerald-500" : "bg-red-500")} />
}

export function Layout() {
  const { status, error, reload } = useStatus()
  const { logout } = useAuth()
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme !== "light"
  const location = useLocation()
  const isLive = location.pathname === "/"

  return (
    <div
      className={cn(
        "flex bg-background text-foreground",
        isLive ? "h-screen max-h-screen overflow-hidden" : "min-h-screen"
      )}
    >
      <aside className="sticky top-0 hidden h-screen w-16 shrink-0 flex-col items-center border-r bg-sidebar py-3 md:flex">
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

      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          isLive ? "h-screen max-h-screen overflow-hidden" : "min-h-screen"
        )}
      >
        <header className="sticky top-0 z-10 flex h-10 shrink-0 items-center gap-2 border-b bg-background/80 px-3 py-1 backdrop-blur md:px-4">
          <nav className="flex gap-1 md:hidden">
            {nav.map(({ to, icon: Icon, label }) => (
              <NavLink key={to} to={to} end={to === "/"} aria-label={label} className={({ isActive }) => cn("rounded-md p-1.5", isActive && "bg-muted")}>
                <Icon className="size-3.5" />
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">{status?.now.slice(11) ?? "…"} IST</span>
            {error && <Badge variant="destructive" className="py-0 text-[10px]">Backend offline</Badge>}
            {status && (
              <>
                <Badge variant="outline" className="gap-1 py-0 text-[11px]">
                  <Dot ok={status.token.valid} />
                  Kotak: {status.token.valid ? (status.token.greeting_name || "Connected") : "Offline"}
                </Badge>
                <button
                  type="button"
                  onClick={async () => {
                    const endpoint = status.capture_running ? "/api/capture/stop" : "/api/capture/start"
                    await postJSON(endpoint, {})
                    await reload()
                  }}
                  title={status.capture_running ? "Click to stop market capture" : "Click to start market capture"}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-medium transition-all select-none cursor-pointer",
                    status.capture_running
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 active:scale-95"
                      : "bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20 active:scale-95"
                  )}
                >
                  <Dot ok={status.capture_running} />
                  <span>Capture {status.capture_running ? "running" : "stopped"}</span>
                  <span className="text-[9px] underline opacity-75 font-normal">
                    {status.capture_running ? "(stop)" : "(start)"}
                  </span>
                </button>
                <Badge
                  className={cn(
                    "py-0 text-[11px]",
                    status.mode === "LIVE" ? "bg-red-600 text-white" : "bg-sky-600 text-white",
                  )}
                >
                  {status.mode}
                </Badge>
                {status.kill_switch && (
                  <Badge variant="destructive" className="gap-1 py-0 text-[11px]">
                    <ShieldAlert className="size-3" /> Kill switch ON
                  </Badge>
                )}
              </>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              className="h-7 w-7"
              aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
              onClick={() => setTheme(dark ? "light" : "dark")}
            >
              {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              title="Lock terminal"
              aria-label="Lock terminal"
              onClick={() => logout()}
            >
              <Lock className="size-3.5" />
            </Button>
          </div>
        </header>
        <main
          className={cn(
            "flex-1 p-2 sm:p-2.5 flex flex-col",
            isLive ? "min-h-0 overflow-hidden p-0" : "min-h-0 overflow-y-auto"
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}

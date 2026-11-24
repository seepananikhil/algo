import { NavLink, Outlet, useLocation } from "react-router-dom"
import { useTheme } from "next-themes"
import { Activity, Briefcase, LineChart, Lock, Moon, Power, Settings as SettingsIcon, ShieldAlert, Sun, Wallet, TrendingUp, Sliders, Zap } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useStatus } from "@/lib/status"
import { postJSON } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const nav = [
  { to: "/", label: "Live Algo", icon: Activity },
  { to: "/holdings", label: "Holdings", icon: Briefcase },
  { to: "/swinger", label: "Swinger Portfolio", icon: TrendingUp },
  { to: "/scalp", label: "Scalp", icon: Zap },
  { to: "/paper", label: "Paper", icon: Wallet },
  { to: "/backtest", label: "Backtest", icon: LineChart },
  { to: "/config", label: "Strategy Config", icon: Sliders },
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
  const isTrade = location.pathname === "/scalp" || location.pathname === "/trade" || location.pathname === "/manual" || location.pathname === "/mobile"
  const isSwinger = location.pathname === "/swinger"
  const isHoldings = location.pathname === "/holdings"
  const isPaper = location.pathname === "/paper"
  const isBacktest = location.pathname === "/backtest"
  const isFixedViewport = isLive || isTrade || isSwinger || isHoldings || isPaper || isBacktest

  return (
    <div
      className={cn(
        "flex bg-background text-foreground",
        isFixedViewport ? "h-[100dvh] max-h-[100dvh] overflow-hidden" : "min-h-screen"
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
          isFixedViewport ? "h-[100dvh] max-h-[100dvh] overflow-hidden" : "min-h-screen"
        )}
      >
        {/* 1. Mobile Top Status Bar - Hidden on /trade */}
        {!isTrade && (
          <header className="flex md:hidden h-10 shrink-0 items-center justify-between px-3 border-b bg-background/95 backdrop-blur z-20">
            <div className="flex items-center gap-2">
              <div className="grid size-6 place-items-center rounded-md bg-primary text-xs font-black text-primary-foreground shadow-xs">
                A
              </div>
              <NavLink
                to="/settings?tab=broker"
                className={cn(
                  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-semibold transition-all select-none",
                  status?.token.valid
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                    : "bg-red-500/15 border-red-500/40 text-red-400 animate-pulse"
                )}
              >
                <Dot ok={Boolean(status?.token.valid)} />
                <span>Kotak: {status?.token.valid ? "Connected" : "Offline"}</span>
              </NavLink>
            </div>

            <div className="flex items-center gap-1.5">
              <Badge
                className={cn(
                  "py-0 px-1.5 text-[10px] font-bold",
                  status?.mode === "LIVE" ? "bg-red-600 text-white" : "bg-sky-600 text-white"
                )}
              >
                • {status?.mode || "LIVE"}
              </Badge>

              <button
                type="button"
                onClick={async () => {
                  const isStopped = status?.kill_switch
                  const url = isStopped ? "/api/kill-switch/off" : "/api/kill-switch/on"
                  await postJSON(url, {})
                  await reload()
                }}
                title={status?.kill_switch ? "Trading Halted - Tap to Resume" : "Emergency Kill Switch"}
                className={cn(
                  "size-7 rounded-lg border flex items-center justify-center transition-all",
                  status?.kill_switch
                    ? "bg-rose-500 text-white border-rose-600 animate-pulse"
                    : "bg-muted/40 border-border/60 text-muted-foreground hover:text-foreground active:scale-95"
                )}
              >
                <Power className="size-3.5" />
              </button>

              <Button
                variant="ghost"
                size="icon-xs"
                className="size-7 text-muted-foreground hover:text-foreground"
                title="Lock terminal"
                onClick={() => logout()}
              >
                <Lock className="size-3.5" />
              </Button>
            </div>
          </header>
        )}

        {/* Desktop Header - Hidden on /trade */}
        {!isTrade && (
          <header className="sticky top-0 z-10 hidden md:flex h-10 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground tabular-nums">{status?.now.slice(11) ?? "…"} IST</span>
              {error && <Badge variant="destructive" className="py-0 text-[10px]">Backend offline</Badge>}
              {status && (
                <>
                  <NavLink
                    to="/settings?tab=broker"
                    title={status.token.valid ? "Kotak Neo session active · Click for account & margin" : "Kotak Neo offline · Click to log in"}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-medium transition-all select-none cursor-pointer",
                      status.token.valid
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                        : "bg-red-500/15 border-red-500/40 text-red-400 hover:bg-red-500/25 animate-pulse"
                    )}
                  >
                    <Dot ok={status.token.valid} />
                    <span>Kotak: {status.token.valid ? (status.token.greeting_name || "Connected") : "Offline"}</span>
                    {!status.token.valid && (
                      <span className="text-[9px] underline font-semibold ml-0.5">
                        (Login)
                      </span>
                    )}
                  </NavLink>
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
        )}

        <main
          className={cn(
            "flex-1 flex flex-col min-h-0",
            isFixedViewport ? "overflow-hidden p-0" : "overflow-y-auto p-0"
          )}
        >
          <Outlet />
        </main>

        {/* 7. Bottom Tab Bar (Mobile) - Hidden on Quick Scalper (/trade) */}
        {!isTrade && (
          <nav className="flex md:hidden h-12 shrink-0 items-center justify-around border-t bg-background/95 backdrop-blur z-20 px-1">
            {[
              { to: "/", label: "Live", icon: Activity },
              { to: "/holdings", label: "Holdings", icon: Briefcase },
              { to: "/scalp", label: "Scalp*", icon: Zap },
              { to: "/paper", label: "Paper", icon: Wallet },
              { to: "/settings", label: "Settings", icon: SettingsIcon },
            ].map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  cn(
                    "flex flex-col items-center justify-center flex-1 py-1 rounded-lg text-[10px] transition-colors",
                    isActive
                      ? "text-primary font-bold"
                      : "text-muted-foreground hover:text-foreground font-medium"
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <div className="relative">
                      <Icon className={cn("size-4", isActive && "stroke-[2.5]")} />
                      {(to === "/scalp" || to === "/trade") && (
                        <span className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-amber-400 animate-ping" />
                      )}
                    </div>
                    <span className="mt-0.5 leading-none">{label}</span>
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}

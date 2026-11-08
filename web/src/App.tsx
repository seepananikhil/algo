import { lazy, Suspense } from "react"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Layout } from "@/components/layout"
import { StatusProvider } from "@/lib/status"
import { AuthProvider, AuthGate } from "@/lib/auth"
import { LivePage } from "@/pages/live"

const ManualTradingPage = lazy(() => import("@/pages/manual").then(m => ({ default: m.ManualTradingPage })))
const DayPage = lazy(() => import("@/pages/day").then(m => ({ default: m.DayPage })))
const PaperPage = lazy(() => import("@/pages/paper").then(m => ({ default: m.PaperPage })))
const BacktestPage = lazy(() => import("@/pages/backtest").then(m => ({ default: m.BacktestPage })))
const LoginPage = lazy(() => import("@/pages/login").then(m => ({ default: m.LoginPage })))
const SettingsPage = lazy(() => import("@/pages/settings").then(m => ({ default: m.SettingsPage })))
const ConfigPage = lazy(() => import("@/pages/config").then(m => ({ default: m.ConfigPage })))

function PageFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center min-h-[300px] text-xs font-mono text-muted-foreground animate-pulse">
      Loading...
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <AuthProvider>
        <AuthGate>
          <StatusProvider>
            <TooltipProvider>
              <BrowserRouter>
                <Routes>
                  <Route element={<Layout />}>
                    <Route index element={<LivePage />} />
                    <Route path="manual" element={<Suspense fallback={<PageFallback />}><ManualTradingPage /></Suspense>} />
                    <Route path="day" element={<Suspense fallback={<PageFallback />}><DayPage /></Suspense>} />
                    <Route path="paper" element={<Suspense fallback={<PageFallback />}><PaperPage /></Suspense>} />
                    <Route path="backtest" element={<Suspense fallback={<PageFallback />}><BacktestPage /></Suspense>} />
                    <Route path="login" element={<Suspense fallback={<PageFallback />}><LoginPage /></Suspense>} />
                    <Route path="settings" element={<Suspense fallback={<PageFallback />}><SettingsPage /></Suspense>} />
                    <Route path="config" element={<Suspense fallback={<PageFallback />}><ConfigPage /></Suspense>} />
                    <Route path="strategy-info" element={<Suspense fallback={<PageFallback />}><ConfigPage /></Suspense>} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Route>
                </Routes>
              </BrowserRouter>
              <Toaster richColors position="bottom-right" />
            </TooltipProvider>
          </StatusProvider>
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  )
}

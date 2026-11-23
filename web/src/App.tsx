import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Layout } from "@/components/layout"
import { StatusProvider } from "@/lib/status"
import { AuthProvider, AuthGate } from "@/lib/auth"
import { AlertCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ManualTradingPage } from "@/pages/manual"

function lazyWithRetry<T extends React.ComponentType<any>>(
  factory: () => Promise<{ default: T }>
) {
  return lazy(async () => {
    try {
      return await factory()
    } catch (err) {
      console.warn("Chunk load failed, retrying import with cache-bust...", err)
      try {
        await new Promise(r => setTimeout(r, 400))
        return await factory()
      } catch (err2) {
        window.location.reload()
        return new Promise<{ default: T }>(() => {})
      }
    }
  })
}

const LivePage = lazyWithRetry(() => import("@/pages/live").then(m => ({ default: m.LivePage })))
const BacktestPage = lazyWithRetry(() => import("@/pages/backtest").then(m => ({ default: m.BacktestPage })))
const PaperPage = lazyWithRetry(() => import("@/pages/paper").then(m => ({ default: m.PaperPage })))
const LoginPage = lazyWithRetry(() => import("@/pages/login").then(m => ({ default: m.LoginPage })))
const SettingsPage = lazyWithRetry(() => import("@/pages/settings").then(m => ({ default: m.SettingsPage })))
const ConfigPage = lazyWithRetry(() => import("@/pages/config").then(m => ({ default: m.ConfigPage })))
const SwingerPage = lazyWithRetry(() => import("@/pages/swinger").then(m => ({ default: m.SwingerPage })))
const HoldingsPage = lazyWithRetry(() => import("@/pages/holdings").then(m => ({ default: m.HoldingsPage })))
const OnboardingPage = lazyWithRetry(() => import("@/pages/onboard").then(m => ({ default: m.OnboardingPage })))

function PageFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center min-h-[300px] text-xs font-mono text-muted-foreground animate-pulse">
      Loading...
    </div>
  )
}

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("AppErrorBoundary caught error:", error, errorInfo)
  }

  handleReload = () => {
    window.location.reload()
  }

  handleHardReset = () => {
    localStorage.removeItem("backtest_main_strategy")
    localStorage.removeItem("backtest_sub_symbol")
    sessionStorage.clear()
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen w-full flex-col items-center justify-center bg-background p-6 text-foreground">
          <div className="max-w-md w-full rounded-2xl border border-rose-500/30 bg-rose-500/5 p-6 shadow-xl backdrop-blur-xs flex flex-col items-center text-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-rose-500/10 text-rose-500">
              <AlertCircle className="size-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Something went wrong</h2>
              <p className="text-xs text-muted-foreground mt-1">
                {this.state.error?.message || "An unexpected rendering error occurred."}
              </p>
            </div>
            <div className="flex items-center gap-2 w-full pt-2">
              <Button onClick={this.handleReload} className="flex-1 bg-primary text-primary-foreground font-semibold text-xs">
                <RefreshCw className="size-3.5 mr-1.5" />
                Reload Page
              </Button>
              <Button onClick={this.handleHardReset} variant="outline" className="flex-1 text-xs">
                Reset App State
              </Button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
        <AuthProvider>
          <AuthGate>
            <StatusProvider>
              <TooltipProvider>
                <BrowserRouter>
                  <Routes>
                    <Route element={<Layout />}>
                      <Route index element={<Suspense fallback={<PageFallback />}><LivePage /></Suspense>} />
                      <Route path="scalp" element={<ManualTradingPage />} />
                      <Route path="trade" element={<ManualTradingPage />} />
                      <Route path="mobile" element={<Navigate to="/scalp" replace />} />
                      <Route path="manual" element={<ManualTradingPage />} />
                      <Route path="day" element={<Navigate to="/paper" replace />} />
                      <Route path="paper" element={<Suspense fallback={<PageFallback />}><PaperPage /></Suspense>} />
                      <Route path="swinger" element={<Suspense fallback={<PageFallback />}><SwingerPage /></Suspense>} />
                      <Route path="holdings" element={<Suspense fallback={<PageFallback />}><HoldingsPage /></Suspense>} />
                      <Route path="portfolio" element={<Navigate to="/holdings" replace />} />
                      <Route path="backtest" element={<Suspense fallback={<PageFallback />}><BacktestPage /></Suspense>} />
                      <Route path="login" element={<Suspense fallback={<PageFallback />}><LoginPage /></Suspense>} />
                      <Route path="settings" element={<Suspense fallback={<PageFallback />}><SettingsPage /></Suspense>} />
                      <Route path="onboard" element={<Suspense fallback={<PageFallback />}><OnboardingPage /></Suspense>} />
                      <Route path="config" element={<Suspense fallback={<PageFallback />}><ConfigPage /></Suspense>} />
                      <Route path="strategy" element={<Suspense fallback={<PageFallback />}><ConfigPage /></Suspense>} />
                      <Route path="broker" element={<Navigate to="/settings?tab=broker" replace />} />
                      <Route path="strategy-info" element={<Navigate to="/config" replace />} />
                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Route>
                  </Routes>
                </BrowserRouter>
                <Toaster richColors position="top-center" visibleToasts={1} duration={1800} closeButton />
              </TooltipProvider>
            </StatusProvider>
          </AuthGate>
        </AuthProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  )
}

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Layout } from "@/components/layout"
import { StatusProvider } from "@/lib/status"
import { LivePage } from "@/pages/live"
import { DayPage } from "@/pages/day"
import { BacktestPage } from "@/pages/backtest"
import { LoginPage } from "@/pages/login"
import { SettingsPage } from "@/pages/settings"

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
    <StatusProvider>
      <TooltipProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<LivePage />} />
              <Route path="day" element={<DayPage />} />
              <Route path="backtest" element={<BacktestPage />} />
              <Route path="login" element={<LoginPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </StatusProvider>
    </ThemeProvider>
  )
}

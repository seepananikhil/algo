import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { Lock, ShieldCheck, KeyRound, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getJSON, postJSON } from "@/lib/api"
import { toast } from "sonner"

type AuthContextType = {
  authenticated: boolean
  loading: boolean
  login: (pin: string) => Promise<boolean>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({
  authenticated: false,
  loading: true,
  login: async () => false,
  logout: async () => {},
})

export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean>(() => {
    return Boolean(localStorage.getItem("algo_auth"))
  })
  const [loading, setLoading] = useState<boolean>(true)

  useEffect(() => {
    checkStatus()
  }, [])

  async function checkStatus() {
    try {
      const res = await getJSON<{ authenticated: boolean }>("/api/auth/status")
      setAuthenticated(res.authenticated)
      if (!res.authenticated) {
        localStorage.removeItem("algo_auth")
      }
    } catch {
      // If endpoint fails, keep current state or allow retry
    } finally {
      setLoading(false)
    }
  }

  async function login(pin: string): Promise<boolean> {
    try {
      const res = await postJSON<{ ok: boolean; token: string }>("/api/auth/login", { pin })
      if (res.ok && res.token) {
        localStorage.setItem("algo_auth", res.token)
        setAuthenticated(true)
        toast.success("Terminal unlocked successfully")
        return true
      }
      return false
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Incorrect PIN")
      return false
    }
  }

  async function logout() {
    try {
      await postJSON("/api/auth/logout", {})
    } catch {
      // Ignore
    }
    localStorage.removeItem("algo_auth")
    setAuthenticated(false)
    toast.info("Terminal locked")
  }

  return (
    <AuthContext.Provider value={{ authenticated, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { authenticated, loading, login } = useAuth()
  const [pin, setPin] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState("")

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background text-xs font-mono text-muted-foreground animate-pulse">
        Verifying security session...
      </div>
    )
  }

  if (authenticated) {
    return <>{children}</>
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!pin.trim()) return
    setSubmitting(true)
    setErrorMsg("")
    const success = await login(pin.trim())
    setSubmitting(false)
    if (!success) {
      setErrorMsg("Invalid PIN. Please try again.")
      setPin("")
    }
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background/95 p-4 select-none">
      <Card className="w-full max-w-sm border-border/80 bg-card/95 shadow-2xl backdrop-blur-md">
        <CardHeader className="text-center pb-4">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
            <Lock className="size-6" />
          </div>
          <CardTitle className="text-xl font-bold tracking-tight">Algo Terminal Locked</CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Enter your 6-digit Kotak MPIN to access live trading, order controls, and metrics.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="relative">
              <Input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                autoFocus
                placeholder="Enter 6-Digit PIN"
                value={pin}
                onChange={(e) => {
                  setErrorMsg("")
                  setPin(e.target.value)
                }}
                className="text-center text-lg tracking-widest font-mono h-12 bg-muted/40 border-border"
              />
              <KeyRound className="absolute left-3 top-3.5 size-5 text-muted-foreground/50 pointer-events-none" />
            </div>

            {errorMsg && (
              <div className="flex items-center gap-1.5 text-xs text-rose-500 justify-center font-medium">
                <AlertCircle className="size-3.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            <Button
              type="submit"
              disabled={submitting || pin.length < 4}
              className="w-full h-11 font-semibold text-sm bg-emerald-600 hover:bg-emerald-500 text-white transition-all"
            >
              <ShieldCheck className="size-4 mr-2" />
              {submitting ? "Unlocking..." : "Unlock Terminal"}
            </Button>

            <p className="text-[11px] text-center text-muted-foreground/70">
              Session is encrypted and automatically remembered on this device for 30 days.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

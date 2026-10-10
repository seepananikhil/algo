import { createContext, useContext, type ReactNode } from "react"
import { usePoll, type Status } from "@/lib/api"

type Ctx = { status: Status | null; error: string | null; reload: () => Promise<boolean> }

const StatusContext = createContext<Ctx>({ status: null, error: null, reload: async () => false })

export function StatusProvider({ children }: { children: ReactNode }) {
  const { data, error, reload } = usePoll<Status>("/api/status", 3000)
  return <StatusContext.Provider value={{ status: data, error, reload }}>{children}</StatusContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useStatus = () => useContext(StatusContext)

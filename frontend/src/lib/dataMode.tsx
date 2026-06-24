import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

interface DataModeValue {
  preferLive: boolean
  setPreferLive: (v: boolean) => void
}

const DataModeContext = createContext<DataModeValue | null>(null)

/**
 * Global "live vs synthetic" data toggle. Every query/WS reads this so one switch in the
 * header controls whether the whole dashboard pulls live yfinance/FRED data or the
 * backend's deterministic synthetic fallback.
 */
export function DataModeProvider({ children }: { children: ReactNode }) {
  const [preferLive, setPreferLive] = useState<boolean>(false)
  const value = useMemo(() => ({ preferLive, setPreferLive }), [preferLive])
  return <DataModeContext.Provider value={value}>{children}</DataModeContext.Provider>
}

export function useDataMode(): DataModeValue {
  const ctx = useContext(DataModeContext)
  if (!ctx) throw new Error('useDataMode must be used within DataModeProvider')
  return ctx
}

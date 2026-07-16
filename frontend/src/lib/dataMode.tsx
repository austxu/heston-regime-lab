import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { DataModeContext } from './dataModeContext'

const STORAGE_KEY = 'heston-regime-lab:data-mode'

/**
 * Global live/synthetic preference. Query keys and calibration streams read the same value,
 * and the small device-local preference is synchronized across browser tabs.
 */
export function DataModeProvider({ children }: { children: ReactNode }) {
  const [preferLive, setPreferLive] = useState(readInitialMode)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, preferLive ? 'live' : 'synthetic')
    } catch {
      // Storage may be disabled; the in-memory preference still works for this session.
    }
  }, [preferLive])

  useEffect(() => {
    const syncMode = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        setPreferLive(event.newValue === 'live')
      }
    }
    window.addEventListener('storage', syncMode)
    return () => window.removeEventListener('storage', syncMode)
  }, [])

  const value = useMemo(() => ({ preferLive, setPreferLive }), [preferLive])
  return <DataModeContext.Provider value={value}>{children}</DataModeContext.Provider>
}

function readInitialMode(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'live'
  } catch {
    return false
  }
}

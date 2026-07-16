import { createContext, useContext } from 'react'

export interface DataModeValue {
  preferLive: boolean
  setPreferLive: (value: boolean) => void
}

export const DataModeContext = createContext<DataModeValue | null>(null)

export function useDataMode(): DataModeValue {
  const context = useContext(DataModeContext)
  if (!context) throw new Error('useDataMode must be used within DataModeProvider')
  return context
}

import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { ComparisonResponse, HealthResponse, SurfaceResponse } from '../api/types'
import { useDataMode } from '../lib/dataModeContext'

// Market-data queries keyed by the live/synthetic mode so flipping the toggle refetches.

export function useHealth() {
  return useQuery<HealthResponse, Error>({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: 30_000,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  })
}

export function useSurface() {
  const { preferLive } = useDataMode()
  return useQuery<SurfaceResponse, Error>({
    queryKey: ['surface', preferLive],
    queryFn: ({ signal }) => api.surface(preferLive, signal),
  })
}

export function useComparison() {
  const { preferLive } = useDataMode()
  return useQuery<ComparisonResponse, Error>({
    queryKey: ['comparison', preferLive],
    queryFn: ({ signal }) => api.comparison(preferLive, signal),
  })
}

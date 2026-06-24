import { useQuery } from '@tanstack/react-query'
import { AnalysisPendingError, api } from '../api/client'
import type {
  RegimeCurrentResponse,
  RegimeHistoryResponse,
  RegimeParametersResponse,
} from '../api/types'
import { useDataMode } from '../lib/dataMode'

export function useRegimeCurrent() {
  const { preferLive } = useDataMode()
  return useQuery<RegimeCurrentResponse, Error>({
    queryKey: ['regime-current', preferLive],
    queryFn: ({ signal }) => api.regimeCurrent(preferLive, signal),
    refetchInterval: 60_000,
  })
}

export function useRegimeHistory(downsample = 5) {
  const { preferLive } = useDataMode()
  return useQuery<RegimeHistoryResponse, Error>({
    queryKey: ['regime-history', preferLive, downsample],
    queryFn: ({ signal }) => api.regimeHistory(preferLive, downsample, signal),
  })
}

/**
 * The heavy Kruskal-Wallis / regime-conditional analysis returns 202 while it computes in
 * the background; we poll every few seconds until it's ready, then stop. The pending state
 * is carried as `AnalysisPendingError` and rendered as "computing" rather than an error.
 */
export function useRegimeParameters() {
  return useQuery<RegimeParametersResponse, Error>({
    queryKey: ['regime-parameters'],
    queryFn: ({ signal }) => api.regimeParameters(signal),
    refetchInterval: (query) =>
      (!!query.state.error && query.state.error instanceof AnalysisPendingError) || !query.state.data
        ? 4_000
        : false,
    retry: false,
    staleTime: Infinity,
  })
}

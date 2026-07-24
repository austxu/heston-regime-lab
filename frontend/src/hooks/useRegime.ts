import { useQuery } from '@tanstack/react-query'
import { AnalysisPendingError, api } from '../api/client'
import type {
  RegimeCurrentResponse,
  RegimeHistoryResponse,
  RegimeParametersResponse,
} from '../api/types'
import { demoData } from '../demo'
import { useDataMode } from '../lib/dataModeContext'

export function useRegimeCurrent() {
  const { preferLive } = useDataMode()
  return useQuery<RegimeCurrentResponse, Error>({
    queryKey: ['regime-current', preferLive],
    queryFn: ({ signal }) =>
      preferLive ? api.regimeCurrent(true, signal) : Promise.resolve(demoData.current),
    initialData: demoData.current,
    initialDataUpdatedAt: preferLive ? 0 : undefined,
    staleTime: preferLive ? 0 : Infinity,
    refetchOnMount: preferLive ? 'always' : false,
    refetchInterval: 60_000,
  })
}

export function useRegimeHistory(downsample = 5) {
  const { preferLive } = useDataMode()
  return useQuery<RegimeHistoryResponse, Error>({
    queryKey: ['regime-history', preferLive, downsample],
    queryFn: ({ signal }) =>
      preferLive
        ? api.regimeHistory(true, downsample, signal)
        : Promise.resolve(demoData.history),
    initialData: demoData.history,
    initialDataUpdatedAt: preferLive ? 0 : undefined,
    staleTime: preferLive ? 0 : Infinity,
    refetchOnMount: preferLive ? 'always' : false,
  })
}

/**
 * The heavy Kruskal-Wallis / regime-conditional analysis returns 202 while it computes in
 * the background; we poll every few seconds until it's ready, then stop. The pending state
 * is carried as `AnalysisPendingError` and rendered as "computing" rather than an error.
 */
export function useRegimeParameters(enabled = true) {
  const { preferLive } = useDataMode()
  return useQuery<RegimeParametersResponse, Error>({
    queryKey: ['regime-parameters', preferLive],
    queryFn: ({ signal }) =>
      preferLive ? api.regimeParameters(true, signal) : Promise.resolve(demoData.parameters),
    enabled,
    initialData: demoData.parameters,
    initialDataUpdatedAt: preferLive ? 0 : undefined,
    staleTime: preferLive ? 0 : Infinity,
    refetchOnMount: preferLive ? 'always' : false,
    refetchInterval: (query) =>
      (!!query.state.error && query.state.error instanceof AnalysisPendingError) || !query.state.data
        ? 4_000
        : false,
    retry: false,
  })
}

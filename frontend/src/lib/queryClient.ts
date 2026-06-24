import { QueryClient } from '@tanstack/react-query'
import { AnalysisPendingError } from '../api/client'

// Backend results are themselves session-cached, so we keep them fresh for a few minutes
// client-side and avoid noisy refetches. Network errors retry a couple of times; the
// "analysis still computing" (202) signal is never treated as a hard failure.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof AnalysisPendingError) return false // handled via refetchInterval
        return failureCount < 2
      },
    },
  },
})

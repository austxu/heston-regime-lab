import type { ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { AnalysisPendingError } from '../../api/client'

interface QueryStateProps<T> {
  query: UseQueryResult<T, Error>
  skeleton: ReactNode
  children: (data: T) => ReactNode
  /** Message shown while the backend reports a heavy analysis is still computing (202). */
  pendingMessage?: string
}

/** Standardised loading / error / pending / success rendering around a React Query result. */
export function QueryState<T>({ query, skeleton, children, pendingMessage }: QueryStateProps<T>) {
  if (query.data) return <>{children(query.data)}</>

  if (query.isError) {
    // The heavy regime analysis returns 202 -> AnalysisPendingError: render as "computing".
    if (query.error instanceof AnalysisPendingError && pendingMessage) {
      return <PendingNotice message={pendingMessage} />
    }
    return <ErrorNotice message={query.error.message} onRetry={() => void query.refetch()} />
  }

  // First load, no data yet.
  return <>{skeleton}</>
}

function PendingNotice({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-edge bg-panel2 px-4 py-6 text-sm text-muted">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-edge border-t-accent" />
      {message}
    </div>
  )
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-5 text-sm">
      <p className="font-medium text-rose-300">API request failed</p>
      <p className="mt-1 break-words text-xs text-muted">{message}</p>
      <button
        onClick={onRetry}
        className="mt-3 rounded-lg border border-edge px-3 py-1.5 text-xs text-ink hover:bg-edge/40"
      >
        Retry
      </button>
    </div>
  )
}

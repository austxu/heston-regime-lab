import type { ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { AnalysisPendingError } from '../../api/client'

interface QueryStateProps<T> {
  query: UseQueryResult<T, Error>
  skeleton: ReactNode
  children: (data: T) => ReactNode
  /** Message shown while the backend reports a heavy analysis is still computing (202). */
  pendingMessage?: string
  /** Disable when the same query is rendered twice on one page to avoid duplicate notices. */
  showBackgroundError?: boolean
}

/** Standard loading / offline / error / pending / success rendering for React Query data. */
export function QueryState<T>({
  query,
  skeleton,
  children,
  pendingMessage,
  showBackgroundError = true,
}: QueryStateProps<T>) {
  if (query.data !== undefined) {
    return (
      <>
        {query.isError && showBackgroundError && (
          <RefreshWarning message={query.error.message} onRetry={() => void query.refetch()} />
        )}
        {children(query.data)}
      </>
    )
  }

  if (query.fetchStatus === 'paused') return <OfflineNotice />

  if (query.isError) {
    if (query.error instanceof AnalysisPendingError && pendingMessage) {
      return <PendingNotice message={pendingMessage} />
    }
    return (
      <ErrorNotice
        message={query.error.message}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    )
  }

  return <>{skeleton}</>
}

function PendingNotice({ message }: { message: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-lg border border-edge bg-panel2 px-4 py-6 text-sm text-muted"
    >
      <span aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-edge border-t-accent" />
      {message}
    </div>
  )
}

function OfflineNotice() {
  return (
    <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-5 text-sm">
      <p className="font-medium text-amber-200">You appear to be offline</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        This view will load automatically when the network connection returns.
      </p>
    </div>
  )
}

function RefreshWarning({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs">
      <span className="text-amber-200" title={message}>
        Showing saved data because the latest refresh failed.
      </span>
      <button type="button" onClick={onRetry} className="font-medium text-ink hover:text-white">
        Retry refresh
      </button>
    </div>
  )
}

function ErrorNotice({
  message,
  retrying,
  onRetry,
}: {
  message: string
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-5 text-sm">
      <p className="font-medium text-rose-300">Unable to load this data</p>
      <p className="mt-1 break-words text-xs leading-relaxed text-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="mt-3 rounded-lg border border-edge px-3 py-1.5 text-xs text-ink transition-colors hover:bg-edge/40 disabled:cursor-wait disabled:opacity-60"
      >
        {retrying ? 'Retrying…' : 'Try again'}
      </button>
    </div>
  )
}

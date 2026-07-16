import { useHealth } from '../../hooks/useApiQueries'
import { DataModeToggle } from './DataModeToggle'

/** App header: title, the live/synthetic data toggle, and an actionable API health pill. */
export function Header() {
  const health = useHealth()
  const paused = health.fetchStatus === 'paused'
  const checking = health.isPending && !paused
  const unavailable = paused || health.isError
  const ok = !unavailable && health.data?.status === 'ok'
  const dotClass = checking ? 'bg-amber-400' : ok ? 'bg-emerald-400' : 'bg-rose-400'
  const statusLabel = paused ? 'Offline' : checking ? 'Checking API' : ok ? 'API online' : 'API unavailable'
  const details = health.data
    ? `API v${health.data.version} · ${health.data.cache_backend} cache`
    : health.error?.message

  return (
    <header className="sticky top-0 z-30 border-b border-edge bg-base/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:flex-nowrap sm:px-6">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="shrink-0 font-mono text-sm font-semibold tracking-tight text-ink">
            heston<span className="text-accent">·</span>regime<span className="text-accent">·</span>lab
          </h1>
          <p className="hidden truncate text-xs text-muted md:block">
            stochastic-vol calibration &amp; regime analytics
          </p>
        </div>

        <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
          <DataModeToggle />
          <button
            type="button"
            onClick={() => void health.refetch()}
            disabled={health.isFetching}
            title={details ?? 'Refresh API health'}
            aria-label={`${statusLabel}. Refresh API health.`}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-edge bg-panel2 px-2.5 py-1 text-xs text-muted transition-colors hover:border-slate-600 hover:text-ink disabled:cursor-wait"
          >
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
            <span role="status" aria-live="polite">{statusLabel}</span>
            {health.data && (
              <span className="hidden text-muted/70 lg:inline">v{health.data.version}</span>
            )}
            {!ok && !checking && !paused && <span className="text-rose-300">· Retry</span>}
          </button>
        </div>
      </div>
    </header>
  )
}

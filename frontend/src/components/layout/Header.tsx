import { useHealth } from '../../hooks/useApiQueries'
import { DataModeToggle } from './DataModeToggle'

/** App header: title, the live/synthetic data toggle, and an API health pill. */
export function Header() {
  const health = useHealth()
  const ok = health.data?.status === 'ok'
  const dotClass = health.isPending ? 'bg-amber-400' : ok ? 'bg-emerald-400' : 'bg-rose-400'

  return (
    <header className="sticky top-0 z-30 border-b border-edge bg-base/80 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-sm font-semibold tracking-tight text-ink">
            heston<span className="text-accent">·</span>regime<span className="text-accent">·</span>lab
          </span>
          <span className="hidden text-xs text-muted sm:inline">
            stochastic-vol calibration &amp; regime analytics
          </span>
        </div>

        <div className="flex items-center gap-3">
          <DataModeToggle />
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-panel2 px-2.5 py-1 text-xs text-muted">
            <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
            API
            {health.data && <span className="text-muted/70">v{health.data.version}</span>}
            {health.data && (
              <span className="text-muted/70">· {health.data.cache_backend}</span>
            )}
          </span>
        </div>
      </div>
    </header>
  )
}

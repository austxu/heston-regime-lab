import type { Provenance } from '../../api/types'
import { timeAgo } from '../../lib/format'
import { Badge } from './Badge'

/**
 * Compact provenance + staleness chip shown on every data panel: whether the data is live
 * or synthetic, when it was last fetched, and whether it is being served stale after a
 * failed refresh.
 */
export function StalenessIndicator({ provenance }: { provenance?: Provenance }) {
  if (!provenance) return null
  const fetched = provenance.cached_at ?? provenance.as_of
  const tone = provenance.stale ? 'warn' : provenance.source === 'live' ? 'good' : 'info'
  const sourceLabel = provenance.source.toUpperCase()

  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
      <Badge tone={tone}>
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            provenance.stale ? 'bg-amber-400' : provenance.source === 'live' ? 'bg-emerald-400' : 'bg-sky-400'
          }`}
        />
        {provenance.stale ? 'STALE' : sourceLabel}
      </Badge>
      <span className="text-xs text-muted" title={fetched ?? ''}>
        updated {timeAgo(fetched)}
      </span>
    </span>
  )
}

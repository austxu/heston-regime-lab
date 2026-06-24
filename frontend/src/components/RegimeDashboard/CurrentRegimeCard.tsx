import type { RegimeCurrentResponse } from '../../api/types'
import { prettyRegime, regimeColor } from '../../lib/theme'

/** Big current-regime badge plus posterior probabilities as labelled CSS bars. */
export function CurrentRegimeCard({ data }: { data: RegimeCurrentResponse }) {
  const color = regimeColor(data.regime)
  // Probabilities in regime order if possible; fall back to entries.
  const entries = Object.entries(data.probabilities)

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
      <div className="flex flex-col items-start justify-center">
        <span className="stat-label">Current market regime</span>
        <div
          className="mt-2 inline-flex items-center gap-2 rounded-xl border px-4 py-3"
          style={{ borderColor: `${color}66`, backgroundColor: `${color}1a` }}
        >
          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-2xl font-semibold" style={{ color }}>
            {prettyRegime(data.label)}
          </span>
        </div>
        <p className="mt-3 text-xs text-muted">
          as of {new Date(data.as_of).toLocaleDateString()} · confidence{' '}
          {(Math.max(...Object.values(data.probabilities)) * 100).toFixed(1)}%
        </p>
      </div>

      <div>
        <span className="stat-label">Posterior probabilities</span>
        <div className="mt-3 space-y-2.5">
          {entries.map(([label, p], i) => {
            const c = regimeColor(i)
            return (
              <div key={label}>
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: c }}>{prettyRegime(label)}</span>
                  <span className="font-mono tabular-nums text-muted">{(p * 100).toFixed(1)}%</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-panel2">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${Math.max(p * 100, 1)}%`, backgroundColor: c }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

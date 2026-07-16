import type { RegimeCurrentResponse } from '../../api/types'
import { marketDate } from '../../lib/format'
import { REGIME_ORDER, prettyRegime, regimeColor, regimeColorForLabel } from '../../lib/theme'

/** Big current-regime badge plus posterior probabilities as labelled CSS bars. */
export function CurrentRegimeCard({ data }: { data: RegimeCurrentResponse }) {
  const color = regimeColor(data.regime)
  const entries = Object.entries(data.probabilities).sort(([a], [b]) => {
    const ai = REGIME_ORDER.indexOf(a as (typeof REGIME_ORDER)[number])
    const bi = REGIME_ORDER.indexOf(b as (typeof REGIME_ORDER)[number])
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
  })
  const probabilities = entries.map(([, probability]) => probability).filter(Number.isFinite)
  const confidence = probabilities.length ? Math.max(...probabilities) : null

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
          as of {marketDate(data.as_of)}
          {confidence != null && ` · confidence ${(confidence * 100).toFixed(1)}%`}
        </p>
      </div>

      <div>
        <span className="stat-label">Posterior probabilities</span>
        <div className="mt-3 space-y-2.5">
          {entries.map(([label, p], i) => {
            const c = regimeColorForLabel(label, i)
            const percentage = Number.isFinite(p) ? Math.max(0, Math.min(100, p * 100)) : 0
            return (
              <div key={label}>
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: c }}>{prettyRegime(label)}</span>
                  <span className="font-mono tabular-nums text-muted">{percentage.toFixed(1)}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={`${prettyRegime(label)} probability`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Number(percentage.toFixed(1))}
                  className="mt-1 h-2 overflow-hidden rounded-full bg-panel2"
                >
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${percentage}%`, backgroundColor: c }}
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

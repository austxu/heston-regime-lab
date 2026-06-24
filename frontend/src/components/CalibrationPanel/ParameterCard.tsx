import { PARAM_NAMES } from '../../api/types'
import { PARAM_META } from '../../lib/params'
import { pct } from '../../lib/format'
import { Badge } from '../ui/Badge'
import type { BadgeTone } from '../ui/Badge'
import { InfoDot } from '../ui/Tooltip'

interface ParameterCardProps {
  params: Record<string, number> | null
  meanError?: number | null
  live?: boolean
}

/** Calibrated κ θ σ ρ v₀ with intuitive labels/tooltips and a colour-coded error badge. */
export function ParameterCard({ params, meanError, live }: ParameterCardProps) {
  const feller =
    params != null ? 2 * params.kappa * params.theta > params.sigma * params.sigma : null

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">
          Calibrated parameters {live && <span className="ml-1 text-xs font-normal text-accent">live</span>}
        </h3>
        {meanError != null && <ErrorBadge meanError={meanError} />}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {PARAM_NAMES.map((name) => {
          const meta = PARAM_META[name]
          const value = params?.[name]
          return (
            <div key={name} className="rounded-lg border border-edge bg-panel2 px-3 py-2">
              <div className="flex items-center text-xs text-muted">
                <span className="font-mono text-base text-ink">{meta.symbol}</span>
                <span className="ml-1.5">{meta.name}</span>
                <InfoDot content={meta.desc} />
              </div>
              <div className="mt-1 font-mono text-lg tabular-nums text-ink">
                {value != null ? value.toFixed(meta.digits) : '—'}
              </div>
            </div>
          )
        })}

        <div className="rounded-lg border border-edge bg-panel2 px-3 py-2">
          <div className="flex items-center text-xs text-muted">
            Feller
            <InfoDot content="2·κ·θ > σ²  ⇒ variance stays strictly positive. A useful calibration sanity check." />
          </div>
          <div className="mt-1">
            {feller == null ? (
              <span className="font-mono text-lg text-muted">—</span>
            ) : (
              <Badge tone={feller ? 'good' : 'warn'}>{feller ? 'satisfied' : 'violated'}</Badge>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ErrorBadge({ meanError }: { meanError: number }) {
  const tone: BadgeTone = meanError < 0.03 ? 'good' : meanError < 0.05 ? 'warn' : 'bad'
  const label = meanError < 0.03 ? 'excellent' : meanError < 0.05 ? 'acceptable' : 'poor'
  return (
    <Badge tone={tone}>
      mean IV error {pct(meanError)} · {label}
    </Badge>
  )
}

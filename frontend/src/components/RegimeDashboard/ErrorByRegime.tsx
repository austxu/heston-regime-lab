import Plot from '../Plot'
import type { RegimeParametersResponse } from '../../api/types'
import { Badge } from '../ui/Badge'
import { COLORS, PLOT_CONFIG, baseLayout, prettyRegime } from '../../lib/theme'

/** Static vs regime-conditional calibration error, grouped by regime, + overall improvement. */
export function ErrorByRegime({ data }: { data: RegimeParametersResponse }) {
  const labels = Object.keys(data.regime_mae_by_regime)
  const x = labels.map(prettyRegime)
  const staticY = labels.map((l) => data.static_mae_by_regime[l])
  const regimeY = labels.map((l) => data.regime_mae_by_regime[l])
  const improvement = data.regime_conditional_improvement_pct

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone={improvement >= 0 ? 'good' : 'warn'}>
          {improvement >= 0
            ? `regime-conditional beats static by ${improvement.toFixed(1)}%`
            : `regime-conditional trails static by ${Math.abs(improvement).toFixed(1)}%`}
        </Badge>
        <span>
          overall mean IV error: static {(data.static_mae_overall * 100).toFixed(2)}% → conditional{' '}
          {(data.regime_mae_overall * 100).toFixed(2)}%
        </span>
      </div>
      {labels.length ? (
        <Plot
          ariaLabel="Static versus regime-conditional calibration error by market regime"
          data={[
            {
              type: 'bar',
              name: 'Static (one fit)',
              x,
              y: staticY,
              marker: { color: COLORS.bs },
              hovertemplate: '%{x}<br>static %{y:.2%}<extra></extra>',
            },
            {
              type: 'bar',
              name: 'Regime-conditional',
              x,
              y: regimeY,
              marker: { color: COLORS.corrected },
              hovertemplate: '%{x}<br>conditional %{y:.2%}<extra></extra>',
            },
          ]}
          layout={baseLayout({
            height: 300,
            barmode: 'group',
            yaxis: { title: { text: 'Mean abs IV error' }, tickformat: '.1%', gridcolor: COLORS.edge },
            xaxis: { gridcolor: COLORS.edge },
          })}
          config={PLOT_CONFIG}
          style={{ width: '100%', height: 300 }}
          useResizeHandler
        />
      ) : (
        <p className="py-12 text-center text-sm text-muted">No per-regime error data is available.</p>
      )}
    </div>
  )
}

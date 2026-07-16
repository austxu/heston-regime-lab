import Plot from '../Plot'
import type { RegimeParametersResponse } from '../../api/types'
import { PARAM_NAMES } from '../../api/types'
import type { ParamName } from '../../api/types'
import { PARAM_META } from '../../lib/params'
import { gaussianKde, spanGrid } from '../../lib/kde'
import { Badge } from '../ui/Badge'
import { PLOT_CONFIG, baseLayout, prettyRegime, regimeColor } from '../../lib/theme'

/** Overlapping per-regime KDE densities for each Heston parameter (small multiples). */
export function ParamDensities({ data }: { data: RegimeParametersResponse }) {
  const labels = Object.keys(data.regime_params)
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {PARAM_NAMES.map((param) => (
        <DensityPanel key={param} param={param} labels={labels} data={data} />
      ))}
      <Legend labels={labels} />
    </div>
  )
}

function DensityPanel({
  param,
  labels,
  data,
}: {
  param: ParamName
  labels: string[]
  data: RegimeParametersResponse
}) {
  const meta = PARAM_META[param]
  const perRegime = labels.map((l) => data.param_samples[l]?.[param] ?? [])
  const grid = spanGrid(perRegime)
  const test = data.kruskal_wallis[param]

  const traces = labels.map((label, i) => {
    const dens = gaussianKde(perRegime[i], grid)
    const c = regimeColor(i)
    return {
      type: 'scatter',
      mode: 'lines',
      x: dens.x,
      y: dens.y,
      name: prettyRegime(label),
      line: { color: c, width: 1.5 },
      fill: 'tozeroy',
      fillcolor: `${c}33`,
      hovertemplate: `${meta.symbol} %{x:.4f}<extra>${prettyRegime(label)}</extra>`,
    }
  })

  return (
    <div className="rounded-lg border border-edge bg-panel2 p-2">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-xs text-muted">
          <span className="font-mono text-ink">{meta.symbol}</span> {meta.name}
        </span>
        {test && (
          <Badge tone={test.significant ? 'good' : 'neutral'}>
            p {test.p_value < 1e-3 ? test.p_value.toExponential(1) : test.p_value.toFixed(3)}
          </Badge>
        )}
      </div>
      <Plot
        ariaLabel={`${meta.name} distribution by market regime`}
        data={traces}
        layout={baseLayout({
          height: 140,
          showlegend: false,
          margin: { l: 8, r: 8, t: 4, b: 20 },
          xaxis: { tickfont: { size: 9 }, nticks: 4 },
          yaxis: { visible: false },
        })}
        config={PLOT_CONFIG}
        style={{ width: '100%', height: 140 }}
        useResizeHandler
      />
    </div>
  )
}

function Legend({ labels }: { labels: string[] }) {
  return (
    <div className="flex flex-col justify-center gap-2 rounded-lg border border-dashed border-edge p-3">
      <span className="stat-label">Regimes</span>
      {labels.map((label, i) => (
        <span key={label} className="inline-flex items-center gap-2 text-xs text-muted">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: regimeColor(i) }} />
          {prettyRegime(label)}
        </span>
      ))}
      <p className="mt-1 text-[11px] leading-snug text-muted/70">
        Green p-value = Kruskal-Wallis significant (parameter differs across regimes).
      </p>
    </div>
  )
}

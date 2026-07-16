import { useMemo } from 'react'
import Plot from '../Plot'
import type { RegimeHistoryResponse } from '../../api/types'
import { COLORS, PLOT_CONFIG, baseLayout, prettyRegime, regimeColor } from '../../lib/theme'

/** SPX price line with contiguous regime periods drawn as coloured background bands. */
export function RegimeHistoryChart({ data }: { data: RegimeHistoryResponse }) {
  const { points, labels } = data

  const shapes = useMemo(() => buildBands(points), [points])

  if (!points.length) {
    return <p className="py-12 text-center text-sm text-muted">No regime history is available.</p>
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-3">
        {labels.map((label, i) => (
          <span key={label} className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: regimeColor(i) }} />
            {prettyRegime(label)}
          </span>
        ))}
      </div>
      <Plot
        ariaLabel="SPX price history with colored market-regime bands"
        data={[
          {
            type: 'scatter',
            mode: 'lines',
            x: points.map((p) => p.date),
            y: points.map((p) => p.price),
            line: { color: COLORS.ink, width: 1.2 },
            hovertemplate: '%{x}<br>SPX %{y:.0f}<extra></extra>',
          },
        ]}
        layout={baseLayout({
          height: 380,
          showlegend: false,
          shapes,
          xaxis: { type: 'date', gridcolor: COLORS.edge },
          yaxis: {
            title: { text: data.provenance.source === 'synthetic' ? 'SPX (synthetic)' : 'SPX' },
            gridcolor: COLORS.edge,
          },
          margin: { l: 60, r: 16, t: 8, b: 36 },
        })}
        config={PLOT_CONFIG}
        style={{ width: '100%', height: 380 }}
        useResizeHandler
      />
    </div>
  )
}

/** Merge consecutive same-regime days into vrect background shapes. */
function buildBands(points: RegimeHistoryResponse['points']): Record<string, unknown>[] {
  const shapes: Record<string, unknown>[] = []
  if (!points.length) return shapes
  let startIdx = 0
  for (let i = 1; i <= points.length; i++) {
    const ended = i === points.length || points[i].regime !== points[startIdx].regime
    if (ended) {
      shapes.push({
        type: 'rect',
        xref: 'x',
        yref: 'paper',
        x0: points[startIdx].date,
        x1: points[Math.min(i, points.length - 1)].date,
        y0: 0,
        y1: 1,
        fillcolor: regimeColor(points[startIdx].regime),
        opacity: 0.16,
        line: { width: 0 },
        layer: 'below',
      })
      startIdx = i
    }
  }
  return shapes
}

// The single Plotly entry point for the app. Plotly is intentionally loaded behind its own
// Suspense boundary: the dashboard shell and panel copy stay usable while the large chart
// engine downloads, and the browser only fetches it after a chart view is opened.
import { lazy, Suspense } from 'react'
import createPlotlyComponent from 'react-plotly.js/factory'
import type { PlotParams } from 'react-plotly.js/factory'

const PlotlyComponent = lazy(async () => {
  const [core, scatter, bar, heatmap, surface] = await Promise.all([
    import('plotly.js/lib/core'),
    import('plotly.js/lib/scatter'),
    import('plotly.js/lib/bar'),
    import('plotly.js/lib/heatmap'),
    import('plotly.js/lib/surface'),
  ])
  const Plotly = core.default
  Plotly.register([scatter.default, bar.default, heatmap.default, surface.default])
  return { default: createPlotlyComponent(Plotly) }
})

interface AccessiblePlotProps extends PlotParams {
  ariaLabel: string
}

export default function Plot({ ariaLabel, ...props }: AccessiblePlotProps) {
  const fallbackHeight = props.style?.height ?? 320
  return (
    <div role="img" aria-label={ariaLabel} className="min-w-0">
      <Suspense fallback={<PlotFallback height={fallbackHeight} />}>
        <PlotlyComponent {...props} />
      </Suspense>
    </div>
  )
}

function PlotFallback({ height }: { height: string | number }) {
  return (
    <div
      aria-hidden="true"
      style={{ height }}
      className="flex w-full items-center justify-center rounded-lg bg-panel2/60"
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-edge border-t-accent" />
    </div>
  )
}

// Minimal ambient declarations for the Plotly factory path.
//
// We use `plotly.js-dist-min` (a prebuilt bundle, much smaller/faster than the full
// `plotly.js`) and wrap it with react-plotly.js's factory. Neither ships TypeScript types
// for this path, so we declare just enough here. Figures are built via typed helpers in
// `src/lib/plotly.ts`, so the `any` surface is contained.

declare module 'plotly.js-dist-min' {
  const Plotly: unknown
  export default Plotly
}

declare module 'react-plotly.js/factory' {
  import type { ComponentType } from 'react'

  export interface PlotParams {
    data: unknown[]
    layout?: Record<string, unknown>
    config?: Record<string, unknown>
    style?: React.CSSProperties
    className?: string
    useResizeHandler?: boolean
    onInitialized?: (figure: unknown, graphDiv: HTMLElement) => void
    onUpdate?: (figure: unknown, graphDiv: HTMLElement) => void
    revision?: number
  }

  const createPlotlyComponent: (plotly: unknown) => ComponentType<PlotParams>
  export default createPlotlyComponent
}

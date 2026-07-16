// Minimal ambient declarations for the Plotly factory path.
//
// We register only the trace types used by the dashboard and wrap the result with
// react-plotly.js's factory. Plotly's CommonJS `lib/*` entry points do not ship usable
// TypeScript declarations for this path, so declare the narrow surface we consume.

declare module 'plotly.js/lib/core' {
  interface PlotlyCore {
    register(modules: unknown[]): void
  }
  const Plotly: PlotlyCore
  export default Plotly
}

declare module 'plotly.js/lib/scatter' {
  const trace: unknown
  export default trace
}

declare module 'plotly.js/lib/bar' {
  const trace: unknown
  export default trace
}

declare module 'plotly.js/lib/heatmap' {
  const trace: unknown
  export default trace
}

declare module 'plotly.js/lib/surface' {
  const trace: unknown
  export default trace
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

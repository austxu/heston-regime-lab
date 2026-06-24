// The single Plotly entry point for the app: react-plotly.js bound to the lighter
// `plotly.js-dist-min` bundle via the factory. Import this `Plot` everywhere instead of
// `react-plotly.js` directly (the default export there expects the full `plotly.js`).
import createPlotlyComponent from 'react-plotly.js/factory'
import Plotly from 'plotly.js-dist-min'

const Plot = createPlotlyComponent(Plotly)

export default Plot

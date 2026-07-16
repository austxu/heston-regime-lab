// Shared visual constants used by both DOM (Tailwind) and Plotly charts so colours stay
// consistent across the app. Keep regime colours in sync with tailwind.config.js.

export const COLORS = {
  base: '#0a0e16',
  panel: '#111726',
  panel2: '#0d1320',
  edge: '#1e2940',
  ink: '#e6edf6',
  muted: '#8a97ad',
  accent: '#38bdf8',
  market: '#38bdf8', // market surface / series
  model: '#a78bfa', // Heston model surface / series
  corrected: '#34d399', // residual-corrected
  bs: '#fb7185', // Black-Scholes baseline
  good: '#34d399',
  warn: '#fbbf24',
  bad: '#f43f5e',
} as const

// Regime index -> colour and display label. Index order = volatility order (0 = calmest).
export const REGIME_COLORS = ['#34d399', '#fbbf24', '#f43f5e'] as const
export const REGIME_ORDER = ['low_vol', 'elevated_vol', 'crisis'] as const

export const REGIME_LABELS: Record<string, string> = {
  low_vol: 'Low Vol',
  elevated_vol: 'Elevated Vol',
  crisis: 'Crisis',
}

export function regimeColor(index: number): string {
  return REGIME_COLORS[index] ?? COLORS.muted
}

export function prettyRegime(label: string): string {
  return (
    REGIME_LABELS[label] ??
    label
      .replaceAll('_', ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase())
  )
}

export function regimeColorForLabel(label: string, fallbackIndex = 0): string {
  const index = REGIME_ORDER.indexOf(label as (typeof REGIME_ORDER)[number])
  return regimeColor(index >= 0 ? index : fallbackIndex)
}

// A dark Plotly layout base shared by every chart.
export function baseLayout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: COLORS.ink, family: 'ui-sans-serif, system-ui, sans-serif', size: 12 },
    margin: { l: 56, r: 16, t: 16, b: 44 },
    xaxis: { gridcolor: COLORS.edge, zerolinecolor: COLORS.edge, linecolor: COLORS.edge },
    yaxis: { gridcolor: COLORS.edge, zerolinecolor: COLORS.edge, linecolor: COLORS.edge },
    legend: { bgcolor: 'rgba(0,0,0,0)', orientation: 'h', y: 1.12, x: 0 },
    hoverlabel: { bgcolor: COLORS.panel, bordercolor: COLORS.edge },
    colorway: [COLORS.accent, COLORS.model, COLORS.corrected, COLORS.bs, COLORS.warn],
    ...overrides,
  }
}

// Scene (3D) styling for surface charts.
export function darkScene(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const axis = {
    gridcolor: COLORS.edge,
    zerolinecolor: COLORS.edge,
    backgroundcolor: COLORS.panel2,
    showbackground: true,
    color: COLORS.muted,
  }
  return {
    xaxis: { ...axis, title: { text: 'Moneyness K/S' } },
    yaxis: { ...axis, title: { text: 'Maturity (yrs)' } },
    zaxis: { ...axis, title: { text: 'Implied vol' } },
    camera: { eye: { x: 1.6, y: -1.6, z: 0.9 } },
    ...overrides,
  }
}

export const PLOT_CONFIG = { displayModeBar: false, responsive: true } as const

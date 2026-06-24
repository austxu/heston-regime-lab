import type { ParamName } from '../api/types'

// Display metadata for the five Heston parameters — used by the parameter card tooltips
// and the convergence trajectory charts.
export interface ParamMeta {
  symbol: string
  name: string
  desc: string
  /** Typical display precision. */
  digits: number
}

export const PARAM_META: Record<ParamName, ParamMeta> = {
  kappa: {
    symbol: 'κ',
    name: 'Mean-reversion speed',
    desc: 'How fast variance pulls back to its long-run level θ. Higher κ = faster reversion.',
    digits: 3,
  },
  theta: {
    symbol: 'θ',
    name: 'Long-run variance',
    desc: 'The level variance reverts to. √θ is the long-horizon volatility.',
    digits: 4,
  },
  sigma: {
    symbol: 'σ',
    name: 'Vol of vol',
    desc: 'Volatility of the variance process. Controls the curvature (smile) of the surface.',
    digits: 3,
  },
  rho: {
    symbol: 'ρ',
    name: 'Spot/vol correlation',
    desc: 'Correlation between price and variance shocks. Negative ρ tilts the skew (leverage effect).',
    digits: 3,
  },
  v0: {
    symbol: 'v₀',
    name: 'Initial variance',
    desc: 'Instantaneous variance today. √v₀ is the current short-dated volatility.',
    digits: 4,
  },
}

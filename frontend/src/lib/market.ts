/** Typed access to the baked market history (src/data/market.json), loaded as its own chunk. */
import type { HestonParams } from '../math/types'

export interface RegimeInfo {
  key: string
  name: string
  share: number
  days: number
  stats: {
    vixMean: number
    vixMedian: number
    vix3mMean: number
    termSlopeMean: number
    realizedVol: number
    rv21Mean: number
    annReturn: number
    skew63Mean: number
    spells: number
    meanSpell: number
    maxSpell: number
    expectedDuration: number
  }
  params: HestonParams
  quotes: { spot: number; rate: number; noiseIv: number; seed: number; strike: number[]; maturity: number[]; iv: number[] }
  python: { params: HestonParams; loss: number; rmseIv: number; nit: number; nfev: number; seconds: number; message: string }
}

export interface MarketData {
  asOf: string
  generatedAt: string
  sources: Record<string, string>
  start: string
  series: {
    t: number[]
    spx: number[]
    vix: number[]
    vix3m: number[]
    rate: number[]
    rv21: number[]
    regime: number[]
    post: number[][]
  }
  features: { cols: string[]; mean: number[]; std: number[]; z: number[][] }
  hmm: { K: number; covariance: string; transmat: number[][]; means: number[][]; logLik: number }
  latestRate: number
  estimation: { kappa: number; termSlope: number; tenorsDays: number[]; method: string }
  regimes: RegimeInfo[]
  /** Derived: epoch-ms timestamps of every row. */
  times: number[]
}

let promise: Promise<MarketData> | null = null
export function loadMarket(): Promise<MarketData> {
  if (!promise) {
    promise = import('../data/market.json').then((m) => {
      const d = m.default as unknown as MarketData
      const t0 = Date.parse(`${d.start}T00:00:00Z`)
      d.times = d.series.t.map((t) => t0 + t * 86400000)
      return d
    })
  }
  return promise
}

export const REGIME_COLORS: Record<number, string[]> = {
  2: ['#7ee787', '#f0887b'],
  3: ['#7ee787', '#53b1fd', '#f0887b'],
  4: ['#7ee787', '#53b1fd', '#f670c7', '#f0887b'],
}
export const REGIME_NAMES: Record<number, string[]> = {
  2: ['calm', 'stressed'],
  3: ['calm', 'normal', 'stressed'],
  4: ['calm', 'normal', 'elevated', 'stressed'],
}

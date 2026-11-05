/** Typed access to the baked real SPX snapshot (src/data/spx.json), loaded as its own chunk. */
import type { MarketSlice } from '../math/market'
import type { ModelId } from '../math/models'
import type { Svi } from '../math/svi'

export interface SpxSlice extends MarketSlice {
  expiry: string
  root: string
  settle: 'AM' | 'PM'
  forward: number
  discount: number
  listed: number
  strike: number[]
  svi: Svi & { rmse: number; minG: number }
}

export interface FitSummary {
  rmse: number
  mae: number
  maxAbs: number
  inside: number
  sliceRmse: number[]
}

export interface ModelFit extends FitSummary {
  params: Record<string, number>
  start: number[]
  nfev: number
  seconds: number
}

export interface SpxData {
  source: { name: string; url: string; note: string }
  asOf: string
  generatedAt: string
  spot: number
  spotChangePct: number
  filters: { maxRelSpread: number; zRange: [number, number]; strikesPerExpiry: number; targetDays: number[] }
  slices: SpxSlice[]
  bounds: Record<ModelId, [number, number][]>
  fits: Record<ModelId, ModelFit> & { svi: FitSummary & { calendarViolations: number } }
}

let promise: Promise<SpxData> | null = null
export function loadSpx(): Promise<SpxData> {
  if (!promise) promise = import('../data/spx.json').then((m) => m.default as unknown as SpxData)
  return promise
}

/** ATM vol at any maturity, linear in total variance between slices (flat outside). */
export function atmAt(slices: MarketSlice[], tau: number): number {
  if (tau <= slices[0].tau) return slices[0].atmVol
  const last = slices[slices.length - 1]
  if (tau >= last.tau) return last.atmVol
  const i = slices.findIndex((s) => s.tau >= tau)
  const a = slices[i - 1]
  const b = slices[i]
  const f = (tau - a.tau) / (b.tau - a.tau)
  const w = a.atmVol ** 2 * a.tau + f * (b.atmVol ** 2 * b.tau - a.atmVol ** 2 * a.tau)
  return Math.sqrt(w / tau)
}

export const MODEL_IDS: ModelId[] = ['heston', 'bates', 'double']
export const MODEL_COLORS: Record<ModelId | 'svi' | 'lognormal', string> = {
  heston: '#9e77ed',
  bates: '#53b1fd',
  double: '#7ee787',
  svi: '#f0887b',
  lognormal: '#94979c',
}

/** "13 Nov" style label for an ISO expiry date. */
export function expiryLabel(iso: string, withYear = false): string {
  const d = new Date(`${iso}T00:00:00Z`)
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  return withYear ? `${d.getUTCDate()} ${m} ${String(d.getUTCFullYear()).slice(2)}` : `${d.getUTCDate()} ${m}`
}

/** Days to expiry, rounded, for labels. */
export const daysLabel = (tau: number) => (tau < 1 ? `${Math.round(tau * 365)}d` : `${(tau).toFixed(1)}y`)

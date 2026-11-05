import type { HmmFit } from '../math/hmm'
import type { FitStats, MarketResult, MarketSlice } from '../math/market'
import type { ModelId } from '../math/models'
import type { PathRequest, PathResult } from '../math/montecarlo'
import type { Grid } from '../math/surface'
import type { HestonParams, Market } from '../math/types'

/** What the market view draws besides the quotes: a surface grid and per-slice smile grids. */
export interface MarketView {
  taus: number[]
  /** Surface strike axis, x = ln(K/F) / sqrt(tau). */
  xs: number[]
  /** ATM vol per surface row (sets the quadrature). */
  atms: number[]
  /** Log-moneyness grid per slice for the smile curves. */
  smileKs: number[][]
}

export type Request =
  | { type: 'surface'; id: number; params: HestonParams; market: Market; grid: Grid; quality: 'draft' | 'fine' }
  | { type: 'market-eval'; id: number; model: ModelId; params: number[]; slices: MarketSlice[]; view: MarketView }
  | { type: 'market-calibrate'; id: number; model: ModelId; start: number[]; slices: MarketSlice[]; view: MarketView }
  | { type: 'densities'; id: number; slices: MarketSlice[]; fits: { model: ModelId; params: number[] }[]; xs: number[][] }
  | { type: 'paths'; id: number; req: PathRequest }
  | { type: 'hmm'; id: number; z: number[][]; K: number }
  | { type: 'cancel'; id: number }

export interface SurfaceMsg {
  type: 'surface'
  id: number
  iv: Float64Array
  flag: Uint8Array
  ms: number
}
/** Model output for the market view at one parameter vector. */
export interface MarketFrame {
  modelIv: Float64Array
  surface: Float64Array
  flag: Uint8Array
  smiles: Float64Array
}
export interface MarketEvalMsg extends MarketFrame {
  type: 'market-eval'
  id: number
  stats: FitStats
}
export interface MarketIterMsg extends MarketFrame {
  type: 'market-iter'
  id: number
  iteration: number
  loss: number
  params: number[]
  nfev: number
}
export interface MarketDoneMsg {
  type: 'market-done'
  id: number
  result: MarketResult
}
export interface DensitiesMsg {
  type: 'densities'
  id: number
  /** q[f][s]: density of fit f on slice s, on xs[s]. */
  q: Float64Array[][]
  ms: number
}
export interface PathsMsg {
  type: 'paths'
  id: number
  result: PathResult
}
export interface HmmMsg {
  type: 'hmm'
  id: number
  fit: HmmFit
  ms: number
}
export type Response = SurfaceMsg | MarketEvalMsg | MarketIterMsg | MarketDoneMsg | DensitiesMsg | PathsMsg | HmmMsg

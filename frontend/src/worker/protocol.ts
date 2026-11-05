import type { CalibResult } from '../math/calibrate'
import type { HmmFit } from '../math/hmm'
import type { PathRequest, PathResult } from '../math/montecarlo'
import type { Grid, Quotes } from '../math/surface'
import type { HestonParams, Market } from '../math/types'

export type Request =
  | { type: 'surface'; id: number; params: HestonParams; market: Market; grid: Grid; quality: 'draft' | 'fine' }
  | { type: 'calibrate'; id: number; quotes: Quotes; grids: Grid[]; initial?: HestonParams }
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
export interface CalibIterMsg {
  type: 'calib-iter'
  id: number
  iteration: number
  loss: number
  params: HestonParams
  nfev: number
  modelIv: Float64Array
  /** One IV array (+ extrapolation flags) per requested grid. */
  surfaces: Float64Array[]
  flags: Uint8Array[]
}
export interface CalibDoneMsg {
  type: 'calib-done'
  id: number
  result: Omit<CalibResult, 'modelIv'> & { modelIv: Float64Array }
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
export type Response = SurfaceMsg | CalibIterMsg | CalibDoneMsg | PathsMsg | HmmMsg

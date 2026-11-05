/** Heston implied vols: the OTM-leg inversion of calibration/optimizer.py, plus display grids. */
import { impliedVol } from './blackScholes'
import { kernelCall, maturityKernel } from './heston'
import { QUAD, type HestonParams, type Market } from './types'

export interface Quotes extends Market {
  strike: number[]
  maturity: number[]
  iv: number[]
  weight?: number[]
}

export interface IvOptions {
  nNodes?: number
  upper?: number
  ivLower?: number
  ivUpper?: number
  xtol?: number
}

/**
 * Implied vol of a Heston *call* price via the out-of-the-money leg (put below the
 * forward, call at/above), exactly like `_iv_from_heston_call`.
 */
export function ivFromCall(
  call: number,
  m: Market,
  strike: number,
  tau: number,
  forward: number,
  lo = 1e-4,
  hi = 5,
  xtol = 1e-12,
): number {
  if (strike >= forward) return impliedVol(call, m.spot, strike, m.rate, m.div, tau, 'call', lo, hi, xtol)
  const put = call - m.spot * Math.exp(-m.div * tau) + strike * Math.exp(-m.rate * tau)
  return impliedVol(put, m.spot, strike, m.rate, m.div, tau, 'put', lo, hi, xtol)
}

/** Group quote indices by maturity (order of first appearance is irrelevant). */
export function groupByMaturity(maturity: ArrayLike<number>): Map<number, number[]> {
  const groups = new Map<number, number[]>()
  for (let i = 0; i < maturity.length; i++) {
    const g = groups.get(maturity[i])
    if (g) g.push(i)
    else groups.set(maturity[i], [i])
  }
  return groups
}

/**
 * Model implied vols aligned with the quotes (NaN where not invertible) — the port of
 * `heston_implied_vols`. Characteristic functions are evaluated once per maturity.
 */
export function hestonImpliedVols(
  p: HestonParams,
  q: Market & { strike: ArrayLike<number>; maturity: ArrayLike<number> },
  opts: IvOptions = {},
  groups = groupByMaturity(q.maturity),
): Float64Array {
  const { nNodes = QUAD.nNodes, upper = QUAD.upperLimit, ivLower = 1e-4, ivUpper = 5, xtol = 1e-12 } = opts
  const out = new Float64Array(q.strike.length).fill(Number.NaN)
  for (const [tau, idx] of groups) {
    const k = maturityKernel(p, q.spot, q.rate, q.div, tau, nNodes, upper)
    const discS = q.spot * Math.exp(-q.div * tau)
    for (const i of idx) {
      const strike = q.strike[i]
      const raw = kernelCall(k, q.spot, strike, q.rate, q.div)
      const discK = strike * Math.exp(-q.rate * tau)
      const call = Math.min(Math.max(raw, Math.max(discS - discK, 0)), discS)
      out[i] = ivFromCall(call, q, strike, tau, k.forward, ivLower, ivUpper, xtol)
    }
  }
  return out
}

export interface Grid {
  /**
   * Strike-axis coordinate. kind 'm': moneyness K / S. kind 'k': forward log-moneyness per
   * root-year, ln(K / F) / sqrt(T) — a delta-like axis on which market quotes are rectangular.
   */
  x: number[]
  /** Maturities in years along the time axis. */
  tau: number[]
  kind: 'm' | 'k'
}

export function strikeAt(grid: Pick<Grid, 'kind'>, x: number, tau: number, m: Market): number {
  if (grid.kind === 'm') return m.spot * x
  return m.spot * Math.exp((m.rate - m.div) * tau + x * Math.sqrt(tau))
}

export function xOfStrike(kind: Grid['kind'], strike: number, tau: number, m: Market): number {
  if (kind === 'm') return strike / m.spot
  return (Math.log(strike / m.spot) - (m.rate - m.div) * tau) / Math.sqrt(tau)
}

export interface SurfaceResult {
  /** Row-major IV, index [i * x.length + j] for tau[i], x[j]. */
  iv: Float64Array
  /** 1 where the quote sits below the quadrature floor and was flat-extrapolated. */
  flag: Uint8Array
}

/**
 * IV surface on a (maturity x moneyness) grid. Deep-wing cells whose prices fall below the
 * ~1e-8 quadrature floor cannot be inverted; they are flat-extrapolated from the nearest
 * invertible strike in the same maturity row and flagged so the UI can show them as such.
 */
export function surfaceGrid(p: HestonParams, market: Market, grid: Grid, opts: IvOptions = {}): SurfaceResult {
  const { nNodes = QUAD.nNodes, upper = QUAD.upperLimit, xtol = 1e-8 } = opts
  const nm = grid.x.length
  const iv = new Float64Array(grid.tau.length * nm)
  const flag = new Uint8Array(grid.tau.length * nm)
  for (let i = 0; i < grid.tau.length; i++) {
    const tau = grid.tau[i]
    const k = maturityKernel(p, market.spot, market.rate, market.div, tau, nNodes, upper)
    const discS = market.spot * Math.exp(-market.div * tau)
    for (let j = 0; j < nm; j++) {
      const strike = strikeAt(grid, grid.x[j], tau, market)
      const raw = kernelCall(k, market.spot, strike, market.rate, market.div)
      const discK = strike * Math.exp(-market.rate * tau)
      const call = Math.min(Math.max(raw, Math.max(discS - discK, 0)), discS)
      // Prices this small are dominated by quadrature error; treat as not invertible.
      const otm = strike >= k.forward ? call : call - discS + discK
      const v = otm > 1e-7 * market.spot ? ivFromCall(call, market, strike, tau, k.forward, 1e-4, 5, xtol) : Number.NaN
      iv[i * nm + j] = v
    }
    fillRow(iv, flag, i * nm, nm)
  }
  return { iv, flag }
}

function fillRow(iv: Float64Array, flag: Uint8Array, off: number, n: number) {
  // Expand outward from the ATM-most valid cell so wings inherit their nearest valid IV.
  let first = -1
  let last = -1
  for (let j = 0; j < n; j++) {
    if (Number.isFinite(iv[off + j])) {
      if (first < 0) first = j
      last = j
    }
  }
  if (first < 0) {
    for (let j = 0; j < n; j++) {
      iv[off + j] = 0
      flag[off + j] = 1
    }
    return
  }
  for (let j = 0; j < first; j++) {
    iv[off + j] = iv[off + first]
    flag[off + j] = 1
  }
  for (let j = last + 1; j < n; j++) {
    iv[off + j] = iv[off + last]
    flag[off + j] = 1
  }
  for (let j = first; j <= last; j++) {
    if (!Number.isFinite(iv[off + j])) {
      iv[off + j] = iv[off + j - 1]
      flag[off + j] = 1
    }
  }
}

/** Display grid: strike axis evenly spaced, maturities evenly spaced in sqrt(time). */
export function makeGrid(nx: number, nt: number, xLo = 0.8, xHi = 1.2, tLo = 1 / 12, tHi = 2, kind: Grid['kind'] = 'm'): Grid {
  const x = Array.from({ length: nx }, (_, j) => xLo + ((xHi - xLo) * j) / (nx - 1))
  const a = Math.sqrt(tLo)
  const b = Math.sqrt(tHi)
  const tau = Array.from({ length: nt }, (_, i) => (a + ((b - a) * i) / (nt - 1)) ** 2)
  return { x, tau, kind }
}

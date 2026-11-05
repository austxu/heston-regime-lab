/**
 * Bounded Levenberg-Marquardt calibration of Heston parameters to implied vols.
 *
 * The objective is identical to calibration/optimizer.py: the sum of squared IV residuals
 * sum_i w_i (IV_model - IV_market)^2 (non-invertible model IVs are penalised with a residual
 * of 10, as in Python), optimised over the same normalised box z in [0, 1]^5. Where Python
 * uses L-BFGS-B on the scalar loss, this exploits the least-squares structure: a
 * forward-difference Jacobian of the residual vector, a Nielsen-damped Gauss-Newton step and
 * projection onto the box with an active set for parameters pinned at a bound.
 */
import { groupByMaturity, hestonImpliedVols, type IvOptions, type Quotes } from './surface'
import { BOUNDS, INITIAL_GUESS, PARAM_NAMES, fromArray, type HestonParams } from './types'

export interface CalibIteration {
  iteration: number
  loss: number
  params: HestonParams
  nfev: number
  lambda: number
  modelIv: Float64Array
}

export interface CalibResult extends CalibIteration {
  rmseIv: number
  meanAbsIv: number
  converged: boolean
  message: string
  ms: number
}

export interface CalibOptions extends IvOptions {
  initial?: HestonParams
  maxIter?: number
  bounds?: typeof BOUNDS
}

const LO = (b: typeof BOUNDS) => PARAM_NAMES.map((n) => b[n][0])
const HI = (b: typeof BOUNDS) => PARAM_NAMES.map((n) => b[n][1])

/** Solve the small dense SPD-ish system A x = b by Gaussian elimination with pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
    if (Math.abs(M[piv][c]) < 1e-300) return null
    ;[M[c], M[piv]] = [M[piv], M[c]]
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]
    x[r] = s / M[r][r]
  }
  return x
}

/**
 * Generator form so a caller (the Web Worker) can stream every accepted iteration and
 * yield to its event loop between iterations. The final value is the CalibResult.
 */
export function* calibrateSteps(quotes: Quotes, opts: CalibOptions = {}): Generator<CalibIteration, CalibResult> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const bounds = opts.bounds ?? BOUNDS
  const lo = LO(bounds)
  const hi = HI(bounds)
  const n = 5
  const maxIter = opts.maxIter ?? 200
  const ivOpts: IvOptions = { xtol: 1e-10, ...opts }
  const groups = groupByMaturity(quotes.maturity)
  const w = quotes.weight ?? quotes.iv.map(() => 1)
  const sw = w.map(Math.sqrt)
  const m = quotes.iv.length
  let nfev = 0

  const toParams = (z: number[]) => fromArray(z.map((zi, i) => lo[i] + zi * (hi[i] - lo[i])))
  const evalZ = (z: number[]) => {
    nfev++
    const iv = hestonImpliedVols(toParams(z), quotes, ivOpts, groups)
    const r = new Float64Array(m)
    let f = 0
    for (let i = 0; i < m; i++) {
      const d = iv[i] - quotes.iv[i]
      r[i] = sw[i] * (Number.isFinite(d) ? d : 10)
      f += r[i] * r[i]
    }
    return { r, f, iv }
  }

  const init = opts.initial ?? INITIAL_GUESS
  let z = PARAM_NAMES.map((name, i) => Math.min(1, Math.max(0, (init[name] - lo[i]) / (hi[i] - lo[i]))))
  let cur = evalZ(z)
  let lambda = -1
  let nu = 2
  let iteration = 0
  let message = 'maximum iterations reached'
  let converged = false

  yield { iteration, loss: cur.f, params: toParams(z), nfev, lambda: 0, modelIv: cur.iv }

  outer: while (iteration < maxIter) {
    // Forward-difference Jacobian in normalised coordinates (backward at the upper bound).
    const J: Float64Array[] = []
    for (let j = 0; j < n; j++) {
      const h = 1e-6
      const step = z[j] + h > 1 ? -h : h
      const zz = z.slice()
      zz[j] += step
      const e = evalZ(zz)
      const col = new Float64Array(m)
      for (let i = 0; i < m; i++) col[i] = (e.r[i] - cur.r[i]) / step
      J.push(col)
    }
    const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
    const g = new Array<number>(n).fill(0)
    for (let a = 0; a < n; a++) {
      for (let i = 0; i < m; i++) g[a] += J[a][i] * cur.r[i]
      for (let b = a; b < n; b++) {
        let s = 0
        for (let i = 0; i < m; i++) s += J[a][i] * J[b][i]
        A[a][b] = A[b][a] = s
      }
    }
    if (lambda < 0) lambda = 1e-3 * Math.max(...A.map((row, i) => row[i]))

    // Active set: a parameter at a bound whose descent direction points outside stays put.
    const free = PARAM_NAMES.map((_, j) => !((z[j] <= 0 && g[j] > 0) || (z[j] >= 1 && g[j] < 0)))
    const idx = free.flatMap((f, j) => (f ? [j] : []))
    const projGrad = Math.max(...idx.map((j) => Math.abs(g[j])), 0)
    if (projGrad < 1e-14) {
      message = 'projected gradient below tolerance'
      converged = true
      break
    }

    for (let attempt = 0; attempt < 30; attempt++) {
      const As = idx.map((a) => idx.map((b) => A[a][b] + (a === b ? lambda * Math.max(A[a][a], 1e-12) : 0)))
      const delta = solve(As, idx.map((a) => -g[a]))
      if (!delta) {
        lambda *= nu
        nu *= 2
        continue
      }
      const zNew = z.slice()
      idx.forEach((j, k) => {
        zNew[j] = Math.min(1, Math.max(0, z[j] + delta[k]))
      })
      const d = zNew.map((v, j) => v - z[j])
      const stepNorm = Math.max(...d.map(Math.abs))
      if (stepNorm < 1e-12) {
        message = 'step below tolerance'
        converged = true
        break outer
      }
      // Predicted reduction of f = |r|^2 for the (projected) step: -(2 g.d + d.A.d).
      let gd = 0
      let dAd = 0
      for (let a = 0; a < n; a++) {
        gd += g[a] * d[a]
        for (let b = 0; b < n; b++) dAd += d[a] * A[a][b] * d[b]
      }
      const pred = -(2 * gd + dAd)
      const next = evalZ(zNew)
      const actual = cur.f - next.f
      if (actual > 0) {
        const gain = pred > 0 ? actual / pred : 0.5
        lambda *= Math.max(1 / 3, 1 - (2 * gain - 1) ** 3)
        nu = 2
        const relImprovement = actual / Math.max(cur.f, 1e-300)
        z = zNew
        cur = next
        iteration++
        yield { iteration, loss: cur.f, params: toParams(z), nfev, lambda, modelIv: cur.iv }
        if (relImprovement < 1e-10 || cur.f < 1e-24) {
          message = 'relative reduction of the loss below tolerance'
          converged = true
          break outer
        }
        continue outer
      }
      lambda *= nu
      nu *= 2
    }
    message = 'no further decrease along the damped step'
    converged = true
    break
  }

  let sq = 0
  let ab = 0
  for (let i = 0; i < m; i++) {
    const e = Number.isFinite(cur.iv[i]) ? cur.iv[i] - quotes.iv[i] : 10
    sq += e * e
    ab += Math.abs(e)
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return {
    iteration,
    loss: cur.f,
    params: toParams(z),
    nfev,
    lambda,
    modelIv: cur.iv,
    rmseIv: Math.sqrt(sq / m),
    meanAbsIv: ab / m,
    converged,
    message,
    ms: t1 - t0,
  }
}

/** Run to completion. */
export function calibrate(quotes: Quotes, opts: CalibOptions = {}): CalibResult {
  const it = calibrateSteps(quotes, opts)
  for (;;) {
    const s = it.next()
    if (s.done) return s.value
  }
}

/** Best flat (Black-Scholes) vol in the least-squares sense is the mean market IV. */
export function flatVolFit(iv: ArrayLike<number>) {
  let s = 0
  for (let i = 0; i < iv.length; i++) s += iv[i]
  const sigma = s / iv.length
  let sq = 0
  for (let i = 0; i < iv.length; i++) sq += (iv[i] - sigma) ** 2
  return { sigma, rmseIv: Math.sqrt(sq / iv.length) }
}

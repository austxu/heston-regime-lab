/**
 * Bounded Levenberg-Marquardt calibration of Heston parameters to implied vols.
 *
 * The objective is identical to calibration/optimizer.py: the sum of squared IV residuals
 * sum_i w_i (IV_model - IV_market)^2 (non-invertible model IVs are penalised with a residual
 * of 10, as in Python), optimised over the same normalised box z in [0, 1]^5. Where Python
 * uses L-BFGS-B on the scalar loss, this exploits the least-squares structure (lm.ts).
 */
import { lmSteps } from './lm'
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

/**
 * Generator form so a caller (the Web Worker) can stream every accepted iteration and
 * yield to its event loop between iterations. The final value is the CalibResult.
 */
export function* calibrateSteps(quotes: Quotes, opts: CalibOptions = {}): Generator<CalibIteration, CalibResult> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const bounds = opts.bounds ?? BOUNDS
  const lo = LO(bounds)
  const hi = HI(bounds)
  const ivOpts: IvOptions = { xtol: 1e-10, ...opts }
  const groups = groupByMaturity(quotes.maturity)
  const w = quotes.weight ?? quotes.iv.map(() => 1)
  const sw = w.map(Math.sqrt)
  const m = quotes.iv.length

  const toParams = (z: number[]) => fromArray(z.map((zi, i) => lo[i] + zi * (hi[i] - lo[i])))
  const evalZ = (z: number[]) => {
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
  const z0 = PARAM_NAMES.map((name, i) => (init[name] - lo[i]) / (hi[i] - lo[i]))
  let iv: Float64Array = new Float64Array(0)
  const steps = lmSteps(evalZ, z0, { maxIter: opts.maxIter, onAccept: (e) => (iv = e.iv) })
  let s = steps.next()
  while (!s.done) {
    const st = s.value
    yield { iteration: st.iteration, loss: st.loss, params: toParams(st.z), nfev: st.nfev, lambda: st.lambda, modelIv: iv }
    s = steps.next()
  }
  const res = s.value

  let sq = 0
  let ab = 0
  for (let i = 0; i < m; i++) {
    const e = Number.isFinite(iv[i]) ? iv[i] - quotes.iv[i] : 10
    sq += e * e
    ab += Math.abs(e)
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return {
    iteration: res.iteration,
    loss: res.loss,
    params: toParams(res.z),
    nfev: res.nfev,
    lambda: res.lambda,
    modelIv: iv,
    rmseIv: Math.sqrt(sq / m),
    meanAbsIv: ab / m,
    converged: res.converged,
    message: res.message,
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

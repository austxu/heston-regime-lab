/**
 * Bounded Levenberg-Marquardt on the unit box z in [0, 1]^n: a forward-difference Jacobian
 * of the residual vector, a Nielsen-damped Gauss-Newton step and projection onto the box,
 * with an active set for coordinates pinned at a bound. Shared by the regime calibration
 * (calibrate.ts) and the real-market fits (market.ts).
 */

export interface LmEval {
  /** Residual vector r(z); the loss is |r|^2. */
  r: Float64Array
  f: number
}

export interface LmStep {
  iteration: number
  loss: number
  z: number[]
  nfev: number
  lambda: number
}

export interface LmResult extends LmStep {
  converged: boolean
  message: string
}

/** Solve the small dense system A x = b by Gaussian elimination with pivoting. */
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
 * Generator form: yields the start and every accepted iteration (the caller keeps whatever
 * extra state its `evaluate` produced for the latest z); returns the final step.
 */
export function* lmSteps<E extends LmEval>(
  evaluate: (z: number[]) => E,
  z0: number[],
  opts: { maxIter?: number; onAccept?: (e: E) => void } = {},
): Generator<LmStep, LmResult> {
  const n = z0.length
  const maxIter = opts.maxIter ?? 200
  let nfev = 0
  const evalZ = (z: number[]) => {
    nfev++
    return evaluate(z)
  }
  let z = z0.map((v) => Math.min(1, Math.max(0, v)))
  let cur = evalZ(z)
  opts.onAccept?.(cur)
  const m = cur.r.length
  let lambda = -1
  let nu = 2
  let iteration = 0
  let message = 'maximum iterations reached'
  let converged = false

  yield { iteration, loss: cur.f, z: z.slice(), nfev, lambda: 0 }

  outer: while (iteration < maxIter) {
    // Forward-difference Jacobian (backward at the upper bound).
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

    // Active set: a coordinate at a bound whose descent direction points outside stays put.
    const idx = z.flatMap((zj, j) => ((zj <= 0 && g[j] > 0) || (zj >= 1 && g[j] < 0) ? [] : [j]))
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
        opts.onAccept?.(cur)
        iteration++
        yield { iteration, loss: cur.f, z: z.slice(), nfev, lambda }
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
  return { iteration, loss: cur.f, z, nfev, lambda, converged, message }
}

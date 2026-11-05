/**
 * Full-covariance Gaussian HMM fitted by Baum-Welch, for refitting the regime model in the
 * browser with K = 2..4 states. Mirrors the models/hmm.py contract: inputs are the
 * standardised features, states are relabelled by mean realised vol (feature 0 = rv_21d)
 * so 0 = calmest, and decoding uses Viterbi with smoothed posteriors alongside.
 */
import { Rng } from './rng'

export interface HmmFit {
  K: number
  means: number[][]
  covars: number[][][]
  transmat: number[][]
  startprob: number[]
  logLik: number
  iterations: number
  states: Uint8Array
  posteriors: Float32Array[] // K arrays of length T
}

const MIN_COVAR = 1e-3

function cholesky(A: number[][]): number[][] | null {
  const n = A.length
  const L = A.map(() => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j]
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]
      if (i === j) {
        if (s <= 0) return null
        L[i][i] = Math.sqrt(s)
      } else L[i][j] = s / L[j][j]
    }
  }
  return L
}

/** log N(x | mu, Sigma) for every row, via the Cholesky factor. */
function logGauss(X: Float64Array[], T: number, D: number, mu: number[], cov: number[][], out: Float64Array) {
  let L = cholesky(cov)
  if (!L) L = cholesky(cov.map((r, i) => r.map((v, j) => v + (i === j ? 1e-6 : 0))))!
  let logDet = 0
  for (let i = 0; i < D; i++) logDet += 2 * Math.log(L[i][i])
  const c = -0.5 * (D * Math.log(2 * Math.PI) + logDet)
  const y = new Float64Array(D)
  for (let t = 0; t < T; t++) {
    let q = 0
    for (let i = 0; i < D; i++) {
      let s = X[i][t] - mu[i]
      for (let k = 0; k < i; k++) s -= L[i][k] * y[k]
      y[i] = s / L[i][i]
      q += y[i] * y[i]
    }
    out[t] = c - 0.5 * q
  }
}

/** k-means++ initial centres (seeded) refined by Lloyd iterations. */
function kmeans(X: Float64Array[], T: number, K: number, rng: Rng): Int32Array {
  const D = X.length
  const centres: number[][] = []
  centres.push(X.map((col) => col[Math.floor(rng.next() * T)]))
  const d2 = new Float64Array(T)
  while (centres.length < K) {
    let total = 0
    for (let t = 0; t < T; t++) {
      let best = Infinity
      for (const c of centres) {
        let s = 0
        for (let i = 0; i < D; i++) s += (X[i][t] - c[i]) ** 2
        best = Math.min(best, s)
      }
      d2[t] = best
      total += best
    }
    let r = rng.next() * total
    let pick = T - 1
    for (let t = 0; t < T; t++) {
      r -= d2[t]
      if (r <= 0) {
        pick = t
        break
      }
    }
    centres.push(X.map((col) => col[pick]))
  }
  const assign = new Int32Array(T)
  for (let it = 0; it < 50; it++) {
    let changed = false
    for (let t = 0; t < T; t++) {
      let best = 0
      let bestD = Infinity
      for (let k = 0; k < K; k++) {
        let s = 0
        for (let i = 0; i < D; i++) s += (X[i][t] - centres[k][i]) ** 2
        if (s < bestD) {
          bestD = s
          best = k
        }
      }
      if (assign[t] !== best) changed = true
      assign[t] = best
    }
    const sums = centres.map(() => new Array<number>(D).fill(0))
    const counts = new Array<number>(K).fill(0)
    for (let t = 0; t < T; t++) {
      counts[assign[t]]++
      for (let i = 0; i < D; i++) sums[assign[t]][i] += X[i][t]
    }
    for (let k = 0; k < K; k++) if (counts[k]) centres[k] = sums[k].map((s) => s / counts[k])
    if (!changed && it > 0) break
  }
  return assign
}

function fitOnce(X: Float64Array[], K: number, seed: number, maxIter: number, tol: number): HmmFit {
  const D = X.length
  const T = X[0].length
  const rng = new Rng(seed)
  // Odd restarts start from a random hard partition instead of k-means for diversity.
  const assign = seed % 2 === 0 ? kmeans(X, T, K, rng) : Int32Array.from({ length: T }, () => Math.floor(rng.next() * K))
  // Initial parameters: cluster means; pooled covariance (hmmlearn's default init); sticky A.
  let means: number[][] = []
  for (let k = 0; k < K; k++) {
    const m = new Array<number>(D).fill(0)
    let n = 0
    for (let t = 0; t < T; t++)
      if (assign[t] === k) {
        n++
        for (let i = 0; i < D; i++) m[i] += X[i][t]
      }
    means.push(m.map((v) => v / Math.max(n, 1)))
  }
  const pooled = Array.from({ length: D }, (_, i) =>
    Array.from({ length: D }, (_, j) => {
      let s = 0
      for (let t = 0; t < T; t++) s += X[i][t] * X[j][t]
      return s / T + (i === j ? MIN_COVAR : 0)
    }),
  )
  let covars = means.map(() => pooled.map((r) => r.slice()))
  let transmat = Array.from({ length: K }, (_, i) => Array.from({ length: K }, (_, j) => (i === j ? 0.95 : 0.05 / (K - 1))))
  let startprob = new Array<number>(K).fill(1 / K)

  const logB = Array.from({ length: K }, () => new Float64Array(T))
  const B = new Float64Array(T * K)
  const alpha = new Float64Array(T * K)
  const beta = new Float64Array(T * K)
  const scale = new Float64Array(T)
  const rowMax = new Float64Array(T)
  let logLik = -Infinity
  let iterations = 0

  const eStep = () => {
    for (let k = 0; k < K; k++) logGauss(X, T, D, means[k], covars[k], logB[k])
    for (let t = 0; t < T; t++) {
      let mx = -Infinity
      for (let k = 0; k < K; k++) mx = Math.max(mx, logB[k][t])
      rowMax[t] = mx
      for (let k = 0; k < K; k++) B[t * K + k] = Math.exp(logB[k][t] - mx)
    }
    let ll = 0
    for (let t = 0; t < T; t++) {
      let s = 0
      for (let k = 0; k < K; k++) {
        let a: number
        if (t === 0) a = startprob[k]
        else {
          a = 0
          for (let j = 0; j < K; j++) a += alpha[(t - 1) * K + j] * transmat[j][k]
        }
        a *= B[t * K + k]
        alpha[t * K + k] = a
        s += a
      }
      s = Math.max(s, 1e-300)
      scale[t] = s
      for (let k = 0; k < K; k++) alpha[t * K + k] /= s
      ll += Math.log(s) + rowMax[t]
    }
    for (let k = 0; k < K; k++) beta[(T - 1) * K + k] = 1
    for (let t = T - 2; t >= 0; t--) {
      for (let i = 0; i < K; i++) {
        let s = 0
        for (let j = 0; j < K; j++) s += transmat[i][j] * B[(t + 1) * K + j] * beta[(t + 1) * K + j]
        beta[t * K + i] = s / scale[t + 1]
      }
    }
    return ll
  }

  for (let it = 0; it < maxIter; it++) {
    const ll = eStep()
    iterations = it + 1
    const improved = ll - logLik
    logLik = ll
    if (it > 0 && improved < tol) break
    // M-step.
    const gamma = Array.from({ length: K }, () => new Float64Array(T))
    for (let t = 0; t < T; t++) {
      let s = 0
      for (let k = 0; k < K; k++) s += alpha[t * K + k] * beta[t * K + k]
      for (let k = 0; k < K; k++) gamma[k][t] = (alpha[t * K + k] * beta[t * K + k]) / s
    }
    const xi = Array.from({ length: K }, () => new Array<number>(K).fill(0))
    for (let t = 0; t < T - 1; t++) {
      let s = 0
      for (let i = 0; i < K; i++)
        for (let j = 0; j < K; j++) s += alpha[t * K + i] * transmat[i][j] * B[(t + 1) * K + j] * beta[(t + 1) * K + j]
      for (let i = 0; i < K; i++)
        for (let j = 0; j < K; j++)
          xi[i][j] += (alpha[t * K + i] * transmat[i][j] * B[(t + 1) * K + j] * beta[(t + 1) * K + j]) / s
    }
    startprob = gamma.map((g) => g[0])
    transmat = xi.map((row) => {
      const s = row.reduce((a, b) => a + b, 0)
      return row.map((v) => v / Math.max(s, 1e-300))
    })
    means = gamma.map((g) => {
      const w = g.reduce((a, b) => a + b, 0)
      return X.map((col) => {
        let s = 0
        for (let t = 0; t < T; t++) s += g[t] * col[t]
        return s / w
      })
    })
    covars = gamma.map((g, k) => {
      const w = g.reduce((a, b) => a + b, 0)
      return Array.from({ length: D }, (_, i) =>
        Array.from({ length: D }, (_, j) => {
          let s = 0
          for (let t = 0; t < T; t++) s += g[t] * (X[i][t] - means[k][i]) * (X[j][t] - means[k][j])
          return s / w + (i === j ? MIN_COVAR : 0)
        }),
      )
    })
  }

  // Final posteriors at the converged parameters.
  eStep()
  const post = Array.from({ length: K }, () => new Float32Array(T))
  for (let t = 0; t < T; t++) {
    let s = 0
    for (let k = 0; k < K; k++) s += alpha[t * K + k] * beta[t * K + k]
    for (let k = 0; k < K; k++) post[k][t] = (alpha[t * K + k] * beta[t * K + k]) / s
  }
  const states = viterbi(logB, transmat, startprob, T, K)
  return { K, means, covars, transmat, startprob, logLik, iterations, states, posteriors: post }
}

function viterbi(logB: Float64Array[], A: number[][], pi: number[], T: number, K: number): Uint8Array {
  const lA = A.map((r) => r.map((v) => Math.log(Math.max(v, 1e-300))))
  let delta = pi.map((p, k) => Math.log(Math.max(p, 1e-300)) + logB[k][0])
  const back = new Uint8Array(T * K)
  for (let t = 1; t < T; t++) {
    const next = new Array<number>(K)
    for (let j = 0; j < K; j++) {
      let best = -Infinity
      let arg = 0
      for (let i = 0; i < K; i++) {
        const c = delta[i] + lA[i][j]
        if (c > best) {
          best = c
          arg = i
        }
      }
      back[t * K + j] = arg
      next[j] = best + logB[j][t]
    }
    delta = next
  }
  const path = new Uint8Array(T)
  path[T - 1] = delta.indexOf(Math.max(...delta))
  for (let t = T - 2; t >= 0; t--) path[t] = back[(t + 1) * K + path[t + 1]]
  return path
}

/**
 * Fit with seeded restarts (alternating k-means and random-partition starts — EM only finds
 * local optima), keep the best likelihood and order states by feature 0.
 */
export function fitHmm(
  X: Float64Array[],
  K: number,
  opts: { restarts?: number; maxIter?: number; tol?: number; seed?: number } = {},
): HmmFit {
  const { restarts = 8, maxIter = 200, tol = 1e-2, seed = 42 } = opts
  let best: HmmFit | null = null
  for (let r = 0; r < restarts; r++) {
    const fit = fitOnce(X, K, seed + r, maxIter, tol)
    if (!best || fit.logLik > best.logLik) best = fit
  }
  return relabel(best!, X[0])
}

function relabel(fit: HmmFit, vol: Float64Array): HmmFit {
  const K = fit.K
  const sums = new Array<number>(K).fill(0)
  const counts = new Array<number>(K).fill(0)
  for (let t = 0; t < vol.length; t++) {
    sums[fit.states[t]] += vol[t]
    counts[fit.states[t]]++
  }
  const meanVol = sums.map((s, k) => (counts[k] ? s / counts[k] : Infinity))
  const order = meanVol.map((_, k) => k).sort((a, b) => meanVol[a] - meanVol[b]) // new -> old
  const inv = new Array<number>(K)
  order.forEach((old, nw) => (inv[old] = nw))
  return {
    ...fit,
    means: order.map((o) => fit.means[o]),
    covars: order.map((o) => fit.covars[o]),
    startprob: order.map((o) => fit.startprob[o]),
    transmat: order.map((o) => order.map((p) => fit.transmat[o][p])),
    states: fit.states.map((s) => inv[s]),
    posteriors: order.map((o) => fit.posteriors[o]),
  }
}

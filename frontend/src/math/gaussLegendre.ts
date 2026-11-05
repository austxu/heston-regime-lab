/**
 * Gauss-Legendre nodes/weights mapped from [-1, 1] onto (0, U) — the quadrature used by
 * `models/heston.py::_gauss_legendre_nodes`. Nodes are strictly interior, so the
 * removable 1/(iu) singularity of the Gil-Pelaez integrand at u = 0 is never sampled.
 */
const cache = new Map<string, { nodes: Float64Array; weights: Float64Array }>()

export function legendreGauss(n: number): { x: Float64Array; w: Float64Array } {
  if (!Number.isInteger(n) || n < 2) throw new Error(`n must be an integer >= 2, got ${n}`)
  const x = new Float64Array(n)
  const w = new Float64Array(n)
  const half = Math.floor((n + 1) / 2)
  for (let i = 0; i < half; i++) {
    // Tricomi initial guess for the i-th largest root, refined by Newton on P_n.
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5))
    let dp = 0
    for (let it = 0; it < 100; it++) {
      let p0 = 1
      let p1 = z
      for (let k = 2; k <= n; k++) {
        const p2 = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k
        p0 = p1
        p1 = p2
      }
      dp = (n * (z * p1 - p0)) / (z * z - 1)
      const dz = p1 / dp
      z -= dz
      if (Math.abs(dz) < 1e-16) break
    }
    // Recompute the derivative at the converged root for the weight.
    let p0 = 1
    let p1 = z
    for (let k = 2; k <= n; k++) {
      const p2 = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k
      p0 = p1
      p1 = p2
    }
    dp = (n * (z * p1 - p0)) / (z * z - 1)
    const weight = 2 / ((1 - z * z) * dp * dp)
    // Ascending order, like numpy.polynomial.legendre.leggauss.
    x[i] = -z
    x[n - 1 - i] = z
    w[i] = weight
    w[n - 1 - i] = weight
  }
  if (n % 2 === 1) x[(n - 1) / 2] = 0
  return { x, w }
}

/** Nodes in (0, U) with the (U / 2) Jacobian folded into the weights. Cached. */
export function gaussLegendreNodes(n: number, upper: number) {
  const key = `${n}:${upper}`
  let hit = cache.get(key)
  if (!hit) {
    const { x, w } = legendreGauss(n)
    const nodes = new Float64Array(n)
    const weights = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      nodes[i] = 0.5 * upper * (x[i] + 1)
      weights[i] = 0.5 * upper * w[i]
    }
    hit = { nodes, weights }
    cache.set(key, hit)
  }
  return hit
}

// A tiny 1-D Gaussian kernel density estimate, used to draw smooth per-regime parameter
// distributions from the small bootstrap samples the API returns.

function std(xs: number[], mean: number): number {
  if (xs.length < 2) return 0
  const v = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(v)
}

export interface Density {
  x: number[]
  y: number[]
}

/**
 * Gaussian KDE evaluated on a grid spanning the combined data range. Bandwidth uses
 * Silverman's rule of thumb, with a small floor so near-degenerate samples still render.
 */
export function gaussianKde(samples: number[], grid: number[]): Density {
  const n = samples.length
  if (n === 0) return { x: grid, y: grid.map(() => 0) }
  const mean = samples.reduce((a, x) => a + x, 0) / n
  const s = std(samples, mean)
  const bw = Math.max(1.06 * s * Math.pow(n, -0.2), 1e-6)
  const norm = 1 / (n * bw * Math.sqrt(2 * Math.PI))
  const y = grid.map((g) => {
    let sum = 0
    for (const xi of samples) {
      const u = (g - xi) / bw
      sum += Math.exp(-0.5 * u * u)
    }
    return norm * sum
  })
  return { x: grid, y }
}

/** A linear grid of `n` points spanning [min(all)-pad, max(all)+pad]. */
export function spanGrid(allSamples: number[][], n = 80): number[] {
  const flat = allSamples.flat().filter((v) => Number.isFinite(v))
  if (!flat.length) return Array.from({ length: n }, (_, i) => i / (n - 1))
  let lo = Math.min(...flat)
  let hi = Math.max(...flat)
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 0.01
  lo -= pad
  hi += pad
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1))
}

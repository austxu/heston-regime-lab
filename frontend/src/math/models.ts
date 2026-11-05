/**
 * The models fitted to the real SPX snapshot, as characteristic functions of the forward
 * log-return (spot 1, no carry): Heston, Bates (Heston + Merton jumps) and double Heston.
 * Mirrors calibration/market.py MODELS (names, order and bounds).
 */
import type { CharFn } from './fourier'
import { charFn } from './heston'
import type { HestonParams } from './types'

export type ModelId = 'heston' | 'bates' | 'double'

export interface ModelSpec {
  id: ModelId
  label: string
  names: string[]
  symbols: string[]
  bounds: [number, number][]
  cf: (p: ArrayLike<number>, tau: number) => CharFn
}

const H_NAMES = ['kappa', 'theta', 'sigma', 'rho', 'v0']
const H_SYM = ['κ', 'θ', 'σ', 'ρ', 'v₀']
// Wider than configs/base.yaml: real short-dated SPX smiles push kappa and sigma far out.
const H_BOUNDS: [number, number][] = [
  [0.1, 50],
  [0.001, 1],
  [0.01, 8],
  [-0.999, 0.999],
  [0.001, 1],
]

const hp = (p: ArrayLike<number>, o = 0): HestonParams => ({ kappa: p[o], theta: p[o + 1], sigma: p[o + 2], rho: p[o + 3], v0: p[o + 4] })

const hestonCf =
  (p: ArrayLike<number>, tau: number): CharFn =>
  (uRe, uIm, out) =>
    charFn(uRe, uIm, hp(p), 1, 0, 0, tau, out)

/** Multiplies out by exp(lam tau [e^{z mu + s^2 z^2 / 2} - 1 - z kbar]) with z = i u. */
function applyJumps(uRe: number, uIm: number, lam: number, mu: number, sj: number, tau: number, out: Float64Array) {
  const zr = -uIm
  const zi = uRe
  const kbar = Math.exp(mu + 0.5 * sj * sj) - 1
  // e^{z mu + s^2 z^2 / 2}
  const er = zr * mu + 0.5 * sj * sj * (zr * zr - zi * zi)
  const ei = zi * mu + sj * sj * zr * zi
  const m = Math.exp(er)
  const gr = lam * tau * (m * Math.cos(ei) - 1 - zr * kbar)
  const gi = lam * tau * (m * Math.sin(ei) - zi * kbar)
  const s = Math.exp(gr)
  const c = s * Math.cos(gi)
  const d = s * Math.sin(gi)
  const re = out[0] * c - out[1] * d
  out[1] = out[0] * d + out[1] * c
  out[0] = re
}

const t2 = new Float64Array(2)

export const MODELS: Record<ModelId, ModelSpec> = {
  heston: { id: 'heston', label: 'Heston', names: H_NAMES, symbols: H_SYM, bounds: H_BOUNDS, cf: hestonCf },
  bates: {
    id: 'bates',
    label: 'Bates',
    names: [...H_NAMES, 'lam', 'mu_j', 'sigma_j'],
    symbols: [...H_SYM, 'λ', 'μⱼ', 'σⱼ'],
    bounds: [...H_BOUNDS, [0, 10], [-0.8, 0.3], [0.005, 0.8]],
    cf: (p, tau) => {
      const h = hp(p)
      return (uRe, uIm, out) => {
        charFn(uRe, uIm, h, 1, 0, 0, tau, out)
        applyJumps(uRe, uIm, p[5], p[6], p[7], tau, out)
      }
    },
  },
  double: {
    id: 'double',
    label: 'Double Heston',
    names: [...H_NAMES.map((n) => `${n}1`), ...H_NAMES.map((n) => `${n}2`)],
    symbols: [...H_SYM.map((s) => `${s.replace('₀', '')}₁`), ...H_SYM.map((s) => `${s.replace('₀', '')}₂`)],
    bounds: [...H_BOUNDS, ...H_BOUNDS],
    cf: (p, tau) => {
      const a = hp(p)
      const b = hp(p, 5)
      return (uRe, uIm, out) => {
        charFn(uRe, uIm, a, 1, 0, 0, tau, out)
        charFn(uRe, uIm, b, 1, 0, 0, tau, t2)
        const re = out[0] * t2[0] - out[1] * t2[1]
        out[1] = out[0] * t2[1] + out[1] * t2[0]
        out[0] = re
      }
    },
  },
}

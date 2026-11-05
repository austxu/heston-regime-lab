export interface HestonParams {
  kappa: number
  theta: number
  sigma: number
  rho: number
  v0: number
}

export const PARAM_NAMES = ['kappa', 'theta', 'sigma', 'rho', 'v0'] as const
export type ParamName = (typeof PARAM_NAMES)[number]

export interface Market {
  spot: number
  rate: number
  div: number
}

/** Quadrature resolution — configs/base.yaml `quadrature`. */
export const QUAD = { nNodes: 128, upperLimit: 200 } as const

/** Calibration box + initial guess — configs/base.yaml `calibration`. */
export const BOUNDS: Record<ParamName, [number, number]> = {
  kappa: [0.1, 15.0],
  theta: [0.001, 1.0],
  sigma: [0.01, 2.0],
  rho: [-0.999, 0.999],
  v0: [0.001, 1.0],
}
export const INITIAL_GUESS: HestonParams = { kappa: 1.0, theta: 0.06, sigma: 0.3, rho: -0.4, v0: 0.05 }

export const toArray = (p: HestonParams) => PARAM_NAMES.map((n) => p[n])
export const fromArray = (a: ArrayLike<number>): HestonParams => ({
  kappa: a[0],
  theta: a[1],
  sigma: a[2],
  rho: a[3],
  v0: a[4],
})

export const feller = (p: HestonParams) => 2 * p.kappa * p.theta > p.sigma * p.sigma

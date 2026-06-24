// TypeScript mirror of the FastAPI Pydantic response models (api/models/schemas.py).
// Keep these in sync with the backend contract.

export interface Provenance {
  source: 'live' | 'synthetic' | string
  as_of: string
  cached_at: string | null
  stale: boolean
  cache_backend: string
}

export interface HealthResponse {
  status: string
  version: string
  cache_backend: string
  redis_healthy: boolean
  regime_model_ready: boolean
  time: string
}

export interface HestonParams {
  kappa: number
  theta: number
  sigma: number
  rho: number
  v0: number
  feller: boolean
}

export interface CalibrationResponse {
  params: HestonParams
  mean_iv_error: number
  rmse_iv: number
  success: boolean
  message: string
  n_iter: number
  n_feval: number
  n_options: number
  spot: number
  rate: number
  liquidity: Record<string, number>
  provenance: Provenance
}

export interface SurfaceResponse {
  moneyness: number[]
  strikes: number[]
  maturities: number[]
  market_iv: (number | null)[][]
  heston_iv: (number | null)[][]
  spot: number
  params: HestonParams
  provenance: Provenance
}

export interface RegimeCurrentResponse {
  regime: number
  label: string
  probabilities: Record<string, number>
  as_of: string
  features: Record<string, number>
  provenance: Provenance
}

export interface RegimeHistoryPoint {
  date: string
  price: number
  regime: number
  label: string
}

export interface RegimeHistoryResponse {
  labels: string[]
  points: RegimeHistoryPoint[]
  provenance: Provenance
}

export interface BucketError {
  center: number
  n: number
  bs: number
  heston: number
  corrected: number
}

export interface ComparisonResponse {
  mae_bs: number
  mae_heston: number
  mae_corrected: number
  heston_vs_bs_improvement_pct: number
  residual_improvement_pct: number
  residual_backend: string
  by_moneyness: BucketError[]
  by_maturity: BucketError[]
  provenance: Provenance
}

export interface ParameterTest {
  H: number
  p_value: number
  significant: boolean
}

export interface RegimeParametersResponse {
  alpha: number
  kruskal_wallis: Record<string, ParameterTest>
  regime_params: Record<string, HestonParams>
  param_samples: Record<string, Record<string, number[]>>
  static_mae_overall: number
  regime_mae_overall: number
  static_mae_by_regime: Record<string, number>
  regime_mae_by_regime: Record<string, number>
  regime_conditional_improvement_pct: number
  provenance: Provenance
}

// One frame on /ws/calibration.
export interface CalibrationStreamMessage {
  type: 'progress' | 'done' | 'error'
  iteration?: number
  loss?: number
  params?: Record<string, number>
  mean_iv_error?: number
  message?: string
}

export type ParamName = 'kappa' | 'theta' | 'sigma' | 'rho' | 'v0'
export const PARAM_NAMES: ParamName[] = ['kappa', 'theta', 'sigma', 'rho', 'v0']

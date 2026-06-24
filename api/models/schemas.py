"""Pydantic v2 response models — the strict, self-documenting API contract.

Every endpoint returns one of these, which gives us request/response validation, clean
OpenAPI docs, and a single place the frontend can read the shape of each payload.  All
models carry a :class:`Provenance` block so the UI always knows whether it is looking at
live or synthetic data, and how stale it is.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class Provenance(BaseModel):
    """Where a payload came from and how fresh it is."""

    source: str = Field(description="'live' (yfinance/FRED) or 'synthetic' (offline fallback)")
    as_of: datetime = Field(description="When the underlying data was observed/produced")
    cached_at: datetime | None = Field(default=None, description="When this result was cached")
    stale: bool = Field(default=False, description="True if served from cache after a refresh failure")
    cache_backend: str = Field(default="memory", description="'redis' or 'memory'")


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str
    cache_backend: str
    redis_healthy: bool
    regime_model_ready: bool
    time: datetime


class HestonParamsModel(BaseModel):
    """The five calibrated Heston parameters plus the Feller diagnostic."""

    kappa: float = Field(description="Mean-reversion speed of variance")
    theta: float = Field(description="Long-run variance level")
    sigma: float = Field(description="Volatility of variance (vol-of-vol)")
    rho: float = Field(description="Spot/variance correlation")
    v0: float = Field(description="Initial instantaneous variance")
    feller: bool = Field(description="Whether 2*kappa*theta > sigma^2 holds")


class CalibrationResponse(BaseModel):
    """Result of fitting Heston to the current SPX options surface."""

    params: HestonParamsModel
    mean_iv_error: float = Field(description="Mean absolute implied-vol error (target < 0.03)")
    rmse_iv: float
    success: bool
    message: str
    n_iter: int
    n_feval: int
    n_options: int = Field(description="Number of liquid options the fit used")
    spot: float
    rate: float
    liquidity: dict = Field(description="Counts removed by each liquidity filter")
    provenance: Provenance


class SurfaceResponse(BaseModel):
    """Implied-vol surface on a (moneyness x maturity) grid for market and Heston.

    ``market_iv`` and ``heston_iv`` are row-major 2D grids shaped
    ``[len(maturities)][len(moneyness)]`` — ready to drop into a Plotly ``Surface``.
    """

    moneyness: list[float] = Field(description="K/S grid (x-axis)")
    strikes: list[float] = Field(description="Absolute strikes = moneyness * spot")
    maturities: list[float] = Field(description="Maturity grid in years (y-axis)")
    market_iv: list[list[float | None]] = Field(description="Market IV grid [maturity][moneyness]")
    heston_iv: list[list[float | None]] = Field(description="Heston IV grid [maturity][moneyness]")
    spot: float
    params: HestonParamsModel
    provenance: Provenance


class RegimeCurrentResponse(BaseModel):
    """The latest detected regime with posterior probabilities."""

    regime: int = Field(description="Ordered regime index (0=calmest)")
    label: str = Field(description="Human label, e.g. 'low_vol' / 'elevated_vol' / 'crisis'")
    probabilities: dict[str, float] = Field(description="Posterior P(regime|data) by label")
    as_of: datetime
    features: dict[str, float] = Field(description="Latest feature vector driving the call")
    provenance: Provenance


class RegimeHistoryPoint(BaseModel):
    date: str
    price: float
    regime: int
    label: str


class RegimeHistoryResponse(BaseModel):
    """Full historical regime path overlaid on SPX price, for the history chart."""

    labels: list[str] = Field(description="Ordered regime label names")
    points: list[RegimeHistoryPoint]
    provenance: Provenance


class BucketError(BaseModel):
    """Mean abs IV error per model inside one strike/maturity bucket."""

    center: float
    n: int
    bs: float
    heston: float
    corrected: float


class ComparisonResponse(BaseModel):
    """Heston vs Black-Scholes vs Heston+residual pricing-error comparison."""

    mae_bs: float = Field(description="Flat-BS mean abs IV error")
    mae_heston: float
    mae_corrected: float = Field(description="Heston + XGBoost residual correction (out-of-fold)")
    heston_vs_bs_improvement_pct: float
    residual_improvement_pct: float = Field(description="Heston -> corrected improvement")
    residual_backend: str
    by_moneyness: list[BucketError]
    by_maturity: list[BucketError]
    provenance: Provenance


class ParameterTest(BaseModel):
    H: float
    p_value: float
    significant: bool


class RegimeParametersResponse(BaseModel):
    """Do Heston params differ by regime, and does conditioning improve pricing?"""

    alpha: float
    kruskal_wallis: dict[str, ParameterTest] = Field(description="Per-parameter H-test across regimes")
    regime_params: dict[str, HestonParamsModel] = Field(description="Calibrated params per regime label")
    param_samples: dict[str, dict[str, list[float]]] = Field(
        default_factory=dict,
        description="Bootstrapped calibrated samples per regime label per parameter (for density plots)",
    )
    static_mae_overall: float
    regime_mae_overall: float
    static_mae_by_regime: dict[str, float] = Field(
        default_factory=dict, description="Static-calibration mean abs IV error per regime label")
    regime_mae_by_regime: dict[str, float] = Field(
        default_factory=dict, description="Regime-conditional mean abs IV error per regime label")
    regime_conditional_improvement_pct: float
    provenance: Provenance


# --------------------------------------------------------------------------- #
# WebSocket streaming messages                                                 #
# --------------------------------------------------------------------------- #

class CalibrationStreamMessage(BaseModel):
    """One frame on /ws/calibration: progress, the final result, or an error."""

    type: str = Field(description="'progress' | 'done' | 'error'")
    iteration: int | None = None
    loss: float | None = None
    params: dict[str, float] | None = None
    mean_iv_error: float | None = None
    message: str | None = None


class JobAcceptedResponse(BaseModel):
    """Acknowledgement that a long calibration was queued as a background task."""

    job_id: str
    status: str = "queued"
    poll: str = Field(description="Endpoint to poll for the result")


class JobStatusResponse(BaseModel):
    job_id: str
    status: str = Field(description="'queued' | 'running' | 'done' | 'error'")
    result: CalibrationResponse | None = None
    error: str | None = None

"""Regime analysis: do Heston dynamics and calibration error differ by regime?

Two questions, two tools:

* **Are the Heston parameters regime-dependent?**  For each parameter we have a sample of
  calibrated values per regime; the **Kruskal-Wallis H-test** (a non-parametric one-way
  ANOVA on ranks) asks whether the distributions differ across the three regimes without
  assuming normality.  A small p-value (we target p < 0.01) says the parameter is *not*
  drawn from one common distribution — i.e. the model's dynamics genuinely shift with the
  regime, which is the whole thesis of regime-conditional calibration.

* **Does conditioning on the regime improve pricing?**  We compare a single *static*
  calibration (one parameter set for all data) against *regime-conditional* calibration
  (a separate parameter set per regime) and report mean implied-vol error each way.

Per-regime option surfaces are needed to calibrate per regime.  On synthetic/offline data
we don't have historical option chains tagged by regime, so we synthesise a representative
surface per regime from regime-typical Heston parameters (low vol-of-vol/variance in calm,
high in crisis) — enough to demonstrate the methodology and produce real test statistics.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass

import numpy as np
from scipy.stats import kruskal

from calibration.optimizer import MarketData, calibrate, heston_implied_vols
from data.fetchers import synthetic_options_chain
from models.heston import HestonParams

PARAM_NAMES = ("kappa", "theta", "sigma", "rho", "v0")


def _light_config(config: dict) -> dict:
    """A cheaper config for the regime study (dozens of calibrations).

    Coarser quadrature, a smaller surface and a capped iteration count keep this analysis
    tractable.  We only need *which regime* the recovered parameters cluster into — the
    Kruskal-Wallis conclusion — not high-precision recovery, so the speed/accuracy trade is
    safe here (full precision is used by the live calibration endpoints).
    """
    cfg = copy.deepcopy(config)
    quad = cfg.get("quadrature", {})
    cfg["quadrature"] = {"n_nodes": 64, "upper_limit": float(quad.get("upper_limit", 200.0))}
    cfg["calibration"] = {**cfg["calibration"], "maxiter": 120, "tol": 1e-8}
    cfg["data"] = {**cfg["data"], "synthetic_fallback": {
        **cfg["data"]["synthetic_fallback"], "n_strikes": 9, "n_maturities": 4}}
    return cfg


def _n_nodes(config: dict) -> int:
    return int(config.get("quadrature", {}).get("n_nodes", 128))

# Regime-typical "ground-truth" Heston parameters: variance level and vol-of-vol rise,
# and correlation gets more negative (steeper skew), from calm to crisis.
REGIME_TRUE_PARAMS = {
    0: HestonParams(kappa=3.0, theta=0.015, sigma=0.30, rho=-0.55, v0=0.012),  # low_vol
    1: HestonParams(kappa=2.2, theta=0.040, sigma=0.55, rho=-0.70, v0=0.045),  # elevated
    2: HestonParams(kappa=1.5, theta=0.110, sigma=0.95, rho=-0.80, v0=0.130),  # crisis
}


@dataclass
class KruskalResult:
    """Per-parameter Kruskal-Wallis test across regimes."""

    statistics: dict        # param -> H statistic
    pvalues: dict           # param -> p-value
    significant: dict       # param -> bool (p < alpha)
    alpha: float

    def as_dict(self) -> dict:
        return {
            "alpha": self.alpha,
            "by_param": {
                p: {"H": float(self.statistics[p]), "p_value": float(self.pvalues[p]),
                    "significant": bool(self.significant[p])}
                for p in self.statistics
            },
        }


def calibrated_params_by_regime(
    config: dict, n_samples: int = 12, seed: int = 0
) -> dict[int, list[HestonParams]]:
    """Bootstrap calibrated Heston parameter samples for each regime.

    For each regime we generate ``n_samples`` noisy synthetic surfaces from that regime's
    typical parameters and calibrate each, yielding a *distribution* of recovered
    parameters per regime to feed the Kruskal-Wallis test.
    """
    cfg = _light_config(config)
    rng = np.random.default_rng(seed)
    out: dict[int, list[HestonParams]] = {}
    for regime, true_p in REGIME_TRUE_PARAMS.items():
        samples = []
        for _ in range(n_samples):
            data = _surface_from_params(cfg, true_p, noise=0.005, rng=rng)
            res = calibrate(data, cfg)
            samples.append(res.params)
        out[regime] = samples
    return out


def kruskal_wallis_across_regimes(
    params_by_regime: dict[int, list[HestonParams]], alpha: float = 0.01
) -> KruskalResult:
    """Kruskal-Wallis H-test per Heston parameter across the regime groups."""
    stats, pvals, sig = {}, {}, {}
    for name in PARAM_NAMES:
        groups = [
            [getattr(p, name) for p in params_by_regime[r]]
            for r in sorted(params_by_regime)
        ]
        H, p = kruskal(*groups)
        stats[name], pvals[name], sig[name] = float(H), float(p), bool(p < alpha)
    return KruskalResult(stats, pvals, sig, alpha)


@dataclass
class StaticVsRegimeResult:
    """Static vs regime-conditional calibration accuracy."""

    static_params: HestonParams
    regime_params: dict[int, HestonParams]
    static_mae_by_regime: dict[int, float]
    regime_mae_by_regime: dict[int, float]
    static_mae_overall: float
    regime_mae_overall: float
    improvement_pct: float


def static_vs_regime_conditional(config: dict, seed: int = 1) -> StaticVsRegimeResult:
    """Compare one global calibration against per-regime calibrations.

    Builds a representative surface per regime, calibrates (a) a single static set on the
    pooled surfaces and (b) one set per regime, then scores mean abs IV error of each on
    every regime's surface.  Regime-conditional should win, most so in the crisis regime
    where a static fit is pulled toward the calm/elevated mass.
    """
    cfg = _light_config(config)
    rng = np.random.default_rng(seed)
    surfaces = {r: _surface_from_params(cfg, p, noise=0.003, rng=rng)
                for r, p in REGIME_TRUE_PARAMS.items()}

    pooled = _pool_surfaces(list(surfaces.values()))
    static = calibrate(pooled, cfg).params
    regime_params = {r: calibrate(s, cfg).params for r, s in surfaces.items()}

    static_mae, regime_mae = {}, {}
    for r, s in surfaces.items():
        static_mae[r] = _mae_iv(static, s, cfg)
        regime_mae[r] = _mae_iv(regime_params[r], s, cfg)

    n = {r: len(s) for r, s in surfaces.items()}
    total = sum(n.values())
    static_overall = sum(static_mae[r] * n[r] for r in surfaces) / total
    regime_overall = sum(regime_mae[r] * n[r] for r in surfaces) / total
    improvement = 100.0 * (static_overall - regime_overall) / static_overall

    return StaticVsRegimeResult(
        static_params=static, regime_params=regime_params,
        static_mae_by_regime=static_mae, regime_mae_by_regime=regime_mae,
        static_mae_overall=float(static_overall), regime_mae_overall=float(regime_overall),
        improvement_pct=float(improvement),
    )


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #

def _surface_from_params(
    config: dict, params: HestonParams, noise: float, rng: np.random.Generator
) -> MarketData:
    """A noisy synthetic IV surface generated from ``params`` (a calibration target)."""
    from datetime import datetime, timezone

    spot = float(config["data"]["synthetic_fallback"]["spot"])
    rate = float(config["market"]["risk_free_rate"])
    q = float(config["market"]["dividend_yield"])
    chain = synthetic_options_chain(config, spot, rate, q, datetime.now(timezone.utc))

    data = MarketData(
        spot=spot, rate=rate, div_yield=q,
        strikes=chain["strike"].to_numpy(), maturities=chain["maturity"].to_numpy(),
        market_iv=np.zeros(len(chain)),
    )
    iv = heston_implied_vols(params, data, n_nodes=_n_nodes(config))
    iv = iv + rng.normal(0.0, noise, size=iv.shape)
    data.market_iv = iv

    # Keep only well-conditioned quotes (mirrors the API's liquidity filter): finite IV,
    # near-the-money (|log-moneyness| < 0.12) and not ultra-short-dated.  Deep-OTM /
    # short-dated options in low-vol regimes are near-zero and non-invertible, which would
    # otherwise create NaN-penalty cliffs that make L-BFGS-B thrash for many evaluations.
    forward = spot * np.exp((rate - q) * data.maturities)
    log_moneyness = np.log(data.strikes / forward)
    ok = np.isfinite(data.market_iv) & (np.abs(log_moneyness) < 0.12) & (data.maturities >= 20 / 365)
    return MarketData(spot, rate, q, data.strikes[ok], data.maturities[ok], data.market_iv[ok])


def _pool_surfaces(surfaces: list[MarketData]) -> MarketData:
    """Concatenate per-regime surfaces into one pooled calibration target."""
    s0 = surfaces[0]
    return MarketData(
        spot=s0.spot, rate=s0.rate, div_yield=s0.div_yield,
        strikes=np.concatenate([s.strikes for s in surfaces]),
        maturities=np.concatenate([s.maturities for s in surfaces]),
        market_iv=np.concatenate([s.market_iv for s in surfaces]),
    )


def _mae_iv(params: HestonParams, data: MarketData, config: dict) -> float:
    """Mean absolute implied-vol error of ``params`` on ``data``."""
    model_iv = heston_implied_vols(params, data, n_nodes=_n_nodes(config))
    return float(np.nanmean(np.abs(model_iv - data.market_iv)))

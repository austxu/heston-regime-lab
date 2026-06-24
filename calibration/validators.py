"""Synthetic-data validation of the Heston pricing + calibration stack.

Before trusting calibration on noisy market data we must prove the machinery is
*self-consistent*: if we generate option implied vols from known ("ground truth")
Heston parameters and then calibrate back, we must recover those parameters.  This
module generates a synthetic vol surface from a chosen ``HestonParams`` and runs the
round trip, asserting recovery to within a relative tolerance (1% by default).

A clean round trip rules out sign errors, branch-cut bugs, discounting mistakes and
optimiser-conditioning problems all at once, and is the gate Phase 1 must pass before
any real data is touched.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from calibration.optimizer import (
    PARAM_NAMES,
    CalibrationResult,
    MarketData,
    calibrate,
    heston_implied_vols,
    load_config,
)
from models.heston import HestonParams

CONFIG_PATH = Path(__file__).resolve().parents[1] / "configs" / "base.yaml"


def generate_synthetic_data(
    true_params: HestonParams,
    config: dict,
    seed: int | None = 0,
) -> MarketData:
    """Generate a synthetic implied-vol surface from known Heston parameters.

    For every (maturity, strike) on the configured grid we Heston-price the option
    and invert to a Black-Scholes implied vol, optionally adding Gaussian noise of
    standard deviation ``synthetic.noise_iv`` to mimic quote noise.

    Returns
    -------
    MarketData
        The synthetic quotes, ready to be fed straight into :func:`calibrate`.
    """
    mkt = config["market"]
    syn = config["synthetic"]
    quad = config.get("quadrature", {})
    spot = float(mkt["spot"])
    rate = float(mkt["risk_free_rate"])
    div_yield = float(mkt["dividend_yield"])

    pct = np.asarray(syn["strikes_pct_of_spot"], dtype=float)
    mats = np.asarray(syn["maturities_years"], dtype=float)

    # Full grid: every strike at every maturity.
    strikes = np.repeat(spot * pct, len(mats))
    maturities = np.tile(mats, len(pct))

    scaffold = MarketData(
        spot=spot, rate=rate, div_yield=div_yield,
        strikes=strikes, maturities=maturities,
        market_iv=np.zeros_like(strikes),  # filled below
    )
    true_iv = heston_implied_vols(
        true_params, scaffold,
        n_nodes=int(quad.get("n_nodes", 128)),
        upper_limit=float(quad.get("upper_limit", 200.0)),
    )

    noise = float(syn.get("noise_iv", 0.0))
    if noise > 0.0:
        rng = np.random.default_rng(seed)
        true_iv = true_iv + rng.normal(0.0, noise, size=true_iv.shape)

    scaffold.market_iv = true_iv
    return scaffold


@dataclass
class RoundTripResult:
    """Per-parameter recovery diagnostics for a synthetic round trip."""

    true_params: HestonParams
    calibration: CalibrationResult
    relative_errors: dict          # name -> |recovered - true| / |true|
    max_relative_error: float
    passed: bool
    tolerance: float


def round_trip_validation(
    config: dict | None = None,
    true_params: HestonParams | None = None,
    tolerance: float = 0.01,
) -> RoundTripResult:
    """Generate synthetic data from ground-truth params and calibrate them back.

    Parameters
    ----------
    config : dict, optional
        Parsed config; defaults to ``configs/base.yaml``.
    true_params : HestonParams, optional
        Ground truth; defaults to ``synthetic.params`` in the config.
    tolerance : float
        Maximum allowed per-parameter relative error (default 1%).

    Returns
    -------
    RoundTripResult
        Recovery diagnostics, including a ``passed`` flag.
    """
    if config is None:
        config = load_config(CONFIG_PATH)
    if true_params is None:
        sp = config["synthetic"]["params"]
        true_params = HestonParams(**{k: float(sp[k]) for k in PARAM_NAMES})

    data = generate_synthetic_data(true_params, config)
    result = calibrate(data, config)

    rel = {}
    for name in PARAM_NAMES:
        truth = getattr(true_params, name)
        recovered = getattr(result.params, name)
        rel[name] = abs(recovered - truth) / abs(truth)
    max_rel = max(rel.values())

    return RoundTripResult(
        true_params=true_params,
        calibration=result,
        relative_errors=rel,
        max_relative_error=max_rel,
        passed=max_rel <= tolerance,
        tolerance=tolerance,
    )


def _main() -> None:
    """Run the round trip and print a readable report (``python -m calibration.validators``)."""
    config = load_config(CONFIG_PATH)
    res = round_trip_validation(config)
    cal = res.calibration

    print("=" * 64)
    print("Heston synthetic round-trip calibration")
    print("=" * 64)
    print(f"converged: {cal.success}  ({cal.message})")
    print(f"L-BFGS-B iterations: {cal.n_iter}   objective evals: {cal.n_feval}")
    print(f"in-sample IV RMSE: {cal.rmse_iv:.2e}   mean|IV err|: {cal.mean_abs_iv_error:.2e}")
    print("-" * 64)
    print(f"{'param':>6} | {'true':>10} | {'recovered':>10} | {'rel.err':>9}")
    print("-" * 64)
    for name in PARAM_NAMES:
        truth = getattr(res.true_params, name)
        rec = getattr(cal.params, name)
        print(f"{name:>6} | {truth:>10.5f} | {rec:>10.5f} | {res.relative_errors[name]:>8.3%}")
    print("-" * 64)
    print(f"max relative error: {res.max_relative_error:.3%}  (tolerance {res.tolerance:.1%})")
    print("PASS" if res.passed else "FAIL")


if __name__ == "__main__":
    _main()

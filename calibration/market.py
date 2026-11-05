"""Calibrate Heston, Bates and double Heston to a real, forward-normalised option snapshot.

Quotes are stored per expiry in forward units (see :mod:`models.fourier`): log-moneyness
k = ln(K / F_T) and the Black implied vols of the bid, mid and ask.  The objective is the
plain sum of squared mid-IV residuals, with the parameters mapped onto the unit box like
:mod:`calibration.optimizer`, solved with scipy's bounded trust-region least squares.

This is the offline reference for the browser's Levenberg-Marquardt fit of the same
quotes (``frontend/src/math/market.ts``).
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np
from scipy.optimize import least_squares

from models.bates import BatesParams, bates_characteristic_function
from models.double_heston import double_heston_characteristic_function
from models.fourier import CharFn, Quad, model_implied_vols, slice_nodes
from models.heston import HestonParams, heston_characteristic_function


@dataclass(frozen=True)
class Slice:
    """One expiry of the snapshot in forward units."""

    tau: float
    k: np.ndarray
    iv: np.ndarray
    iv_bid: np.ndarray
    iv_ask: np.ndarray
    atm_vol: float

    @property
    def quad(self) -> Quad:
        return slice_nodes(self.atm_vol, self.tau)


@dataclass(frozen=True)
class ModelSpec:
    names: tuple[str, ...]
    bounds: tuple[tuple[float, float], ...]
    cf: Callable[[np.ndarray, float], CharFn]


def _heston_cf(p: np.ndarray, tau: float) -> CharFn:
    hp = HestonParams.from_array(p)
    return lambda u: heston_characteristic_function(u, hp, 1.0, 0.0, 0.0, tau)


def _bates_cf(p: np.ndarray, tau: float) -> CharFn:
    bp = BatesParams(*(float(x) for x in p))
    return lambda u: bates_characteristic_function(u, bp, 1.0, 0.0, 0.0, tau)


def _double_cf(p: np.ndarray, tau: float) -> CharFn:
    f1 = HestonParams.from_array(p[:5])
    f2 = HestonParams.from_array(p[5:])
    return lambda u: double_heston_characteristic_function(u, f1, f2, 1.0, 0.0, 0.0, tau)


# Wider than configs/base.yaml (kappa <= 15, sigma <= 2), which is sized for the synthetic
# surfaces: fits to real SPX smiles that include one-week expiries push vol-of-vol and
# mean reversion well past those limits.
HESTON_BOUNDS = ((0.1, 50.0), (0.001, 1.0), (0.01, 8.0), (-0.999, 0.999), (0.001, 1.0))
HESTON_NAMES = ("kappa", "theta", "sigma", "rho", "v0")
MODELS: dict[str, ModelSpec] = {
    "heston": ModelSpec(HESTON_NAMES, HESTON_BOUNDS, _heston_cf),
    "bates": ModelSpec(
        HESTON_NAMES + ("lam", "mu_j", "sigma_j"),
        HESTON_BOUNDS + ((0.0, 10.0), (-0.8, 0.3), (0.005, 0.8)),
        _bates_cf,
    ),
    "double": ModelSpec(
        tuple(f"{n}{i}" for i in (1, 2) for n in HESTON_NAMES),
        HESTON_BOUNDS + HESTON_BOUNDS,
        _double_cf,
    ),
}


def model_ivs(model: str, params: np.ndarray, slices: Sequence[Slice]) -> list[np.ndarray]:
    spec = MODELS[model]
    return [
        model_implied_vols(spec.cf(np.asarray(params, float), s.tau), s.k, s.tau, s.quad)
        for s in slices
    ]


def fit_stats(model_iv: Sequence[np.ndarray], slices: Sequence[Slice]) -> dict:
    """RMSE / MAE in vol, share of quotes priced inside the bid-ask IV band, per slice too."""
    err = np.concatenate([m - s.iv for m, s in zip(model_iv, slices, strict=True)])
    inside = np.concatenate(
        [(m >= s.iv_bid) & (m <= s.iv_ask) for m, s in zip(model_iv, slices, strict=True)]
    )
    err = np.where(np.isfinite(err), err, 1.0)
    return {
        "rmse": float(np.sqrt(np.mean(err**2))),
        "mae": float(np.mean(np.abs(err))),
        "maxAbs": float(np.max(np.abs(err))),
        "inside": float(np.mean(inside)),
        "sliceRmse": [
            float(np.sqrt(np.nanmean((m - s.iv) ** 2)))
            for m, s in zip(model_iv, slices, strict=True)
        ],
    }


def calibrate_market(
    model: str,
    slices: Sequence[Slice],
    starts: Sequence[Sequence[float]],
    max_nfev: int = 400,
) -> dict:
    """Best of several bounded least-squares fits; returns params, stats, nfev, seconds."""
    spec = MODELS[model]
    lo = np.array([b[0] for b in spec.bounds])
    hi = np.array([b[1] for b in spec.bounds])
    iv = np.concatenate([s.iv for s in slices])

    def resid(z: np.ndarray) -> np.ndarray:
        r = np.concatenate(model_ivs(model, lo + z * (hi - lo), slices)) - iv
        return np.where(np.isfinite(r), r, 10.0)

    t0 = time.perf_counter()
    best = None
    best_start: Sequence[float] = starts[0]
    nfev = 0
    for x0 in starts:
        z0 = np.clip((np.asarray(x0, float) - lo) / (hi - lo), 1e-6, 1 - 1e-6)
        sol = least_squares(
            resid, z0, bounds=(0.0, 1.0), method="trf", x_scale=1.0, max_nfev=max_nfev
        )
        nfev += int(sol.nfev)
        if best is None or sol.cost < best.cost:
            best = sol
            best_start = x0
    assert best is not None
    params = lo + best.x * (hi - lo)
    stats = fit_stats(model_ivs(model, params, slices), slices)
    return {
        "params": dict(zip(spec.names, (float(p) for p in params), strict=True)),
        **stats,
        "start": [float(x) for x in best_start],
        "nfev": nfev,
        "seconds": time.perf_counter() - t0,
    }

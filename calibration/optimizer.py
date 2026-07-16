"""Nonlinear least-squares calibration of Heston parameters to implied vols.

Calibration solves the inverse problem: given a set of market option implied
volatilities sigma_iv(K_i, tau_i), find the Heston parameters
p = (kappa, theta, sigma, rho, v0) that best reproduce them in the least-squares
sense,

    p* = argmin_p  sum_i w_i ( IV_model(p; K_i, tau_i) - IV_market(K_i, tau_i) )^2.

IV_model is obtained by Heston-pricing each option and inverting the price back to a
Black-Scholes implied vol, so the objective lives entirely in vol space (the natural
space for option quotes).  The minimisation uses scipy's L-BFGS-B — a quasi-Newton
method with simple box constraints, which lets us keep every parameter inside an
economically sensible range.

Two numerical conditioning choices matter:

* **Parameter scaling.**  The raw parameters span very different magnitudes
  (kappa ~ O(1), theta ~ O(0.01), rho ~ O(1)).  L-BFGS-B's finite-difference
  gradients and Hessian approximation behave far better on commensurate variables,
  so we optimise a normalised vector z in [0, 1] obtained by mapping each parameter
  affinely from its [lower, upper] box, and map back inside the objective.

* **OTM inversion.**  Implied vol is recovered from the out-of-the-money leg (puts
  below the forward, calls above) where time value — and hence vega — is largest,
  which keeps the Brent inversion well-conditioned.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping

import numpy as np
import yaml
from scipy.optimize import minimize

from models.black_scholes import implied_vol
from models.heston import HestonParams, heston_price

# Canonical parameter order used everywhere in this module.
PARAM_NAMES = ("kappa", "theta", "sigma", "rho", "v0")


@dataclass
class CalibrationProgress:
    """One L-BFGS-B iteration snapshot, emitted to a calibration ``callback``.

    Used by the WebSocket streamer to render a live convergence chart: the iteration
    number, the current objective (sum of squared IV residuals) and the current
    parameter estimates.
    """

    iteration: int
    loss: float
    params: dict  # {kappa, theta, sigma, rho, v0}


def load_config(path: str | Path) -> dict:
    """Load a YAML configuration file into a plain dict."""
    with Path(path).open("r", encoding="utf-8") as fh:
        config = yaml.safe_load(fh)
    if not isinstance(config, dict):
        raise ValueError(f"configuration root must be a mapping, got {type(config).__name__}")
    return config


@dataclass
class MarketData:
    """A set of option implied-volatility quotes against one underlying.

    Strikes, maturities and implied vols are parallel arrays of equal length; one
    entry per quoted option.  This is the calibration target (synthetic in Phase 1).
    """

    spot: float
    rate: float
    div_yield: float
    strikes: np.ndarray
    maturities: np.ndarray
    market_iv: np.ndarray
    weights: np.ndarray | None = None

    def __post_init__(self) -> None:
        scalars = {"spot": self.spot, "rate": self.rate, "div_yield": self.div_yield}
        for name, value in scalars.items():
            if not np.isfinite(value):
                raise ValueError(f"{name} must be finite, got {value!r}")
        if self.spot <= 0.0:
            raise ValueError(f"spot must be > 0, got {self.spot}")

        self.strikes = np.array(self.strikes, dtype=float, copy=True)
        self.maturities = np.array(self.maturities, dtype=float, copy=True)
        self.market_iv = np.array(self.market_iv, dtype=float, copy=True)
        arrays = {
            "strikes": self.strikes,
            "maturities": self.maturities,
            "market_iv": self.market_iv,
        }
        for name, values in arrays.items():
            if values.ndim != 1:
                raise ValueError(f"{name} must be one-dimensional, got shape {values.shape}")

        n = self.strikes.size
        if not (self.maturities.size == self.market_iv.size == n):
            raise ValueError("strikes, maturities, market_iv must have equal length")
        if n == 0:
            raise ValueError("market data must contain at least one option quote")
        if not np.all(np.isfinite(self.strikes)) or np.any(self.strikes <= 0.0):
            raise ValueError("strikes must all be finite and > 0")
        if not np.all(np.isfinite(self.maturities)) or np.any(self.maturities <= 0.0):
            raise ValueError("maturities must all be finite and > 0")
        if not np.all(np.isfinite(self.market_iv)) or np.any(self.market_iv <= 0.0):
            raise ValueError("market_iv must all be finite and > 0")

        if self.weights is None:
            self.weights = np.ones(n, dtype=float)
        else:
            self.weights = np.array(self.weights, dtype=float, copy=True)
            if self.weights.ndim != 1 or self.weights.size != n:
                raise ValueError("weights must be one-dimensional and match the quote count")
            if not np.all(np.isfinite(self.weights)) or np.any(self.weights < 0.0):
                raise ValueError("weights must all be finite and >= 0")
            if not np.any(self.weights > 0.0):
                raise ValueError("at least one weight must be > 0")

    def __len__(self) -> int:
        return len(self.strikes)


@dataclass
class CalibrationResult:
    """Outcome of a calibration run."""

    params: HestonParams
    success: bool
    rmse_iv: float  # root-mean-square implied-vol error
    mean_abs_iv_error: float  # mean absolute implied-vol error
    n_iter: int
    n_feval: int
    message: str
    model_iv: np.ndarray = field(repr=False, default=None)


def _iv_from_heston_call(
    call_price: float,
    spot: float,
    strike: float,
    rate: float,
    div_yield: float,
    tau: float,
    forward: float,
    iv_bounds: tuple[float, float],
    xtol: float,
) -> float:
    """Convert a Heston *call* price to implied vol via the out-of-the-money leg.

    The implied vol of a call and its parity-linked put are identical; inverting the
    OTM leg (put for K < forward, call otherwise) maximises vega and stabilises the
    Brent root-find.
    """
    lo, hi = iv_bounds
    if strike >= forward:
        return implied_vol(call_price, spot, strike, rate, div_yield, tau, "call", lo, hi, xtol)
    put_price = call_price - spot * np.exp(-div_yield * tau) + strike * np.exp(-rate * tau)
    return implied_vol(put_price, spot, strike, rate, div_yield, tau, "put", lo, hi, xtol)


def heston_implied_vols(
    params: HestonParams,
    data: MarketData,
    n_nodes: int = 128,
    upper_limit: float = 200.0,
    iv_bounds: tuple[float, float] = (1e-4, 5.0),
    iv_xtol: float = 1e-12,
) -> np.ndarray:
    """Model-implied vols for every quote in ``data`` under ``params``.

    Options are grouped by maturity so the characteristic function is evaluated once
    per maturity and reused across all strikes (the Heston pricing hot path).

    Returns
    -------
    np.ndarray
        Model implied vols aligned with ``data.strikes`` (``nan`` where the price is
        not invertible).
    """
    model_iv = np.full(len(data), np.nan)
    for tau in np.unique(data.maturities):
        mask = data.maturities == tau
        strikes = data.strikes[mask]
        forward = data.spot * np.exp((data.rate - data.div_yield) * tau)
        call_prices = heston_price(
            params,
            data.spot,
            strikes,
            data.rate,
            data.div_yield,
            tau,
            "call",
            n_nodes=n_nodes,
            upper_limit=upper_limit,
        )
        ivs = np.array(
            [
                _iv_from_heston_call(
                    float(cp),
                    data.spot,
                    float(k),
                    data.rate,
                    data.div_yield,
                    float(tau),
                    forward,
                    iv_bounds,
                    iv_xtol,
                )
                for cp, k in zip(np.atleast_1d(call_prices), strikes)
            ]
        )
        model_iv[mask] = ivs
    return model_iv


def _normalise(p: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    """Map raw parameters in [lo, hi] to a normalised vector in [0, 1]."""
    return (p - lo) / (hi - lo)


def _denormalise(z: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    """Inverse of :func:`_normalise`: map z in [0, 1] back to raw parameters."""
    return lo + z * (hi - lo)


def calibrate(
    data: MarketData,
    config: dict,
    initial_guess: HestonParams | None = None,
    callback: Callable[[CalibrationProgress], None] | None = None,
) -> CalibrationResult:
    """Calibrate Heston parameters to ``data`` by L-BFGS-B least squares on IV error.

    Parameters
    ----------
    data : MarketData
        The implied-vol quotes to fit.
    config : dict
        Parsed configuration (see ``configs/base.yaml``); the ``calibration`` and
        ``quadrature`` sections drive bounds, the initial guess, the Feller penalty
        and quadrature resolution.
    initial_guess : HestonParams, optional
        Overrides the initial guess from ``config``.
    callback : callable, optional
        Invoked once per accepted L-BFGS-B iteration with a
        :class:`CalibrationProgress` (iteration, loss, params).  Used by the WebSocket
        streamer to push live convergence updates.  When ``None`` the optimisation is
        untouched.

    Returns
    -------
    CalibrationResult
        Fitted parameters plus convergence diagnostics and IV error metrics.
    """
    if not isinstance(config, Mapping):
        raise TypeError("config must be a mapping")
    cal = config["calibration"]
    quad = config.get("quadrature", {})
    iv_cfg = config.get("implied_vol", {})
    n_nodes = int(quad.get("n_nodes", 128))
    upper_limit = float(quad.get("upper_limit", 200.0))
    iv_bounds = (float(iv_cfg.get("lower", 1e-4)), float(iv_cfg.get("upper", 5.0)))
    iv_xtol = float(iv_cfg.get("xtol", 1e-12))
    feller_w = float(cal.get("feller_penalty", 0.0))

    lo = np.array([cal["bounds"][name][0] for name in PARAM_NAMES], dtype=float)
    hi = np.array([cal["bounds"][name][1] for name in PARAM_NAMES], dtype=float)
    if not np.all(np.isfinite(lo)) or not np.all(np.isfinite(hi)) or np.any(lo >= hi):
        raise ValueError("every calibration bound must be finite with lower < upper")
    # Every point in the optimiser box must be constructible as HestonParams.
    if np.any(lo[[0, 1, 2, 4]] <= 0.0) or lo[3] <= -1.0 or hi[3] >= 1.0:
        raise ValueError("Heston bounds require positive kappa/theta/sigma/v0 and -1 < rho < 1")

    if initial_guess is None:
        ig = cal["initial_guess"]
        p0 = np.array([ig[name] for name in PARAM_NAMES])
    else:
        p0 = initial_guess.to_array()
    z0 = _normalise(np.clip(p0, lo, hi), lo, hi)

    w = data.weights
    counter = {"feval": 0}
    last_evaluation: dict[str, np.ndarray | float | None] = {"z": None, "loss": None}

    def objective(z: np.ndarray, *, count: bool = True) -> float:
        z = np.asarray(z, dtype=float)
        if count:
            counter["feval"] += 1
        cached_z = last_evaluation["z"]
        if isinstance(cached_z, np.ndarray) and np.array_equal(z, cached_z):
            return float(last_evaluation["loss"])
        params = HestonParams.from_array(_denormalise(z, lo, hi))
        model_iv = heston_implied_vols(
            params,
            data,
            n_nodes=n_nodes,
            upper_limit=upper_limit,
            iv_bounds=iv_bounds,
            iv_xtol=iv_xtol,
        )
        resid = model_iv - data.market_iv
        # A non-invertible quote (nan) is penalised heavily rather than dropped.
        resid = np.where(np.isfinite(resid), resid, 10.0)
        loss = float(np.sum(w * resid**2))
        if feller_w > 0.0:  # soft penalty on Feller violation 2*kappa*theta > sigma^2
            viol = max(0.0, params.sigma**2 - 2.0 * params.kappa * params.theta)
            loss += feller_w * viol**2
        last_evaluation["z"] = z.copy()
        last_evaluation["loss"] = loss
        return loss

    iter_counter = {"it": 0}

    def _on_step(zk: np.ndarray) -> None:
        # scipy passes the current normalised parameter vector each accepted iteration.
        iter_counter["it"] += 1
        p = HestonParams.from_array(_denormalise(np.asarray(zk), lo, hi))
        callback(
            CalibrationProgress(
                iteration=iter_counter["it"],
                loss=objective(np.asarray(zk), count=False),
                params={name: getattr(p, name) for name in PARAM_NAMES},
            )
        )

    result = minimize(
        objective,
        z0,
        method="L-BFGS-B",
        bounds=[(0.0, 1.0)] * len(PARAM_NAMES),
        options={
            "maxiter": int(cal.get("maxiter", 500)),
            "ftol": float(cal.get("tol", 1e-10)),
            "gtol": 1e-12,
        },
        callback=_on_step if callback is not None else None,
    )

    params = HestonParams.from_array(_denormalise(result.x, lo, hi))
    model_iv = heston_implied_vols(
        params,
        data,
        n_nodes=n_nodes,
        upper_limit=upper_limit,
        iv_bounds=iv_bounds,
        iv_xtol=iv_xtol,
    )
    err = model_iv - data.market_iv
    finite = np.isfinite(err)
    metric_err = np.where(finite, err, 10.0)
    success = bool(result.success) and bool(np.all(finite))
    message = str(result.message)
    if not np.all(finite):
        message = f"{message}; {int((~finite).sum())} final model IVs were not invertible"
    return CalibrationResult(
        params=params,
        success=success,
        rmse_iv=float(np.sqrt(np.mean(metric_err**2))),
        mean_abs_iv_error=float(np.mean(np.abs(metric_err))),
        n_iter=int(result.nit),
        n_feval=counter["feval"],
        message=message,
        model_iv=model_iv,
    )

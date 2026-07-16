"""Synthetic-data test suite for the Heston mathematical core (Phase 1).

These tests are the correctness gate for the pricing + calibration stack.  They run
entirely on synthetic/analytic data (no network, no market feeds) and cover:

* HestonParams validation and array round-trips,
* the characteristic function's martingale property,
* Gil-Pelaez / Gauss-Legendre pricing vs an independent adaptive-quadrature value,
* put-call parity (Heston and Black-Scholes),
* Black-Scholes <-> implied-vol inversion,
* the Heston -> Black-Scholes zero-vol-of-vol limit,
* end-to-end round-trip calibration recovering ground-truth parameters within 1%.
"""

from __future__ import annotations

import numpy as np
import pytest
from scipy import integrate

from calibration.optimizer import load_config
from calibration.validators import CONFIG_PATH, round_trip_validation
from models.black_scholes import bs_price, bs_vega, implied_vol
from models.heston import (
    HestonParams,
    heston_characteristic_function,
    heston_price,
)

# A reference parameter set / market used across several tests.
PARAMS = HestonParams(kappa=2.0, theta=0.04, sigma=0.5, rho=-0.7, v0=0.04)
SPOT, RATE, DIV = 100.0, 0.03, 0.0


# --------------------------------------------------------------------------- #
# HestonParams
# --------------------------------------------------------------------------- #
def test_params_array_roundtrip():
    arr = PARAMS.to_array()
    assert np.allclose(HestonParams.from_array(arr).to_array(), arr)


@pytest.mark.parametrize(
    "kwargs",
    [
        dict(kappa=-1, theta=0.04, sigma=0.5, rho=-0.7, v0=0.04),
        dict(kappa=2, theta=-0.04, sigma=0.5, rho=-0.7, v0=0.04),
        dict(kappa=2, theta=0.04, sigma=0.5, rho=-1.5, v0=0.04),
        dict(kappa=2, theta=0.04, sigma=0.5, rho=-0.7, v0=0.0),
    ],
)
def test_params_validation_rejects_bad_values(kwargs):
    with pytest.raises(ValueError):
        HestonParams(**kwargs)


def test_feller_flag():
    # 2*2*0.04 = 0.16 > 0.5^2 = 0.25 ? No -> Feller violated here.
    assert PARAMS.feller is False
    assert HestonParams(3.0, 0.04, 0.2, -0.5, 0.04).feller is True


# --------------------------------------------------------------------------- #
# Characteristic function
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("tau", [0.25, 1.0, 5.0, 15.0])
def test_characteristic_function_martingale(tau):
    """phi(-i) = E[S_T] = forward.  Evaluated as a limit to dodge the 0/0 point."""
    phi = heston_characteristic_function(-1j + 1e-7, PARAMS, SPOT, RATE, DIV, tau)
    forward = SPOT * np.exp((RATE - DIV) * tau)
    assert abs(phi - forward) / forward < 1e-4


@pytest.mark.parametrize("tau", [0.5, 5.0, 15.0])
def test_characteristic_function_finite_and_bounded(tau):
    """|phi(u)| <= forward for real u; finite even at long maturity (trap form)."""
    u = np.linspace(1e-3, 200.0, 5000)
    phi = heston_characteristic_function(u, PARAMS, SPOT, RATE, DIV, tau)
    assert np.all(np.isfinite(phi))
    forward = SPOT * np.exp((RATE - DIV) * tau)
    assert np.max(np.abs(phi)) <= forward * (1.0 + 1e-9)


def test_phi_zero_is_one_limit():
    phi = heston_characteristic_function(1e-8, PARAMS, SPOT, RATE, DIV, 1.0)
    assert abs(phi - 1.0) < 1e-6


# --------------------------------------------------------------------------- #
# Gil-Pelaez / Gauss-Legendre pricing
# --------------------------------------------------------------------------- #
def _reference_call(params, spot, strike, rate, div, tau):
    """Independent call price via adaptive quadrature on the Gil-Pelaez integrals."""
    forward = spot * np.exp((rate - div) * tau)

    def integ(u, shift):
        cf = heston_characteristic_function(u - shift, params, spot, rate, div, tau)
        denom = 1j * u * (forward if shift else 1.0)
        return (np.exp(-1j * u * np.log(strike)) * cf / denom).real

    p1 = 0.5 + integrate.quad(integ, 0, 500, args=(1j,), limit=400)[0] / np.pi
    p2 = 0.5 + integrate.quad(integ, 0, 500, args=(0,), limit=400)[0] / np.pi
    return spot * np.exp(-div * tau) * p1 - strike * np.exp(-rate * tau) * p2


@pytest.mark.parametrize("strike", [80.0, 100.0, 120.0])
@pytest.mark.parametrize("tau", [0.25, 1.0, 3.0])
def test_pricing_matches_adaptive_quadrature(strike, tau):
    px = heston_price(PARAMS, SPOT, strike, RATE, DIV, tau, "call", n_nodes=128)
    ref = _reference_call(PARAMS, SPOT, strike, RATE, DIV, tau)
    # 1e-7 is the shared truncation floor of the two quadratures; far-OTM,
    # short-dated integrands decay slowest and set the worst case (~1e-8 here).
    assert abs(px - ref) < 1e-7


def test_quadrature_convergence():
    """More nodes -> monotone approach to the converged price."""
    ref = heston_price(PARAMS, SPOT, 100.0, RATE, DIV, 1.0, "call", n_nodes=256)
    errs = [
        abs(heston_price(PARAMS, SPOT, 100.0, RATE, DIV, 1.0, "call", n_nodes=n) - ref)
        for n in (16, 32, 64)
    ]
    assert errs[0] > errs[1] > errs[2]
    assert errs[2] < 1e-7


def test_heston_put_call_parity():
    for strike in (80.0, 100.0, 120.0):
        c = heston_price(PARAMS, SPOT, strike, RATE, DIV, 1.0, "call")
        p = heston_price(PARAMS, SPOT, strike, RATE, DIV, 1.0, "put")
        expected = SPOT * np.exp(-DIV * 1.0) - strike * np.exp(-RATE * 1.0)
        assert abs((c - p) - expected) < 1e-10


def test_price_vectorised_matches_scalar():
    strikes = np.array([80.0, 90.0, 100.0, 110.0, 120.0])
    vec = heston_price(PARAMS, SPOT, strikes, RATE, DIV, 1.0, "call")
    scalar = [heston_price(PARAMS, SPOT, float(k), RATE, DIV, 1.0, "call") for k in strikes]
    assert np.allclose(vec, scalar)


# --------------------------------------------------------------------------- #
# Black-Scholes & implied vol
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("option_type", ["call", "put"])
@pytest.mark.parametrize("sigma", [0.1, 0.25, 0.6])
@pytest.mark.parametrize("strike", [70.0, 100.0, 130.0])
def test_bs_implied_vol_roundtrip(option_type, sigma, strike):
    px = bs_price(SPOT, strike, RATE, DIV, 0.75, sigma, option_type)
    iv = implied_vol(px, SPOT, strike, RATE, DIV, 0.75, option_type)
    assert abs(iv - sigma) < 1e-8


def test_bs_put_call_parity():
    c = bs_price(SPOT, 100.0, RATE, DIV, 0.75, 0.25, "call")
    p = bs_price(SPOT, 100.0, RATE, DIV, 0.75, 0.25, "put")
    assert abs((c - p) - (SPOT * np.exp(-DIV * 0.75) - 100.0 * np.exp(-RATE * 0.75))) < 1e-10


def test_bs_vega_matches_finite_difference():
    h = 1e-5
    fd = (
        bs_price(SPOT, 100.0, RATE, DIV, 0.75, 0.25 + h, "call")
        - bs_price(SPOT, 100.0, RATE, DIV, 0.75, 0.25 - h, "call")
    ) / (2 * h)
    assert abs(bs_vega(SPOT, 100.0, RATE, DIV, 0.75, 0.25) - fd) < 1e-4


def test_implied_vol_returns_nan_when_unbracketed():
    # Price below intrinsic is not invertible.
    assert np.isnan(implied_vol(-1.0, SPOT, 100.0, RATE, DIV, 0.75, "call"))


def test_heston_reduces_to_black_scholes_limit():
    """sigma->0 with v0=theta makes variance deterministic: Heston == BS(sqrt(v0))."""
    v0 = 0.04
    params = HestonParams(2.0, v0, 1e-6, -0.3, v0)
    for strike in (80.0, 100.0, 120.0):
        h = heston_price(
            params, SPOT, strike, RATE, DIV, 0.75, "call", n_nodes=256, upper_limit=300.0
        )
        b = bs_price(SPOT, strike, RATE, DIV, 0.75, np.sqrt(v0), "call")
        assert abs(h - b) / b < 1e-3


# --------------------------------------------------------------------------- #
# End-to-end round-trip calibration
# --------------------------------------------------------------------------- #
def test_round_trip_recovers_ground_truth_within_1pct():
    config = load_config(CONFIG_PATH)
    res = round_trip_validation(config, tolerance=0.01)
    assert res.calibration.success
    assert res.passed, f"max rel err {res.max_relative_error:.3%}: {res.relative_errors}"
    assert res.calibration.rmse_iv < 1e-4

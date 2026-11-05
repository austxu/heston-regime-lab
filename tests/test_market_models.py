"""Real-market models: Lewis pricing, Bates, double Heston, SVI, densities, Cboe parsing."""

from __future__ import annotations

from datetime import datetime, timezone
from math import factorial

import numpy as np
import pytest
from scipy.stats import norm

from calibration.market import Slice, calibrate_market, model_ivs
from data import cboe
from models.bates import BatesParams, bates_characteristic_function
from models.double_heston import double_heston_characteristic_function
from models.fourier import (
    black_otm,
    density_nodes,
    implied_vol_otm,
    lewis_call,
    log_density,
    otm_price,
    slice_nodes,
)
from models.heston import HestonParams, heston_characteristic_function, heston_price
from models.svi import fit_svi, svi_density, svi_g, svi_w

BASE = HestonParams(kappa=2.0, theta=0.04, sigma=0.5, rho=-0.7, v0=0.04)
STRESS = HestonParams(kappa=12.0, theta=0.05, sigma=3.5, rho=-0.8, v0=0.09)
FAST = HestonParams(kappa=8.0, theta=0.03, sigma=1.5, rho=-0.8, v0=0.05)


def heston_cf(p: HestonParams, tau: float):
    return lambda u: heston_characteristic_function(u, p, 1.0, 0.0, 0.0, tau)


def black_call(k: np.ndarray, vol: float | np.ndarray, tau: float) -> np.ndarray:
    sd = vol * np.sqrt(tau)
    d1 = -k / sd + 0.5 * sd
    return norm.cdf(d1) - np.exp(k) * norm.cdf(d1 - sd)


@pytest.mark.parametrize("params", [BASE, STRESS])
@pytest.mark.parametrize("tau", [0.03, 0.25, 1.0, 2.0])
def test_lewis_matches_gil_pelaez(params: HestonParams, tau: float) -> None:
    """Two independent Fourier formulas for the same Heston call agree."""
    k = np.linspace(-0.4, 0.2, 13) * np.sqrt(tau)
    lewis = lewis_call(heston_cf(params, tau), k, slice_nodes(0.2, tau))
    gp = heston_price(
        params, 1.0, np.exp(k), 0.0, 0.0, tau, "call", n_nodes=1024, upper_limit=3000.0
    )
    np.testing.assert_allclose(lewis, gp, atol=1e-8)


def test_bates_without_jumps_is_heston() -> None:
    u = np.array([0.3, 2.0, 15.0]) - 0.5j
    b = BatesParams(2.0, 0.04, 0.5, -0.7, 0.04, 0.0, -0.1, 0.1)
    np.testing.assert_allclose(
        bates_characteristic_function(u, b, 1.0, 0.0, 0.0, 0.7), heston_cf(BASE, 0.7)(u), rtol=1e-14
    )


def test_bates_constant_vol_is_merton() -> None:
    """With a frozen variance, Bates is Merton's jump diffusion: a Poisson mix of Blacks."""
    lam, mu, sj, v, tau = 0.8, -0.15, 0.2, 0.04, 0.5
    b = BatesParams(2.0, v, 1e-3, 0.0, v, lam, mu, sj)
    k = np.array([-0.3, -0.1, 0.0, 0.1])
    price = lewis_call(
        lambda u: bates_characteristic_function(u, b, 1.0, 0.0, 0.0, tau), k, slice_nodes(0.2, tau)
    )
    kbar = np.exp(mu + 0.5 * sj**2) - 1.0
    merton = np.zeros_like(k)
    for n in range(40):
        fn = np.exp(n * (mu + 0.5 * sj**2) - lam * kbar * tau)
        vol_n = np.sqrt(v + n * sj**2 / tau)
        weight = np.exp(-lam * tau) * (lam * tau) ** n / factorial(n)
        merton += weight * fn * black_call(k - np.log(fn), vol_n, tau)
    np.testing.assert_allclose(price, merton, atol=1e-8)


def test_double_heston_frozen_factors_is_black() -> None:
    """Two frozen variance factors add up to one Black variance."""
    f1 = HestonParams(2.0, 0.03, 1e-3, 0.0, 0.03)
    f2 = HestonParams(1.0, 0.01, 1e-3, 0.0, 0.01)
    tau = 0.8
    k = np.linspace(-0.3, 0.2, 6)
    price = lewis_call(
        lambda u: double_heston_characteristic_function(u, f1, f2, 1.0, 0.0, 0.0, tau),
        k,
        slice_nodes(0.2, tau),
    )
    np.testing.assert_allclose(price, black_call(k, 0.2, tau), atol=1e-7)


@pytest.mark.parametrize(
    "cf",
    [
        heston_cf(BASE, 0.5),
        lambda u: bates_characteristic_function(
            u, BatesParams(2.0, 0.04, 0.5, -0.7, 0.04, 0.6, -0.1, 0.12), 1, 0, 0, 0.5
        ),
        lambda u: double_heston_characteristic_function(u, FAST, BASE, 1.0, 0.0, 0.0, 0.5),
    ],
)
def test_models_are_martingales_with_unit_density(cf) -> None:
    np.testing.assert_allclose(cf(np.array([-1j])), 1.0, atol=1e-13)
    x = np.linspace(-2.5, 1.5, 4001)
    q = log_density(cf, x, density_nodes(0.15, 0.5))
    dx = x[1] - x[0]
    assert abs(q.sum() * dx - 1.0) < 1e-5
    assert abs((q * np.exp(x)).sum() * dx - 1.0) < 1e-5


def test_density_of_black_is_normal() -> None:
    vol, tau = 0.25, 0.4
    x = np.linspace(-0.6, 0.4, 11)
    q = log_density(
        lambda u: np.exp(-0.5j * u * vol**2 * tau - 0.5 * u**2 * vol**2 * tau),
        x,
        density_nodes(vol, tau),
    )
    np.testing.assert_allclose(q, norm.pdf(x, -0.5 * vol**2 * tau, vol * np.sqrt(tau)), atol=1e-10)


def test_implied_vol_round_trip() -> None:
    k = np.linspace(-0.5, 0.3, 17)
    vol = 0.12 + 0.3 * k**2 - 0.2 * k
    tau = 0.3
    np.testing.assert_allclose(implied_vol_otm(black_otm(k, vol, tau), k, tau), vol, atol=1e-12)
    assert np.isnan(implied_vol_otm(np.array([0.0, -1.0]), np.array([0.1, 0.1]), tau)).all()


def test_otm_price_uses_put_below_forward() -> None:
    tau = 0.5
    cf = lambda u: np.exp(-0.5j * u * 0.04 * tau - 0.5 * u**2 * 0.04 * tau)  # noqa: E731
    k = np.array([-0.2, 0.1])
    np.testing.assert_allclose(
        otm_price(cf, k, slice_nodes(0.2, tau)), black_otm(k, 0.2, tau), atol=1e-11
    )


SVI_TRUE = np.array([0.01, 0.12, -0.6, 0.02, 0.15])


def test_svi_density_is_breeden_litzenberger() -> None:
    """Gatheral's g-based density equals d^2 C / dK^2 of the SVI call prices."""
    tau = 0.5
    k = np.linspace(-0.6, 0.4, 2001)
    vol = np.sqrt(svi_w(k, SVI_TRUE) / tau)
    strike = np.exp(k)
    call = black_call(k, vol, tau)
    d2c = np.gradient(np.gradient(call, strike), strike)  # density of F_T at K
    q = svi_density(k, SVI_TRUE) / strike  # density of x mapped to density of F_T
    inner = slice(10, -10)
    np.testing.assert_allclose(d2c[inner], q[inner], atol=2e-4 * q.max())
    assert svi_g(k, SVI_TRUE).min() > 0


def test_svi_fit_recovers_parameters() -> None:
    tau = 0.25
    k = np.linspace(-0.35, 0.15, 21)
    iv = np.sqrt(svi_w(k, SVI_TRUE) / tau)
    p, rmse = fit_svi(k, iv, tau)
    assert rmse < 1e-6
    np.testing.assert_allclose(np.sqrt(svi_w(k, p) / tau), iv, atol=1e-6)


def test_svi_fit_respects_lee_wing_bound() -> None:
    """A smile that wants a right wing steeper than Lee's bound is held at slope 2."""
    tau = 0.04
    k = np.linspace(-0.15, 0.09, 21)
    steep = np.array([-0.02, 2.6, 0.975, 0.227, 0.037])  # b (1 + rho) ~ 5.1
    iv = np.sqrt(svi_w(k, steep) / tau)
    p, _ = fit_svi(k, iv, tau)
    assert p[1] * (1 + p[2]) <= 2 + 1e-3 and p[1] * (1 - p[2]) <= 2 + 1e-3


# ----------------------------------------------------------------- Cboe snapshot


def _fake_chain(
    forward: float, discount: float, vol: float, as_of: str, expiry: str, root: str
) -> dict:
    """A tiny chain priced with Black, flat vol, symmetric half-spread."""
    tau = cboe.year_fraction(
        datetime.strptime(as_of, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc), expiry, root
    )
    opts = []
    yymmdd = expiry[2:4] + expiry[5:7] + expiry[8:10]
    for strike in np.arange(0.7, 1.3001, 0.01) * forward:
        strike = round(float(strike) / 5) * 5
        k = np.log(strike / forward)
        call = discount * forward * float(black_call(np.array([k]), vol, tau)[0])
        put = call - discount * (forward - strike)
        for right, px in (("C", call), ("P", put)):
            half = max(0.05, 0.01 * px)
            opts.append(
                {
                    "option": f"{root}{yymmdd}{right}{int(strike * 1000):08d}",
                    "bid": max(px - half, 0.0),
                    "ask": px + half,
                    "open_interest": 100.0,
                }
            )
    return {"timestamp": as_of, "data": {"current_price": forward * 0.99, "options": opts}}


def test_parse_and_settlement() -> None:
    chain = _fake_chain(5000.0, 0.99, 0.2, "2026-01-05 21:30:00", "2026-03-20", "SPX")
    as_of, spot, contracts = cboe.parse_chain(chain)
    assert as_of.tzinfo is not None and spot == pytest.approx(4950.0)
    assert {c.root for c in contracts} == {"SPX"} and {c.right for c in contracts} == {"C", "P"}
    am = cboe.settlement("2026-03-20", "SPX")
    pm = cboe.settlement("2026-03-20", "SPXW")
    assert (pm - am).total_seconds() == 6.5 * 3600


def test_build_slice_recovers_forward_discount_and_vol() -> None:
    chain = _fake_chain(5000.0, 0.985, 0.2, "2026-01-05 21:30:00", "2026-07-17", "SPX")
    as_of, spot, contracts = cboe.parse_chain(chain)
    tau = cboe.year_fraction(as_of, "2026-07-17", "SPX")
    s = cboe.build_slice(contracts, "2026-07-17", "SPX", tau, spot, None)
    assert s is not None
    assert s.forward == pytest.approx(5000.0, rel=1e-6)
    assert s.discount == pytest.approx(0.985, rel=1e-6)
    np.testing.assert_allclose(s.iv, 0.2, atol=1e-6)
    assert np.all(s.iv_bid <= s.iv) and np.all(s.iv <= s.iv_ask)
    assert np.all(np.diff(s.k) > 0) and len(s.k) <= cboe.N_STRIKES


def test_market_calibration_round_trip() -> None:
    taus = [0.08, 0.5, 1.5]
    true = np.array([3.0, 0.05, 0.9, -0.75, 0.06])
    slices = []
    for tau in taus:
        k = np.linspace(-2.5, 1.5, 9) * 0.22 * np.sqrt(tau)
        s = Slice(tau, k, np.zeros_like(k), np.zeros_like(k), np.zeros_like(k), 0.22)
        iv = model_ivs("heston", true, [s])[0]
        slices.append(Slice(tau, k, iv, iv - 0.001, iv + 0.001, 0.22))
    fit = calibrate_market("heston", slices, [[1.0, 0.06, 0.3, -0.4, 0.05]])
    assert fit["rmse"] < 1e-6
    np.testing.assert_allclose(list(fit["params"].values()), true, rtol=1e-3)
    assert fit["inside"] == 1.0

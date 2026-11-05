"""Forward-normalised Fourier pricing and risk-neutral densities for any affine model.

Real option chains come with a different forward F_T and discount factor D_T per expiry.
Working in *forward units* removes both: with x_T = ln(F_T / F_0) the undiscounted call
price per unit forward is C(k) = E[(e^{x_T} - e^k)^+], k = ln(K / F_0), and the
Black-Scholes implied vol of C(k) equals the market's (Black-76) implied vol.

Every model here is described by the characteristic function phi(u) = E[e^{i u x_T}] of
the forward log-return, a callable on complex arrays.  On top of it:

* :func:`lewis_call` prices calls with the Lewis (2001) single-integral formula

      C(k) = 1 - (e^{k/2} / pi) * int_0^inf Re[e^{-i u k} phi(u - i/2)] / (u^2 + 1/4) du,

  whose integrand decays like phi / u^2 (faster and better conditioned than the two
  Gil-Pelaez integrals in :mod:`models.heston`, which it is tested against).
* :func:`log_density` inverts phi to the risk-neutral density of x_T,

      q(x) = (1 / pi) * int_0^inf Re[e^{-i u x} phi(u)] du,

  the Fourier-side equivalent of Breeden-Litzenberger's d^2 C / dK^2.

Quadrature (:func:`slice_nodes`): three Gauss-Legendre panels on [0, 2], [2, 12 / a] and
[12 / a, 60 / a] with 24, 96 and 64 nodes, where a = vol_atm sqrt(tau) is the *market*
ATM standard deviation of the expiry (fixed per slice, so the calibration objective stays
smooth in the parameters).  The first panel resolves the 1 / (u^2 + 1/4) kernel near
u = 0; the last one covers the slow, exponential (not Gaussian) decay of phi at the large
vol-of-vol values real short-dated SPX smiles call for.  Against a 4,000-node reference
on [0, 8000] this rule reprices the fitted SPX surfaces to ~1e-11 in implied vol.
Densities are evaluated further from the money (|x| up to ~8 a), where e^{-iux} oscillates
faster, so :func:`density_nodes` splits [2, 60 / a] into 14 panels of 48 nodes instead.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np
from scipy.special import ndtr

CharFn = Callable[[np.ndarray], np.ndarray]
Quad = tuple[np.ndarray, np.ndarray]

PANEL_NODES = (24, 96, 64)


def _panels(edges: np.ndarray, counts: list[int]) -> Quad:
    nodes, weights = [], []
    for lo, hi, n in zip(edges[:-1], edges[1:], counts, strict=True):
        t, w = np.polynomial.legendre.leggauss(n)
        nodes.append(lo + 0.5 * (hi - lo) * (t + 1.0))
        weights.append(0.5 * (hi - lo) * w)
    return np.concatenate(nodes), np.concatenate(weights)


def slice_nodes(atm_vol: float, tau: float) -> Quad:
    """Composite Gauss-Legendre nodes and weights for pricing one expiry."""
    a = atm_vol * np.sqrt(tau)
    return _panels(np.array([0.0, 2.0, 12.0 / a, 60.0 / a]), list(PANEL_NODES))


def density_nodes(atm_vol: float, tau: float) -> Quad:
    """Finer composite rule for densities far from the money."""
    a = atm_vol * np.sqrt(tau)
    return _panels(np.concatenate([[0.0], np.linspace(2.0, 60.0 / a, 15)]), [24] + [48] * 14)


def lewis_call(cf: CharFn, k: np.ndarray, quad: Quad) -> np.ndarray:
    """Undiscounted call price per unit forward at log-moneyness ``k`` (Lewis 2001)."""
    nodes, weights = quad
    phi = cf(nodes - 0.5j)
    k = np.atleast_1d(np.asarray(k, dtype=float))
    integrand = (np.exp(-1j * nodes[None, :] * k[:, None]) * phi[None, :]).real
    integral = (integrand * (weights / (nodes**2 + 0.25))[None, :]).sum(axis=1)
    return 1.0 - np.exp(0.5 * k) * integral / np.pi


def otm_price(cf: CharFn, k: np.ndarray, quad: Quad) -> np.ndarray:
    """Out-of-the-money price per unit forward: the put below the forward, else the call."""
    k = np.atleast_1d(np.asarray(k, dtype=float))
    call = lewis_call(cf, k, quad)
    return np.where(k < 0.0, call - 1.0 + np.exp(k), call)


def log_density(cf: CharFn, x: np.ndarray, quad: Quad) -> np.ndarray:
    """Risk-neutral density of x_T = ln(F_T / F_0) at the points ``x``."""
    nodes, weights = quad
    phi = cf(nodes + 0.0j)
    x = np.atleast_1d(np.asarray(x, dtype=float))
    integrand = (np.exp(-1j * nodes[None, :] * x[:, None]) * phi[None, :]).real
    return (integrand * weights[None, :]).sum(axis=1) / np.pi


def black_otm(k: np.ndarray, vol: np.ndarray, tau: float) -> np.ndarray:
    """Black-76 OTM price per unit forward (undiscounted) at log-moneyness ``k``."""
    k = np.asarray(k, dtype=float)
    sd = np.asarray(vol, dtype=float) * np.sqrt(tau)
    with np.errstate(divide="ignore", invalid="ignore"):
        d1 = -k / sd + 0.5 * sd
    d2 = d1 - sd
    call = ndtr(d1) - np.exp(k) * ndtr(d2)
    put = np.exp(k) * ndtr(-d2) - ndtr(-d1)
    return np.where(k < 0.0, put, call)


def implied_vol_otm(
    price: np.ndarray,
    k: np.ndarray,
    tau: float,
    lower: float = 1e-4,
    upper: float = 5.0,
    iterations: int = 100,
) -> np.ndarray:
    """Vectorised Black implied vol of OTM prices per unit forward (bisection).

    The OTM price is strictly increasing in vol, so bisection on [lower, upper] always
    converges; 100 halvings reach machine precision.  Prices outside the bracket
    (non-positive, or above the vol = ``upper`` price) return NaN.
    """
    price = np.asarray(price, dtype=float)
    k = np.broadcast_to(np.asarray(k, dtype=float), price.shape)
    lo = np.full(price.shape, lower)
    hi = np.full(price.shape, upper)
    ok = np.isfinite(price) & (price > black_otm(k, lo, tau)) & (price < black_otm(k, hi, tau))
    for _ in range(iterations):
        mid = 0.5 * (lo + hi)
        above = black_otm(k, mid, tau) > price
        hi = np.where(above, mid, hi)
        lo = np.where(above, lo, mid)
    return np.where(ok, 0.5 * (lo + hi), np.nan)


def model_implied_vols(cf: CharFn, k: np.ndarray, tau: float, quad: Quad) -> np.ndarray:
    """Model implied vols at log-moneyness ``k`` for one expiry."""
    return implied_vol_otm(otm_price(cf, k, quad), k, tau)

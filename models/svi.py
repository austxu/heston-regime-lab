"""Raw SVI smile parameterisation (Gatheral 2004) with arbitrage diagnostics.

Per expiry, total implied variance w(k) = sigma_BS(k)^2 tau is modelled as

    w(k) = a + b [ rho (k - m) + sqrt((k - m)^2 + s^2) ]

(s is Gatheral's sigma, renamed to avoid a clash with Heston's vol of vol).  SVI is a
*smoothing* parameterisation, not a model of the price process: five parameters per
expiry, fitted slice by slice.  It is the usual industry baseline for how well a smooth
curve can match the quotes, and it gives a twice-differentiable smile for the density.

Butterfly arbitrage is absent on a slice iff the implied density is non-negative, i.e.
iff (Gatheral & Jacquier 2014)

    g(k) = (1 - k w' / (2 w))^2 - (w'^2 / 4) (1 / w + 1 / 4) + w'' / 2  >=  0,

and the risk-neutral density of x = ln(F_T / F_0) is then

    q(k) = g(k) / sqrt(2 pi w) * exp(-d_-(k)^2 / 2),   d_- = -k / sqrt(w) - sqrt(w) / 2.
"""

from __future__ import annotations

import numpy as np
from scipy.optimize import least_squares

SVI_NAMES = ("a", "b", "rho", "m", "s")


def svi_w(k: np.ndarray, p: np.ndarray) -> np.ndarray:
    a, b, rho, m, s = p
    d = np.asarray(k, dtype=float) - m
    return a + b * (rho * d + np.sqrt(d * d + s * s))


def svi_derivatives(k: np.ndarray, p: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """w, w' and w'' at ``k``."""
    a, b, rho, m, s = p
    d = np.asarray(k, dtype=float) - m
    r = np.sqrt(d * d + s * s)
    return a + b * (rho * d + r), b * (rho + d / r), b * s * s / r**3


def svi_g(k: np.ndarray, p: np.ndarray) -> np.ndarray:
    """Gatheral's g(k); negative values flag butterfly arbitrage."""
    k = np.asarray(k, dtype=float)
    w, w1, w2 = svi_derivatives(k, p)
    return (1.0 - k * w1 / (2.0 * w)) ** 2 - 0.25 * w1 * w1 * (1.0 / w + 0.25) + 0.5 * w2


def svi_density(k: np.ndarray, p: np.ndarray) -> np.ndarray:
    """Risk-neutral density of x_T = ln(F_T / F_0) implied by the slice."""
    k = np.asarray(k, dtype=float)
    w = svi_w(k, p)
    sw = np.sqrt(w)
    dm = -k / sw - 0.5 * sw
    return svi_g(k, p) / np.sqrt(2.0 * np.pi * w) * np.exp(-0.5 * dm * dm)


def _inner_fit(k: np.ndarray, w: np.ndarray, m: float, s: float) -> np.ndarray:
    """Quasi-explicit step (Zeliade 2009): for fixed (m, s), w = a + d y + c sqrt(y^2 + 1)
    with y = (k - m) / s is linear in (a, d, c).  Solve it, then map back to raw SVI with
    b = c / s and rho = d / c clipped to |rho| < 1."""
    y = (k - m) / s
    A = np.stack([np.ones_like(y), y, np.sqrt(y * y + 1.0)], axis=1)
    (a, d, c), *_ = np.linalg.lstsq(A, w, rcond=None)
    c = max(c, 1e-8)
    rho = float(np.clip(d / c, -0.999, 0.999))
    return np.array([a, c / s, rho, m, s])


def fit_svi(
    k: np.ndarray, iv: np.ndarray, tau: float, check: tuple[float, float] | None = None
) -> tuple[np.ndarray, float]:
    """Arbitrage-aware SVI fit of one slice; returns (params, rmse_iv).

    A grid over (m, s) with the linear inner solve gives a robust start; a bounded
    least-squares polish in implied-vol space then minimises the same objective as the
    models.  Unconstrained raw SVI fits to short-dated SPX smiles put a sharp vertex just
    beyond the last quoted call and extrapolate a wing steeper than any arbitrage-free
    smile allows, so the extrapolated density is not a density.  Hence:

    * the vertex m stays inside the quoted strikes, b >= 0, |rho| < 1, s > 0;
    * penalties keep the minimum total variance a + b s sqrt(1 - rho^2) >= 0 and both wing
      slopes b (1 +- rho) within Roger Lee's moment bound of 2;
    * a penalty keeps Gatheral's g(k) >= 0 (no butterfly arbitrage) on ``check``, the
      log-moneyness range where the density is used (default: quotes padded by their span).
    """
    k = np.asarray(k, dtype=float)
    iv = np.asarray(iv, dtype=float)
    w_mkt = iv * iv * tau
    span = float(k.max() - k.min())
    lo_k, hi_k = check if check is not None else (k.min() - span, k.max() + span)
    k_check = np.linspace(lo_k, hi_k, 321)

    def resid(p: np.ndarray) -> np.ndarray:
        model = np.sqrt(np.maximum(svi_w(k, p), 1e-12) / tau)
        floor = p[0] + p[1] * p[4] * np.sqrt(1.0 - p[2] ** 2)
        wings = (2.0 - p[1] * (1.0 + p[2]), 2.0 - p[1] * (1.0 - p[2]))
        penalties = [10.0 * min(floor, 0.0), *(10.0 * min(x, 0.0) for x in wings)]
        return np.concatenate([model - iv, penalties, np.minimum(svi_g(k_check, p), 0.0)])

    starts = []
    for m in np.linspace(k.min(), k.max(), 15):
        for s in span * np.geomspace(0.01, 1.0, 12):
            p = _inner_fit(k, w_mkt, float(m), float(s))
            starts.append((float(np.sum(resid(p) ** 2)), p))
    starts.sort(key=lambda t: t[0])

    lo = np.array([-1.0, 0.0, -0.999, k.min(), 1e-4])
    hi = np.array([1.0, 50.0, 0.999, k.max(), 4.0 * span])
    best: tuple[np.ndarray, float] | None = None
    for _, p0 in starts[:4]:
        sol = least_squares(
            resid, np.clip(p0, lo + 1e-9, hi - 1e-9), bounds=(lo, hi), method="trf", x_scale="jac"
        )
        rmse = float(np.sqrt(np.mean(sol.fun[: len(k)] ** 2)))
        if best is None or rmse < best[1]:
            best = (sol.x, rmse)
    assert best is not None
    return best

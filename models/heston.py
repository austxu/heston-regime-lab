"""Heston (1993) stochastic-volatility model: the characteristic function.

The Heston model describes a risk-neutral asset price S_t and its instantaneous
*variance* v_t by the coupled SDEs

    dS_t = (r - q) S_t dt + sqrt(v_t) S_t dW_t^S
    dv_t = kappa (theta - v_t) dt + sigma sqrt(v_t) dW_t^v
    d<W^S, W^v>_t = rho dt

with parameters
    kappa  > 0   speed of mean reversion of the variance,
    theta  > 0   long-run variance level,
    sigma  > 0   volatility of variance ("vol of vol"),
    rho in (-1,1) correlation between the two Brownian motions,
    v0     > 0   initial variance.

The model is analytically tractable because the characteristic function of the
log-price x_T = ln S_T is known in closed form.  Writing phi(u) = E[exp(i u x_T)],
Heston showed that

    phi(u; tau) = exp( C(u, tau) + D(u, tau) v0 + i u (ln S0 + (r - q) tau) )

where, with the shorthand  xi = kappa - rho sigma i u,

    d  = sqrt( (rho sigma i u - kappa)^2 + sigma^2 (i u + u^2) )
    g  = (xi + d) / (xi - d)
    C  = (kappa theta / sigma^2) [ (xi + d) tau - 2 ln((1 - g e^{d tau}) / (1 - g)) ]
    D  = ((xi + d) / sigma^2) (1 - e^{d tau}) / (1 - g e^{d tau})

This module implements that characteristic function.  Pricing by Fourier inversion
is added on top of it in the same file as the project grows.

Reference: S. L. Heston, "A Closed-Form Solution for Options with Stochastic
Volatility...", Review of Financial Studies 6(2), 1993.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class HestonParams:
    """The five Heston parameters, with light validation and array conversions.

    Attributes
    ----------
    kappa : float  mean-reversion speed of the variance process (> 0).
    theta : float  long-run variance level (> 0).
    sigma : float  volatility of variance, "vol of vol" (> 0).
    rho   : float  correlation between price and variance shocks, in (-1, 1).
    v0    : float  initial instantaneous variance (> 0).
    """

    kappa: float
    theta: float
    sigma: float
    rho: float
    v0: float

    def __post_init__(self) -> None:
        if self.kappa <= 0:
            raise ValueError(f"kappa must be > 0, got {self.kappa}")
        if self.theta <= 0:
            raise ValueError(f"theta must be > 0, got {self.theta}")
        if self.sigma <= 0:
            raise ValueError(f"sigma must be > 0, got {self.sigma}")
        if not -1.0 < self.rho < 1.0:
            raise ValueError(f"rho must be in (-1, 1), got {self.rho}")
        if self.v0 <= 0:
            raise ValueError(f"v0 must be > 0, got {self.v0}")

    @property
    def feller(self) -> bool:
        """True iff the Feller condition 2 kappa theta > sigma^2 holds.

        When Feller holds the variance process stays strictly positive; otherwise
        v_t can touch zero.  The pricing formula remains valid either way, but the
        condition is a useful diagnostic during calibration.
        """
        return 2.0 * self.kappa * self.theta > self.sigma**2

    def to_array(self) -> np.ndarray:
        """Return the parameters as a numpy array [kappa, theta, sigma, rho, v0]."""
        return np.array([self.kappa, self.theta, self.sigma, self.rho, self.v0])

    @classmethod
    def from_array(cls, arr: np.ndarray) -> "HestonParams":
        """Build a ``HestonParams`` from an array [kappa, theta, sigma, rho, v0]."""
        kappa, theta, sigma, rho, v0 = (float(x) for x in arr)
        return cls(kappa=kappa, theta=theta, sigma=sigma, rho=rho, v0=v0)


def heston_characteristic_function(
    u: np.ndarray | complex,
    params: HestonParams,
    spot: float,
    rate: float,
    div_yield: float,
    tau: float,
) -> np.ndarray:
    """Characteristic function phi(u) = E[exp(i u ln S_T)] of the Heston log-price.

    Uses the original Heston (1993) parameterisation (the "g1" branch).  This is
    correct, but the complex logarithm in ``C`` can cross a branch cut for long
    maturities; a numerically stabilised version is introduced later.

    Parameters
    ----------
    u : complex or array of complex
        Fourier argument(s).  Accepts a numpy array for vectorised evaluation at
        many quadrature nodes at once.
    params : HestonParams
        The five Heston parameters.
    spot : float
        Current asset price S0.
    rate : float
        Continuously-compounded risk-free rate r (annualised).
    div_yield : float
        Continuously-compounded dividend yield q (annualised).
    tau : float
        Time to maturity in years.

    Returns
    -------
    np.ndarray
        phi(u) evaluated elementwise, as complex128.

    Notes
    -----
    With xi = kappa - rho sigma i u and
        d = sqrt( (rho sigma i u - kappa)^2 + sigma^2 (i u + u^2) ),
        g = (xi + d) / (xi - d),
    the exponent is C + D v0 + i u (ln S0 + (r - q) tau), where
        C = (kappa theta / sigma^2)[(xi + d) tau - 2 ln((1 - g e^{d tau})/(1 - g))],
        D = ((xi + d) / sigma^2)(1 - e^{d tau})/(1 - g e^{d tau}).
    """
    u = np.asarray(u, dtype=np.complex128)

    kappa, theta, sigma, rho, v0 = (
        params.kappa,
        params.theta,
        params.sigma,
        params.rho,
        params.v0,
    )

    iu = 1j * u
    xi = kappa - rho * sigma * iu
    d = np.sqrt((rho * sigma * iu - kappa) ** 2 + sigma**2 * (iu + u**2))

    g = (xi + d) / (xi - d)
    exp_dt = np.exp(d * tau)

    # C and D (Heston's A/B up to constants), original g1 branch.
    C = (kappa * theta / sigma**2) * (
        (xi + d) * tau - 2.0 * np.log((1.0 - g * exp_dt) / (1.0 - g))
    )
    D = (xi + d) / sigma**2 * (1.0 - exp_dt) / (1.0 - g * exp_dt)

    drift = iu * (np.log(spot) + (rate - div_yield) * tau)
    return np.exp(C + D * v0 + drift)

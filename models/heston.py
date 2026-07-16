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

import functools
from dataclasses import dataclass
from numbers import Integral

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
        for name in ("kappa", "theta", "sigma", "rho", "v0"):
            value = getattr(self, name)
            if not np.isfinite(value):
                raise ValueError(f"{name} must be finite, got {value!r}")
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
        values = np.asarray(arr, dtype=float).reshape(-1)
        if values.size != 5:
            raise ValueError(f"expected exactly 5 Heston parameters, got {values.size}")
        kappa, theta, sigma, rho, v0 = (float(x) for x in values)
        return cls(kappa=kappa, theta=theta, sigma=sigma, rho=rho, v0=v0)


def _validate_market_inputs(
    spot: float,
    rate: float,
    div_yield: float,
    tau: float,
) -> None:
    values = {"spot": spot, "rate": rate, "div_yield": div_yield, "tau": tau}
    for name, value in values.items():
        if not np.isfinite(value):
            raise ValueError(f"{name} must be finite, got {value!r}")
    if spot <= 0.0:
        raise ValueError(f"spot must be > 0, got {spot}")
    if tau < 0.0:
        raise ValueError(f"tau must be >= 0, got {tau}")


def heston_characteristic_function(
    u: np.ndarray | complex,
    params: HestonParams,
    spot: float,
    rate: float,
    div_yield: float,
    tau: float,
) -> np.ndarray:
    """Characteristic function phi(u) = E[exp(i u ln S_T)] of the Heston log-price.

    Uses the numerically stable "little Heston trap" parameterisation (Albrecher,
    Mayer, Schoutens & Tistaert, 2007).  The original Heston (1993) form is written
    with  g1 = (xi + d)/(xi - d)  and the factor  e^{+d tau}; because Re(d) > 0 that
    grows without bound and *overflows* for long maturities, and the complex
    logarithm of (1 - g1 e^{d tau}) crosses a branch cut, corrupting the integral.
    The trap rewrites it with  g2 = 1/g1 = (xi - d)/(xi + d)  and  e^{-d tau}, which
    decays to 0, so (1 - g2 e^{-d tau}) stays near 1 on the principal branch.  The
    two forms are analytically identical; only the trap is numerically safe.

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
        d  = sqrt( (rho sigma i u - kappa)^2 + sigma^2 (i u + u^2) ),
        g2 = (xi - d) / (xi + d),
    the exponent is C + D v0 + i u (ln S0 + (r - q) tau), where
        C = (kappa theta / sigma^2)[(xi - d) tau - 2 ln((1 - g2 e^{-d tau})/(1 - g2))],
        D = ((xi - d) / sigma^2)(1 - e^{-d tau})/(1 - g2 e^{-d tau}).
    """
    _validate_market_inputs(spot, rate, div_yield, tau)
    u = np.asarray(u, dtype=np.complex128)
    if not np.all(np.isfinite(u)):
        raise ValueError("Fourier arguments must all be finite")
    if tau == 0.0:
        return np.exp(1j * u * np.log(spot))

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

    # "Little trap": g2 = (xi - d)/(xi + d) paired with the decaying e^{-d tau}.
    g2 = (xi - d) / (xi + d)
    exp_dt = np.exp(-d * tau)

    C = (kappa * theta / sigma**2) * (
        (xi - d) * tau - 2.0 * np.log((1.0 - g2 * exp_dt) / (1.0 - g2))
    )
    D = (xi - d) / sigma**2 * (1.0 - exp_dt) / (1.0 - g2 * exp_dt)

    drift = iu * (np.log(spot) + (rate - div_yield) * tau)
    return np.exp(C + D * v0 + drift)


# --------------------------------------------------------------------------- #
# Gil-Pelaez Fourier inversion via Gauss-Legendre quadrature                   #
# --------------------------------------------------------------------------- #
#
# Gil-Pelaez (1951) inverts a characteristic function into the survival
# probability without ever forming the density:
#
#     P(X > a) = 1/2 + (1/pi) integral_0^inf Re[ e^{-i u a} phi(u) / (i u) ] du.
#
# A European call paying (S_T - K)^+ has the Heston price
#
#     Call = S0 e^{-q tau} P1 - K e^{-r tau} P2,
#
# where P2 = Q(S_T > K) is the risk-neutral exercise probability and P1 is the
# same probability under the stock-as-numeraire ("delta") measure.  With
# phi(u) = E[e^{i u ln S_T}] and forward F = phi(-i) = S0 e^{(r-q) tau},
#
#     P2 = 1/2 + (1/pi) integral_0^inf Re[ e^{-i u ln K} phi(u)      / (i u) ] du,
#     P1 = 1/2 + (1/pi) integral_0^inf Re[ e^{-i u ln K} phi(u - i)  / (i u F) ] du.
#
# The semi-infinite integral is truncated at an upper limit U and evaluated with
# Gauss-Legendre quadrature.  Legendre nodes are strictly interior to the
# interval, so the removable 1/(i u) singularity at u = 0 is never sampled.


@functools.lru_cache(maxsize=16)
def _gauss_legendre_nodes(n_nodes: int, upper_limit: float) -> tuple[np.ndarray, np.ndarray]:
    """Gauss-Legendre nodes and weights mapped from [-1, 1] onto (0, U).

    ``numpy.polynomial.legendre.leggauss`` returns ``n`` nodes/weights for the
    canonical interval [-1, 1].  The affine map  u = (U/2)(t + 1)  carries them
    onto (0, U) with the Jacobian (U/2) folded into the weights.  Cached because
    the nodes depend only on (n_nodes, U), not on any model parameters.

    Returns
    -------
    (nodes, weights) : tuple of np.ndarray
        ``nodes`` in (0, U); ``weights`` already include the (U/2) Jacobian.
    """
    t, w = np.polynomial.legendre.leggauss(n_nodes)
    nodes = 0.5 * upper_limit * (t + 1.0)
    weights = 0.5 * upper_limit * w
    # Cached arrays must not be mutable by callers, or one accidental write would
    # corrupt every subsequent price using the same quadrature configuration.
    nodes.setflags(write=False)
    weights.setflags(write=False)
    return nodes, weights


def heston_price(
    params: HestonParams,
    spot: float,
    strike: float | np.ndarray,
    rate: float,
    div_yield: float,
    tau: float,
    option_type: str = "call",
    n_nodes: int = 128,
    upper_limit: float = 200.0,
) -> float | np.ndarray:
    """Price a European option under Heston by Gil-Pelaez Fourier inversion.

    The characteristic function for a given maturity is independent of the strike,
    so when ``strike`` is an array we evaluate phi(u) and phi(u - i) once at the
    quadrature nodes and reuse them across all strikes (only the e^{-i u ln K}
    factor changes).  This is the hot path during calibration.

    Parameters
    ----------
    params : HestonParams
        The five Heston parameters.
    spot : float
        Current asset price S0.
    strike : float or array of float
        Strike(s) K.  A scalar returns a float; an array returns an array.
    rate, div_yield : float
        Continuously-compounded rate r and dividend yield q.
    tau : float
        Time to maturity in years.
    option_type : {"call", "put"}
        "put" is obtained from the call by put-call parity.
    n_nodes : int
        Number of Gauss-Legendre nodes.
    upper_limit : float
        Truncation U of the Fourier integral.

    Returns
    -------
    float or np.ndarray
        Option price(s), matching the shape of ``strike``.
    """
    if option_type not in {"call", "put"}:
        raise ValueError(f"option_type must be 'call' or 'put', got {option_type!r}")
    _validate_market_inputs(spot, rate, div_yield, tau)
    if isinstance(n_nodes, bool) or not isinstance(n_nodes, Integral) or n_nodes < 2:
        raise ValueError(f"n_nodes must be an integer >= 2, got {n_nodes!r}")
    n_nodes = int(n_nodes)
    if not np.isfinite(upper_limit) or upper_limit <= 0.0:
        raise ValueError(f"upper_limit must be finite and > 0, got {upper_limit!r}")

    strike_array = np.asarray(strike, dtype=float)
    scalar_input = strike_array.ndim == 0
    original_shape = strike_array.shape
    strikes = np.atleast_1d(strike_array).reshape(-1)
    if strikes.size == 0:
        return np.empty(original_shape, dtype=float)
    if not np.all(np.isfinite(strikes)) or np.any(strikes <= 0.0):
        raise ValueError("all strikes must be finite and > 0")

    if tau == 0.0:
        if option_type == "call":
            price = np.maximum(spot - strikes, 0.0)
        else:
            price = np.maximum(strikes - spot, 0.0)
        return float(price[0]) if scalar_input else price.reshape(original_shape)

    nodes, weights = _gauss_legendre_nodes(n_nodes, float(upper_limit))

    # Characteristic function at u (for P2) and at u - i (for P1), evaluated once.
    phi_u = heston_characteristic_function(nodes, params, spot, rate, div_yield, tau)
    phi_ui = heston_characteristic_function(nodes - 1j, params, spot, rate, div_yield, tau)
    forward = spot * np.exp((rate - div_yield) * tau)  # = phi(-i), closed form

    iu = 1j * nodes
    # Strike-dependent factor e^{-i u ln K}: shape (n_strikes, n_nodes).
    log_k = np.log(strikes)[:, None]
    phase = np.exp(-1j * nodes[None, :] * log_k)

    integrand_2 = (phase * phi_u[None, :] / iu[None, :]).real
    integrand_1 = (phase * phi_ui[None, :] / (iu[None, :] * forward)).real

    p2 = 0.5 + (weights[None, :] * integrand_2).sum(axis=1) / np.pi
    p1 = 0.5 + (weights[None, :] * integrand_1).sum(axis=1) / np.pi

    call = spot * np.exp(-div_yield * tau) * p1 - strikes * np.exp(-rate * tau) * p2

    disc_s = spot * np.exp(-div_yield * tau)
    disc_k = strikes * np.exp(-rate * tau)
    if option_type == "call":
        # Remove tiny quadrature violations of the model-free no-arbitrage bounds.
        price = np.clip(call, np.maximum(disc_s - disc_k, 0.0), disc_s)
    else:
        # Put-call parity: P = C - S0 e^{-q tau} + K e^{-r tau}.
        put = call - disc_s + disc_k
        price = np.clip(put, np.maximum(disc_k - disc_s, 0.0), disc_k)

    return float(price[0]) if scalar_input else price.reshape(original_shape)

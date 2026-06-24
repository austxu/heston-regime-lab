"""Black-Scholes-Merton pricing and implied-volatility inversion.

The Black-Scholes model assumes the asset follows geometric Brownian motion with a
*constant* volatility sigma:

    dS_t = (r - q) S_t dt + sigma S_t dW_t.

The closed-form price of a European call with strike K and maturity tau is

    Call = S0 e^{-q tau} N(d1) - K e^{-r tau} N(d2),
    d1   = [ ln(S0 / K) + (r - q + sigma^2 / 2) tau ] / (sigma sqrt(tau)),
    d2   = d1 - sigma sqrt(tau),

with N the standard-normal CDF.  The put follows from put-call parity.

Black-Scholes serves two roles in this project:

1. a transparent pricing *baseline* to sanity-check the Heston implementation
   (Heston with zero vol-of-vol and v0 = theta collapses to Black-Scholes), and
2. the bridge between prices and *implied volatility*.  Market data and Heston
   model prices are both quoted/compared in implied-vol space; converting a price
   to its implied vol means solving  BS(sigma) = price  for sigma.  Because the BS
   price is strictly increasing in sigma (vega > 0), the root is unique and we find
   it with Brent's method (`scipy.optimize.brentq`), a bracketing, derivative-free
   root finder with guaranteed convergence and super-linear speed.
"""

from __future__ import annotations

import numpy as np
from scipy.optimize import brentq
from scipy.stats import norm


def _d1_d2(
    spot: float,
    strike: float,
    rate: float,
    div_yield: float,
    tau: float,
    sigma: float,
) -> tuple[float, float]:
    """Return the Black-Scholes d1 and d2 terms.

    d1 = [ln(S0/K) + (r - q + sigma^2/2) tau] / (sigma sqrt(tau));  d2 = d1 - sigma sqrt(tau).
    """
    sqrt_t = np.sqrt(tau)
    d1 = (np.log(spot / strike) + (rate - div_yield + 0.5 * sigma**2) * tau) / (
        sigma * sqrt_t
    )
    d2 = d1 - sigma * sqrt_t
    return d1, d2


def bs_price(
    spot: float,
    strike: float,
    rate: float,
    div_yield: float,
    tau: float,
    sigma: float,
    option_type: str = "call",
) -> float:
    """Black-Scholes-Merton price of a European call or put.

    Parameters
    ----------
    spot : float       current asset price S0.
    strike : float     strike K.
    rate : float       continuously-compounded risk-free rate r.
    div_yield : float  continuously-compounded dividend yield q.
    tau : float        time to maturity in years.
    sigma : float      volatility (annualised).
    option_type : {"call", "put"}

    Returns
    -------
    float
        The option price.  Handles the degenerate tau <= 0 or sigma <= 0 limits by
        returning the discounted intrinsic value.
    """
    if tau <= 0.0 or sigma <= 0.0:
        forward = spot * np.exp((rate - div_yield) * tau)
        intrinsic = max(forward - strike, 0.0) if option_type == "call" else max(
            strike - forward, 0.0
        )
        return float(np.exp(-rate * tau) * intrinsic)

    d1, d2 = _d1_d2(spot, strike, rate, div_yield, tau, sigma)
    disc_s = spot * np.exp(-div_yield * tau)
    disc_k = strike * np.exp(-rate * tau)

    if option_type == "call":
        return float(disc_s * norm.cdf(d1) - disc_k * norm.cdf(d2))
    if option_type == "put":
        return float(disc_k * norm.cdf(-d2) - disc_s * norm.cdf(-d1))
    raise ValueError(f"option_type must be 'call' or 'put', got {option_type!r}")


def bs_vega(
    spot: float,
    strike: float,
    rate: float,
    div_yield: float,
    tau: float,
    sigma: float,
) -> float:
    """Black-Scholes vega: d(Price)/d(sigma) = S0 e^{-q tau} phi(d1) sqrt(tau).

    Vega is identical for calls and puts and is strictly positive, which is exactly
    why the implied-vol root is unique.  (phi here is the standard-normal pdf.)
    """
    if tau <= 0.0 or sigma <= 0.0:
        return 0.0
    d1, _ = _d1_d2(spot, strike, rate, div_yield, tau, sigma)
    return float(spot * np.exp(-div_yield * tau) * norm.pdf(d1) * np.sqrt(tau))


def implied_vol(
    price: float,
    spot: float,
    strike: float,
    rate: float,
    div_yield: float,
    tau: float,
    option_type: str = "call",
    lower: float = 1e-4,
    upper: float = 5.0,
    xtol: float = 1e-10,
) -> float:
    """Invert a European option price to its Black-Scholes implied volatility.

    Solves  bs_price(sigma) - price = 0  for sigma with Brent's method.  The BS
    price is strictly increasing in sigma, so if ``price`` lies strictly between the
    no-vol intrinsic (sigma -> 0) and the sigma = ``upper`` price, the bracket
    [lower, upper] contains exactly one root and Brent converges to it.

    Parameters
    ----------
    price : float       observed/target option price.
    spot, strike, rate, div_yield, tau : float   contract & market data.
    option_type : {"call", "put"}
    lower, upper : float   volatility search bracket.
    xtol : float           absolute tolerance on sigma.

    Returns
    -------
    float
        The implied volatility, or ``nan`` if ``price`` is outside the no-arbitrage
        range reachable on [lower, upper] (e.g. below intrinsic or above the cap).
    """
    if not np.isfinite(price) or price <= 0.0 or tau <= 0.0:
        return float("nan")

    objective = lambda s: bs_price(spot, strike, rate, div_yield, tau, s, option_type) - price

    f_lo, f_hi = objective(lower), objective(upper)
    if f_lo * f_hi > 0.0:
        # Price not bracketed: below intrinsic or above the sigma=upper cap.
        return float("nan")

    return float(brentq(objective, lower, upper, xtol=xtol))

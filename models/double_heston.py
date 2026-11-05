"""Double Heston (Christoffersen, Heston & Jacobs 2009): two independent variance factors.

    dS_t / S_t = (r - q) dt + sqrt(v1_t) dW1_t + sqrt(v2_t) dW2_t
    dvi_t      = kappa_i (theta_i - vi_t) dt + sigma_i sqrt(vi_t) dZi_t,   d<Wi, Zi> = rho_i dt

with the two (Wi, Zi) pairs independent of each other.  The characteristic function is
the product of two Heston factors, so pricing costs two Heston evaluations per node.

Why it matters for SPX: one Heston factor ties the level, slope and term structure of the
skew to a single mean-reversion speed.  A fast factor can carry the steep short-dated skew
while a slow one sets the long end, which a single factor (or Merton jumps) cannot do at
the same time.

Reference: P. Christoffersen, S. Heston & K. Jacobs, "The Shape and Term Structure of the
Index Option Smirk: Why Multifactor Stochastic Volatility Models Work So Well",
Management Science 55(12), 2009.
"""

from __future__ import annotations

import numpy as np

from models.heston import HestonParams, heston_characteristic_function


def double_heston_characteristic_function(
    u: np.ndarray | complex,
    f1: HestonParams,
    f2: HestonParams,
    spot: float,
    rate: float,
    div_yield: float,
    tau: float,
) -> np.ndarray:
    """phi(u) = E[exp(i u ln S_T)]: factor 1 carries the drift, factor 2 is driftless."""
    return heston_characteristic_function(
        u, f1, spot, rate, div_yield, tau
    ) * heston_characteristic_function(u, f2, 1.0, 0.0, 0.0, tau)

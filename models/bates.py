"""Bates (1996): Heston stochastic volatility plus Merton lognormal price jumps.

    dS_t / S_t- = (r - q - lambda kbar) dt + sqrt(v_t) dW_t^S + (e^J - 1) dN_t
    dv_t        = kappa (theta - v_t) dt + sigma sqrt(v_t) dW_t^v,   d<W^S, W^v> = rho dt

with N_t a Poisson process of intensity ``lam`` and jump sizes J ~ N(mu_j, sigma_j^2),
independent of the diffusion; kbar = E[e^J - 1] = exp(mu_j + sigma_j^2 / 2) - 1 is the
compensator that keeps the discounted price a martingale.  Jumps and diffusion are
independent, so the characteristic function factorises:

    phi_Bates(u) = phi_Heston(u) * exp(lam tau [e^{i u mu_j - sigma_j^2 u^2 / 2} - 1 - i u kbar]).

Why it matters for SPX: diffusive models make short-dated smiles flat (the skew of a pure
diffusion vanishes like sqrt(tau)), while the market's one-week skew is steep.  A jump
component produces skew that does not die out as tau -> 0.

Reference: D. S. Bates, "Jumps and Stochastic Volatility: Exchange Rate Processes Implicit
in Deutsche Mark Options", Review of Financial Studies 9(1), 1996.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from models.heston import HestonParams, heston_characteristic_function


@dataclass(frozen=True)
class BatesParams:
    """Heston's five parameters plus jump intensity, mean and std of log jump size."""

    kappa: float
    theta: float
    sigma: float
    rho: float
    v0: float
    lam: float
    mu_j: float
    sigma_j: float

    def __post_init__(self) -> None:
        HestonParams(self.kappa, self.theta, self.sigma, self.rho, self.v0)  # validates
        if not np.isfinite(self.lam) or self.lam < 0:
            raise ValueError(f"lam must be finite and >= 0, got {self.lam}")
        if not np.isfinite(self.mu_j):
            raise ValueError(f"mu_j must be finite, got {self.mu_j}")
        if not np.isfinite(self.sigma_j) or self.sigma_j < 0:
            raise ValueError(f"sigma_j must be finite and >= 0, got {self.sigma_j}")

    @property
    def heston(self) -> HestonParams:
        return HestonParams(self.kappa, self.theta, self.sigma, self.rho, self.v0)


def jump_exponent(u: np.ndarray, lam: float, mu_j: float, sigma_j: float, tau: float) -> np.ndarray:
    """lam tau [e^{i u mu_j - sigma_j^2 u^2 / 2} - 1 - i u kbar] for complex ``u``."""
    iu = 1j * np.asarray(u, dtype=np.complex128)
    kbar = np.exp(mu_j + 0.5 * sigma_j**2) - 1.0
    return lam * tau * (np.exp(iu * mu_j + 0.5 * sigma_j**2 * iu**2) - 1.0 - iu * kbar)


def bates_characteristic_function(
    u: np.ndarray | complex,
    params: BatesParams,
    spot: float,
    rate: float,
    div_yield: float,
    tau: float,
) -> np.ndarray:
    """phi(u) = E[exp(i u ln S_T)] under Bates; reduces to Heston when ``lam`` = 0."""
    phi = heston_characteristic_function(u, params.heston, spot, rate, div_yield, tau)
    return phi * np.exp(jump_exponent(u, params.lam, params.mu_j, params.sigma_j, tau))

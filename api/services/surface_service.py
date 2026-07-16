"""Surface service: market and Heston implied-vol grids for the 3D surface chart.

The liquid options form a *scattered* set of (moneyness, maturity) points; the frontend
wants a regular grid.  We:

* build a regular grid from config (``api.surface``),
* interpolate the market IVs onto it (linear, nearest-fill outside the convex hull),
* evaluate the calibrated Heston IV analytically at every grid node,

returning two aligned 2D grids ready for a Plotly ``Surface``.
"""

from __future__ import annotations

import numpy as np
from scipy.interpolate import griddata
from scipy.spatial import QhullError

from api.cache.redis_client import Cache, session_suffix
from api.services.calibration_service import _params_dict, calibrated_params_and_data
from calibration.optimizer import MarketData, heston_implied_vols


def _none_nan(grid: np.ndarray) -> list[list[float | None]]:
    """Convert a 2D float grid to nested lists with NaN -> None for clean JSON."""
    return [[None if not np.isfinite(v) else float(v) for v in row] for row in grid]


def _compute_surface(config: dict, cache: Cache, prefer_live: bool) -> dict:
    params, data, _snapshot, prov = calibrated_params_and_data(config, cache, prefer_live)

    scfg = config["api"]["surface"]
    n_k, n_t = int(scfg["n_strikes"]), int(scfg["n_maturities"])
    mny_min = float(scfg["moneyness_min"])
    mny_max = float(scfg["moneyness_max"])
    if n_k < 2 or n_t < 1 or not 0.0 < mny_min < mny_max:
        raise ValueError(
            "surface grid requires n_strikes >= 2, n_maturities >= 1, and "
            "0 < moneyness_min < moneyness_max"
        )
    moneyness = np.linspace(mny_min, mny_max, n_k)

    # Maturity grid spans the liquid maturities actually observed.
    tau_lo, tau_hi = float(data.maturities.min()), float(data.maturities.max())
    maturities = np.linspace(tau_lo, tau_hi, n_t)

    # Market IV: interpolate scattered (moneyness, maturity) -> grid.
    # The public axis and returned strikes use spot moneyness K/S, so market and
    # Heston grids must use that same coordinate convention.
    pts_mny = data.strikes / data.spot
    pts = np.column_stack([pts_mny, data.maturities])
    MNY, TAU = np.meshgrid(moneyness, maturities)
    grid_pts = np.column_stack([MNY.ravel(), TAU.ravel()])
    market_near = griddata(pts, data.market_iv, grid_pts, method="nearest", rescale=True)
    try:
        market_lin = griddata(pts, data.market_iv, grid_pts, method="linear", rescale=True)
    except (QhullError, ValueError):
        # A live chain can have only one usable maturity or otherwise collinear
        # coordinates. Nearest-neighbour interpolation remains well-defined.
        market_lin = np.full(grid_pts.shape[0], np.nan)
    market_iv = np.where(np.isfinite(market_lin), market_lin, market_near).reshape(MNY.shape)

    # Heston IV: evaluate analytically at every grid node (strike = moneyness * spot).
    heston_grid = np.full(MNY.shape, np.nan)
    for i, tau in enumerate(maturities):
        strikes = moneyness * data.spot
        row_data = MarketData(
            spot=data.spot,
            rate=data.rate,
            div_yield=data.div_yield,
            strikes=strikes,
            maturities=np.full(n_k, tau),
            market_iv=np.full(n_k, 0.2),
        )
        quad = config.get("quadrature", {})
        heston_grid[i] = heston_implied_vols(
            params,
            row_data,
            n_nodes=int(quad.get("n_nodes", 128)),
            upper_limit=float(quad.get("upper_limit", 200.0)),
        )

    return {
        "moneyness": [float(m) for m in moneyness],
        "strikes": [float(m * data.spot) for m in moneyness],
        "maturities": [float(t) for t in maturities],
        "market_iv": _none_nan(market_iv),
        "heston_iv": _none_nan(heston_grid),
        "spot": float(data.spot),
        "params": _params_dict(params),
        "provenance": {**prov, "as_of": prov["as_of"].isoformat()},
    }


def get_surface(config: dict, cache: Cache, prefer_live: bool = True) -> dict:
    """Cached implied-vol surface (market + Heston) for the surface chart."""
    from datetime import datetime

    key = f"surface:v2:{session_suffix()}:{'live' if prefer_live else 'offline'}"
    ttl = int(config["api"]["cache"]["surface_ttl"])
    res = cache.get_or_compute(key, ttl, lambda: _compute_surface(config, cache, prefer_live))
    out = dict(res.value)
    prov = dict(out["provenance"])
    upstream_stale = bool(prov.get("stale", False))
    prov["as_of"] = datetime.fromisoformat(prov["as_of"])
    prov["cached_at"] = res.cached_at
    prov["stale"] = upstream_stale or res.stale
    prov["cache_backend"] = cache.backend
    out["provenance"] = prov
    return out

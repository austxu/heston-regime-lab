"""Calibration service: fetch the live SPX surface, fit Heston, cache the result.

The heavy work (a yfinance pull plus an L-BFGS-B optimisation that prices hundreds of
options) is wrapped in the cache so repeated calls within a trading session are instant.
The surface and comparison services reuse :func:`calibrated_params_and_data` so the whole
API shares a single calibration per session.
"""

from __future__ import annotations

from api.cache.redis_client import Cache, CacheResult, session_suffix
from api.services.pipeline import build_market_data, get_snapshot
from calibration.optimizer import MarketData, calibrate
from data.fetchers import ChainSnapshot
from models.heston import HestonParams


def _calibration_key(prefer_live: bool) -> str:
    return f"calibration:{session_suffix()}:{'live' if prefer_live else 'offline'}"


def _params_dict(params: HestonParams) -> dict:
    return {
        "kappa": params.kappa, "theta": params.theta, "sigma": params.sigma,
        "rho": params.rho, "v0": params.v0, "feller": params.feller,
    }


def _compute_calibration(config: dict, cache: Cache, prefer_live: bool) -> dict:
    """Fetch the snapshot, build liquid MarketData and calibrate (the cached producer)."""
    snapshot, _ = get_snapshot(config, cache, prefer_live=prefer_live)
    data, liquidity = build_market_data(snapshot, config)
    result = calibrate(data, config)
    return {
        "params": _params_dict(result.params),
        "mean_iv_error": result.mean_abs_iv_error,
        "rmse_iv": result.rmse_iv,
        "success": result.success,
        "message": result.message,
        "n_iter": result.n_iter,
        "n_feval": result.n_feval,
        "n_options": len(data),
        "spot": snapshot.spot,
        "rate": snapshot.rate,
        "liquidity": liquidity,
        # snapshot provenance carried inside the cached value so it survives cache hits.
        "_source": snapshot.source,
        "_as_of": snapshot.as_of.isoformat(),
    }


def run_calibration(config: dict, cache: Cache, prefer_live: bool = True) -> dict:
    """Cached Heston calibration to the current SPX surface (CalibrationResponse shape)."""
    from datetime import datetime

    key = _calibration_key(prefer_live)
    ttl = int(config["api"]["cache"]["calibration_ttl"])
    res: CacheResult = cache.get_or_compute(
        key, ttl, lambda: _compute_calibration(config, cache, prefer_live)
    )
    core = res.value
    return {
        "params": core["params"],
        "mean_iv_error": core["mean_iv_error"],
        "rmse_iv": core["rmse_iv"],
        "success": core["success"],
        "message": core["message"],
        "n_iter": core["n_iter"],
        "n_feval": core["n_feval"],
        "n_options": core["n_options"],
        "spot": core["spot"],
        "rate": core["rate"],
        "liquidity": core["liquidity"],
        "provenance": {
            "source": core["_source"],
            "as_of": datetime.fromisoformat(core["_as_of"]),
            "cached_at": res.cached_at,
            "stale": res.stale,
            "cache_backend": cache.backend,
        },
    }


def calibrated_params_and_data(
    config: dict, cache: Cache, prefer_live: bool = True
) -> tuple[HestonParams, MarketData, ChainSnapshot, dict]:
    """Calibrated params + the liquid MarketData + snapshot + provenance (reused by surface/comparison)."""
    from datetime import datetime

    run = run_calibration(config, cache, prefer_live=prefer_live)
    params = HestonParams(
        kappa=run["params"]["kappa"], theta=run["params"]["theta"],
        sigma=run["params"]["sigma"], rho=run["params"]["rho"], v0=run["params"]["v0"],
    )
    snapshot, _ = get_snapshot(config, cache, prefer_live=prefer_live)
    data, _ = build_market_data(snapshot, config)
    prov = run["provenance"]
    # Ensure as_of is a datetime for downstream schema use.
    if isinstance(prov["as_of"], str):
        prov = {**prov, "as_of": datetime.fromisoformat(prov["as_of"])}
    return params, data, snapshot, prov

"""Calibration service: fetch the live SPX surface, fit Heston, cache the result.

The heavy work (a yfinance pull plus an L-BFGS-B optimisation that prices hundreds of
options) is wrapped in the cache so repeated calls within a trading session are instant.
The surface and comparison services reuse :func:`calibrated_params_and_data` so the whole
API shares a single calibration per session.
"""

from __future__ import annotations

from api.cache.redis_client import Cache, CacheResult, session_suffix
from api.services.pipeline import (
    build_market_data,
    get_snapshot,
    snapshot_from_dict,
    snapshot_to_dict,
)
from calibration.optimizer import MarketData, calibrate
from data.fetchers import ChainSnapshot
from models.heston import HestonParams


def _calibration_key(prefer_live: bool) -> str:
    return f"calibration:v2:{session_suffix()}:{'live' if prefer_live else 'offline'}"


def _params_dict(params: HestonParams) -> dict:
    return {
        "kappa": params.kappa,
        "theta": params.theta,
        "sigma": params.sigma,
        "rho": params.rho,
        "v0": params.v0,
        "feller": params.feller,
    }


def _compute_calibration(config: dict, cache: Cache, prefer_live: bool) -> dict:
    """Fetch the snapshot, build liquid MarketData and calibrate (the cached producer)."""
    snapshot, snapshot_cache = get_snapshot(config, cache, prefer_live=prefer_live)
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
        # Bind downstream surface/comparison calculations to the exact market
        # snapshot used for this fit, even if the snapshot cache refreshes later.
        "_snapshot": snapshot_to_dict(snapshot),
        # snapshot provenance carried inside the cached value so it survives cache hits.
        "_source": snapshot.source,
        "_as_of": snapshot.as_of.isoformat(),
        "_upstream_stale": snapshot_cache.stale,
    }


def _cached_calibration(config: dict, cache: Cache, prefer_live: bool) -> CacheResult:
    key = _calibration_key(prefer_live)
    ttl = int(config["api"]["cache"]["calibration_ttl"])
    return cache.get_or_compute(key, ttl, lambda: _compute_calibration(config, cache, prefer_live))


def _calibration_provenance(core: dict, res: CacheResult, cache: Cache) -> dict:
    from datetime import datetime

    return {
        "source": core["_source"],
        "as_of": datetime.fromisoformat(core["_as_of"]),
        "cached_at": res.cached_at,
        "stale": bool(core.get("_upstream_stale", False)) or res.stale,
        "cache_backend": cache.backend,
    }


def run_calibration(config: dict, cache: Cache, prefer_live: bool = True) -> dict:
    """Cached Heston calibration to the current SPX surface (CalibrationResponse shape)."""
    res = _cached_calibration(config, cache, prefer_live)
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
        "provenance": _calibration_provenance(core, res, cache),
    }


def calibrated_params_and_data(
    config: dict, cache: Cache, prefer_live: bool = True
) -> tuple[HestonParams, MarketData, ChainSnapshot, dict]:
    """Calibrated params + the liquid MarketData + snapshot + provenance (reused by surface/comparison)."""
    res = _cached_calibration(config, cache, prefer_live)
    core = res.value
    params = HestonParams(
        kappa=core["params"]["kappa"],
        theta=core["params"]["theta"],
        sigma=core["params"]["sigma"],
        rho=core["params"]["rho"],
        v0=core["params"]["v0"],
    )
    snapshot = snapshot_from_dict(core["_snapshot"])
    data, _ = build_market_data(snapshot, config)
    prov = _calibration_provenance(core, res, cache)
    return params, data, snapshot, prov

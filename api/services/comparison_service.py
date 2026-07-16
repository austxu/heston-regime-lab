"""Comparison service: Heston vs Black-Scholes vs Heston+residual, cached.

Wraps :func:`analysis.pricing_comparison.compare_pricing` for the ``/api/comparison``
endpoint and shapes its output into the response schema.
"""

from __future__ import annotations

from datetime import datetime

from analysis.pricing_comparison import compare_pricing
from api.cache.redis_client import Cache, session_suffix
from api.services.calibration_service import calibrated_params_and_data


def _compute_comparison(config: dict, cache: Cache, prefer_live: bool) -> dict:
    params, data, snapshot, prov = calibrated_params_and_data(config, cache, prefer_live)
    cmp = compare_pricing(data, params, config)

    def buckets(rows: list, key: str) -> list:
        return [
            {
                "center": float(r[key]),
                "n": int(r["n"]),
                "bs": float(r["bs"]),
                "heston": float(r["heston"]),
                "corrected": float(r["corrected"]),
            }
            for r in rows
        ]

    heston_vs_bs = 100.0 * (cmp.mae_bs - cmp.mae_heston) / cmp.mae_bs if cmp.mae_bs else 0.0
    resid_impr = (
        100.0 * (cmp.mae_heston - cmp.mae_corrected) / cmp.mae_heston if cmp.mae_heston else 0.0
    )

    return {
        "mae_bs": cmp.mae_bs,
        "mae_heston": cmp.mae_heston,
        "mae_corrected": cmp.mae_corrected,
        "heston_vs_bs_improvement_pct": float(heston_vs_bs),
        "residual_improvement_pct": float(resid_impr),
        "residual_backend": cmp.residual_backend,
        "by_moneyness": buckets(cmp.by_moneyness, "moneyness"),
        "by_maturity": buckets(cmp.by_maturity, "maturity"),
        "provenance": {**prov, "as_of": prov["as_of"].isoformat()},
    }


def get_comparison(config: dict, cache: Cache, prefer_live: bool = True) -> dict:
    """Cached BS/Heston/residual pricing-error comparison."""
    key = f"comparison:v2:{session_suffix()}:{'live' if prefer_live else 'offline'}"
    ttl = int(config["api"]["cache"]["comparison_ttl"])
    res = cache.get_or_compute(key, ttl, lambda: _compute_comparison(config, cache, prefer_live))
    out = dict(res.value)
    prov = dict(out["provenance"])
    upstream_stale = bool(prov.get("stale", False))
    prov["as_of"] = datetime.fromisoformat(prov["as_of"])
    prov["cached_at"] = res.cached_at
    prov["stale"] = upstream_stale or res.stale
    prov["cache_backend"] = cache.backend
    out["provenance"] = prov
    return out

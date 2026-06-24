"""Regime service: train the HMM once, then serve fast cached inference.

Fitting a Gaussian HMM on 20 years of features is expensive, so we do it **once** and keep
the fitted :class:`~models.hmm.RegimeModel` (plus its features/prices) in process memory.
Per-request inference is then just a forward-backward pass on already-computed features —
comfortably sub-200ms — and the JSON results are additionally cached (Redis/in-memory) so
repeat calls and other workers are instant.

The bundle is built lazily on first use and warmed at app startup (see ``api.main``).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import numpy as np
import pandas as pd

from api.cache.redis_client import Cache, session_suffix
from data.features import engineer_features, feature_matrix
from data.fetchers import get_price_history, get_vix_term_structure
from models.hmm import RegimeModel, fit_regime_hmm

# In-process singleton of the fitted model, keyed by data mode (live/offline).
_BUNDLES: dict[bool, "RegimeBundle"] = {}


@dataclass
class RegimeBundle:
    model: RegimeModel
    features: pd.DataFrame
    prices: pd.DataFrame
    source: str
    as_of: datetime


def build_regime_bundle(config: dict, prefer_live: bool = True) -> RegimeBundle:
    """Fetch history, engineer features and fit the HMM (the expensive one-time step)."""
    hist = get_price_history(config, prefer_live=prefer_live)
    vix = get_vix_term_structure(config, price_history=hist.data, prefer_live=prefer_live)
    feats = engineer_features(hist.data, vix.data, config)
    X = feature_matrix(feats, list(config["hmm"]["feature_cols"]))
    model = fit_regime_hmm(X, config)
    source = "live" if (hist.source == "live" and vix.source == "live") else "synthetic"
    as_of = max(hist.as_of, vix.as_of)
    return RegimeBundle(model=model, features=feats, prices=hist.data, source=source, as_of=as_of)


def get_regime_bundle(config: dict, prefer_live: bool = True, refresh: bool = False) -> RegimeBundle:
    """Return the cached fitted bundle, building it on first use."""
    if refresh or prefer_live not in _BUNDLES:
        _BUNDLES[prefer_live] = build_regime_bundle(config, prefer_live=prefer_live)
    return _BUNDLES[prefer_live]


def _provenance(bundle: RegimeBundle, cache, cached_at, stale) -> dict:
    return {
        "source": bundle.source, "as_of": bundle.as_of,
        "cached_at": cached_at, "stale": stale, "cache_backend": cache.backend,
    }


def get_current_regime(config: dict, cache: Cache, prefer_live: bool = True) -> dict:
    """Latest regime + posteriors (RegimeCurrentResponse shape), cached and fast."""
    bundle = get_regime_bundle(config, prefer_live=prefer_live)
    labels = bundle.model.labels
    cols = list(config["hmm"]["feature_cols"])

    def producer() -> dict:
        X = feature_matrix(bundle.features, cols)
        regime, post = bundle.model.current(X)
        latest = bundle.features.iloc[-1]
        return {
            "regime": int(regime),
            "label": labels[regime],
            "probabilities": {labels[k]: float(post[k]) for k in range(len(labels))},
            "as_of": str(bundle.features.index[-1].date()),
            "features": {c: float(latest[c]) for c in cols},
            "_source": bundle.source,
        }

    key = f"regime_current:{session_suffix()}:{'live' if prefer_live else 'offline'}"
    res = cache.get_or_compute(key, int(config["api"]["cache"]["regime_ttl"]), producer)
    core = res.value
    return {
        "regime": core["regime"],
        "label": core["label"],
        "probabilities": core["probabilities"],
        "as_of": datetime.fromisoformat(core["as_of"]),
        "features": core["features"],
        "provenance": _provenance(bundle, cache, res.cached_at, res.stale),
    }


def get_regime_history(
    config: dict, cache: Cache, prefer_live: bool = True, downsample: int = 1
) -> dict:
    """Full historical regime path overlaid on price (RegimeHistoryResponse shape)."""
    bundle = get_regime_bundle(config, prefer_live=prefer_live)
    labels = bundle.model.labels
    cols = list(config["hmm"]["feature_cols"])

    def producer() -> dict:
        X = feature_matrix(bundle.features, cols)
        path = bundle.model.decode(X)
        close = bundle.prices["close"].reindex(bundle.features.index)
        idx = bundle.features.index
        step = max(int(downsample), 1)
        points = [
            {"date": str(idx[i].date()), "price": float(close.iloc[i]),
             "regime": int(path[i]), "label": labels[int(path[i])]}
            for i in range(0, len(idx), step)
        ]
        return {"labels": labels, "points": points, "_source": bundle.source}

    key = f"regime_history:{session_suffix()}:{'live' if prefer_live else 'offline'}:{downsample}"
    res = cache.get_or_compute(key, int(config["api"]["cache"]["regime_ttl"]), producer)
    core = res.value
    return {
        "labels": core["labels"],
        "points": core["points"],
        "provenance": _provenance(bundle, cache, res.cached_at, res.stale),
    }


def get_regime_parameters(config: dict, cache: Cache, n_samples: int = 8) -> dict:
    """Do Heston params differ by regime, and does conditioning improve pricing?

    Runs Kruskal-Wallis on bootstrapped per-regime calibrations and compares static vs
    regime-conditional pricing accuracy.  This is heavy (dozens of calibrations) so it is
    cached for a full day; the route triggers it as a background task on a cache miss.
    """
    from analysis.regime_analysis import (
        calibrated_params_by_regime,
        kruskal_wallis_across_regimes,
        static_vs_regime_conditional,
    )

    labels = list(config["hmm"]["state_labels"])

    def producer() -> dict:
        pbr = calibrated_params_by_regime(config, n_samples=n_samples, seed=0)
        kw = kruskal_wallis_across_regimes(pbr).as_dict()
        sr = static_vs_regime_conditional(config, seed=1)
        return {
            "alpha": kw["alpha"],
            "kruskal_wallis": kw["by_param"],
            "regime_params": {
                labels[r]: {
                    "kappa": p.kappa, "theta": p.theta, "sigma": p.sigma,
                    "rho": p.rho, "v0": p.v0, "feller": p.feller,
                }
                for r, p in sr.regime_params.items()
            },
            "static_mae_overall": sr.static_mae_overall,
            "regime_mae_overall": sr.regime_mae_overall,
            "regime_conditional_improvement_pct": sr.improvement_pct,
            "_source": "synthetic",  # this analysis always runs on regime-typical surfaces
        }

    key = f"regime_params:{session_suffix()}:{n_samples}"
    res = cache.get_or_compute(key, int(config["api"]["cache"]["regime_ttl"]), producer)
    core = res.value
    return {
        "alpha": core["alpha"],
        "kruskal_wallis": core["kruskal_wallis"],
        "regime_params": core["regime_params"],
        "static_mae_overall": core["static_mae_overall"],
        "regime_mae_overall": core["regime_mae_overall"],
        "regime_conditional_improvement_pct": core["regime_conditional_improvement_pct"],
        "provenance": {
            "source": core["_source"], "as_of": res.cached_at,
            "cached_at": res.cached_at, "stale": res.stale, "cache_backend": cache.backend,
        },
    }


def has_regime_parameters(config: dict, cache: Cache, n_samples: int = 8) -> bool:
    """True if the (heavy) regime-parameter analysis is already cached and fresh."""
    entry = cache.get_entry(f"regime_params:{session_suffix()}:{n_samples}")
    return entry is not None and entry[2]

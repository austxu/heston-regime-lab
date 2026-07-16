"""Regime service: train the HMM once, then serve fast cached inference.

Fitting a Gaussian HMM on 20 years of features is expensive, so we do it **once** and keep
the fitted :class:`~models.hmm.RegimeModel` (plus its features/prices) in process memory.
Per-request inference is then just a forward-backward pass on already-computed features —
comfortably sub-200ms — and the JSON results are additionally cached (Redis/in-memory) so
repeat calls and other workers are instant.

The bundle is built lazily on first use and warmed at app startup (see ``api.main``).
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone

import pandas as pd

from api.cache.redis_client import Cache, session_suffix
from data.features import engineer_features, feature_matrix
from data.fetchers import get_price_history, get_vix_term_structure
from models.hmm import RegimeModel, fit_regime_hmm

# In-process fitted models, isolated by session, data mode, and relevant config.
_BUNDLES: dict[tuple[str, bool, str], "RegimeBundle"] = {}
_BUNDLE_LOCK = threading.RLock()
_BUNDLE_BUILD_LOCKS: dict[tuple[str, bool, str], threading.Lock] = {}


@dataclass
class RegimeBundle:
    model: RegimeModel
    features: pd.DataFrame
    prices: pd.DataFrame
    source: str
    as_of: datetime
    built_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


def build_regime_bundle(config: dict, prefer_live: bool = True) -> RegimeBundle:
    """Fetch history, engineer features and fit the HMM (the expensive one-time step)."""
    hist = get_price_history(config, prefer_live=prefer_live)
    vix = get_vix_term_structure(config, price_history=hist.data, prefer_live=prefer_live)
    if prefer_live and (hist.source != "live" or vix.source != "live"):
        # A live leg paired with an independently generated synthetic leg has no
        # economic/date relationship.  If either live fetch fails, rebuild both from
        # the same deterministic synthetic regime history.
        hist = get_price_history(config, prefer_live=False)
        vix = get_vix_term_structure(config, price_history=hist.data, prefer_live=False)
    feats = engineer_features(hist.data, vix.data, config)
    X = feature_matrix(feats, list(config["hmm"]["feature_cols"]))
    model = fit_regime_hmm(X, config)
    source = "live" if (hist.source == "live" and vix.source == "live") else "synthetic"
    as_of = max(hist.as_of, vix.as_of)
    return RegimeBundle(model=model, features=feats, prices=hist.data, source=source, as_of=as_of)


def _config_fingerprint(config: dict) -> str:
    """Stable digest of settings that affect regime training and synthetic inputs."""
    relevant = {
        "hmm": config.get("hmm", {}),
        "history_years": config.get("data", {}).get("history_years"),
        "spx_ticker": config.get("data", {}).get("spx_ticker"),
        "vix_tickers": config.get("data", {}).get("vix_tickers"),
        "synthetic_fallback": config.get("data", {}).get("synthetic_fallback"),
        "vix_forward_fill_days": config.get("data", {}).get("vix_forward_fill_days"),
    }
    encoded = json.dumps(relevant, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:12]


def _bundle_key(
    config: dict, prefer_live: bool, session: str | None = None
) -> tuple[str, bool, str]:
    return session or session_suffix(), prefer_live, _config_fingerprint(config)


def _live_fallback_expired(bundle: RegimeBundle, config: dict, prefer_live: bool) -> bool:
    """Whether a synthetic live-mode fallback is due for another live attempt."""
    if not prefer_live or bundle.source == "live":
        return False
    retry = max(
        1,
        int(config.get("api", {}).get("cache", {}).get("regime_live_retry_ttl", 900)),
    )
    return (datetime.now(timezone.utc) - bundle.built_at).total_seconds() >= retry


def get_regime_bundle(
    config: dict,
    prefer_live: bool = True,
    refresh: bool = False,
    session: str | None = None,
) -> RegimeBundle:
    """Return the session/config-specific fitted bundle, building it on first use."""
    key = _bundle_key(config, prefer_live, session=session)
    with _BUNDLE_LOCK:
        existing = _BUNDLES.get(key)
        if (
            not refresh
            and existing is not None
            and not _live_fallback_expired(existing, config, prefer_live)
        ):
            return existing
        build_lock = _BUNDLE_BUILD_LOCKS.setdefault(key, threading.Lock())

    # Build outside the registry lock so health/readiness checks remain responsive.
    # The keyed lock still coalesces concurrent first requests for the same model.
    with build_lock:
        with _BUNDLE_LOCK:
            existing = _BUNDLES.get(key)
            if (
                not refresh
                and existing is not None
                and not _live_fallback_expired(existing, config, prefer_live)
            ):
                return existing
        bundle = build_regime_bundle(config, prefer_live=prefer_live)
        with _BUNDLE_LOCK:
            active_session = session_suffix()
            if key[0] != active_session:
                # A pre-open request can finish after the session rolls. Its response
                # remains internally consistent, but it must not evict/cache over the
                # newly active session's model.
                _BUNDLE_BUILD_LOCKS.pop(key, None)
                return bundle
            _BUNDLES[key] = bundle
            # Bound process memory while retaining both live and offline models for
            # the current session/configuration.
            for old_key in list(_BUNDLES):
                if old_key[0] != active_session:
                    _BUNDLES.pop(old_key, None)
                    _BUNDLE_BUILD_LOCKS.pop(old_key, None)
            return bundle


def regime_model_ready(config: dict) -> bool:
    """Whether any current-session regime bundle for this config is already fitted."""
    session = session_suffix()
    fingerprint = _config_fingerprint(config)
    with _BUNDLE_LOCK:
        return any(key[0] == session and key[2] == fingerprint for key in _BUNDLES)


def _cached_provenance(
    core: dict,
    config: dict,
    prefer_live: bool,
    cache: Cache,
    cached_at: datetime,
    stale: bool,
    session: str,
) -> dict:
    """Build provenance from cached data, falling back for pre-v2 cache entries."""
    source = core.get("_source")
    as_of = core.get("_as_of")
    if source is None or as_of is None:
        bundle = get_regime_bundle(config, prefer_live=prefer_live, session=session)
        source = source or bundle.source
        as_of = as_of or bundle.as_of
    if isinstance(as_of, str):
        as_of = datetime.fromisoformat(as_of)
    return {
        "source": source,
        "as_of": as_of,
        "cached_at": cached_at,
        "stale": stale,
        "cache_backend": cache.backend,
    }


def _regime_response_ttl(config: dict, prefer_live: bool) -> int:
    base = max(1, int(config["api"]["cache"]["regime_ttl"]))
    if not prefer_live:
        return base
    retry = max(1, int(config["api"]["cache"].get("regime_live_retry_ttl", 900)))
    return min(base, retry)


def get_current_regime(config: dict, cache: Cache, prefer_live: bool = True) -> dict:
    """Latest regime + posteriors (RegimeCurrentResponse shape), cached and fast."""
    session = session_suffix()
    fingerprint = _config_fingerprint(config)
    cols = list(config["hmm"]["feature_cols"])

    def producer() -> dict:
        bundle = get_regime_bundle(config, prefer_live=prefer_live, session=session)
        labels = bundle.model.labels
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
            "_as_of": bundle.as_of.isoformat(),
        }

    key = f"regime_current:v2:{session}:{'live' if prefer_live else 'offline'}:{fingerprint}"
    res = cache.get_or_compute(key, _regime_response_ttl(config, prefer_live), producer)
    core = res.value
    return {
        "regime": core["regime"],
        "label": core["label"],
        "probabilities": core["probabilities"],
        "as_of": datetime.fromisoformat(core["as_of"]),
        "features": core["features"],
        "provenance": _cached_provenance(
            core, config, prefer_live, cache, res.cached_at, res.stale, session
        ),
    }


def get_regime_history(
    config: dict, cache: Cache, prefer_live: bool = True, downsample: int = 1
) -> dict:
    """Full historical regime path overlaid on price (RegimeHistoryResponse shape)."""
    downsample = int(downsample)
    if not 1 <= downsample <= 5000:
        raise ValueError("downsample must be between 1 and 5000")
    session = session_suffix()
    fingerprint = _config_fingerprint(config)
    cols = list(config["hmm"]["feature_cols"])

    def producer() -> dict:
        bundle = get_regime_bundle(config, prefer_live=prefer_live, session=session)
        labels = bundle.model.labels
        X = feature_matrix(bundle.features, cols)
        path = bundle.model.decode(X)
        close = bundle.prices["close"].reindex(bundle.features.index)
        idx = bundle.features.index
        step = downsample
        points = [
            {
                "date": str(idx[i].date()),
                "price": float(close.iloc[i]),
                "regime": int(path[i]),
                "label": labels[int(path[i])],
            }
            for i in range(0, len(idx), step)
        ]
        return {
            "labels": labels,
            "points": points,
            "_source": bundle.source,
            "_as_of": bundle.as_of.isoformat(),
        }

    key = (
        f"regime_history:v2:{session}:{'live' if prefer_live else 'offline'}:"
        f"{fingerprint}:{downsample}"
    )
    res = cache.get_or_compute(key, _regime_response_ttl(config, prefer_live), producer)
    core = res.value
    return {
        "labels": core["labels"],
        "points": core["points"],
        "provenance": _cached_provenance(
            core, config, prefer_live, cache, res.cached_at, res.stale, session
        ),
    }


def _analysis_fingerprint(config: dict) -> str:
    relevant = {
        name: config.get(name, {})
        for name in ("market", "quadrature", "implied_vol", "calibration", "data", "hmm")
    }
    encoded = json.dumps(relevant, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:12]


def regime_parameters_cache_key(
    config: dict, n_samples: int = 8, session: str | None = None
) -> str:
    """Versioned, session/config-specific key for the heavy regime study."""
    session = session or session_suffix()
    return f"regime_params:v2:{session}:{_analysis_fingerprint(config)}:{n_samples}"


def get_regime_parameters(
    config: dict,
    cache: Cache,
    n_samples: int = 8,
    session: str | None = None,
) -> dict:
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

    param_names = ("kappa", "theta", "sigma", "rho", "v0")

    def producer() -> dict:
        pbr = calibrated_params_by_regime(config, n_samples=n_samples, seed=0)
        kw = kruskal_wallis_across_regimes(pbr).as_dict()
        sr = static_vs_regime_conditional(config, seed=1)
        return {
            "alpha": kw["alpha"],
            "kruskal_wallis": kw["by_param"],
            "regime_params": {
                labels[r]: {
                    "kappa": p.kappa,
                    "theta": p.theta,
                    "sigma": p.sigma,
                    "rho": p.rho,
                    "v0": p.v0,
                    "feller": p.feller,
                }
                for r, p in sr.regime_params.items()
            },
            # Raw bootstrap samples so the frontend can draw real per-regime densities.
            "param_samples": {
                labels[r]: {name: [getattr(p, name) for p in samples] for name in param_names}
                for r, samples in pbr.items()
            },
            "static_mae_overall": sr.static_mae_overall,
            "regime_mae_overall": sr.regime_mae_overall,
            "static_mae_by_regime": {labels[r]: v for r, v in sr.static_mae_by_regime.items()},
            "regime_mae_by_regime": {labels[r]: v for r, v in sr.regime_mae_by_regime.items()},
            "regime_conditional_improvement_pct": sr.improvement_pct,
            "_source": "synthetic",  # this analysis always runs on regime-typical surfaces
        }

    key = regime_parameters_cache_key(config, n_samples=n_samples, session=session)
    res = cache.get_or_compute(key, int(config["api"]["cache"]["regime_ttl"]), producer)
    core = res.value
    return {
        "alpha": core["alpha"],
        "kruskal_wallis": core["kruskal_wallis"],
        "regime_params": core["regime_params"],
        "param_samples": core.get("param_samples", {}),
        "static_mae_overall": core["static_mae_overall"],
        "regime_mae_overall": core["regime_mae_overall"],
        "static_mae_by_regime": core.get("static_mae_by_regime", {}),
        "regime_mae_by_regime": core.get("regime_mae_by_regime", {}),
        "regime_conditional_improvement_pct": core["regime_conditional_improvement_pct"],
        "provenance": {
            "source": core["_source"],
            "as_of": res.cached_at,
            "cached_at": res.cached_at,
            "stale": res.stale,
            "cache_backend": cache.backend,
        },
    }


def has_regime_parameters(
    config: dict,
    cache: Cache,
    n_samples: int = 8,
    session: str | None = None,
) -> bool:
    """True if the (heavy) regime-parameter analysis is already cached and fresh."""
    entry = cache.get_entry(
        regime_parameters_cache_key(config, n_samples=n_samples, session=session)
    )
    return entry is not None and entry[2]

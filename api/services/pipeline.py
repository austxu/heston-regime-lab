"""Shared service helpers: cached market snapshot, MarketData assembly, provenance.

Every endpoint that touches market data goes through :func:`get_snapshot`, which folds
the live-vs-cache-vs-synthetic policy into one place:

* try a **live** snapshot (raises if not genuinely live),
* on failure serve the last **cached** live snapshot, flagged stale,
* if nothing is cached, fall back to **synthetic** data.

Snapshots are JSON-serialised (the options chain as records) so a single live pull is
shared across the calibration, surface and comparison endpoints within a trading session.
"""

from __future__ import annotations

from datetime import datetime

import pandas as pd

from api.cache.redis_client import Cache, CacheResult, session_suffix
from calibration.optimizer import MarketData
from data.fetchers import (
    CHAIN_COLUMNS,
    ChainSnapshot,
    DataUnavailable,
    filter_liquid_options,
    get_market_snapshot,
)


def snapshot_to_dict(snap: ChainSnapshot) -> dict:
    """Serialise a :class:`ChainSnapshot` to a JSON-friendly dict."""
    return {
        "spot": snap.spot,
        "rate": snap.rate,
        "div_yield": snap.div_yield,
        "source": snap.source,
        "as_of": snap.as_of.isoformat(),
        "chain": snap.chain.to_dict(orient="records"),
    }


def snapshot_from_dict(d: dict) -> ChainSnapshot:
    """Inverse of :func:`snapshot_to_dict`."""
    chain = pd.DataFrame(d["chain"], columns=CHAIN_COLUMNS)
    return ChainSnapshot(
        spot=float(d["spot"]),
        rate=float(d["rate"]),
        div_yield=float(d["div_yield"]),
        chain=chain,
        source=d["source"],
        as_of=datetime.fromisoformat(d["as_of"]),
    )


def get_snapshot(
    config: dict, cache: Cache, prefer_live: bool = True
) -> tuple[ChainSnapshot, CacheResult]:
    """Cached market snapshot with live -> stale-cache -> synthetic fallback."""
    mode = "live" if prefer_live else "offline"
    key = f"snapshot:v2:{session_suffix()}:{mode}"
    ttl = int(config["api"]["cache"]["calibration_ttl"])

    def live_producer() -> dict:
        return snapshot_to_dict(
            get_market_snapshot(config, prefer_live=True, allow_synthetic=False)
        )

    def synthetic_fallback() -> dict:
        return snapshot_to_dict(get_market_snapshot(config, prefer_live=False))

    if prefer_live:
        res = cache.get_or_compute(key, ttl, live_producer, fallback=synthetic_fallback)
    else:
        # Offline mode: produce synthetic directly (still cached).
        res = cache.get_or_compute(key, ttl, synthetic_fallback)
    return snapshot_from_dict(res.value), res


def build_market_data(snapshot: ChainSnapshot, config: dict) -> tuple[MarketData, dict]:
    """Filter to liquid options and assemble a calibration :class:`MarketData`."""
    liquid, report = filter_liquid_options(snapshot, config)
    if liquid.empty:
        raise DataUnavailable(
            f"no liquid option quotes remain after filtering; filter counts={report.as_dict()}"
        )
    data = MarketData(
        spot=snapshot.spot,
        rate=snapshot.rate,
        div_yield=snapshot.div_yield,
        strikes=liquid["strike"].to_numpy(),
        maturities=liquid["maturity"].to_numpy(),
        market_iv=liquid["market_iv"].to_numpy(),
    )
    return data, report.as_dict()


def provenance(snapshot: ChainSnapshot, cache_res: CacheResult, cache: Cache) -> dict:
    """Build the Provenance block shared by every response."""
    return {
        "source": snapshot.source,
        "as_of": snapshot.as_of,
        "cached_at": cache_res.cached_at,
        "stale": cache_res.stale,
        "cache_backend": cache.backend,
    }

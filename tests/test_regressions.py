"""Focused regressions for validation, concurrency, and API boundary behavior.

These tests intentionally avoid calibrations and network access so they add coverage without
materially slowing the full numerical suite.
"""

from __future__ import annotations

import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from fastapi import BackgroundTasks
from starlette.datastructures import QueryParams
from starlette.requests import Request

from api.cache.redis_client import Cache, session_suffix
from api.ratelimit import _client_ip
from api.routes.calibration import _prune_jobs
from calibration.optimizer import MarketData
from data.fetchers import CHAIN_COLUMNS, ChainSnapshot
from models.black_scholes import bs_price, implied_vol
from models.heston import HestonParams, heston_characteristic_function, heston_price

PARAMS = HestonParams(kappa=2.0, theta=0.04, sigma=0.5, rho=-0.7, v0=0.04)


def _market_data(**overrides) -> MarketData:
    values = {
        "spot": 100.0,
        "rate": 0.03,
        "div_yield": 0.0,
        "strikes": [90.0, 100.0, 110.0],
        "maturities": [0.5, 1.0, 1.5],
        "market_iv": [0.24, 0.20, 0.19],
    }
    values.update(overrides)
    return MarketData(**values)


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"spot": 0.0}, "spot must be > 0"),
        (
            {"strikes": [], "maturities": [], "market_iv": []},
            "at least one option quote",
        ),
        ({"strikes": [[90.0, 100.0, 110.0]]}, "one-dimensional"),
        ({"strikes": [90.0, np.nan, 110.0]}, "strikes must all be finite"),
        ({"maturities": [0.5, 0.0, 1.5]}, "maturities must all be finite"),
        ({"market_iv": [0.24, -0.1, 0.19]}, "market_iv must all be finite"),
        ({"weights": [1.0, 1.0]}, "match the quote count"),
        ({"weights": [1.0, -1.0, 1.0]}, "weights must all be finite"),
        ({"weights": [0.0, 0.0, 0.0]}, "at least one weight must be > 0"),
    ],
)
def test_market_data_rejects_invalid_inputs(overrides, message):
    with pytest.raises(ValueError, match=message):
        _market_data(**overrides)


def test_market_data_copies_mutable_inputs():
    strikes = np.array([90.0, 100.0, 110.0])
    weights = np.ones(3)
    data = _market_data(strikes=strikes, weights=weights)

    strikes[0] = 1.0
    weights[0] = 0.0

    assert data.strikes[0] == 90.0
    assert data.weights[0] == 1.0


@pytest.mark.parametrize("option_type", ["CALL", "", "straddle"])
def test_pricers_reject_unknown_option_type_even_at_expiry(option_type):
    with pytest.raises(ValueError, match="option_type"):
        bs_price(100.0, 100.0, 0.03, 0.0, 0.0, 0.2, option_type)
    with pytest.raises(ValueError, match="option_type"):
        heston_price(PARAMS, 100.0, 100.0, 0.03, 0.0, 0.0, option_type)
    with pytest.raises(ValueError, match="option_type"):
        implied_vol(10.0, 100.0, 100.0, 0.03, 0.0, 1.0, option_type)


def test_heston_expiry_values_preserve_input_shape():
    strikes = np.array([[90.0, 100.0], [110.0, 120.0]])
    calls = heston_price(PARAMS, 100.0, strikes, 0.03, 0.0, 0.0, "call")
    puts = heston_price(PARAMS, 100.0, strikes, 0.03, 0.0, 0.0, "put")

    assert calls.shape == strikes.shape
    assert puts.shape == strikes.shape
    assert np.array_equal(calls, [[10.0, 0.0], [0.0, 0.0]])
    assert np.array_equal(puts, [[0.0, 0.0], [10.0, 20.0]])
    assert heston_characteristic_function(0.7, PARAMS, 100.0, 0.03, 0.0, 0.0) == pytest.approx(
        np.exp(0.7j * np.log(100.0))
    )


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"n_nodes": 1}, "n_nodes"),
        ({"n_nodes": 8.5}, "n_nodes"),
        ({"upper_limit": 0.0}, "upper_limit"),
        ({"tau": -0.1}, "tau must be"),
        ({"strike": np.nan}, "strikes must"),
    ],
)
def test_heston_price_rejects_invalid_numerical_inputs(kwargs, message):
    values = {
        "params": PARAMS,
        "spot": 100.0,
        "strike": 100.0,
        "rate": 0.03,
        "div_yield": 0.0,
        "tau": 1.0,
    }
    values.update(kwargs)
    with pytest.raises(ValueError, match=message):
        heston_price(**values)


def test_memory_cache_set_if_absent_is_atomic():
    cache = Cache(url=None, namespace="atomic-test")
    workers = 12
    barrier = threading.Barrier(workers)

    def compete(index: int) -> bool:
        barrier.wait()
        return cache.set_if_absent("key", {"winner": index}, ttl=60)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        admitted = list(pool.map(compete, range(workers)))

    assert sum(admitted) == 1
    assert cache.get_entry("key")[0]["winner"] == admitted.index(True)
    cache.invalidate("key")
    assert cache.set_if_absent("key", {"winner": "next"}, ttl=60)


def test_memory_cache_refreshes_only_a_live_matching_lease():
    cache = Cache(url=None, namespace="lease-refresh-test")
    assert cache.set_if_absent("lease", "owner-a", ttl=60)
    before = cache.get_entry("lease")[1]

    assert not cache.refresh_if_value("lease", "owner-b", ttl=120)
    assert cache.get_entry("lease")[1] == before
    time.sleep(0.01)
    assert cache.refresh_if_value("lease", "owner-a", ttl=120)

    value, refreshed_at, fresh = cache.get_entry("lease")
    assert value == "owner-a"
    assert refreshed_at > before
    assert fresh


def test_memory_cache_coalesces_concurrent_computation():
    cache = Cache(url=None, namespace="single-flight-test")
    calls = 0
    calls_lock = threading.Lock()

    def producer() -> dict[str, int]:
        nonlocal calls
        with calls_lock:
            calls += 1
        time.sleep(0.05)
        return {"value": 42}

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: cache.get_or_compute("key", 60, producer), range(8)))

    assert calls == 1
    assert all(result.value == {"value": 42} for result in results)
    assert sum(not result.hit for result in results) == 1


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        # Monday 09:29 ET belongs to Friday's session; 09:30 starts Monday's key.
        (datetime(2026, 7, 13, 13, 29, tzinfo=timezone.utc), "2026-07-10"),
        (datetime(2026, 7, 13, 13, 30, tzinfo=timezone.utc), "2026-07-13"),
        # Weekend activity also belongs to Friday.
        (datetime(2026, 7, 11, 18, 0, tzinfo=timezone.utc), "2026-07-10"),
    ],
)
def test_session_suffix_boundaries(now, expected):
    assert session_suffix(now) == expected


def test_live_and_offline_snapshots_have_independent_cache_keys(monkeypatch):
    from api.services import pipeline

    chain = pd.DataFrame([{column: None for column in CHAIN_COLUMNS}], columns=CHAIN_COLUMNS)
    calls: list[tuple[bool, bool]] = []

    def fake_snapshot(_config, prefer_live=True, allow_synthetic=True):
        calls.append((prefer_live, allow_synthetic))
        return ChainSnapshot(
            spot=5000.0,
            rate=0.03,
            div_yield=0.01,
            chain=chain,
            source="live" if prefer_live else "synthetic",
            as_of=datetime(2026, 7, 15, tzinfo=timezone.utc),
        )

    monkeypatch.setattr(pipeline, "get_market_snapshot", fake_snapshot)
    monkeypatch.setattr(pipeline, "session_suffix", lambda: "2026-07-15")
    config = {"api": {"cache": {"calibration_ttl": 60}}}
    cache = Cache(url=None, namespace="snapshot-mode-test")

    offline, offline_result = pipeline.get_snapshot(config, cache, prefer_live=False)
    live, live_result = pipeline.get_snapshot(config, cache, prefer_live=True)
    cached_offline, cached_offline_result = pipeline.get_snapshot(config, cache, prefer_live=False)
    cached_live, cached_live_result = pipeline.get_snapshot(config, cache, prefer_live=True)

    assert (offline.source, live.source) == ("synthetic", "live")
    assert (cached_offline.source, cached_live.source) == ("synthetic", "live")
    assert not offline_result.hit and not live_result.hit
    assert cached_offline_result.hit and cached_live_result.hit
    assert calls == [(False, True), (True, False)]


@pytest.mark.parametrize(
    ("offline", "query", "expected"),
    [
        (True, "", False),
        (False, "", True),
        (True, "live=true", True),
        (False, "live=false", False),
    ],
)
def test_websocket_data_mode_matches_http_default(monkeypatch, offline, query, expected):
    from api.websocket.calibration_stream import _parse_prefer_live

    monkeypatch.setenv("HRL_OFFLINE", "1" if offline else "0")
    websocket = SimpleNamespace(query_params=QueryParams(query))
    assert _parse_prefer_live(websocket) is expected


def test_websocket_accepts_public_same_origin_behind_proxy():
    from api.websocket.calibration_stream import _origin_allowed

    config = {"api": {"cors_origins": ["http://localhost:5173"]}}
    websocket = SimpleNamespace(
        headers={
            "origin": "https://dashboard.example.com",
            "host": "dashboard.example.com",
            "x-forwarded-proto": "https",
        },
        url=SimpleNamespace(scheme="ws"),
    )

    assert _origin_allowed(websocket, config)


@pytest.mark.parametrize("forwarded_proto", ["https", "https, http", "javascript"])
def test_websocket_rejects_hostile_or_malformed_proxy_origin(forwarded_proto):
    from api.websocket.calibration_stream import _origin_allowed

    config = {"api": {"cors_origins": ["http://localhost:5173"]}}
    websocket = SimpleNamespace(
        headers={
            "origin": "https://evil.example",
            "host": "dashboard.example.com",
            "x-forwarded-proto": forwarded_proto,
        },
        url=SimpleNamespace(scheme="ws"),
    )

    assert not _origin_allowed(websocket, config)


def test_websocket_client_ip_uses_normalized_proxy_identity_only_when_trusted():
    from api.websocket.calibration_stream import _client_ip

    websocket = SimpleNamespace(
        headers={"x-real-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.2"},
        client=SimpleNamespace(host="10.0.0.4"),
    )

    assert _client_ip(websocket, {"api": {"trust_proxy_headers": True}}) == "203.0.113.8"
    assert _client_ip(websocket, {"api": {"trust_proxy_headers": False}}) == "10.0.0.4"


def test_cancelled_websocket_accept_releases_worker_and_client_lease():
    import asyncio

    from api.websocket import calibration_stream as stream

    class CancelledHandshake:
        headers = {}
        query_params = QueryParams("")
        client = SimpleNamespace(host="203.0.113.9")
        url = SimpleNamespace(scheme="ws")

        async def accept(self):
            raise asyncio.CancelledError

    config = {
        "api": {
            "cors_origins": [],
            "trust_proxy_headers": False,
            "websocket": {"max_concurrent_calibrations": 1, "per_ip_lease_ttl": 60},
        }
    }
    cache = Cache(url=None, namespace="cancelled-websocket-test")
    stream._ACTIVE_CALIBRATIONS = 0

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(stream.stream_calibration(CancelledHandshake(), config, cache))

    assert stream._ACTIVE_CALIBRATIONS == 0
    assert cache.set_if_absent("ws:calibration:203.0.113.9", "next-owner", ttl=60)


def test_background_calibration_jobs_have_a_separate_rate_limit():
    from api.ratelimit import calibration_job_rate_limit
    from api.routes.calibration import router

    route = next(
        route
        for route in router.routes
        if route.path == "/api/calibration/jobs" and "POST" in route.methods
    )
    assert any(
        dependency.dependency is calibration_job_rate_limit for dependency in route.dependencies
    )


def test_synthetic_live_regime_bundle_retries_after_short_ttl(monkeypatch):
    from api.services import regime_service as service

    now = datetime.now(timezone.utc)
    old = service.RegimeBundle(
        model=object(),
        features=pd.DataFrame(),
        prices=pd.DataFrame(),
        source="synthetic",
        as_of=now,
        built_at=now - timedelta(seconds=61),
    )
    fresh = service.RegimeBundle(
        model=object(),
        features=pd.DataFrame(),
        prices=pd.DataFrame(),
        source="synthetic",
        as_of=now,
        built_at=now,
    )
    built = iter([old, fresh])
    calls = []

    def fake_build(_config, prefer_live=True):
        calls.append(prefer_live)
        return next(built)

    config = {
        "api": {"cache": {"regime_ttl": 86400, "regime_live_retry_ttl": 60}},
        "hmm": {},
        "data": {"spx_ticker": "retry-test"},
    }
    monkeypatch.setattr(service, "session_suffix", lambda: "2026-07-15")
    monkeypatch.setattr(service, "build_regime_bundle", fake_build)

    assert service.get_regime_bundle(config, prefer_live=True) is old
    assert service.get_regime_bundle(config, prefer_live=True) is fresh
    assert service.get_regime_bundle(config, prefer_live=True) is fresh
    assert calls == [True, True]
    assert service._regime_response_ttl(config, prefer_live=True) == 60
    assert service._regime_response_ttl(config, prefer_live=False) == 86400


def test_proxy_headers_do_not_trust_a_spoofed_leftmost_address():
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [(b"x-forwarded-for", b"203.0.113.9, 10.0.0.2")],
            "client": ("10.0.0.2", 1234),
            "scheme": "http",
            "server": ("testserver", 80),
            "query_string": b"",
        }
    )

    # A client can prepend 203.0.113.9; the trusted edge appends 10.0.0.2.
    assert _client_ip(request, trust_proxy_headers=True) == "10.0.0.2"
    assert _client_ip(request, trust_proxy_headers=False) == "10.0.0.2"


def test_job_pruning_expires_results_and_preserves_running_work():
    now = datetime(2026, 7, 15, tzinfo=timezone.utc)

    def job(status: str, age_seconds: int) -> dict:
        updated = now - timedelta(seconds=age_seconds)
        return {"status": status, "created_at": updated, "updated_at": updated}

    jobs = {
        "running": job("running", 10_000),
        "expired": job("done", 120),
        "older-result": job("error", 20),
        "newer-result": job("done", 10),
    }

    _prune_jobs(jobs, now=now, ttl=60, max_jobs=3)

    # Expiry removes one result; capacity pruning removes the oldest remaining terminal
    # result to leave room for the incoming job. In-progress work is never discarded.
    assert set(jobs) == {"running", "newer-result"}


def test_regime_analysis_lease_prevents_duplicate_background_work(monkeypatch):
    from api.routes import regime

    cache = Cache(url=None, namespace="regime-lease-test")
    config = {"api": {"regime_analysis_timeout": 60}}
    monkeypatch.setattr(regime, "has_regime_parameters", lambda _config, _cache: False)
    first = BackgroundTasks()
    second = BackgroundTasks()

    first_response = asyncio.run(regime.regime_parameters(first, config, cache))
    second_response = asyncio.run(regime.regime_parameters(second, config, cache))

    assert first_response.status_code == second_response.status_code == 202
    assert len(first.tasks) == 1
    assert len(second.tasks) == 0

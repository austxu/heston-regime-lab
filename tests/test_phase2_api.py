"""Phase 2 test suite: data layer, regime HMM, cache, and the FastAPI service.

Runs entirely offline (synthetic fallback, in-memory cache) — no network, no Redis — so it
is deterministic and CI-friendly.  A module-scoped TestClient shares the app cache so the
expensive calibration runs once and the dependent endpoints reuse it.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

from calibration.optimizer import MarketData, calibrate, load_config
from calibration.validators import CONFIG_PATH

CONFIG = load_config(CONFIG_PATH)


# --------------------------------------------------------------------------- #
# Data layer: fetchers, liquidity filtering, features
# --------------------------------------------------------------------------- #
def test_synthetic_snapshot_is_well_formed():
    from data import fetchers as F

    snap = F.get_market_snapshot(CONFIG, prefer_live=False)
    assert snap.source == "synthetic"
    assert snap.spot > 0 and 0.0 <= snap.rate < 0.2
    assert set(F.CHAIN_COLUMNS).issubset(snap.chain.columns)
    assert (snap.chain["mid"] > 0).all()


def test_liquidity_filter_removes_and_reports():
    from data import fetchers as F

    snap = F.get_market_snapshot(CONFIG, prefer_live=False)
    liquid, report = F.filter_liquid_options(snap, CONFIG)
    d = report.as_dict()
    assert d["n_input"] == len(snap.chain)
    assert d["n_kept"] == len(liquid)
    assert d["n_kept"] < d["n_input"]  # at least some deep-OTM removed
    assert np.isfinite(liquid["market_iv"]).all()


def test_features_have_expected_columns_and_no_nans():
    from data import fetchers as F
    from data.features import engineer_features

    hist = F.get_price_history(CONFIG, prefer_live=False)
    vix = F.get_vix_term_structure(CONFIG, price_history=hist.data, prefer_live=False)
    feats = engineer_features(hist.data, vix.data, CONFIG)
    for col in CONFIG["hmm"]["feature_cols"]:
        assert col in feats.columns
    assert not feats[CONFIG["hmm"]["feature_cols"]].isna().any().any()


# --------------------------------------------------------------------------- #
# HMM regime model
# --------------------------------------------------------------------------- #
def test_hmm_states_ordered_by_volatility():
    from data import fetchers as F
    from data.features import engineer_features, feature_matrix
    from models.hmm import fit_regime_hmm

    hist = F.get_price_history(CONFIG, prefer_live=False)
    vix = F.get_vix_term_structure(CONFIG, price_history=hist.data, prefer_live=False)
    feats = engineer_features(hist.data, vix.data, CONFIG)
    cols = CONFIG["hmm"]["feature_cols"]
    X = feature_matrix(feats, cols)
    model = fit_regime_hmm(X, CONFIG)
    path = model.decode(X)

    # Mean realized vol must be non-decreasing across ordered regimes (calm->crisis).
    rv = feats["rv_21d"].to_numpy()
    means = [rv[path == k].mean() for k in range(model.n_states)]
    assert means == sorted(means)
    # Posteriors are valid probability vectors.
    post = model.posteriors(X)
    assert np.allclose(post.sum(axis=1), 1.0, atol=1e-6)


# --------------------------------------------------------------------------- #
# Pricing comparison
# --------------------------------------------------------------------------- #
def test_heston_beats_flat_bs():
    from analysis.pricing_comparison import compare_pricing
    from data import fetchers as F

    snap = F.get_market_snapshot(CONFIG, prefer_live=False)
    liquid, _ = F.filter_liquid_options(snap, CONFIG)
    data = MarketData(snap.spot, snap.rate, snap.div_yield,
                      liquid["strike"].to_numpy(), liquid["maturity"].to_numpy(),
                      liquid["market_iv"].to_numpy())
    res = calibrate(data, CONFIG)
    cmp = compare_pricing(data, res.params, CONFIG)
    assert cmp.mae_heston < cmp.mae_bs           # Heston fits the smile
    assert cmp.mae_corrected <= cmp.mae_heston * 1.05  # residual correction doesn't hurt


# --------------------------------------------------------------------------- #
# Calibration callback (WebSocket streaming hook)
# --------------------------------------------------------------------------- #
def test_calibration_callback_fires_and_is_noop_when_absent():
    from data import fetchers as F

    snap = F.get_market_snapshot(CONFIG, prefer_live=False)
    liquid, _ = F.filter_liquid_options(snap, CONFIG)
    data = MarketData(snap.spot, snap.rate, snap.div_yield,
                      liquid["strike"].to_numpy(), liquid["maturity"].to_numpy(),
                      liquid["market_iv"].to_numpy())
    progress = []
    res_cb = calibrate(data, CONFIG, callback=progress.append)
    res_plain = calibrate(data, CONFIG)
    assert len(progress) >= 1
    assert progress[-1].iteration == len(progress)
    # The callback must not change the optimum.
    assert np.allclose(res_cb.params.to_array(), res_plain.params.to_array(), atol=1e-6)


# --------------------------------------------------------------------------- #
# Cache: in-memory fallback, freshness, serve-stale-on-error, session keys
# --------------------------------------------------------------------------- #
def test_cache_get_or_compute_freshness_and_stale():
    from api.cache.redis_client import Cache

    cache = Cache(url=None)  # forces in-memory backend
    assert cache.backend == "memory"

    calls = {"n": 0}
    def producer():
        calls["n"] += 1
        return {"v": calls["n"]}

    r1 = cache.get_or_compute("k", 100, producer)
    assert r1.value == {"v": 1} and not r1.hit and not r1.stale
    r2 = cache.get_or_compute("k", 100, producer)  # fresh hit, no recompute
    assert r2.hit and r2.value == {"v": 1} and calls["n"] == 1

    # Expired entry + failing producer -> serve stale.
    cache.set("k2", {"v": 10}, ttl=0)
    def boom():
        raise RuntimeError("live source down")
    r3 = cache.get_or_compute("k2", 0, boom)
    assert r3.stale and r3.value == {"v": 10}

    # No cache + failing producer + fallback -> fallback value.
    r4 = cache.get_or_compute("k3", 100, boom, fallback=lambda: {"v": -1})
    assert r4.value == {"v": -1} and not r4.stale


def test_session_suffix_is_a_weekday_iso_date():
    from datetime import date

    from api.cache.redis_client import session_suffix

    s = session_suffix()
    d = date.fromisoformat(s)
    assert d.weekday() < 5  # never a weekend


# --------------------------------------------------------------------------- #
# API endpoints (offline) — shared client so calibration runs once
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="module")
def client():
    os.environ["HRL_OFFLINE"] = "1"
    from fastapi.testclient import TestClient

    from api.main import create_app

    with TestClient(create_app()) as c:
        yield c


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["cache_backend"] in ("memory", "redis")


def test_calibration_endpoint(client):
    r = client.get("/api/calibration/run", params={"live": "false"})
    assert r.status_code == 200
    body = r.json()
    assert set(body["params"]) >= {"kappa", "theta", "sigma", "rho", "v0"}
    assert body["mean_iv_error"] < 0.03      # target: under 3% vol error
    assert body["n_options"] > 0
    assert body["provenance"]["source"] == "synthetic"


def test_surface_endpoint(client):
    r = client.get("/api/surface", params={"live": "false"})
    assert r.status_code == 200
    body = r.json()
    assert len(body["market_iv"]) == len(body["maturities"])
    assert len(body["market_iv"][0]) == len(body["moneyness"])
    assert len(body["heston_iv"]) == len(body["maturities"])


def test_regime_current_endpoint(client):
    r = client.get("/api/regime/current", params={"live": "false"})
    assert r.status_code == 200
    body = r.json()
    assert body["regime"] in (0, 1, 2)
    assert abs(sum(body["probabilities"].values()) - 1.0) < 1e-6


def test_regime_history_endpoint(client):
    r = client.get("/api/regime/history", params={"live": "false", "downsample": "21"})
    assert r.status_code == 200
    body = r.json()
    assert len(body["points"]) > 0
    assert {"date", "price", "regime", "label"} == set(body["points"][0])


def test_comparison_endpoint(client):
    r = client.get("/api/comparison", params={"live": "false"})
    assert r.status_code == 200
    body = r.json()
    assert body["mae_heston"] < body["mae_bs"]
    assert body["residual_backend"]


def test_websocket_streams_convergence(client):
    msgs = []
    with client.websocket_connect("/ws/calibration?live=false") as ws:
        while True:
            m = ws.receive_json()
            msgs.append(m)
            if m["type"] in ("done", "error"):
                break
    assert any(m["type"] == "progress" for m in msgs)
    assert msgs[-1]["type"] == "done"
    assert msgs[-1]["mean_iv_error"] < 0.03


def test_background_calibration_job(client):
    import time

    r = client.post("/api/calibration/jobs", params={"live": "false"})
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    for _ in range(60):
        s = client.get(f"/api/calibration/jobs/{job_id}").json()
        if s["status"] in ("done", "error"):
            break
        time.sleep(0.5)
    assert s["status"] == "done"
    assert s["result"] is not None
    assert client.get("/api/calibration/jobs/does-not-exist").status_code == 404

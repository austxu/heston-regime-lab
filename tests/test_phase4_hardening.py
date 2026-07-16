"""Phase 4 production-hardening tests: rate limiting, request IDs, compression, logging.

Each test builds a fresh app so the in-memory cache (and rate-limit buckets) start clean.
Offline mode keeps everything deterministic and network-free.
"""

from __future__ import annotations

import json
import logging
import os

import pytest


@pytest.fixture()
def client():
    os.environ["HRL_OFFLINE"] = "1"
    from fastapi.testclient import TestClient

    from api.main import create_app

    with TestClient(create_app()) as c:
        yield c


def test_calibration_rate_limited(client):
    first = client.get("/api/calibration/run", params={"live": "false"})
    assert first.status_code == 200
    second = client.get("/api/calibration/run", params={"live": "false"})
    assert second.status_code == 429
    assert int(second.headers["Retry-After"]) > 0


def test_other_endpoints_not_rate_limited(client):
    # Only /api/calibration/run is on the limited bucket; other endpoints aren't.
    assert client.get("/api/regime/current", params={"live": "false"}).status_code == 200
    assert client.get("/api/regime/current", params={"live": "false"}).status_code == 200


def test_request_id_header(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert len(r.headers.get("X-Request-ID", "")) >= 8


def test_gzip_compression_on_large_payload(client):
    # The regime history payload (1000s of points) is well over the 500-byte threshold.
    r = client.get(
        "/api/regime/history",
        params={"live": "false", "downsample": "5"},
        headers={"Accept-Encoding": "gzip"},
    )
    assert r.status_code == 200
    # Starlette's GZipMiddleware sets this; TestClient/httpx transparently decodes the body.
    assert r.headers.get("content-encoding") == "gzip"


def test_json_log_formatter_emits_valid_json():
    from api.logging_config import JsonFormatter

    rec = logging.LogRecord(
        name="hrl.api",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="request",
        args=(),
        exc_info=None,
    )
    rec.status = 200
    rec.path = "/health"
    parsed = json.loads(JsonFormatter().format(rec))
    assert parsed["message"] == "request"
    assert parsed["status"] == 200
    assert parsed["path"] == "/health"
    assert parsed["level"] == "INFO"


def test_rate_limit_disabled_via_config(client):
    # Flip the runtime config off and confirm repeated calls are allowed.
    client.app.state.config["api"]["rate_limit"]["enabled"] = False
    try:
        assert client.get("/api/calibration/run", params={"live": "false"}).status_code == 200
        assert client.get("/api/calibration/run", params={"live": "false"}).status_code == 200
    finally:
        client.app.state.config["api"]["rate_limit"]["enabled"] = True

"""FastAPI application: wires the Heston/HMM research into a live, cached API.

Responsibilities:
* load config and build the shared cache (Redis or in-memory) on startup (lifespan),
* register the calibration / surface / regime / comparison routers and the calibration
  WebSocket,
* production hardening: gzip compression, env-driven CORS, structured JSON request logging,
  and optional Sentry error tracking,
* expose a health check and clean, tagged OpenAPI docs.

Run locally:  ``uvicorn api.main:app --reload``
Offline mode (no network): set ``HRL_OFFLINE=1`` so every endpoint uses synthetic data.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from api.cache.redis_client import build_cache
from api.logging_config import configure_logging, get_logger
from api.models.schemas import HealthResponse
from api.routes import calibration, comparison, regime, surface
from api.websocket.calibration_stream import stream_calibration
from calibration.optimizer import load_config

CONFIG_PATH = Path(__file__).resolve().parents[1] / "configs" / "base.yaml"

log = get_logger("hrl.api")


def _init_sentry(version: str) -> bool:
    """Initialise Sentry if SENTRY_DSN is set and the SDK is installed; else no-op."""
    dsn = os.environ.get("SENTRY_DSN")
    if not dsn:
        return False
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=dsn,
            release=f"heston-regime-lab@{version}",
            environment=os.environ.get("ENVIRONMENT", "production"),
            traces_sample_rate=float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0.0")),
        )
        return True
    except Exception:  # noqa: BLE001 — error tracking must never break startup
        return False


def _cors_origins(api_cfg: dict) -> list[str]:
    """Production CORS origins from the env var if set, else the config defaults.

    Set ``CORS_ORIGINS`` (comma-separated) in production to restrict to the deployed
    frontend origin only.
    """
    env_name = api_cfg.get("cors_origins_env", "CORS_ORIGINS")
    raw = os.environ.get(env_name, "")
    if raw.strip():
        return [o.strip() for o in raw.split(",") if o.strip()]
    return list(api_cfg["cors_origins"])


OPENAPI_TAGS = [
    {"name": "calibration", "description": "Fit Heston to the live SPX surface; background jobs."},
    {"name": "surface", "description": "Market vs Heston implied-vol surface grids."},
    {"name": "regime", "description": "HMM market-regime detection and analysis."},
    {"name": "comparison", "description": "Heston vs Black-Scholes vs residual-corrected errors."},
    {"name": "health", "description": "Service liveness and cache status."},
]

DESCRIPTION = """
Live API over the **heston-regime-lab** research stack:

* **/api/calibration/run** — calibrate Heston (κ, θ, σ, ρ, v₀) to the current SPX surface.
* **/api/surface** — market & Heston implied-vol grids for a 3D surface chart.
* **/api/regime/current**, **/api/regime/history** — HMM regime detection (3 states).
* **/api/comparison** — Heston vs Black-Scholes vs XGBoost residual-corrected pricing error.
* **/ws/calibration** — live L-BFGS-B convergence stream.

Data is pulled live from yfinance/FRED, with a deterministic **synthetic fallback** so the
API runs offline; every response carries a `provenance` block (source + staleness).
"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Build shared state on startup; warm the regime model when running offline."""
    config = load_config(CONFIG_PATH)
    app.state.config = config
    app.state.cache = build_cache(config)
    app.state.jobs = {}  # background calibration-job registry
    app.state.jobs_lock = threading.RLock()
    app.state.regime_warm = False
    log.info(
        "startup",
        extra={"cache_backend": app.state.cache.backend, "sentry": app.state.sentry_on},
    )

    # Warm the (fast) synthetic regime model when offline so the first call is instant.
    # In live mode we warm lazily to avoid blocking startup on a 20y network pull.
    if os.environ.get("HRL_OFFLINE", "").lower() in ("1", "true", "yes"):
        try:
            from api.services.regime_service import get_regime_bundle

            get_regime_bundle(config, prefer_live=False)
            app.state.regime_warm = True
        except Exception:  # noqa: BLE001 — warming is best-effort
            app.state.regime_warm = False

    yield


def create_app() -> FastAPI:
    configure_logging()
    config = load_config(CONFIG_PATH)
    api_cfg = config["api"]

    sentry_on = _init_sentry(api_cfg["version"])

    app = FastAPI(
        title=api_cfg["title"],
        version=api_cfg["version"],
        description=DESCRIPTION,
        openapi_tags=OPENAPI_TAGS,
        lifespan=lifespan,
    )
    app.state.sentry_on = sentry_on

    # Compress large JSON payloads (surfaces, regime history) over the wire.
    app.add_middleware(GZipMiddleware, minimum_size=500)

    # CORS: restrict to the deployed frontend origin in production via CORS_ORIGINS.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(api_cfg),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        """Emit one structured log line per request (and per unhandled error)."""
        request_id = uuid.uuid4().hex[:12]
        start = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = round((time.perf_counter() - start) * 1000, 1)
            log.exception(
                "request_error",
                extra={
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": duration_ms,
                },
            )
            raise
        duration_ms = round((time.perf_counter() - start) * 1000, 1)
        log.info(
            "request",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
            },
        )
        response.headers["X-Request-ID"] = request_id
        return response

    app.include_router(calibration.router)
    app.include_router(surface.router)
    app.include_router(regime.router)
    app.include_router(comparison.router)

    @app.get("/health", response_model=HealthResponse, tags=["health"], summary="Health check")
    async def health() -> HealthResponse:
        from api.services.regime_service import regime_model_ready

        cache = app.state.cache
        # Redis clients perform network I/O even for a ping. Keep that work off the
        # event loop and reuse the single result for the two related health fields.
        cache_healthy = await run_in_threadpool(lambda: cache.healthy)
        cache_backend = cache.backend
        return HealthResponse(
            version=api_cfg["version"],
            cache_backend=cache_backend,
            cache_healthy=cache_healthy,
            redis_configured=cache.redis_configured,
            redis_healthy=cache_backend == "redis" and cache_healthy,
            regime_model_ready=regime_model_ready(app.state.config),
            time=datetime.now(timezone.utc),
        )

    @app.websocket("/ws/calibration")
    async def calibration_ws(websocket: WebSocket) -> None:
        await stream_calibration(websocket, app.state.config, app.state.cache)

    return app


app = create_app()

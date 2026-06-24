"""FastAPI application: wires the Heston/HMM research into a live, cached API.

Responsibilities:
* load config and build the shared cache (Redis or in-memory) on startup (lifespan),
* register the calibration / surface / regime / comparison routers and the calibration
  WebSocket,
* configure CORS for local frontend development,
* expose a health check and clean, tagged OpenAPI docs.

Run locally:  ``uvicorn api.main:app --reload``
Offline mode (no network): set ``HRL_OFFLINE=1`` so every endpoint uses synthetic data.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from api.cache.redis_client import build_cache
from api.models.schemas import HealthResponse
from api.routes import calibration, comparison, regime, surface
from api.websocket.calibration_stream import stream_calibration
from calibration.optimizer import load_config

CONFIG_PATH = Path(__file__).resolve().parents[1] / "configs" / "base.yaml"

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
    app.state.regime_warm = False

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
    config = load_config(CONFIG_PATH)
    api_cfg = config["api"]

    app = FastAPI(
        title=api_cfg["title"],
        version=api_cfg["version"],
        description=DESCRIPTION,
        openapi_tags=OPENAPI_TAGS,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(api_cfg["cors_origins"]),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(calibration.router)
    app.include_router(surface.router)
    app.include_router(regime.router)
    app.include_router(comparison.router)

    @app.get("/health", response_model=HealthResponse, tags=["health"], summary="Health check")
    async def health() -> HealthResponse:
        cache = app.state.cache
        return HealthResponse(
            version=api_cfg["version"],
            cache_backend=cache.backend,
            redis_healthy=cache.healthy,
            regime_model_ready=bool(getattr(app.state, "regime_warm", False)),
            time=datetime.now(timezone.utc),
        )

    @app.websocket("/ws/calibration")
    async def calibration_ws(websocket: WebSocket) -> None:
        await stream_calibration(websocket, app.state.config, app.state.cache)

    return app


app = create_app()

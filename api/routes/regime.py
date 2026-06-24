"""Regime routes: current regime (fast), full history, and parameter-significance analysis.

``/current`` and ``/history`` read the in-process fitted HMM, so they are fast and cached.
``/parameters`` (Kruskal-Wallis + static-vs-regime calibration) is heavy: on a cache miss
it is queued as a background task and the request returns ``202`` with a poll hint.
"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from api.cache.redis_client import Cache
from api.deps import get_cache, get_config, resolve_prefer_live
from api.models.schemas import (
    RegimeCurrentResponse,
    RegimeHistoryResponse,
    RegimeParametersResponse,
)
from api.services.regime_service import (
    get_current_regime,
    get_regime_history,
    get_regime_parameters,
    has_regime_parameters,
)

router = APIRouter(prefix="/api/regime", tags=["regime"])


@router.get("/current", response_model=RegimeCurrentResponse,
            summary="Current market regime with posterior probabilities")
async def regime_current(
    config: dict = Depends(get_config),
    cache: Cache = Depends(get_cache),
    prefer_live: bool = Depends(resolve_prefer_live),
) -> RegimeCurrentResponse:
    """Latest detected regime (0/1/2), its label, and P(regime | data). Sub-200ms (cached)."""
    result = await run_in_threadpool(get_current_regime, config, cache, prefer_live)
    return RegimeCurrentResponse(**result)


@router.get("/history", response_model=RegimeHistoryResponse,
            summary="Historical regime path over SPX price")
async def regime_history(
    downsample: int = 1,
    config: dict = Depends(get_config),
    cache: Cache = Depends(get_cache),
    prefer_live: bool = Depends(resolve_prefer_live),
) -> RegimeHistoryResponse:
    """Full regime sequence overlaid on SPX price for the historical overlay chart."""
    result = await run_in_threadpool(get_regime_history, config, cache, prefer_live, downsample)
    return RegimeHistoryResponse(**result)


@router.get("/parameters", response_model=RegimeParametersResponse,
            responses={202: {"description": "Analysis is being computed; poll again."}},
            summary="Do Heston params differ by regime? (Kruskal-Wallis + static vs conditional)")
async def regime_parameters(
    background: BackgroundTasks,
    config: dict = Depends(get_config),
    cache: Cache = Depends(get_cache),
):
    """Kruskal-Wallis significance per parameter and static-vs-regime-conditional accuracy.

    Heavy (dozens of calibrations).  Returns the cached result if ready, else schedules the
    computation in the background and returns ``202``.
    """
    if has_regime_parameters(config, cache):
        result = await run_in_threadpool(get_regime_parameters, config, cache)
        return RegimeParametersResponse(**result)

    background.add_task(get_regime_parameters, config, cache)
    return JSONResponse(
        status_code=202,
        content={"status": "computing", "poll": "/api/regime/parameters"},
    )

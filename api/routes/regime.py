"""Regime routes: current regime (fast), full history, and parameter-significance analysis.

``/current`` and ``/history`` read the in-process fitted HMM, so they are fast and cached.
``/parameters`` (Kruskal-Wallis + static-vs-regime calibration) is heavy: on a cache miss
it is queued as a background task and the request returns ``202`` with a poll hint.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from api.cache.redis_client import Cache, session_suffix
from api.deps import get_cache, get_config, resolve_prefer_live
from api.models.schemas import (
    RegimeCurrentResponse,
    RegimeHistoryResponse,
    RegimeParametersResponse,
)
from api.services import regime_service as _regime_service
from api.services.regime_service import (
    get_current_regime,
    get_regime_history,
    get_regime_parameters,
    regime_parameters_cache_key,
)

router = APIRouter(prefix="/api/regime", tags=["regime"])

# Kept as a module attribute for callers/tests that imported the former route helper.
has_regime_parameters = _regime_service.has_regime_parameters


@router.get(
    "/current",
    response_model=RegimeCurrentResponse,
    summary="Current market regime with posterior probabilities",
)
async def regime_current(
    config: dict = Depends(get_config),
    cache: Cache = Depends(get_cache),
    prefer_live: bool = Depends(resolve_prefer_live),
) -> RegimeCurrentResponse:
    """Latest detected regime (0/1/2), its label, and P(regime | data). Sub-200ms (cached)."""
    result = await run_in_threadpool(get_current_regime, config, cache, prefer_live)
    return RegimeCurrentResponse(**result)


@router.get(
    "/history",
    response_model=RegimeHistoryResponse,
    summary="Historical regime path over SPX price",
)
async def regime_history(
    downsample: int = Query(
        default=1,
        ge=1,
        le=5000,
        description="Return every Nth daily observation (1-5000).",
    ),
    config: dict = Depends(get_config),
    cache: Cache = Depends(get_cache),
    prefer_live: bool = Depends(resolve_prefer_live),
) -> RegimeHistoryResponse:
    """Full regime sequence overlaid on SPX price for the historical overlay chart."""
    result = await run_in_threadpool(get_regime_history, config, cache, prefer_live, downsample)
    return RegimeHistoryResponse(**result)


@router.get(
    "/parameters",
    response_model=RegimeParametersResponse,
    responses={202: {"description": "Analysis is being computed; poll again."}},
    summary="Do Heston params differ by regime? (Kruskal-Wallis + static vs conditional)",
)
async def regime_parameters(
    background: BackgroundTasks,
    config: dict = Depends(get_config),
    cache: Cache = Depends(get_cache),
):
    """Kruskal-Wallis significance per parameter and static-vs-regime-conditional accuracy.

    Heavy (dozens of calibrations).  Returns the cached result if ready, else schedules the
    computation in the background and returns ``202``.
    """
    session = session_suffix()
    result_key = regime_parameters_cache_key(config, session=session)
    entry = cache.get_entry(result_key)
    if entry is not None and entry[2]:
        result = await run_in_threadpool(get_regime_parameters, config, cache, 8, session)
        return RegimeParametersResponse(**result)

    lock_key = f"job:{result_key}"
    lease_ttl = max(60, int(config["api"].get("regime_analysis_timeout", 3600)))
    owner = uuid.uuid4().hex
    acquired = cache.set_if_absent(lock_key, owner, ttl=lease_ttl)
    if acquired:

        def _compute_and_release() -> None:
            try:
                get_regime_parameters(config, cache, n_samples=8, session=session)
            finally:
                cache.delete_if_value(lock_key, owner)

        background.add_task(_compute_and_release)
    return JSONResponse(
        status_code=202,
        content={"status": "computing", "poll": "/api/regime/parameters"},
    )

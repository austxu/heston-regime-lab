"""Comparison route: Heston vs Black-Scholes vs Heston+residual pricing errors."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.concurrency import run_in_threadpool

from api.cache.redis_client import Cache
from api.deps import get_cache, get_config, resolve_prefer_live
from api.models.schemas import ComparisonResponse
from api.services.comparison_service import get_comparison

router = APIRouter(prefix="/api", tags=["comparison"])


@router.get("/comparison", response_model=ComparisonResponse,
            summary="Heston vs Black-Scholes vs residual-corrected errors")
async def comparison(
    config: dict = Depends(get_config),
    cache: Cache = Depends(get_cache),
    prefer_live: bool = Depends(resolve_prefer_live),
) -> ComparisonResponse:
    """Mean abs IV error for flat-BS, Heston, and Heston+XGBoost-residual, by strike/maturity."""
    result = await run_in_threadpool(get_comparison, config, cache, prefer_live)
    return ComparisonResponse(**result)

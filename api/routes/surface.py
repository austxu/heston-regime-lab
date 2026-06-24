"""Surface route: market vs Heston implied-vol grids for the 3D surface chart."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.concurrency import run_in_threadpool

from api.cache.redis_client import Cache
from api.deps import get_cache, get_config, resolve_prefer_live
from api.models.schemas import SurfaceResponse
from api.services.surface_service import get_surface

router = APIRouter(prefix="/api", tags=["surface"])


@router.get("/surface", response_model=SurfaceResponse, summary="Implied-vol surface (market + Heston)")
async def surface(
    config: dict = Depends(get_config),
    cache: Cache = Depends(get_cache),
    prefer_live: bool = Depends(resolve_prefer_live),
) -> SurfaceResponse:
    """Market and Heston IV on a (moneyness × maturity) grid, ready for a Plotly surface."""
    result = await run_in_threadpool(get_surface, config, cache, prefer_live)
    return SurfaceResponse(**result)

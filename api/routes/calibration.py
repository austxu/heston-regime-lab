"""Calibration routes: run a fit synchronously, or queue a long one as a background job.

* ``GET /api/calibration/run`` — fetch the live SPX surface, calibrate Heston, return the
  parameters and fit error.  Cached per session, so the first call does the work and the
  rest are instant.
* ``POST /api/calibration/jobs`` / ``GET /api/calibration/jobs/{id}`` — a
  ``BackgroundTasks`` queue for long calibrations that should not block the request.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from api.cache.redis_client import Cache
from api.deps import get_cache, get_config, resolve_prefer_live
from api.models.schemas import (
    CalibrationResponse,
    JobAcceptedResponse,
    JobStatusResponse,
)
from api.ratelimit import calibration_rate_limit
from api.services.calibration_service import run_calibration

router = APIRouter(prefix="/api/calibration", tags=["calibration"])


@router.get(
    "/run",
    response_model=CalibrationResponse,
    summary="Calibrate Heston to live SPX",
    dependencies=[Depends(calibration_rate_limit)],
)
async def calibration_run(
    config: dict = Depends(get_config),
    cache: Cache = Depends(get_cache),
    prefer_live: bool = Depends(resolve_prefer_live),
) -> CalibrationResponse:
    """Calibrate Heston (κ, θ, σ, ρ, v₀) to the current SPX surface and report fit error."""
    result = await run_in_threadpool(run_calibration, config, cache, prefer_live)
    return CalibrationResponse(**result)


@router.post("/jobs", response_model=JobAcceptedResponse, status_code=202,
             summary="Queue a calibration as a background job")
async def calibration_job(
    request: Request,
    background: BackgroundTasks,
    config: dict = Depends(get_config),
    cache: Cache = Depends(get_cache),
    prefer_live: bool = Depends(resolve_prefer_live),
) -> JobAcceptedResponse:
    """Queue a (potentially slow) calibration; poll ``/api/calibration/jobs/{id}``."""
    jobs = request.app.state.jobs
    job_id = uuid.uuid4().hex[:12]
    jobs[job_id] = {"status": "queued", "result": None, "error": None}

    def _run() -> None:
        jobs[job_id]["status"] = "running"
        try:
            jobs[job_id]["result"] = run_calibration(config, cache, prefer_live)
            jobs[job_id]["status"] = "done"
        except Exception as exc:  # noqa: BLE001
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = str(exc)

    background.add_task(_run)
    return JobAcceptedResponse(job_id=job_id, poll=f"/api/calibration/jobs/{job_id}")


@router.get("/jobs/{job_id}", response_model=JobStatusResponse, summary="Poll a calibration job")
async def calibration_job_status(
    job_id: str, request: Request
) -> JobStatusResponse:
    job = request.app.state.jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job_id")
    result = CalibrationResponse(**job["result"]) if job["result"] else None
    return JobStatusResponse(job_id=job_id, status=job["status"], result=result, error=job["error"])

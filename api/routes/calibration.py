"""Calibration routes: run a fit synchronously, or queue a long one as a background job.

* ``GET /api/calibration/run`` — fetch the live SPX surface, calibrate Heston, return the
  parameters and fit error.  Cached per session, so the first call does the work and the
  rest are instant.
* ``POST /api/calibration/jobs`` / ``GET /api/calibration/jobs/{id}`` — a
  ``BackgroundTasks`` queue for long calibrations that should not block the request.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from api.cache.redis_client import Cache
from api.deps import get_cache, get_config, resolve_prefer_live
from api.models.schemas import (
    CalibrationResponse,
    JobAcceptedResponse,
    JobStatusResponse,
)
from api.ratelimit import calibration_job_rate_limit, calibration_rate_limit
from api.services.calibration_service import run_calibration

router = APIRouter(prefix="/api/calibration", tags=["calibration"])


def _prune_jobs(jobs: dict, *, now: datetime, ttl: int, max_jobs: int) -> None:
    """Remove expired/old terminal jobs without discarding work in progress."""
    terminal = {"done", "error"}
    for job_id, job in list(jobs.items()):
        updated_at = job.get("updated_at", job["created_at"])
        if job["status"] in terminal and (now - updated_at).total_seconds() >= ttl:
            jobs.pop(job_id, None)

    overflow = max(0, len(jobs) - max_jobs + 1)
    completed = sorted(
        (
            (job.get("updated_at", job["created_at"]), job_id)
            for job_id, job in jobs.items()
            if job["status"] in terminal
        ),
        key=lambda item: item[0],
    )
    for _, job_id in completed[:overflow]:
        jobs.pop(job_id, None)


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


@router.post(
    "/jobs",
    response_model=JobAcceptedResponse,
    status_code=202,
    summary="Queue a calibration as a background job",
    dependencies=[Depends(calibration_job_rate_limit)],
)
async def calibration_job(
    request: Request,
    background: BackgroundTasks,
    config: dict = Depends(get_config),
    cache: Cache = Depends(get_cache),
    prefer_live: bool = Depends(resolve_prefer_live),
) -> JobAcceptedResponse:
    """Queue a (potentially slow) calibration; poll ``/api/calibration/jobs/{id}``."""
    jobs = request.app.state.jobs
    lock = request.app.state.jobs_lock
    job_cfg = config["api"].get("jobs", {})
    ttl = max(1, int(job_cfg.get("retention_seconds", 3600)))
    max_jobs = max(1, int(job_cfg.get("max_entries", 100)))
    job_id = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc)
    with lock:
        _prune_jobs(jobs, now=now, ttl=ttl, max_jobs=max_jobs)
        if len(jobs) >= max_jobs:
            raise HTTPException(status_code=503, detail="calibration job queue is full")
        jobs[job_id] = {
            "status": "queued",
            "result": None,
            "error": None,
            "created_at": now,
            "updated_at": now,
        }

    def _run() -> None:
        with lock:
            jobs[job_id]["status"] = "running"
            jobs[job_id]["updated_at"] = datetime.now(timezone.utc)
        try:
            result = run_calibration(config, cache, prefer_live)
            with lock:
                jobs[job_id]["result"] = result
                jobs[job_id]["status"] = "done"
                jobs[job_id]["updated_at"] = datetime.now(timezone.utc)
        except Exception as exc:  # noqa: BLE001
            with lock:
                jobs[job_id]["status"] = "error"
                jobs[job_id]["error"] = str(exc)[:2000]
                jobs[job_id]["updated_at"] = datetime.now(timezone.utc)

    background.add_task(_run)
    return JobAcceptedResponse(job_id=job_id, poll=f"/api/calibration/jobs/{job_id}")


@router.get("/jobs/{job_id}", response_model=JobStatusResponse, summary="Poll a calibration job")
async def calibration_job_status(job_id: str, request: Request) -> JobStatusResponse:
    with request.app.state.jobs_lock:
        stored = request.app.state.jobs.get(job_id)
        job = dict(stored) if stored is not None else None
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job_id")
    result = CalibrationResponse(**job["result"]) if job["result"] else None
    return JobStatusResponse(job_id=job_id, status=job["status"], result=result, error=job["error"])

"""Per-IP rate limiting backed by the shared cache.

Calibration is expensive, so ``/api/calibration/run`` is capped at one call per window per
client IP (default 60s). The limiter reuses the app cache (Redis in prod, in-memory in
dev) so the limit is shared across workers when Redis is present. Behind Railway/N proxies
the real client IP comes from the first hop of ``X-Forwarded-For``.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException, Request

from api.cache.redis_client import Cache


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def make_rate_limiter(bucket: str):
    """Build a FastAPI dependency enforcing one request per window per IP for ``bucket``.

    The window (and an on/off switch) come from ``config.api.rate_limit``. Returns a
    dependency that raises HTTP 429 with a ``Retry-After`` header when tripped.
    """

    async def dependency(request: Request) -> None:
        rl = request.app.state.config["api"].get("rate_limit", {})
        if not rl.get("enabled", True):
            return
        window = int(rl.get("window_seconds", 60))
        cache: Cache = request.app.state.cache
        ip = _client_ip(request)
        key = f"ratelimit:{bucket}:{ip}"

        entry = cache.get_entry(key)
        if entry is not None and entry[2]:  # a fresh entry == within the window
            _, cached_at, _ = entry
            age = (datetime.now(timezone.utc) - cached_at).total_seconds()
            retry_after = max(1, int(window - age))
            raise HTTPException(
                status_code=429,
                detail=f"Rate limit exceeded: max 1 request per {window}s for this endpoint.",
                headers={"Retry-After": str(retry_after)},
            )
        cache.set(key, {"hit": datetime.now(timezone.utc).isoformat()}, ttl=window)

    return dependency


# Shared instance for the calibration endpoint.
calibration_rate_limit = make_rate_limiter("calibration_run")

"""Per-IP rate limiting backed by the shared cache.

Calibration is expensive, so ``/api/calibration/run`` is capped at one call per window per
client IP (default 60s). The limiter reuses the app cache (Redis in prod, in-memory in
dev) so the limit is shared across workers when Redis is present. Behind the trusted
Railway/nginx edge, the real client IP comes from the rightmost valid forwarded address.
"""

from __future__ import annotations

from datetime import datetime, timezone
from ipaddress import ip_address

from fastapi import HTTPException, Request

from api.cache.redis_client import Cache


def _client_ip(request: Request, trust_proxy_headers: bool) -> str:
    candidates: list[str] = []
    if trust_proxy_headers:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            # With one trusted nginx/Railway edge, the rightmost address is the one
            # appended by that edge.  Taking the leftmost value would let a client
            # prepend a spoofed address and evade the limiter.
            candidates.extend(
                part.strip() for part in reversed(forwarded.split(",")) if part.strip()
            )
        real_ip = request.headers.get("x-real-ip")
        if real_ip:
            candidates.append(real_ip.strip())
    if request.client:
        candidates.append(request.client.host)
    for candidate in candidates:
        try:
            return ip_address(candidate).compressed
        except ValueError:
            continue
    return "unknown"


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
        if window < 1:
            raise RuntimeError("api.rate_limit.window_seconds must be >= 1")
        cache: Cache = request.app.state.cache
        ip = _client_ip(
            request,
            trust_proxy_headers=bool(
                request.app.state.config["api"].get("trust_proxy_headers", True)
            ),
        )
        key = f"ratelimit:{bucket}:{ip}"

        admitted = cache.set_if_absent(
            key, {"hit": datetime.now(timezone.utc).isoformat()}, ttl=window
        )
        if not admitted:
            entry = cache.get_entry(key)
            cached_at = entry[1] if entry is not None else datetime.now(timezone.utc)
            age = (datetime.now(timezone.utc) - cached_at).total_seconds()
            retry_after = max(1, int(window - age))
            raise HTTPException(
                status_code=429,
                detail=f"Rate limit exceeded: max 1 request per {window}s for this endpoint.",
                headers={"Retry-After": str(retry_after)},
            )

    return dependency


# Shared instance for the calibration endpoint.
calibration_rate_limit = make_rate_limiter("calibration_run")
calibration_job_rate_limit = make_rate_limiter("calibration_job")

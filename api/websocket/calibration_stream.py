"""WebSocket calibration streaming: push L-BFGS-B convergence in real time.

The optimisation is synchronous and CPU-bound, so we run it in a worker thread and bridge
its per-iteration ``callback`` to the event loop through a thread-safe queue.  The handler
drains that queue and forwards each :class:`CalibrationProgress` as a JSON frame, then a
final ``done`` frame with the fitted parameters and fit error.

Robustness: the client may disconnect at any time.  We detect a closed socket while
sending and signal the worker to stop, and we guard every send so a dropped connection
tears the job down cleanly instead of leaking a thread.
"""

from __future__ import annotations

import asyncio
import os
import threading
import uuid
from ipaddress import ip_address
from urllib.parse import urlsplit

from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from api.cache.redis_client import Cache
from api.services.pipeline import build_market_data, get_snapshot
from calibration.optimizer import CalibrationProgress, calibrate

# Sentinel marking the end of the worker's output stream.
_DONE = object()
_ACTIVE_LOCK = threading.Lock()
_ACTIVE_CALIBRATIONS = 0


def _configured_origins(config: dict) -> set[str]:
    api_cfg = config["api"]
    env_name = api_cfg.get("cors_origins_env", "CORS_ORIGINS")
    raw = os.environ.get(env_name, "")
    origins = raw.split(",") if raw.strip() else api_cfg.get("cors_origins", [])
    return {str(origin).strip().rstrip("/") for origin in origins if str(origin).strip()}


def _normalise_http_origin(value: str) -> tuple[str, str, int] | None:
    """Parse an HTTP(S) origin into a comparable scheme/host/effective-port tuple."""
    try:
        parsed = urlsplit(value)
        scheme = parsed.scheme.lower()
        if (
            scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            return None
        port = parsed.port or (443 if scheme == "https" else 80)
    except ValueError:
        return None
    return scheme, parsed.hostname.lower(), port


def _same_origin_target(websocket: WebSocket) -> tuple[str, str, int] | None:
    """Recover the browser-facing origin preserved by the trusted nginx proxy."""
    host = websocket.headers.get("host")
    if not host:
        return None

    forwarded_proto = websocket.headers.get("x-forwarded-proto")
    if forwarded_proto is not None:
        # nginx overwrites this with one normalized token. Reject lists or arbitrary
        # values rather than interpreting a client-controlled prefix.
        scheme = forwarded_proto.strip().lower()
        if scheme not in {"http", "https"}:
            return None
    else:
        websocket_scheme = getattr(getattr(websocket, "url", None), "scheme", "")
        scheme = {"ws": "http", "wss": "https"}.get(websocket_scheme.lower())
        if scheme is None:
            return None
    return _normalise_http_origin(f"{scheme}://{host}")


def _origin_allowed(websocket: WebSocket, config: dict) -> bool:
    """Allow same-origin or explicitly configured browser sockets."""
    origin = websocket.headers.get("origin")
    if origin is None:
        return True
    normalised_origin = _normalise_http_origin(origin)
    if normalised_origin is None:
        return False
    if normalised_origin == _same_origin_target(websocket):
        return True
    allowed = _configured_origins(config)
    if "*" in allowed:
        return True
    return any(normalised_origin == _normalise_http_origin(candidate) for candidate in allowed)


def _client_ip(websocket: WebSocket, config: dict) -> str:
    """Return a normalized peer address for per-IP calibration admission."""
    candidates: list[str] = []
    if config["api"].get("trust_proxy_headers", True):
        real_ip = websocket.headers.get("x-real-ip")
        if real_ip:
            candidates.append(real_ip.strip())
        forwarded = websocket.headers.get("x-forwarded-for")
        if forwarded:
            candidates.extend(
                value.strip() for value in reversed(forwarded.split(",")) if value.strip()
            )
    client = getattr(websocket, "client", None)
    if client is not None and getattr(client, "host", None):
        candidates.append(client.host)
    for candidate in candidates:
        try:
            return ip_address(candidate).compressed
        except ValueError:
            continue
    return "unknown"


def _reserve_worker(limit: int) -> bool:
    global _ACTIVE_CALIBRATIONS
    with _ACTIVE_LOCK:
        if _ACTIVE_CALIBRATIONS >= limit:
            return False
        _ACTIVE_CALIBRATIONS += 1
        return True


def _release_worker() -> None:
    global _ACTIVE_CALIBRATIONS
    with _ACTIVE_LOCK:
        _ACTIVE_CALIBRATIONS = max(0, _ACTIVE_CALIBRATIONS - 1)


async def stream_calibration(websocket: WebSocket, config: dict, cache: Cache) -> None:
    """Run a calibration and stream convergence frames over ``websocket``.

    Frames (JSON):
      {"type": "progress", "iteration", "loss", "params"}
      {"type": "done", "params", "mean_iv_error", "iteration"}
      {"type": "error", "message"}
    """
    if not _origin_allowed(websocket, config):
        await websocket.close(code=1008, reason="WebSocket origin is not allowed")
        return

    limit = int(config["api"].get("websocket", {}).get("max_concurrent_calibrations", 2))
    if limit < 1:
        await websocket.close(code=1011, reason="WebSocket calibration is disabled")
        return

    ws_cfg = config["api"].get("websocket", {})
    lease_ttl = max(60, int(ws_cfg.get("per_ip_lease_ttl", 900)))
    lease_owner = uuid.uuid4().hex
    lease_key = f"ws:calibration:{_client_ip(websocket, config)}"
    owns_ip_slot = await asyncio.to_thread(cache.set_if_absent, lease_key, lease_owner, lease_ttl)
    if not owns_ip_slot:
        await websocket.close(code=1013, reason="A calibration is already active for this client")
        return
    if not _reserve_worker(limit):
        await asyncio.to_thread(cache.delete_if_value, lease_key, lease_owner)
        await websocket.close(code=1013, reason="Calibration capacity is currently full")
        return

    lease_stop = threading.Event()

    def renew_lease() -> None:
        # Keep admission tied to the actual worker lifetime, not merely the initial
        # lease TTL.  compare-and-refresh prevents a delayed heartbeat from touching a
        # lease that expired and was acquired by a newer owner.
        interval = max(1.0, lease_ttl / 3)
        while not lease_stop.wait(interval):
            if not cache.refresh_if_value(lease_key, lease_owner, lease_ttl):
                return

    try:
        threading.Thread(
            target=renew_lease,
            daemon=True,
            name="hrl-ws-lease-heartbeat",
        ).start()
    except Exception:
        _release_worker()
        cache.delete_if_value(lease_key, lease_owner)
        raise

    try:
        await websocket.accept()
    except asyncio.CancelledError:
        lease_stop.set()
        _release_worker()
        cache.delete_if_value(lease_key, lease_owner)
        raise
    except Exception:
        lease_stop.set()
        _release_worker()
        cache.delete_if_value(lease_key, lease_owner)
        raise
    prefer_live = _parse_prefer_live(websocket)

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    stop = threading.Event()

    def emit(item) -> None:
        # Called from the worker thread; hop back onto the event loop thread-safely.
        try:
            loop.call_soon_threadsafe(queue.put_nowait, item)
        except RuntimeError:
            stop.set()  # event loop already closed

    def worker() -> None:
        try:
            snapshot, _ = get_snapshot(config, cache, prefer_live=prefer_live)
            data, _ = build_market_data(snapshot, config)

            def on_step(p: CalibrationProgress) -> None:
                if stop.is_set():
                    raise _Aborted()
                emit(
                    {
                        "type": "progress",
                        "iteration": p.iteration,
                        "loss": float(p.loss),
                        "params": p.params,
                    }
                )

            result = calibrate(data, config, callback=on_step)
            emit(
                {
                    "type": "done",
                    "iteration": result.n_iter,
                    "params": {
                        "kappa": result.params.kappa,
                        "theta": result.params.theta,
                        "sigma": result.params.sigma,
                        "rho": result.params.rho,
                        "v0": result.params.v0,
                    },
                    "mean_iv_error": result.mean_abs_iv_error,
                    "message": result.message,
                }
            )
        except _Aborted:
            pass  # client disconnected; nothing more to send
        except Exception as exc:  # noqa: BLE001 — report any compute error to the client
            emit({"type": "error", "message": str(exc)})
        finally:
            lease_stop.set()
            _release_worker()
            cache.delete_if_value(lease_key, lease_owner)
            emit(_DONE)

    try:
        threading.Thread(target=worker, daemon=True, name="hrl-ws-calibration").start()
    except Exception:
        lease_stop.set()
        _release_worker()
        cache.delete_if_value(lease_key, lease_owner)
        raise

    try:
        while True:
            item = await queue.get()
            if item is _DONE:
                break
            if websocket.client_state != WebSocketState.CONNECTED:
                break
            await websocket.send_json(item)
    except WebSocketDisconnect:
        stop.set()  # tell the worker to abort at its next iteration
    finally:
        stop.set()
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.close()


def _parse_prefer_live(websocket: WebSocket) -> bool:
    """Read ``?live=`` with the same HRL_OFFLINE default as HTTP endpoints."""
    explicit = websocket.query_params.get("live")
    if explicit is None:
        return os.environ.get("HRL_OFFLINE", "").lower() not in ("1", "true", "yes")
    val = explicit.lower()
    return val not in ("0", "false", "no")


class _Aborted(Exception):
    """Internal signal that the client went away mid-optimisation."""

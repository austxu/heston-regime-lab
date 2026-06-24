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
import threading

from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from api.cache.redis_client import Cache
from api.services.pipeline import build_market_data, get_snapshot
from calibration.optimizer import CalibrationProgress, calibrate

# Sentinel marking the end of the worker's output stream.
_DONE = object()


async def stream_calibration(websocket: WebSocket, config: dict, cache: Cache) -> None:
    """Run a calibration and stream convergence frames over ``websocket``.

    Frames (JSON):
      {"type": "progress", "iteration", "loss", "params"}
      {"type": "done", "params", "mean_iv_error", "iteration"}
      {"type": "error", "message"}
    """
    await websocket.accept()
    prefer_live = _parse_prefer_live(websocket)

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    stop = threading.Event()

    def emit(item) -> None:
        # Called from the worker thread; hop back onto the event loop thread-safely.
        loop.call_soon_threadsafe(queue.put_nowait, item)

    def worker() -> None:
        try:
            snapshot, _ = get_snapshot(config, cache, prefer_live=prefer_live)
            data, _ = build_market_data(snapshot, config)

            def on_step(p: CalibrationProgress) -> None:
                if stop.is_set():
                    raise _Aborted()
                emit({"type": "progress", "iteration": p.iteration,
                      "loss": float(p.loss), "params": p.params})

            result = calibrate(data, config, callback=on_step)
            emit({"type": "done",
                  "iteration": result.n_iter,
                  "params": {"kappa": result.params.kappa, "theta": result.params.theta,
                             "sigma": result.params.sigma, "rho": result.params.rho,
                             "v0": result.params.v0},
                  "mean_iv_error": result.mean_abs_iv_error,
                  "message": result.message})
        except _Aborted:
            pass  # client disconnected; nothing more to send
        except Exception as exc:  # noqa: BLE001 — report any compute error to the client
            emit({"type": "error", "message": str(exc)})
        finally:
            emit(_DONE)

    threading.Thread(target=worker, daemon=True).start()

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
    """Read ?live=true|false from the query string (defaults to live)."""
    val = websocket.query_params.get("live", "true").lower()
    return val not in ("0", "false", "no")


class _Aborted(Exception):
    """Internal signal that the client went away mid-optimisation."""

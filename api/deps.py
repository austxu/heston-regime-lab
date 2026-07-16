"""FastAPI dependencies: shared config, cache, and the live-vs-offline switch.

Config and the cache live on ``app.state`` (set up in :mod:`api.main`); these providers
expose them to routes via ``Depends``.  ``resolve_prefer_live`` centralises the data-mode
decision: an explicit ``?live=`` query param wins, otherwise the ``HRL_OFFLINE`` env var
flips the default (handy for running the API with no network).
"""

from __future__ import annotations

import os

from fastapi import Query, Request

from api.cache.redis_client import Cache


def get_config(request: Request) -> dict:
    return request.app.state.config


def get_cache(request: Request) -> Cache:
    return request.app.state.cache


def resolve_prefer_live(
    live: bool | None = Query(
        default=None,
        description="Force live (true) or offline/synthetic (false) data. "
        "Defaults to live unless HRL_OFFLINE is set.",
    ),
) -> bool:
    if live is not None:
        return live
    return os.environ.get("HRL_OFFLINE", "").lower() not in ("1", "true", "yes")

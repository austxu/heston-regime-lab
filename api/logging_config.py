"""Structured (JSON) logging for the API.

In production (``LOG_FORMAT=json``, the default in the container) every log line is a single
JSON object — easy for Railway / log aggregators to parse. Locally you can set
``LOG_FORMAT=text`` for human-readable logs. Request-level access logs are emitted by the
middleware in :mod:`api.main`; this module just configures the handler/formatter.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone

# Standard LogRecord attributes we don't want to duplicate into the JSON "extra" fields.
_RESERVED = set(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime", "taskName"}


class JsonFormatter(logging.Formatter):
    """Render a LogRecord as a compact JSON object, including any ``extra=`` fields."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        # Merge structured extras passed via logger.info(..., extra={...}).
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        return json.dumps(payload, default=str)


def configure_logging() -> None:
    """Install a single stdout handler with the JSON (or text) formatter on the root logger."""
    fmt = os.environ.get("LOG_FORMAT", "json").lower()
    level = os.environ.get("LOG_LEVEL", "INFO").upper()

    handler = logging.StreamHandler(sys.stdout)
    if fmt == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)
    # Uvicorn's own access log is redundant with our structured request middleware.
    logging.getLogger("uvicorn.access").handlers.clear()
    logging.getLogger("uvicorn.access").propagate = False
    # Quiet chatty client libraries (httpx is only used by the test client).
    for noisy in ("httpx", "httpcore", "urllib3", "yfinance", "peewee"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str = "hrl.api") -> logging.Logger:
    return logging.getLogger(name)

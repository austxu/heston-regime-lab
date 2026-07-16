"""Global test isolation for deterministic, side-effect-free runs."""

from __future__ import annotations

import os

# Tests must never contact live market data, a developer's Redis instance, or Sentry merely
# because those variables happen to exist in the invoking shell. Individual tests can use
# monkeypatch when they intentionally exercise an environment override.
os.environ["HRL_OFFLINE"] = "1"
for external_setting in ("REDIS_URL", "SENTRY_DSN", "CORS_ORIGINS"):
    os.environ.pop(external_setting, None)

"""Caching layer: Redis-backed with a transparent in-process fallback.

The API caches expensive results (calibration, regime inference, surfaces).  Two
behaviours matter for a research API serving live-ish market data:

* **Graceful degradation.**  If Redis is unreachable (no server, wrong URL, dropped
  connection) the cache silently falls back to an in-process dict so the API keeps
  working — just without cross-process sharing.  ``backend`` reports which is active.

* **Serve-stale-on-error.**  :meth:`Cache.get_or_compute` runs a producer to refresh a
  key; if the producer *raises* (e.g. a live yfinance fetch fails) it returns the last
  cached value flagged ``stale=True`` with its original timestamp, rather than erroring.
  A ``fallback`` producer (e.g. synthetic data) is used only when nothing is cached.

**Invalidation** is twofold: a per-key TTL, and a *market-session* component folded into
keys (:func:`session_suffix`) so cached values roll over at the next session — "stale
after market close, refresh on next open".
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

_EASTERN = ZoneInfo("America/New_York")


def _json_default(o: Any):
    """JSON encoder for numpy scalars/arrays and datetimes used across responses."""
    import numpy as np

    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, datetime):
        return o.isoformat()
    raise TypeError(f"not JSON serialisable: {type(o)}")


def session_suffix(now: datetime | None = None) -> str:
    """The current US-equity *trading session* date, as a cache-key component.

    Before the 09:30 ET open (or on weekends) we attribute activity to the previous
    business day, so a key minted after close stays valid until the next open and then
    naturally misses.  This is a simplified calendar (no exchange holidays) — documented
    as a known limitation.
    """
    now = (now or datetime.now(timezone.utc)).astimezone(_EASTERN)
    session = now.date()
    before_open = (now.hour, now.minute) < (9, 30)
    # Roll back over the weekend and (approximately) over pre-open hours.
    if before_open:
        session = session.fromordinal(session.toordinal() - 1)
    while session.weekday() >= 5:  # Sat=5, Sun=6
        session = session.fromordinal(session.toordinal() - 1)
    return session.isoformat()


@dataclass
class CacheResult:
    """A value plus how it was served, so endpoints can report staleness."""

    value: Any
    cached_at: datetime
    hit: bool  # served from cache without recomputation
    stale: bool  # producer failed; this is an older value


class Cache:
    """Key/value cache over Redis with an in-memory fallback and stale-serving."""

    def __init__(self, url: str | None = None, namespace: str = "hrl"):
        self.namespace = namespace
        self._redis_configured = bool(url)
        self._mem: dict[str, str] = {}
        self._lock = threading.RLock()
        self._compute_locks: dict[str, threading.Lock] = {}
        self._redis = None
        if url:
            try:
                import redis

                client = redis.Redis.from_url(
                    url, socket_connect_timeout=0.5, socket_timeout=0.5, decode_responses=True
                )
                client.ping()
                self._redis = client
            except Exception:  # noqa: BLE001 — any redis problem -> in-memory
                self._redis = None

    @property
    def backend(self) -> str:
        return "redis" if self._redis is not None else "memory"

    @property
    def redis_configured(self) -> bool:
        """Whether a Redis URL was supplied, independent of connection success."""
        return self._redis_configured

    @property
    def healthy(self) -> bool:
        if self._redis is None:
            return True  # in-memory always available
        try:
            return bool(self._redis.ping())
        except Exception:  # noqa: BLE001
            return False

    def _key(self, key: str) -> str:
        return f"{self.namespace}:{key}"

    # -- low-level get/set ------------------------------------------------- #
    def _get_raw(self, key: str) -> str | None:
        nk = self._key(key)
        if self._redis is not None:
            try:
                return self._redis.get(nk)
            except Exception:  # noqa: BLE001 — connection dropped mid-flight
                self._redis = None  # demote to memory for the rest of the process
        with self._lock:
            return self._mem.get(nk)

    def _set_raw(self, key: str, payload: str, ttl: int) -> None:
        nk = self._key(key)
        if self._redis is not None:
            try:
                self._redis.set(nk, payload, ex=max(int(ttl), 1))
                return
            except Exception:  # noqa: BLE001
                self._redis = None
        with self._lock:
            self._mem[nk] = payload  # TTL is evaluated by get_entry.

    @staticmethod
    def _payload(value: Any, ttl: int, cached_at: datetime | None = None) -> str:
        timestamp = cached_at or datetime.now(timezone.utc)
        return json.dumps(
            {"value": value, "cached_at": timestamp.isoformat(), "ttl": int(ttl)},
            default=_json_default,
        )

    # -- structured get/set ------------------------------------------------ #
    def set(self, key: str, value: Any, ttl: int) -> None:
        payload = self._payload(value, ttl)
        self._set_raw(key, payload, ttl)

    def set_if_absent(self, key: str, value: Any, ttl: int) -> bool:
        """Atomically set a fresh key and return whether this caller won.

        Redis uses ``SET ... NX EX``; the memory backend uses a process lock and
        treats expired entries as absent.  This supports race-free rate limits and
        lightweight distributed job leases.
        """
        ttl = max(int(ttl), 1)
        payload = self._payload(value, ttl)
        nk = self._key(key)
        if self._redis is not None:
            try:
                return bool(self._redis.set(nk, payload, ex=ttl, nx=True))
            except Exception:  # noqa: BLE001
                self._redis = None

        with self._lock:
            raw = self._mem.get(nk)
            if raw is not None:
                try:
                    obj = json.loads(raw)
                    cached_at = datetime.fromisoformat(obj["cached_at"])
                    age = (datetime.now(timezone.utc) - cached_at).total_seconds()
                    if age < float(obj.get("ttl", 0)):
                        return False
                except Exception:  # noqa: BLE001 — corrupt entries are replaceable
                    pass
            self._mem[nk] = payload
            return True

    def get_entry(self, key: str) -> tuple[Any, datetime, bool] | None:
        """Return ``(value, cached_at, fresh)`` for ``key`` or ``None`` if absent."""
        raw = self._get_raw(key)
        if raw is None:
            return None
        try:
            obj = json.loads(raw)
            cached_at = datetime.fromisoformat(obj["cached_at"])
            age = (datetime.now(timezone.utc) - cached_at).total_seconds()
            fresh = age < float(obj.get("ttl", 0))
            return obj["value"], cached_at, fresh
        except Exception:  # noqa: BLE001 — corrupt entry
            return None

    def get_or_compute(
        self,
        key: str,
        ttl: int,
        producer: Callable[[], Any],
        fallback: Callable[[], Any] | None = None,
    ) -> CacheResult:
        """Return a fresh cached value, recompute it, or serve stale on producer error.

        1. Fresh cache hit -> return it (``hit=True``).
        2. Otherwise run ``producer``; on success cache and return it.
        3. If ``producer`` raises: serve the last cached value as ``stale=True`` if one
           exists; else run ``fallback`` (uncached) if provided; else re-raise.
        """
        entry = self.get_entry(key)
        if entry is not None and entry[2]:  # fresh
            value, cached_at, _ = entry
            return CacheResult(value, cached_at, hit=True, stale=False)

        # Single-flight expensive producers inside this process.  The second check
        # after acquiring the keyed lock lets concurrent waiters reuse the winner.
        with self._lock:
            compute_lock = self._compute_locks.setdefault(key, threading.Lock())
        with compute_lock:
            entry = self.get_entry(key)
            if entry is not None and entry[2]:
                value, cached_at, _ = entry
                return CacheResult(value, cached_at, hit=True, stale=False)

            try:
                value = producer()
                self.set(key, value, ttl)
                stored = self.get_entry(key)
                cached_at = stored[1] if stored is not None else datetime.now(timezone.utc)
                return CacheResult(value, cached_at, hit=False, stale=False)
            except Exception:  # noqa: BLE001 — producer failed (e.g. live fetch down)
                if entry is not None:
                    value, cached_at, _ = entry
                    return CacheResult(value, cached_at, hit=True, stale=True)
                if fallback is not None:
                    value = fallback()
                    self.set(key, value, ttl)
                    stored = self.get_entry(key)
                    cached_at = stored[1] if stored is not None else datetime.now(timezone.utc)
                    return CacheResult(value, cached_at, hit=False, stale=False)
                raise

    def invalidate(self, key: str) -> None:
        nk = self._key(key)
        if self._redis is not None:
            try:
                self._redis.delete(nk)
                return
            except Exception:  # noqa: BLE001
                self._redis = None
        with self._lock:
            self._mem.pop(nk, None)

    def delete_if_value(self, key: str, expected_value: str) -> bool:
        """Atomically delete ``key`` only when its wrapped value still owns it.

        This compare-and-delete primitive prevents an expired background worker from
        deleting a newer worker's lease after the key has been reacquired.
        """
        nk = self._key(key)
        if self._redis is not None:
            script = """
                local raw = redis.call('GET', KEYS[1])
                if not raw then return 0 end
                local ok, decoded = pcall(cjson.decode, raw)
                if ok and decoded['value'] == ARGV[1] then
                    return redis.call('DEL', KEYS[1])
                end
                return 0
            """
            try:
                return bool(self._redis.eval(script, 1, nk, expected_value))
            except Exception:  # noqa: BLE001
                self._redis = None

        with self._lock:
            raw = self._mem.get(nk)
            if raw is None:
                return False
            try:
                if json.loads(raw).get("value") != expected_value:
                    return False
            except Exception:  # noqa: BLE001
                return False
            self._mem.pop(nk, None)
            return True

    def refresh_if_value(self, key: str, expected_value: str, ttl: int) -> bool:
        """Extend a live owner lease without allowing an expired owner to reclaim it.

        Redis updates the wrapped timestamp and key expiry atomically.  The memory
        backend applies the same freshness check under its process lock, so a delayed
        heartbeat cannot revive a lease that has already expired or changed owners.
        """
        ttl = max(int(ttl), 1)
        nk = self._key(key)
        now = datetime.now(timezone.utc)
        if self._redis is not None:
            script = """
                local raw = redis.call('GET', KEYS[1])
                if not raw then return 0 end
                local ok, decoded = pcall(cjson.decode, raw)
                if not ok or decoded['value'] ~= ARGV[1] then return 0 end
                decoded['cached_at'] = ARGV[2]
                decoded['ttl'] = tonumber(ARGV[3])
                redis.call('SET', KEYS[1], cjson.encode(decoded), 'EX', ARGV[3])
                return 1
            """
            try:
                return bool(
                    self._redis.eval(
                        script,
                        1,
                        nk,
                        expected_value,
                        now.isoformat(),
                        ttl,
                    )
                )
            except Exception:  # noqa: BLE001
                self._redis = None

        with self._lock:
            raw = self._mem.get(nk)
            if raw is None:
                return False
            try:
                obj = json.loads(raw)
                cached_at = datetime.fromisoformat(obj["cached_at"])
                age = (now - cached_at).total_seconds()
                if age >= float(obj.get("ttl", 0)):
                    self._mem.pop(nk, None)
                    return False
                if obj.get("value") != expected_value:
                    return False
            except Exception:  # noqa: BLE001
                return False
            self._mem[nk] = self._payload(expected_value, ttl, cached_at=now)
            return True

    def clear(self) -> None:
        """Drop everything in this namespace (used in tests)."""
        if self._redis is not None:
            try:
                for k in self._redis.scan_iter(f"{self.namespace}:*"):
                    self._redis.delete(k)
                return
            except Exception:  # noqa: BLE001
                self._redis = None
        with self._lock:
            self._mem.clear()
            self._compute_locks.clear()


def build_cache(config: dict) -> Cache:
    """Construct the app cache from config: read the Redis URL env var, else in-memory."""
    url = os.environ.get(config["api"].get("redis_url_env", "REDIS_URL"))
    return Cache(url=url)

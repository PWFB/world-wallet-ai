"""Small, testable cache for the last successful real market-price response."""
from datetime import datetime, timezone


class MarketPriceCache:
    def __init__(self, max_age_seconds=900):
        self.max_age_seconds = max_age_seconds
        self._entry = None

    def store(self, payload, fetched_at=None):
        fetched_at = fetched_at or datetime.now(timezone.utc)
        # Copy top-level and prices mapping so response decoration never mutates cache.
        saved = dict(payload)
        if isinstance(saved.get("prices"), dict):
            saved["prices"] = {key: dict(value) if isinstance(value, dict) else value
                               for key, value in saved["prices"].items()}
        saved["stale"] = False
        saved["cache_age_seconds"] = 0
        self._entry = {"payload": saved, "fetched_at": fetched_at}

    def fresh_response(self, now=None, max_age_seconds=60):
        """Return a copy of a recent quote without marking it stale."""
        if self._entry is None:
            return None
        now = now or datetime.now(timezone.utc)
        age = max(0, int((now - self._entry["fetched_at"]).total_seconds()))
        if age > max_age_seconds:
            return None
        payload = dict(self._entry["payload"])
        payload["prices"] = {key: dict(value) if isinstance(value, dict) else value
                             for key, value in payload.get("prices", {}).items()}
        payload["stale"] = False
        payload["cache_age_seconds"] = age
        return payload

    def stale_response(self, now=None):
        if self._entry is None:
            return None
        now = now or datetime.now(timezone.utc)
        age = max(0, int((now - self._entry["fetched_at"]).total_seconds()))
        if age > self.max_age_seconds:
            return None
        payload = dict(self._entry["payload"])
        payload["prices"] = {key: dict(value) if isinstance(value, dict) else value
                             for key, value in payload.get("prices", {}).items()}
        payload["stale"] = True
        payload["cache_age_seconds"] = age
        return payload

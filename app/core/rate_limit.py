"""Jednoduchý rate limiter pro lokální nasazení."""
from __future__ import annotations

import time
from collections import defaultdict


class RateLimiter:
    def __init__(self, max_calls: int, window_s: int = 3600):
        self.max_calls = max_calls
        self.window_s = window_s
        self._hits: dict[str, list[float]] = defaultdict(list)

    def allow(self, key: str) -> bool:
        now = time.time()
        self._prune(now)
        hits = [t for t in self._hits[key] if now - t < self.window_s]
        if len(hits) >= self.max_calls:
            self._hits[key] = hits
            return False
        hits.append(now)
        self._hits[key] = hits
        return True

    def _prune(self, now: float):
        """Zahodí klíče bez čerstvých záznamů, aby slovník nerostl donekonečna
        (každá IP by v něm jinak zůstala navždy)."""
        if len(self._hits) < 1000:
            return
        stale = [k for k, hits in self._hits.items()
                 if not hits or now - hits[-1] >= self.window_s]
        for k in stale:
            del self._hits[k]

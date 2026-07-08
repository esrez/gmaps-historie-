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
        hits = [t for t in self._hits[key] if now - t < self.window_s]
        if len(hits) >= self.max_calls:
            self._hits[key] = hits
            return False
        hits.append(now)
        self._hits[key] = hits
        return True

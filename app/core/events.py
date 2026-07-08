"""Server-Sent Events pro notifikace (import, synchronizace)."""
from __future__ import annotations

import asyncio
import json
import threading
from collections import defaultdict, deque
from contextlib import suppress
from typing import Any

_MAX_HISTORY = 50


class EventBus:
    def __init__(self):
        self._queues: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._history: deque[dict] = deque(maxlen=_MAX_HISTORY)
        self._lock = threading.Lock()

    def subscribe(self, channel: str = "all") -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=50)
        self._queues[channel].append(q)
        return q

    def unsubscribe(self, channel: str, q: asyncio.Queue):
        if q in self._queues[channel]:
            self._queues[channel].remove(q)

    def publish_sync(self, event: str, data: dict[str, Any], channel: str = "all"):
        payload = {"event": event, **data}
        with self._lock:
            self._history.append(payload)
        for q in list(self._queues.get(channel, [])) + list(self._queues.get("all", [])):
            with suppress(Exception):
                q.put_nowait(payload)

    async def publish(self, event: str, data: dict[str, Any], channel: str = "all"):
        self.publish_sync(event, data, channel)

    async def sse_stream(self, channel: str = "all"):
        q = self.subscribe(channel)
        try:
            with self._lock:
                for msg in self._history:
                    yield "data: " + json.dumps(msg, ensure_ascii=False) + "\n\n"
            yield "data: " + json.dumps({"event": "connected"}) + "\n\n"
            while True:
                msg = await q.get()
                yield "data: " + json.dumps(msg, ensure_ascii=False) + "\n\n"
        finally:
            self.unsubscribe(channel, q)


event_bus = EventBus()

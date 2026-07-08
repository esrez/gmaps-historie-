"""Strukturované logování."""
from __future__ import annotations

import json
import logging
import os
import sys
from datetime import UTC, datetime


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info and record.exc_info[1]:
            payload["error"] = str(record.exc_info[1])
        return json.dumps(payload, ensure_ascii=False)


def setup_logging() -> logging.Logger:
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    root = logging.getLogger("gmaps")
    if root.handlers:
        return root
    handler = logging.StreamHandler(sys.stdout)
    if os.environ.get("LOG_JSON") == "1":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    root.addHandler(handler)
    root.setLevel(level)
    return root


log = setup_logging()

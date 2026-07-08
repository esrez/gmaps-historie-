"""Konfigurace a konstanty aplikace."""
from __future__ import annotations

import hashlib
import os
import sys

from .. import db

MAX_TRACK_POINTS = 60_000
MAX_HEAT_CELLS = 40_000
MAX_DIST_ROWS = 3_000_000
BACKUP_KEEP = 14
OUTLIER_SPEED = 70.0
DEFAULT_ACC_LIMIT = 100.0
IMPORT_RATE_LIMIT = int(os.environ.get("IMPORT_RATE_LIMIT", "10"))  # za hodinu
SESSION_MAX_AGE = 30 * 24 * 3600  # 30 dní

AUTH_PASSWORD = os.environ.get("AUTH_PASSWORD", "")
_VERSION_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "VERSION")


def _read_release() -> str:
    if os.environ.get("APP_VERSION"):
        return os.environ["APP_VERSION"]
    try:
        with open(_VERSION_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    return line
    except OSError:
        pass
    return "2.0.0"


APP_RELEASE = _read_release()

if getattr(sys, "frozen", False):
    STATIC_DIR = os.path.join(sys._MEIPASS, "app", "static")  # type: ignore[attr-defined]
else:
    STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")


def data_dir() -> str:
    return os.path.dirname(db.DB_PATH) or "."


def static_version() -> str:
    """Otisk obsahu frontendu pro verzování PWA cache."""
    h = hashlib.sha1()
    for root, _dirs, files in os.walk(STATIC_DIR):
        for name in sorted(files):
            path = os.path.join(root, name)
            h.update(name.encode())
            with open(path, "rb") as f:
                h.update(f.read())
    return h.hexdigest()[:10]


APP_VERSION = static_version()

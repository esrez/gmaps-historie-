#!/usr/bin/env python3
"""Jednoduchý aktualizátor Windows instalace (CLI – stejná logika jako GMapsHistorie.exe --update)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.core.updater import run_update  # noqa: E402


def main() -> int:
    app_dir = Path(os.environ.get("APP_DIR", ROOT))
    return run_update(app_dir)


if __name__ == "__main__":
    sys.exit(main())

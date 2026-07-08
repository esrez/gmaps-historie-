"""Zálohování databáze."""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime

from .. import db
from .config import BACKUP_KEEP, data_dir
from .logging import log


def make_backup() -> str:
    """Konzistentní kopie SQLite databáze + rotace starých záloh."""
    backup_dir = os.path.join(data_dir(), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    base = f"history-{datetime.now(tz=None):%Y%m%d-%H%M%S}"
    name = f"{base}.db"
    n = 1
    while os.path.exists(os.path.join(backup_dir, name)):
        name = f"{base}-{n}.db"
        n += 1
    dest = os.path.join(backup_dir, name)
    src = sqlite3.connect(db.DB_PATH)
    dst = sqlite3.connect(dest)
    try:
        with dst:
            src.backup(dst)
    finally:
        src.close()
        dst.close()
    files = sorted(f for f in os.listdir(backup_dir)
                   if f.startswith("history-") and f.endswith(".db"))
    for old in files[:-BACKUP_KEEP]:
        os.unlink(os.path.join(backup_dir, old))
    log.info("Záloha vytvořena: %s", name)
    return dest


def is_backup_name(name: str) -> bool:
    return (name.startswith("history-") and name.endswith(".db")
            and os.path.basename(name) == name)

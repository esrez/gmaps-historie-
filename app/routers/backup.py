"""Zálohy a auto-import."""
from __future__ import annotations

import asyncio
import os
import sqlite3
import time
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from .. import db, importer
from ..core.backup import is_backup_name, make_backup
from ..core.config import data_dir
from ..core.logging import log

router = APIRouter(tags=["zálohy"])

AUTOIMPORT_LOG: list[dict] = []


def process_import_folder():
    folder = os.path.join(data_dir(), "import")
    if not os.path.isdir(folder):
        os.makedirs(folder, exist_ok=True)
        return
    for name in sorted(os.listdir(folder)):
        low = name.lower()
        if not (low.endswith((".json", ".zip", ".gpx", ".geojson")) or low == "owntracks"):
            continue
        path = os.path.join(folder, name)
        entry = {"file": name, "when": datetime.now().strftime("%d.%m. %H:%M")}
        try:
            if low.endswith(".gpx") or low.endswith(".geojson"):
                from ..services.sync import import_geojson_file, import_gpx_file
                if low.endswith(".gpx"):
                    counters = import_gpx_file(path)
                else:
                    counters = import_geojson_file(path)
            else:
                counters = importer.import_path(path)
            entry.update(counters.as_dict() if hasattr(counters, "as_dict") else counters)
            entry["status"] = "ok"
            os.rename(path, path + ".imported")
            db.after_import()
        except Exception as exc:
            entry["status"] = "error"
            entry["error"] = str(exc)
            os.rename(path, path + ".error")
            log.exception("Auto-import selhal: %s", name)
        AUTOIMPORT_LOG.append(entry)
        del AUTOIMPORT_LOG[:-5]


def auto_backup_if_due():
    if not os.path.exists(db.DB_PATH):
        return
    backup_dir = os.path.join(data_dir(), "backups")
    newest = 0.0
    if os.path.isdir(backup_dir):
        for f in os.listdir(backup_dir):
            if f.startswith("history-") and f.endswith(".db"):
                newest = max(newest, os.path.getmtime(os.path.join(backup_dir, f)))
    if time.time() - newest >= 24 * 3600:
        make_backup()


async def background_loop():
    while True:
        try:
            await asyncio.to_thread(auto_backup_if_due)
            await asyncio.to_thread(process_import_folder)
        except Exception as exc:
            log.exception("Úloha na pozadí selhala: %s", exc)
        await asyncio.sleep(60)


@router.get("/api/backup")
def api_backup():
    dest = make_backup()
    return FileResponse(dest, filename=os.path.basename(dest),
                        media_type="application/octet-stream")


@router.get("/api/backups")
def api_backups():
    backup_dir = os.path.join(data_dir(), "backups")
    items = []
    if os.path.isdir(backup_dir):
        for name in os.listdir(backup_dir):
            if not is_backup_name(name):
                continue
            st = os.stat(os.path.join(backup_dir, name))
            items.append({"name": name, "size": st.st_size,
                          "when": datetime.fromtimestamp(st.st_mtime)
                          .strftime("%d.%m.%Y %H:%M")})
    items.sort(key=lambda x: x["name"], reverse=True)
    return {"backups": items}


@router.post("/api/restore")
def api_restore(name: str = Query(...)):
    if not is_backup_name(name):
        raise HTTPException(400, "Neplatné jméno zálohy")
    path = os.path.join(data_dir(), "backups", name)
    if not os.path.exists(path):
        raise HTTPException(404, "Záloha nenalezena")
    safety = make_backup()
    src = sqlite3.connect(path)
    dst = sqlite3.connect(db.DB_PATH)
    try:
        with dst:
            src.backup(dst)
    finally:
        src.close()
        dst.close()
    return {"restored": name, "safety_backup": os.path.basename(safety)}


@router.get("/api/autoimport")
def api_autoimport():
    return {"log": AUTOIMPORT_LOG[-5:]}

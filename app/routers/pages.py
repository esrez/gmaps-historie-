"""Statické stránky, PWA, PMTiles, přihlášení."""
from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..core.auth import (
    create_session,
    login_allowed,
    note_login_fail,
    note_login_ok,
)
from ..core.config import APP_RELEASE, APP_VERSION, AUTH_PASSWORD, DESKTOP_APP, STATIC_DIR

router = APIRouter(tags=["stránky"])


class LoginBody(BaseModel):
    password: str


@router.post("/api/login")
def api_login(body: LoginBody, request: Request):
    if not AUTH_PASSWORD:
        return {"ok": True, "auth": "disabled"}
    ip = request.client.host if request.client else "?"
    if not login_allowed(ip):
        raise HTTPException(429, "Příliš mnoho pokusů. Zkuste to za pár minut.")
    import secrets
    if not secrets.compare_digest(body.password, AUTH_PASSWORD):
        note_login_fail(ip)
        raise HTTPException(401, "Špatné heslo")
    note_login_ok(ip)
    resp = Response(content='{"ok":true}')
    resp.media_type = "application/json"
    create_session(resp)
    return resp


@router.get("/api/version")
def api_version():
    return {"version": APP_VERSION, "release": APP_RELEASE, "desktop": DESKTOP_APP}


@router.get("/api/health")
def api_health():
    """Stav aplikace pro sekci „O aplikaci": databáze, poslední záloha."""
    import os
    from contextlib import closing

    from .. import db
    from ..core.config import data_dir
    db_size = os.path.getsize(db.DB_PATH) if os.path.exists(db.DB_PATH) else 0
    backup_dir = os.path.join(data_dir(), "backups")
    last_backup = None
    if os.path.isdir(backup_dir):
        stamps = [os.path.getmtime(os.path.join(backup_dir, f))
                  for f in os.listdir(backup_dir)
                  if f.startswith("history-") and f.endswith(".db")]
        if stamps:
            from datetime import datetime
            last_backup = datetime.fromtimestamp(max(stamps)) \
                .strftime("%d.%m.%Y %H:%M")
    with closing(db.connect()) as conn:
        counts = {t: conn.execute(f"SELECT COUNT(*) c FROM {t}").fetchone()["c"]
                  for t in ("points", "visits", "activities", "trips")}
    return {"db_size": db_size, "db_path": os.path.basename(db.DB_PATH),
            "last_backup": last_backup, "profile": db.active_profile(), **counts}


@router.post("/api/health/check")
def api_health_check():
    """Kontrola integrity SQLite databáze (PRAGMA quick_check)."""
    from contextlib import closing

    from .. import db
    with closing(db.connect()) as conn:
        rows = [r[0] for r in conn.execute("PRAGMA quick_check")]
    ok = rows == ["ok"]
    return {"ok": ok, "detail": rows[:5]}


@router.post("/api/shutdown")
def api_shutdown():
    """Korektní ukončení aplikace – jen v desktopovém režimu (.exe / run.py),
    aby se nedal omylem vypnout server běžící pod Dockerem."""
    if not DESKTOP_APP:
        raise HTTPException(403, "Ukončení je dostupné jen v desktopové aplikaci")
    from ..core import runtime
    runtime.request_shutdown()
    return {"ok": True, "message": "Aplikace se ukončuje…"}


@router.get("/api/update")
def api_update():
    """Info pro aktualizátor Windows – porovná release verzi."""
    return {
        "current": APP_RELEASE,
        "package_url": "/api/update/package",
        "download": "/api/update/package",
    }


@router.get("/api/update/package")
def api_update_package():
    """Vrátí update balík (ZIP), pokud je připraven na disku."""
    from ..core.config import data_dir
    path = os.path.join(data_dir(), "update", "GMapsHistorie-update.zip")
    if not os.path.exists(path):
        raise HTTPException(404, "Balík aktualizace není připraven")
    return FileResponse(path, media_type="application/zip",
                        filename="GMapsHistorie-update.zip")


@router.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@router.get("/kniha")
def kniha():
    return FileResponse(os.path.join(STATIC_DIR, "kniha.html"))


@router.get("/sw.js")
def service_worker():
    with open(os.path.join(STATIC_DIR, "sw.js"), encoding="utf-8") as f:
        body = f.read().replace("__VERSION__", APP_VERSION)
    return Response(body, media_type="application/javascript",
                    headers={"Cache-Control": "no-cache"})


@router.get("/manifest.webmanifest")
def manifest():
    return FileResponse(os.path.join(STATIC_DIR, "manifest.webmanifest"),
                        media_type="application/manifest+json")


def pmtiles_path() -> str:
    try:
        import app.main as main
        fn = getattr(main, "_pmtiles_path", None)
        if callable(fn):
            return fn()
    except Exception:
        pass
    from ..core.config import data_dir
    return os.path.join(data_dir(), "map.pmtiles")


@router.get("/api/pmtiles/status")
def api_pmtiles_status():
    path = pmtiles_path()
    ok = os.path.exists(path)
    return {"available": ok, "size": os.path.getsize(path) if ok else 0}


@router.get("/api/pmtiles")
def api_pmtiles(request: Request):
    path = pmtiles_path()
    if not os.path.exists(path):
        raise HTTPException(404, "Soubor data/map.pmtiles neexistuje")
    size = os.path.getsize(path)
    range_header = request.headers.get("range", "")
    if range_header.startswith("bytes="):
        try:
            start_s, end_s = range_header[6:].split("-", 1)
            start = int(start_s)
            end = min(int(end_s) if end_s else size - 1, size - 1)
        except ValueError as exc:
            raise HTTPException(416, "Neplatný Range") from exc
        if start > end or start >= size:
            raise HTTPException(416, "Range mimo soubor")
        with open(path, "rb") as f:
            f.seek(start)
            chunk = f.read(end - start + 1)
        return Response(chunk, status_code=206, media_type="application/octet-stream",
                        headers={"Content-Range": f"bytes {start}-{end}/{size}",
                                 "Accept-Ranges": "bytes"})
    return FileResponse(path, media_type="application/octet-stream",
                        headers={"Accept-Ranges": "bytes"})

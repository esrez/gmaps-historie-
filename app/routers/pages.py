"""Statické stránky, PWA, PMTiles, přihlášení."""
from __future__ import annotations

import json
import os
import secrets
import sys
import time
import urllib.request
from contextlib import closing
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import db
from ..core import runtime, updater
from ..core.auth import (
    create_session,
    login_allowed,
    note_login_fail,
    note_login_ok,
)
from ..core.config import (
    APP_RELEASE,
    APP_VERSION,
    AUTH_PASSWORD,
    DESKTOP_APP,
    STATIC_DIR,
    data_dir,
)

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
    if not secrets.compare_digest(body.password, AUTH_PASSWORD):
        note_login_fail(ip)
        raise HTTPException(401, "Špatné heslo")
    note_login_ok(ip)
    resp = Response(content='{"ok":true}')
    resp.media_type = "application/json"
    https = (request.url.scheme == "https"
             or request.headers.get("x-forwarded-proto", "").startswith("https"))
    create_session(resp, secure=https)
    return resp


@router.get("/api/version")
def api_version():
    return {"version": APP_VERSION, "release": APP_RELEASE, "desktop": DESKTOP_APP}


@router.get("/api/health")
def api_health():
    """Stav aplikace pro sekci „O aplikaci": databáze, poslední záloha."""
    db_size = os.path.getsize(db.DB_PATH) if os.path.exists(db.DB_PATH) else 0
    backup_dir = os.path.join(data_dir(), "backups")
    last_backup = None
    if os.path.isdir(backup_dir):
        stamps = [os.path.getmtime(os.path.join(backup_dir, f))
                  for f in os.listdir(backup_dir)
                  if f.startswith("history-") and f.endswith(".db")]
        if stamps:
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
    runtime.request_shutdown()
    return {"ok": True, "message": "Aplikace se ukončuje…"}


# -------- nenápadná kontrola nové verze (GitHub releases) ----------------
# Vypnutí: UPDATE_CHECK_URL="" (nikam se pak nepřipojuje). Frontend se ptá
# nejvýš 1× denně; server drží odpověď v paměti, ať GitHub nezatěžujeme.
UPDATE_CHECK_URL = os.environ.get(
    "UPDATE_CHECK_URL",
    "https://api.github.com/repos/esrez/gmaps-historie-/releases/latest")
_UPDATE_CACHE_S = 6 * 3600
_update_cache: dict = {"ts": 0.0, "data": None}


def _fetch_latest_release() -> dict:
    """Stáhne metadata posledního vydání (oddělené kvůli testům)."""
    req = urllib.request.Request(UPDATE_CHECK_URL, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "gmaps-historie",
    })
    with urllib.request.urlopen(req, timeout=4) as r:
        return json.loads(r.read().decode("utf-8"))


def _ver_tuple(v: str) -> tuple[int, ...]:
    parts = []
    for p in v.strip().lstrip("vV").split("."):
        digits = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


@router.get("/api/update_check")
def api_update_check():
    """Je k dispozici novější vydání? {current, latest, available, url}."""
    if not UPDATE_CHECK_URL:
        return {"current": APP_RELEASE, "latest": None, "available": None, "url": None}
    now = time.time()
    if now - _update_cache["ts"] > _UPDATE_CACHE_S:
        try:
            rel = _fetch_latest_release()
            tag = str(rel.get("tag_name") or "").strip()
            _update_cache["data"] = {
                "latest": tag.lstrip("vV") or None,
                "url": rel.get("html_url"),
                "asset": updater.find_exe_asset(rel),   # pro samoaktualizaci
            }
        except Exception:
            _update_cache["data"] = None    # offline / GitHub nedostupný
        _update_cache["ts"] = now
    data = _update_cache["data"]
    if not data or not data["latest"]:
        return {"current": APP_RELEASE, "latest": None, "available": None, "url": None}
    available = _ver_tuple(data["latest"]) > _ver_tuple(APP_RELEASE)
    return {"current": APP_RELEASE, "latest": data["latest"],
            "available": available, "url": data["url"]}


def _self_update_dir() -> Path | None:
    """Složka s exe, pokud běžíme jako zabalená desktopová aplikace na
    Windows – jen tam dává samoaktualizace smysl (jinde je git pull/Docker)."""
    if os.name != "nt" or not DESKTOP_APP or not getattr(sys, "frozen", False):
        return None
    return Path(os.environ.get("APP_DIR") or os.path.dirname(sys.executable))


@router.post("/api/update/download")
def api_update_download():
    """Stáhne nový GMapsHistorie.exe z GitHub Release vedle aplikace
    a ověří ho (velikost dle vydání, MZ hlavička, spuštění s --version)."""
    app_dir = _self_update_dir()
    if app_dir is None:
        raise HTTPException(403, "Samoaktualizace funguje jen v desktopové "
                                 "aplikaci na Windows")
    info = api_update_check()
    if not info["available"]:
        raise HTTPException(400, "Není k dispozici novější verze")
    asset = (_update_cache["data"] or {}).get("asset")
    if not asset:
        raise HTTPException(502, "Vydání na GitHubu neobsahuje GMapsHistorie.exe")
    dest = app_dir / updater.NEW_EXE_NAME
    try:
        updater.download_exe(asset["url"], dest, asset.get("size") or None)
    except Exception as exc:
        raise HTTPException(502, f"Stažení selhalo: {exc}") from exc
    if not updater.verify_exe_version(dest, info["latest"]):
        dest.unlink(missing_ok=True)
        raise HTTPException(502, "Ověření staženého programu selhalo "
                                 "(nespustil se nebo hlásí jinou verzi)")
    return {"ok": True, "version": info["latest"], "file": dest.name}


@router.post("/api/update/apply")
def api_update_apply():
    """Dokončí připravenou aktualizaci: pomocný skript po ukončení aplikace
    prohodí exe a novou verzi spustí. Aplikace se hned poté sama ukončí."""
    app_dir = _self_update_dir()
    if app_dir is None:
        raise HTTPException(403, "Samoaktualizace funguje jen v desktopové "
                                 "aplikaci na Windows")
    if not (app_dir / updater.NEW_EXE_NAME).exists():
        raise HTTPException(400, "Aktualizace není připravena – nejdřív ji stáhněte")
    updater.spawn_swap_helper(app_dir, os.getpid())
    runtime.request_shutdown()
    return {"ok": True, "message": "Aplikace se ukončí a spustí v nové verzi…"}


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

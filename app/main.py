"""FastAPI server – API nad historií polohy + statický frontend."""
from __future__ import annotations

import asyncio
import base64
import math
import os
import secrets
import shutil
import sqlite3
import tempfile
import threading
import uuid
from collections import defaultdict
from contextlib import closing
from datetime import UTC, datetime

from fastapi import FastAPI, HTTPException, Query, Request, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import db, importer, places, trips
from .common import fmt_dt, haversine_m, local_dt, sheet, ts_range, xlsx_response

app = FastAPI(title="GMaps Historie", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(GZipMiddleware, minimum_size=2048)  # JSON s body/heatmapou je velký
app.include_router(trips.router)
app.include_router(places.router)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

MAX_TRACK_POINTS = 60_000
MAX_HEAT_CELLS = 40_000
MAX_DIST_ROWS = 3_000_000

# ------------------------------------------------- volitelné přihlášení

AUTH_PASSWORD = os.environ.get("AUTH_PASSWORD", "")


@app.middleware("http")
async def basic_auth(request, call_next):
    """Když je nastavené AUTH_PASSWORD, vyžaduje HTTP Basic (jméno libovolné)."""
    if AUTH_PASSWORD:
        header = request.headers.get("authorization", "")
        ok = False
        if header.startswith("Basic "):
            try:
                decoded = base64.b64decode(header[6:]).decode("utf-8", "replace")
                password = decoded.split(":", 1)[1] if ":" in decoded else ""
                ok = secrets.compare_digest(password, AUTH_PASSWORD)
            except Exception:
                ok = False
        if not ok:
            return Response(status_code=401, content="Přihlaste se",
                            headers={"WWW-Authenticate": 'Basic realm="GMaps Historie"'})
    return await call_next(request)


# --------------------------------------------- zálohy a auto-import složky

BACKUP_KEEP = 14


def _data_dir() -> str:
    return os.path.dirname(db.DB_PATH) or "."


def make_backup() -> str:
    """Konzistentní kopie SQLite databáze (backup API) + rotace starých záloh."""
    backup_dir = os.path.join(_data_dir(), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    name = f"history-{datetime.now(tz=None):%Y%m%d-%H%M%S}.db"
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
    return dest


def _auto_backup_if_due():
    if not os.path.exists(db.DB_PATH):
        return
    backup_dir = os.path.join(_data_dir(), "backups")
    newest = 0.0
    if os.path.isdir(backup_dir):
        for f in os.listdir(backup_dir):
            if f.startswith("history-") and f.endswith(".db"):
                newest = max(newest, os.path.getmtime(os.path.join(backup_dir, f)))
    import time
    if time.time() - newest >= 24 * 3600:
        make_backup()
        print("Automatická záloha databáze vytvořena.")


AUTOIMPORT_LOG: list[dict] = []   # posledních pár zpracovaných souborů


def _process_import_folder():
    """Soubory nakopírované do data/import/ se samy naimportují."""
    folder = os.path.join(_data_dir(), "import")
    if not os.path.isdir(folder):
        os.makedirs(folder, exist_ok=True)
        return
    for name in sorted(os.listdir(folder)):
        if not name.lower().endswith((".json", ".zip")):
            continue
        path = os.path.join(folder, name)
        entry = {"file": name, "when": datetime.now().strftime("%d.%m. %H:%M")}
        try:
            counters = importer.import_path(path)
            entry.update(counters.as_dict())
            entry["status"] = "ok"
            os.rename(path, path + ".imported")
        except Exception as exc:
            entry["status"] = "error"
            entry["error"] = str(exc)
            os.rename(path, path + ".error")
        AUTOIMPORT_LOG.append(entry)
        del AUTOIMPORT_LOG[:-5]


async def _background_loop():
    while True:
        try:
            await asyncio.to_thread(_auto_backup_if_due)
            await asyncio.to_thread(_process_import_folder)
        except Exception as exc:      # noqa: BLE001 – smyčka nesmí umřít
            print(f"Úloha na pozadí selhala: {exc}")
        await asyncio.sleep(60)


@app.on_event("startup")
async def _startup():
    if os.environ.get("DISABLE_BACKGROUND") != "1":
        asyncio.create_task(_background_loop())


@app.get("/api/backup")
def api_backup():
    """Stáhne čerstvou zálohu databáze."""
    dest = make_backup()
    return FileResponse(dest, filename=os.path.basename(dest),
                        media_type="application/octet-stream")


@app.get("/api/autoimport")
def api_autoimport():
    return {"log": AUTOIMPORT_LOG[-5:]}


@app.get("/api/range")
def api_range():
    with closing(db.connect()) as conn:
        row = conn.execute(
            "SELECT MIN(ts) a, MAX(ts) b, COUNT(*) n FROM points").fetchone()
        visits = conn.execute("SELECT COUNT(*) n, MIN(start_ts) a, MAX(end_ts) b FROM visits").fetchone()
        acts = conn.execute("SELECT COUNT(*) n FROM activities").fetchone()
    lo = min(x for x in (row["a"], visits["a"], 2**53) if x is not None)
    hi = max(x for x in (row["b"], visits["b"], 0) if x is not None)
    return {
        "min_ts": lo if lo < 2**53 else None,
        "max_ts": hi if hi > 0 else None,
        "points": row["n"], "visits": visits["n"], "activities": acts["n"],
    }


def _bbox_sql(min_lat, max_lat, min_lon, max_lon) -> tuple[str, tuple]:
    """Volitelné omezení na výřez mapy – klient tak při přiblížení dostane
    plný detail místo hrubého vzorku celého období."""
    if None in (min_lat, max_lat, min_lon, max_lon):
        return "", ()
    return (" AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
            (min_lat, max_lat, min_lon, max_lon))


def _points_data(from_ts, to_ts, limit=MAX_TRACK_POINTS,
                 min_lat=None, max_lat=None, min_lon=None, max_lon=None):
    lo, hi = ts_range(from_ts, to_ts)
    bsql, bargs = _bbox_sql(min_lat, max_lat, min_lon, max_lon)
    with closing(db.connect()) as conn:
        n = conn.execute(
            f"SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?{bsql}",
            (lo, hi, *bargs)).fetchone()["c"]
        step = max(1, -(-n // limit))
        rows = conn.execute(
            f"SELECT ts, lat, lon FROM points WHERE ts BETWEEN ? AND ?{bsql} "
            f"AND (id % ?) = 0 ORDER BY ts",
            (lo, hi, *bargs, step)).fetchall()
    return {"total": n, "sampled": len(rows), "step": step,
            "points": [[r["ts"], round(r["lat"], 6), round(r["lon"], 6)] for r in rows]}


@app.get("/api/points")
def api_points(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
               limit: int = Query(MAX_TRACK_POINTS, ge=1, le=200_000),
               min_lat: float | None = Query(None), max_lat: float | None = Query(None),
               min_lon: float | None = Query(None), max_lon: float | None = Query(None)):
    return _points_data(from_ts, to_ts, limit, min_lat, max_lat, min_lon, max_lon)


@app.get("/api/heatmap")
def api_heatmap(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                precision: int = Query(4, ge=2, le=6),
                min_lat: float | None = Query(None), max_lat: float | None = Query(None),
                min_lon: float | None = Query(None), max_lon: float | None = Query(None)):
    """Heatmapa s rozlišením podle přiblížení (precision = desetinná místa)."""
    lo, hi = ts_range(from_ts, to_ts)
    bsql, bargs = _bbox_sql(min_lat, max_lat, min_lon, max_lon)
    with closing(db.connect()) as conn:
        rows = conn.execute(
            f"SELECT ROUND(lat,?) la, ROUND(lon,?) lo, COUNT(*) c FROM points "
            f"WHERE ts BETWEEN ? AND ?{bsql} GROUP BY la, lo ORDER BY c DESC LIMIT ?",
            (precision, precision, lo, hi, *bargs, MAX_HEAT_CELLS)).fetchall()
    return {"cells": [[r["la"], r["lo"], r["c"]] for r in rows]}


@app.get("/api/visits")
def api_visits(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
               limit: int = Query(5000, le=20000)):
    lo, hi = ts_range(from_ts, to_ts)
    with closing(db.connect()) as conn:
        rows = conn.execute(
            "SELECT start_ts, end_ts, lat, lon, name, address, semantic FROM visits "
            "WHERE start_ts BETWEEN ? AND ? ORDER BY start_ts LIMIT ?",
            (lo, hi, limit)).fetchall()
        custom = places.load_places(conn)
    out = []
    for r in rows:
        d = dict(r)
        d["label"] = places.visit_label(custom, r["lat"], r["lon"],
                                        r["name"], r["semantic"])
        out.append(d)
    return {"visits": out}


@app.get("/api/day")
def api_day(from_ts: int = Query(...), to_ts: int = Query(...)):
    """Vše pro přehrávání jednoho dne (hranice dne posílá klient ve své TZ)."""
    with closing(db.connect()) as conn:
        pts = conn.execute(
            "SELECT ts, lat, lon FROM points WHERE ts BETWEEN ? AND ? ORDER BY ts LIMIT 50000",
            (from_ts, to_ts)).fetchall()
        vis = conn.execute(
            "SELECT start_ts, end_ts, lat, lon, name, address, semantic FROM visits "
            "WHERE end_ts >= ? AND start_ts <= ? ORDER BY start_ts", (from_ts, to_ts)).fetchall()
        acts = conn.execute(
            "SELECT start_ts, end_ts, type, distance_m FROM activities "
            "WHERE end_ts >= ? AND start_ts <= ? ORDER BY start_ts", (from_ts, to_ts)).fetchall()
    return {"points": [[r["ts"], r["lat"], r["lon"]] for r in pts],
            "visits": [dict(r) for r in vis],
            "activities": [dict(r) for r in acts]}


def _point_distances(conn, lo: int, hi: int):
    """Vzdálenost spočtená ze surových bodů, po měsících (fallback bez aktivit).

    Přeskakuje mezery > 10 minut a nereálné skoky (> 70 m/s), aby chyby GPS
    nenafukovaly součet. U obřích rozsahů se body vzorkují a časová mezera
    se úměrně zvětší, jinak by vzorkování většinu úseků zahodilo.
    """
    n = conn.execute("SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?",
                     (lo, hi)).fetchone()["c"]
    step = max(1, -(-n // MAX_DIST_ROWS))
    max_gap = 600 * step
    monthly: dict[str, float] = defaultdict(float)
    prev = None
    cur = conn.execute(
        "SELECT ts, lat, lon FROM points WHERE ts BETWEEN ? AND ? AND (id % ?) = 0 ORDER BY ts",
        (lo, hi, step))
    for ts, lat, lon in cur:
        if prev is not None:
            dt = ts - prev[0]
            if 0 < dt <= max_gap:
                d = haversine_m(prev[1], prev[2], lat, lon)
                if d / dt <= 70:
                    monthly[local_dt(ts).strftime("%Y-%m")] += d
        prev = (ts, lat, lon)
    return monthly, step > 1


@app.get("/api/stats")
def api_stats(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
              min_stay_min: float = Query(2, ge=0, le=120)):
    """Souhrnné statistiky. Návštěvy kratší než min_stay_min (výchozí 2 min)
    se do počtů, hodin ani top míst nepočítají – jde o průjezdy."""
    lo, hi = ts_range(from_ts, to_ts)
    min_stay_s = int(min_stay_min * 60)
    with closing(db.connect()) as conn:
        n_points = conn.execute(
            "SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?", (lo, hi)).fetchone()["c"]
        days = conn.execute(
            "SELECT COUNT(DISTINCT date(ts, 'unixepoch', 'localtime')) c "
            "FROM points WHERE ts BETWEEN ? AND ?", (lo, hi)).fetchone()["c"]

        by_type = conn.execute(
            "SELECT type, COUNT(*) n, SUM(COALESCE(distance_m,0)) dist "
            "FROM activities WHERE start_ts BETWEEN ? AND ? "
            "GROUP BY type ORDER BY dist DESC", (lo, hi)).fetchall()

        act_monthly = conn.execute(
            "SELECT strftime('%Y-%m', start_ts, 'unixepoch', 'localtime') m, "
            "SUM(COALESCE(distance_m,0)) dist FROM activities "
            "WHERE start_ts BETWEEN ? AND ? GROUP BY m ORDER BY m", (lo, hi)).fetchall()

        n_visits, visit_secs = conn.execute(
            "SELECT COUNT(*), SUM(end_ts - start_ts) FROM visits "
            "WHERE start_ts BETWEEN ? AND ? AND end_ts - start_ts >= ?",
            (lo, hi, min_stay_s)).fetchone()

        # top místa: popisky se řeší v Pythonu, aby vlastní názvy (place_names)
        # měly přednost a sloučily i blízké skupiny souřadnic pod jedno jméno
        visit_rows = conn.execute(
            "SELECT lat, lon, name, semantic, end_ts - start_ts secs "
            "FROM visits WHERE start_ts BETWEEN ? AND ? AND end_ts - start_ts >= ?",
            (lo, hi, min_stay_s)).fetchall()
        custom = places.load_places(conn)
        agg: dict[str, dict] = {}
        for v in visit_rows:
            label = places.visit_label(custom, v["lat"], v["lon"],
                                       v["name"], v["semantic"])
            g = agg.setdefault(label, {"label": label, "lat": 0.0, "lon": 0.0,
                                       "n": 0, "secs": 0})
            g["n"] += 1
            g["secs"] += max(v["secs"], 0)
            g["lat"] += v["lat"]
            g["lon"] += v["lon"]
        top_places = sorted(agg.values(), key=lambda g: -g["secs"])[:15]
        for g in top_places:
            g["lat"] /= g["n"]
            g["lon"] /= g["n"]

        activities_total = sum(r["dist"] or 0 for r in by_type)
        monthly_source = "activities"
        approx = False
        if activities_total > 0:
            monthly = {r["m"]: r["dist"] for r in act_monthly}
        else:
            # žádné aktivity, nebo aktivity bez vzdáleností → spočítat z bodů
            monthly, approx = _point_distances(conn, lo, hi)
            monthly_source = "points"

    total_km = (activities_total if activities_total else sum(monthly.values())) / 1000
    return {
        "points": n_points,
        "days_with_data": days,
        "visits": n_visits,
        "visit_hours": round((visit_secs or 0) / 3600, 1),
        "total_km": round(total_km, 1),
        "by_type": [{"type": r["type"], "count": r["n"],
                     "km": round((r["dist"] or 0) / 1000, 1)} for r in by_type],
        "monthly_km": [{"month": m, "km": round(v / 1000, 1)}
                       for m, v in sorted(monthly.items())],
        "monthly_source": monthly_source,
        "monthly_approx": approx,
        "top_places": [{"label": r["label"], "lat": r["lat"], "lon": r["lon"],
                        "count": r["n"], "hours": round((r["secs"] or 0) / 3600, 1)}
                       for r in top_places],
    }


@app.get("/api/search_visits")
def api_search_visits(q: str = Query(..., min_length=2), limit: int = Query(20, le=100)):
    """Fulltextové hledání ve vlastních navštívených místech i vlastních názvech."""
    like = f"%{q}%"
    with closing(db.connect()) as conn:
        custom = [{"label": p["name"], "lat": p["lat"], "lon": p["lon"],
                   "count": None, "hours": None, "last_ts": None, "custom": True}
                  for p in places.load_places(conn)
                  if q.lower() in p["name"].lower()]
        rows = conn.execute(
            "SELECT COALESCE(NULLIF(name,''), COALESCE(semantic,'') || ' ' || "
            "       ROUND(lat,3) || ', ' || ROUND(lon,3)) label, "
            "       AVG(lat) lat, AVG(lon) lon, COUNT(*) n, "
            "       SUM(end_ts - start_ts) secs, MAX(end_ts) last_ts "
            "FROM visits WHERE name LIKE ? OR address LIKE ? OR semantic LIKE ? "
            "GROUP BY label ORDER BY n DESC LIMIT ?", (like, like, like, limit)).fetchall()
    return {"results": custom + [{"label": r["label"], "lat": r["lat"], "lon": r["lon"],
                         "count": r["n"], "hours": round((r["secs"] or 0) / 3600, 1),
                         "last_ts": r["last_ts"]} for r in rows]}


def _stays_at(conn, lat: float, lon: float, radius_m: float,
              lo: int, hi: int, gap_s: int = 2700):
    """Pobyty v okruhu daného místa: GPS body seskupené v čase + záznamy návštěv,
    překrývající se intervaly sloučené do jednoho."""
    dlat = radius_m / 111_000
    dlon = radius_m / (111_000 * max(math.cos(math.radians(lat)), 0.01))
    intervals: list[list] = []  # [start, end, name]

    prev = None
    cur = conn.execute(
        "SELECT ts, lat, lon FROM points WHERE lat BETWEEN ? AND ? "
        "AND lon BETWEEN ? AND ? AND ts BETWEEN ? AND ? ORDER BY ts",
        (lat - dlat, lat + dlat, lon - dlon, lon + dlon, lo, hi))
    for ts, plat, plon in cur:
        if haversine_m(lat, lon, plat, plon) > radius_m:
            continue
        if prev is not None and ts - prev[1] <= gap_s:
            prev[1] = ts
        else:
            prev = [ts, ts, None]
            intervals.append(prev)

    vrows = conn.execute(
        "SELECT start_ts, end_ts, name, semantic FROM visits WHERE lat BETWEEN ? AND ? "
        "AND lon BETWEEN ? AND ? AND start_ts BETWEEN ? AND ? ORDER BY start_ts",
        (lat - dlat, lat + dlat, lon - dlon, lon + dlon, lo, hi)).fetchall()
    for v in vrows:
        intervals.append([v["start_ts"], v["end_ts"], v["name"] or v["semantic"]])

    intervals.sort(key=lambda x: x[0])
    merged: list[list] = []
    for s, e, name in intervals:
        if merged and s <= merged[-1][1] + gap_s:
            merged[-1][1] = max(merged[-1][1], e)
            merged[-1][2] = merged[-1][2] or name
        else:
            merged.append([s, e, name])
    return merged


@app.get("/api/at_location")
def api_at_location(lat: float = Query(...), lon: float = Query(...),
                    radius_m: float = Query(200, ge=20, le=5000),
                    from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                    min_stay_min: float = Query(2, ge=0, le=120)):
    """Pobyty v okruhu místa. Pobyty kratší než min_stay_min (výchozí 2 min)
    se nepočítají – jde nejspíš jen o průjezd místem, ne o návštěvu."""
    lo, hi = ts_range(from_ts, to_ts)
    with closing(db.connect()) as conn:
        merged = _stays_at(conn, lat, lon, radius_m, lo, hi)
        custom = places.load_places(conn)
    min_s = min_stay_min * 60
    merged = [(s, e, n) for s, e, n in merged if e - s >= min_s]

    def stay_name(n):
        if not n:
            return None
        return places.SEMANTIC_CZ.get(n.upper(), n) or n

    return {
        "place_name": places.custom_label(custom, lat, lon),
        "stays": [{"start_ts": s, "end_ts": e, "name": stay_name(n),
                   "duration_s": max(e - s, 60)} for s, e, n in merged],
        "total_s": sum(max(e - s, 60) for s, e, _ in merged),
        "count": len(merged),
    }


# ---------------------------------------------------------------- exporty

@app.get("/api/export.xlsx")
def api_export_xlsx(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                    include_points: bool = Query(True)):
    from openpyxl import Workbook
    lo, hi = ts_range(from_ts, to_ts)
    wb = Workbook()
    wb.remove(wb.active)

    with closing(db.connect()) as conn:
        visits = conn.execute(
            "SELECT start_ts, end_ts, name, address, semantic, lat, lon FROM visits "
            "WHERE start_ts BETWEEN ? AND ? ORDER BY start_ts", (lo, hi)).fetchall()
        sheet(wb, "Návštěvy",
              ["Od", "Do", "Hodin", "Místo", "Adresa", "Typ", "Lat", "Lon"],
              [[fmt_dt(v["start_ts"]), fmt_dt(v["end_ts"]),
                round((v["end_ts"] - v["start_ts"]) / 3600, 2),
                v["name"], v["address"], v["semantic"], v["lat"], v["lon"]]
               for v in visits],
              widths=[18, 18, 8, 30, 30, 14, 11, 11])

        acts = conn.execute(
            "SELECT start_ts, end_ts, type, distance_m FROM activities "
            "WHERE start_ts BETWEEN ? AND ? ORDER BY start_ts", (lo, hi)).fetchall()
        sheet(wb, "Cesty",
              ["Od", "Do", "Minut", "Způsob", "Km"],
              [[fmt_dt(a["start_ts"]), fmt_dt(a["end_ts"]),
                round((a["end_ts"] - a["start_ts"]) / 60, 1), a["type"],
                round((a["distance_m"] or 0) / 1000, 2)] for a in acts],
              widths=[18, 18, 8, 24, 9])

        stats = api_stats(from_ts=from_ts, to_ts=to_ts, min_stay_min=2)
        sheet(wb, "Km po měsících", ["Měsíc", "Km"],
              [[m["month"], m["km"]] for m in stats["monthly_km"]], widths=[10, 10])
        sheet(wb, "Top místa", ["Místo", "Návštěv", "Hodin", "Lat", "Lon"],
              [[p["label"], p["count"], p["hours"], round(p["lat"], 6), round(p["lon"], 6)]
               for p in stats["top_places"]], widths=[34, 9, 9, 11, 11])

        if include_points:
            pts = _points_data(from_ts, to_ts, limit=100_000)
            ws = sheet(wb, "GPS body", ["Čas", "Lat", "Lon"],
                       [[fmt_dt(p[0]), p[1], p[2]] for p in pts["points"]],
                       widths=[18, 11, 11])
            if pts["step"] > 1:
                ws.append([])
                ws.append([f"Pozn.: vzorkováno 1:{pts['step']} "
                           f"(celkem {pts['total']} bodů v období)"])

    return xlsx_response(wb, "gmaps-historie.xlsx")


@app.get("/api/export_location.xlsx")
def api_export_location(lat: float = Query(...), lon: float = Query(...),
                        radius_m: float = Query(200, ge=20, le=5000),
                        from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                        min_stay_min: float = Query(2, ge=0, le=120),
                        label: str = Query("")):
    from openpyxl import Workbook
    lo, hi = ts_range(from_ts, to_ts)
    with closing(db.connect()) as conn:
        merged = _stays_at(conn, lat, lon, radius_m, lo, hi)
    merged = [(s, e, n) for s, e, n in merged if e - s >= min_stay_min * 60]
    wb = Workbook()
    wb.remove(wb.active)
    ws = sheet(wb, "Pobyty",
               ["Datum", "Od", "Do", "Hodin", "Místo"],
               [[fmt_dt(s).date(), fmt_dt(s).strftime("%H:%M"),
                 fmt_dt(e).strftime("%H:%M"),
                 round(max(e - s, 60) / 3600, 2), n or label]
                for s, e, n in merged],
               widths=[12, 8, 8, 8, 34])
    ws.append([])
    ws.append([f"Souřadnice: {lat:.6f}, {lon:.6f}; okruh {int(radius_m)} m; "
               f"celkem {len(merged)} pobytů"])
    return xlsx_response(wb, "gmaps-misto.xlsx")


@app.get("/api/export.gpx")
def api_export_gpx(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                   limit: int = Query(100_000, ge=1, le=500_000)):
    pts = _points_data(from_ts, to_ts, limit=limit)
    parts = ['<?xml version="1.0" encoding="UTF-8"?>\n'
             '<gpx version="1.1" creator="gmaps-historie" '
             'xmlns="http://www.topografix.com/GPX/1/1">\n<trk><trkseg>\n']
    for ts, lat, lon in pts["points"]:
        t = datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        parts.append(f'<trkpt lat="{lat}" lon="{lon}"><time>{t}</time></trkpt>\n')
    parts.append("</trkseg></trk>\n</gpx>\n")
    return Response("".join(parts), media_type="application/gpx+xml",
                    headers={"Content-Disposition": 'attachment; filename="gmaps-historie.gpx"'})


# ------------------------------------------------- kvalita dat a analýza

OUTLIER_SPEED = 70.0        # m/s (~250 km/h) – rychlejší skok = chyba GPS
DEFAULT_ACC_LIMIT = 100.0   # m


def _find_outliers(conn, lo: int, hi: int, limit_ids: int | None = None):
    """Najde GPS „teleporty": bod, který od předchozího vyžaduje nereálnou
    rychlost a následující bod je zpět u předchozího (osamocený skok)."""
    ids: list[int] = []
    prev = None      # poslední důvěryhodný bod (id, ts, lat, lon)
    cand = None      # podezřelý bod čekající na potvrzení dalším bodem
    cur = conn.execute(
        "SELECT id, ts, lat, lon FROM points WHERE ts BETWEEN ? AND ? ORDER BY ts",
        (lo, hi))
    for pid, ts, lat, lon in cur:
        if prev is None:
            prev = (pid, ts, lat, lon)
            continue
        if cand is not None:
            # je návrat k prev reálný, zatímco skok na cand nebyl?
            d_prev = haversine_m(prev[2], prev[3], lat, lon)
            dt_prev = ts - prev[1]
            if dt_prev > 0 and d_prev / dt_prev <= OUTLIER_SPEED:
                ids.append(cand[0])       # cand byl osamocený skok
            else:
                prev = cand               # skok byl skutečný přesun
            cand = None
            if limit_ids and len(ids) >= limit_ids:
                break
        dt = ts - prev[1]
        d = haversine_m(prev[2], prev[3], lat, lon)
        if dt > 0 and d / dt > OUTLIER_SPEED:
            cand = (pid, ts, lat, lon)
        else:
            prev = (pid, ts, lat, lon)
    return ids


def _find_duplicate_activities(conn, lo: int, hi: int) -> list[int]:
    """Stejná cesta uložená dvakrát (typicky překryv starého Takeoutu
    a nového exportu z telefonu): stejný druh pohybu a >50% časový překryv.
    Ponechá se záznam s vyplněnou (delší) vzdáleností."""
    car = {"IN_PASSENGER_VEHICLE", "DRIVING", "IN_VEHICLE"}   # různé názvy téhož
    ids: list[int] = []
    active: list[list] = []   # [id, start, end, type, dist]
    cur = conn.execute(
        "SELECT id, start_ts, end_ts, REPLACE(UPPER(type),' ','_') tn, "
        "COALESCE(distance_m,0) dist FROM activities "
        "WHERE start_ts BETWEEN ? AND ? ORDER BY start_ts", (lo, hi))
    for pid, s, e, tn, dist in cur:
        if tn in car:
            tn = "CAR"
        active = [a for a in active if a[2] > s]
        dup_of = None
        for a in active:
            overlap = min(a[2], e) - max(a[1], s)
            shorter = max(min(a[2] - a[1], e - s), 1)
            if a[3] == tn and overlap > 0.5 * shorter:
                dup_of = a
                break
        if dup_of is not None:
            if dist > dup_of[4]:
                ids.append(dup_of[0])
                active.remove(dup_of)
                active.append([pid, s, e, tn, dist])
            else:
                ids.append(pid)
        else:
            active.append([pid, s, e, tn, dist])
    return ids


@app.get("/api/quality")
def api_quality(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                accuracy_limit: float = Query(DEFAULT_ACC_LIMIT, ge=10)):
    """Kontrola kvality dat + upozornění (mezery v historii)."""
    lo, hi = ts_range(from_ts, to_ts)
    with closing(db.connect()) as conn:
        low_acc = conn.execute(
            "SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ? AND accuracy > ?",
            (lo, hi, accuracy_limit)).fetchone()["c"]
        bad_visits = conn.execute(
            "SELECT COUNT(*) c FROM visits WHERE start_ts BETWEEN ? AND ? "
            "AND end_ts <= start_ts", (lo, hi)).fetchone()["c"]
        bounds = conn.execute(
            "SELECT MIN(ts) a, MAX(ts) b, COUNT(*) n FROM points WHERE ts BETWEEN ? AND ?",
            (lo, hi)).fetchone()
        outliers = len(_find_outliers(conn, lo, hi)) if (bounds["n"] or 0) <= 3_000_000 else None
        dup_acts = len(_find_duplicate_activities(conn, lo, hi))

        gaps: list[str] = []
        gap_count = 0
        if bounds["a"] is not None:
            have = {r["d"] for r in conn.execute(
                "SELECT DISTINCT date(ts,'unixepoch','localtime') d FROM points "
                "WHERE ts BETWEEN ? AND ?", (lo, hi))}
            from datetime import timedelta
            day = local_dt(bounds["a"]).date()
            last = local_dt(bounds["b"]).date()
            while day <= last:
                if day.isoformat() not in have:
                    gap_count += 1
                    if len(gaps) < 30:
                        gaps.append(day.isoformat())
                day += timedelta(days=1)
    return {
        "points": bounds["n"],
        "low_accuracy": low_acc,
        "accuracy_limit": accuracy_limit,
        "outliers": outliers,
        "bad_visits": bad_visits,
        "duplicate_activities": dup_acts,
        "gap_days": gap_count,
        "gap_samples": gaps,
    }


@app.post("/api/cleanup")
def api_cleanup(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                remove_low_accuracy: bool = Query(True),
                accuracy_limit: float = Query(DEFAULT_ACC_LIMIT, ge=10),
                remove_outliers: bool = Query(True),
                remove_bad_visits: bool = Query(True),
                remove_duplicate_activities: bool = Query(True),
                dry_run: bool = Query(True)):
    """Automatické opravy: smaže nepřesné body, GPS teleporty, vadné návštěvy
    a duplicitní cesty. S dry_run=true jen spočítá, co by se smazalo."""
    lo, hi = ts_range(from_ts, to_ts)
    result = {"dry_run": dry_run, "low_accuracy": 0, "outliers": 0,
              "bad_visits": 0, "duplicate_activities": 0}
    with closing(db.connect()) as conn:
        if remove_low_accuracy:
            if dry_run:
                result["low_accuracy"] = conn.execute(
                    "SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ? AND accuracy > ?",
                    (lo, hi, accuracy_limit)).fetchone()["c"]
            else:
                result["low_accuracy"] = conn.execute(
                    "DELETE FROM points WHERE ts BETWEEN ? AND ? AND accuracy > ?",
                    (lo, hi, accuracy_limit)).rowcount
        if remove_outliers:
            ids = _find_outliers(conn, lo, hi)
            result["outliers"] = len(ids)
            if not dry_run:
                for i in range(0, len(ids), 900):
                    chunk = ids[i:i + 900]
                    conn.execute(
                        f"DELETE FROM points WHERE id IN ({','.join('?' * len(chunk))})",
                        chunk)
        if remove_bad_visits:
            if dry_run:
                result["bad_visits"] = conn.execute(
                    "SELECT COUNT(*) c FROM visits WHERE start_ts BETWEEN ? AND ? "
                    "AND end_ts <= start_ts", (lo, hi)).fetchone()["c"]
            else:
                result["bad_visits"] = conn.execute(
                    "DELETE FROM visits WHERE start_ts BETWEEN ? AND ? AND end_ts <= start_ts",
                    (lo, hi)).rowcount
        if remove_duplicate_activities:
            dup_ids = _find_duplicate_activities(conn, lo, hi)
            result["duplicate_activities"] = len(dup_ids)
            if not dry_run:
                for i in range(0, len(dup_ids), 900):
                    chunk = dup_ids[i:i + 900]
                    conn.execute(
                        f"DELETE FROM activities WHERE id IN ({','.join('?' * len(chunk))})",
                        chunk)
        if not dry_run:
            conn.commit()
            if sum(v for k, v in result.items() if k != "dry_run") > 0:
                conn.execute("VACUUM")   # uvolnit místo po smazaných záznamech
    return result


@app.get("/api/calendar")
def api_calendar(year: int = Query(..., ge=2000, le=2100)):
    """Denní souhrn pro kalendářový přehled roku: km z cest + počet GPS bodů."""
    from .common import LOCAL_TZ
    lo = int(datetime(year, 1, 1, tzinfo=LOCAL_TZ).timestamp())
    hi = int(datetime(year + 1, 1, 1, tzinfo=LOCAL_TZ).timestamp()) - 1
    with closing(db.connect()) as conn:
        km = {r["d"]: r["km"] for r in conn.execute(
            "SELECT date(start_ts,'unixepoch','localtime') d, "
            "SUM(COALESCE(distance_m,0))/1000.0 km FROM activities "
            "WHERE start_ts BETWEEN ? AND ? GROUP BY d", (lo, hi))}
        pts = {r["d"]: r["c"] for r in conn.execute(
            "SELECT date(ts,'unixepoch','localtime') d, COUNT(*) c FROM points "
            "WHERE ts BETWEEN ? AND ? GROUP BY d", (lo, hi))}
    days = sorted(set(km) | set(pts))
    return {"year": year,
            "days": [{"date": d, "km": round(km.get(d, 0), 1),
                      "points": pts.get(d, 0)} for d in days]}


# ------------------------------------------------ offline mapy (PMTiles)

def _pmtiles_path() -> str:
    return os.path.join(_data_dir(), "map.pmtiles")


@app.get("/api/pmtiles/status")
def api_pmtiles_status():
    path = _pmtiles_path()
    ok = os.path.exists(path)
    return {"available": ok, "size": os.path.getsize(path) if ok else 0}


@app.get("/api/pmtiles")
def api_pmtiles(request: Request):
    """Servíruje data/map.pmtiles s podporou HTTP Range (vyžaduje PMTiles klient)."""
    path = _pmtiles_path()
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


@app.get("/api/analysis")
def api_analysis(from_ts: int | None = Query(None), to_ts: int | None = Query(None)):
    """Podklady pro analytické grafy."""
    lo, hi = ts_range(from_ts, to_ts)
    with closing(db.connect()) as conn:
        weekday = conn.execute(
            "SELECT CAST(strftime('%w', start_ts, 'unixepoch', 'localtime') AS INT) w, "
            "SUM(COALESCE(distance_m,0))/1000.0 km FROM activities "
            "WHERE start_ts BETWEEN ? AND ? GROUP BY w", (lo, hi)).fetchall()
        hours = conn.execute(
            "SELECT CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INT) h, COUNT(*) c "
            "FROM points WHERE ts BETWEEN ? AND ? GROUP BY h", (lo, hi)).fetchall()
        yearly = conn.execute(
            "SELECT strftime('%Y', start_ts, 'unixepoch', 'localtime') y, "
            "SUM(COALESCE(distance_m,0))/1000.0 km, COUNT(*) n FROM activities "
            "WHERE start_ts BETWEEN ? AND ? GROUP BY y ORDER BY y", (lo, hi)).fetchall()
        places_monthly = conn.execute(
            "SELECT strftime('%Y-%m', start_ts, 'unixepoch', 'localtime') m, "
            "COUNT(DISTINCT ROUND(lat,3) || ',' || ROUND(lon,3)) n FROM visits "
            "WHERE start_ts BETWEEN ? AND ? GROUP BY m ORDER BY m", (lo, hi)).fetchall()
    wk = {r["w"]: round(r["km"], 1) for r in weekday}
    hr = {r["h"]: r["c"] for r in hours}
    return {
        # 0=neděle ve strftime → přeskládat na Po..Ne
        "weekday_km": [{"day": d, "km": wk.get(w, 0)}
                       for d, w in zip(["Po", "Út", "St", "Čt", "Pá", "So", "Ne"],
                                       [1, 2, 3, 4, 5, 6, 0], strict=True)],
        "hourly_points": [{"hour": h, "count": hr.get(h, 0)} for h in range(24)],
        "yearly_km": [{"year": r["y"], "km": round(r["km"], 1), "trips": r["n"]}
                      for r in yearly],
        "places_monthly": [{"month": r["m"], "places": r["n"]} for r in places_monthly],
    }


IMPORT_JOBS: dict[str, dict] = {}


@app.post("/api/import")
async def api_import(file: UploadFile):
    """Uloží nahraný soubor a import spustí na pozadí – u velkých souborů
    server zůstává použitelný a průběh jde sledovat přes /api/import/status."""
    tmpdir = _data_dir()
    os.makedirs(tmpdir, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=tmpdir, suffix=".upload", delete=False) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    job_id = uuid.uuid4().hex[:12]
    counters = importer.Counters()
    job = {"status": "running", "counters": counters, "error": None,
           "filename": file.filename}
    IMPORT_JOBS[job_id] = job

    def run():
        try:
            importer.import_path(tmp_path, counters=counters)
            job["status"] = "done"
        except Exception as exc:      # noqa: BLE001
            job["status"] = "error"
            job["error"] = (f"{exc} (část dat už mohla být uložena; opakovaný "
                            f"import je bezpečný, duplicity se přeskočí)")
        finally:
            os.unlink(tmp_path)

    threading.Thread(target=run, daemon=True).start()
    return {"job_id": job_id}


@app.get("/api/import/status/{job_id}")
def api_import_status(job_id: str):
    job = IMPORT_JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Neznámý import")
    return {"status": job["status"], "error": job["error"],
            "filename": job["filename"], **job["counters"].as_dict()}


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/kniha")
def kniha():
    return FileResponse(os.path.join(STATIC_DIR, "kniha.html"))


@app.get("/sw.js")
def service_worker():
    # service worker musí být servírovaný z kořene, aby měl scope na celou aplikaci
    return FileResponse(os.path.join(STATIC_DIR, "sw.js"),
                        media_type="application/javascript")


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(os.path.join(STATIC_DIR, "manifest.webmanifest"),
                        media_type="application/manifest+json")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

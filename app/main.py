"""FastAPI server – API nad historií polohy + statický frontend."""
from __future__ import annotations

import math
import os
import shutil
import tempfile
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db, importer

app = FastAPI(title="GMaps Historie", docs_url="/api/docs", openapi_url="/api/openapi.json")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

MAX_TRACK_POINTS = 60_000
MAX_HEAT_CELLS = 40_000
MAX_DIST_ROWS = 3_000_000


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _range(from_ts: int | None, to_ts: int | None) -> tuple[int, int]:
    return (from_ts if from_ts is not None else 0,
            to_ts if to_ts is not None else 2**53)


@app.get("/api/range")
def api_range():
    with db.connect() as conn:
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


@app.get("/api/points")
def api_points(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
               limit: int = Query(MAX_TRACK_POINTS, le=200_000)):
    lo, hi = _range(from_ts, to_ts)
    with db.connect() as conn:
        n = conn.execute("SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?",
                         (lo, hi)).fetchone()["c"]
        step = max(1, -(-n // limit))
        rows = conn.execute(
            "SELECT ts, lat, lon FROM points WHERE ts BETWEEN ? AND ? AND (id % ?) = 0 ORDER BY ts",
            (lo, hi, step)).fetchall()
    return {"total": n, "sampled": len(rows), "step": step,
            "points": [[r["ts"], round(r["lat"], 6), round(r["lon"], 6)] for r in rows]}


@app.get("/api/heatmap")
def api_heatmap(from_ts: int | None = Query(None), to_ts: int | None = Query(None)):
    lo, hi = _range(from_ts, to_ts)
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT ROUND(lat,4) la, ROUND(lon,4) lo, COUNT(*) c FROM points "
            "WHERE ts BETWEEN ? AND ? GROUP BY la, lo ORDER BY c DESC LIMIT ?",
            (lo, hi, MAX_HEAT_CELLS)).fetchall()
    return {"cells": [[r["la"], r["lo"], r["c"]] for r in rows]}


@app.get("/api/visits")
def api_visits(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
               limit: int = Query(5000, le=20000)):
    lo, hi = _range(from_ts, to_ts)
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT start_ts, end_ts, lat, lon, name, address, semantic FROM visits "
            "WHERE start_ts BETWEEN ? AND ? ORDER BY start_ts LIMIT ?",
            (lo, hi, limit)).fetchall()
    return {"visits": [dict(r) for r in rows]}


@app.get("/api/day")
def api_day(from_ts: int = Query(...), to_ts: int = Query(...)):
    """Vše pro přehrávání jednoho dne (hranice dne posílá klient ve své TZ)."""
    with db.connect() as conn:
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


def _point_distances(conn, lo: int, hi: int, tz_offset_min: int):
    """Vzdálenost spočtená ze surových bodů, po měsících (fallback bez aktivit).

    Přeskakuje mezery > 10 minut a nereálné skoky (> 70 m/s), aby chyby GPS
    nenafukovaly součet.
    """
    n = conn.execute("SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?",
                     (lo, hi)).fetchone()["c"]
    step = max(1, -(-n // MAX_DIST_ROWS))
    monthly: dict[str, float] = defaultdict(float)
    prev = None
    off = tz_offset_min * 60
    cur = conn.execute(
        "SELECT ts, lat, lon FROM points WHERE ts BETWEEN ? AND ? AND (id % ?) = 0 ORDER BY ts",
        (lo, hi, step))
    for ts, lat, lon in cur:
        if prev is not None:
            dt = ts - prev[0]
            if 0 < dt <= 600:
                d = haversine_m(prev[1], prev[2], lat, lon)
                if d / dt <= 70:
                    month = datetime.fromtimestamp(ts + off, timezone.utc).strftime("%Y-%m")
                monthly[month] += d
        prev = (ts, lat, lon)
    return monthly, step > 1


@app.get("/api/stats")
def api_stats(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
              tz_offset_min: int = Query(0)):
    lo, hi = _range(from_ts, to_ts)
    off = tz_offset_min * 60
    with db.connect() as conn:
        n_points = conn.execute(
            "SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?", (lo, hi)).fetchone()["c"]
        days = conn.execute(
            "SELECT COUNT(DISTINCT (ts + ?) / 86400) c FROM points WHERE ts BETWEEN ? AND ?",
            (off, lo, hi)).fetchone()["c"]

        by_type = conn.execute(
            "SELECT type, COUNT(*) n, SUM(COALESCE(distance_m,0)) dist "
            "FROM activities WHERE start_ts BETWEEN ? AND ? "
            "GROUP BY type ORDER BY dist DESC", (lo, hi)).fetchall()

        act_monthly = conn.execute(
            "SELECT strftime('%Y-%m', datetime(start_ts + ?, 'unixepoch')) m, "
            "SUM(COALESCE(distance_m,0)) dist FROM activities "
            "WHERE start_ts BETWEEN ? AND ? GROUP BY m ORDER BY m", (off, lo, hi)).fetchall()

        n_visits, visit_secs = conn.execute(
            "SELECT COUNT(*), SUM(end_ts - start_ts) FROM visits "
            "WHERE start_ts BETWEEN ? AND ?", (lo, hi)).fetchone()

        top_places = conn.execute(
            "SELECT COALESCE(NULLIF(name,''), COALESCE(semantic,'') || ' ' || "
            "       ROUND(lat,3) || ', ' || ROUND(lon,3)) label, "
            "       AVG(lat) lat, AVG(lon) lon, COUNT(*) n, SUM(end_ts - start_ts) secs "
            "FROM visits WHERE start_ts BETWEEN ? AND ? "
            "GROUP BY label ORDER BY secs DESC LIMIT 15", (lo, hi)).fetchall()

        activities_total = sum(r["dist"] or 0 for r in by_type)
        monthly_source = "activities"
        approx = False
        if act_monthly:
            monthly = {r["m"]: r["dist"] for r in act_monthly}
        else:
            monthly, approx = _point_distances(conn, lo, hi, tz_offset_min)
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


@app.post("/api/import")
async def api_import(file: UploadFile):
    suffix = ".zip" if (file.filename or "").lower().endswith(".zip") else ".json"
    tmpdir = os.path.dirname(db.DB_PATH) or "."
    os.makedirs(tmpdir, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=tmpdir, suffix=suffix, delete=False) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name
    try:
        counters = importer.import_path(tmp_path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Import selhal: {exc}")
    finally:
        os.unlink(tmp_path)
    return counters.as_dict()


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

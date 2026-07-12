"""Mapová data: body, heatmapa, návštěvy, den."""
from __future__ import annotations

import math
from contextlib import closing

from fastapi import APIRouter, Query

from .. import db, places
from ..common import haversine_m, ts_range
from ..core.config import MAX_HEAT_CELLS, MAX_TRACK_POINTS
from ..services.geo import bbox_sql, points_data
from ..services.simplify import rows_to_api, simplify_track

router = APIRouter(tags=["mapa"])


@router.get("/api/range")
def api_range():
    with closing(db.connect()) as conn:
        row = conn.execute(
            "SELECT MIN(ts) a, MAX(ts) b, COUNT(*) n FROM points").fetchone()
        visits = conn.execute(
            "SELECT COUNT(*) n, MIN(start_ts) a, MAX(end_ts) b FROM visits").fetchone()
        acts = conn.execute("SELECT COUNT(*) n FROM activities").fetchone()
        meta = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM import_meta")}
    lo = min(x for x in (row["a"], visits["a"], 2**53) if x is not None)
    hi = max(x for x in (row["b"], visits["b"], 0) if x is not None)
    return {
        "min_ts": lo if lo < 2**53 else None,
        "max_ts": hi if hi > 0 else None,
        "points": row["n"], "visits": visits["n"], "activities": acts["n"],
        "last_import": meta.get("last_import"),
        "profile": db.active_profile(),
    }


@router.get("/api/points")
def api_points(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
               limit: int = Query(MAX_TRACK_POINTS, ge=1, le=200_000),
               min_lat: float | None = Query(None), max_lat: float | None = Query(None),
               min_lon: float | None = Query(None), max_lon: float | None = Query(None),
               transport: str | None = Query(None)):
    return points_data(from_ts, to_ts, limit, min_lat, max_lat, min_lon, max_lon, transport)


@router.get("/api/heatmap")
def api_heatmap(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                precision: int = Query(4, ge=2, le=6),
                min_lat: float | None = Query(None), max_lat: float | None = Query(None),
                min_lon: float | None = Query(None), max_lon: float | None = Query(None)):
    lo, hi = ts_range(from_ts, to_ts)
    bsql, bargs = bbox_sql(min_lat, max_lat, min_lon, max_lon)
    with closing(db.connect()) as conn:
        # U milionů bodů se agreguje jen každý N-tý bod a počty se krokem
        # přenásobí – hustota (relativní intenzita) zůstává, dotaz je rychlý.
        n = conn.execute(
            f"SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?{bsql}",
            (lo, hi, *bargs)).fetchone()["c"]
        step = max(1, n // 500_000)
        ssql = " AND (id % ?) = 0" if step > 1 else ""
        sargs = (step,) if step > 1 else ()
        rows = conn.execute(
            f"SELECT ROUND(lat,?) la, ROUND(lon,?) lo, COUNT(*) * ? c FROM points "
            f"WHERE ts BETWEEN ? AND ?{bsql}{ssql} "
            f"GROUP BY la, lo ORDER BY c DESC LIMIT ?",
            (precision, precision, step, lo, hi, *bargs, *sargs, MAX_HEAT_CELLS)).fetchall()
    return {"cells": [[r["la"], r["lo"], r["c"]] for r in rows]}


@router.get("/api/visits")
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


@router.get("/api/day")
def api_day(from_ts: int = Query(...), to_ts: int = Query(...)):
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
    simplified = simplify_track(pts, 50_000) if len(pts) > 50_000 else pts
    return {"points": rows_to_api(simplified),
            "visits": [dict(r) for r in vis],
            "activities": [dict(r) for r in acts]}


def stays_at(conn, lat: float, lon: float, radius_m: float,
             lo: int, hi: int, gap_s: int = 2700):
    dlat = radius_m / 111_000
    dlon = radius_m / (111_000 * max(math.cos(math.radians(lat)), 0.01))
    intervals: list[list] = []
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


@router.get("/api/search_visits")
def api_search_visits(q: str = Query(..., min_length=2), limit: int = Query(20, le=100)):
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


@router.get("/api/at_location")
def api_at_location(lat: float = Query(...), lon: float = Query(...),
                    radius_m: float = Query(200, ge=20, le=5000),
                    from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                    min_stay_min: float = Query(2, ge=0, le=120)):
    lo, hi = ts_range(from_ts, to_ts)
    with closing(db.connect()) as conn:
        merged = stays_at(conn, lat, lon, radius_m, lo, hi)
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

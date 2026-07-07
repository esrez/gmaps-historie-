"""FastAPI server – API nad historií polohy + statický frontend."""
from __future__ import annotations

import math
import os
import shutil
import tempfile
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
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


@app.get("/api/search_visits")
def api_search_visits(q: str = Query(..., min_length=2), limit: int = Query(20, le=100)):
    """Fulltextové hledání ve vlastních navštívených místech."""
    like = f"%{q}%"
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT COALESCE(NULLIF(name,''), COALESCE(semantic,'') || ' ' || "
            "       ROUND(lat,3) || ', ' || ROUND(lon,3)) label, "
            "       AVG(lat) lat, AVG(lon) lon, COUNT(*) n, "
            "       SUM(end_ts - start_ts) secs, MAX(end_ts) last_ts "
            "FROM visits WHERE name LIKE ? OR address LIKE ? OR semantic LIKE ? "
            "GROUP BY label ORDER BY n DESC LIMIT ?", (like, like, like, limit)).fetchall()
    return {"results": [{"label": r["label"], "lat": r["lat"], "lon": r["lon"],
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
                    from_ts: int | None = Query(None), to_ts: int | None = Query(None)):
    lo, hi = _range(from_ts, to_ts)
    with db.connect() as conn:
        merged = _stays_at(conn, lat, lon, radius_m, lo, hi)
    return {
        "stays": [{"start_ts": s, "end_ts": e, "name": n,
                   "duration_s": max(e - s, 60)} for s, e, n in merged],
        "total_s": sum(max(e - s, 60) for s, e, _ in merged),
        "count": len(merged),
    }


# ---------------------------------------------------------------- exporty

def _fmt_dt(ts: int | None, off: int):
    if ts is None:
        return None
    return datetime.fromtimestamp(ts + off, timezone.utc).replace(tzinfo=None)


def _xlsx_response(wb, filename: str):
    import io
    buf = io.BytesIO()
    wb.save(buf)
    return Response(
        buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def _sheet(wb, title, headers, rows, widths=None):
    ws = wb.create_sheet(title)
    from openpyxl.styles import Font
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in rows:
        ws.append(row)
    for i, w in enumerate(widths or []):
        ws.column_dimensions[chr(ord("A") + i)].width = w
    ws.freeze_panes = "A2"
    return ws


@app.get("/api/export.xlsx")
def api_export_xlsx(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                    tz_offset_min: int = Query(0), include_points: bool = Query(True)):
    from openpyxl import Workbook
    lo, hi = _range(from_ts, to_ts)
    off = tz_offset_min * 60
    wb = Workbook()
    wb.remove(wb.active)

    with db.connect() as conn:
        visits = conn.execute(
            "SELECT start_ts, end_ts, name, address, semantic, lat, lon FROM visits "
            "WHERE start_ts BETWEEN ? AND ? ORDER BY start_ts", (lo, hi)).fetchall()
        _sheet(wb, "Návštěvy",
               ["Od", "Do", "Hodin", "Místo", "Adresa", "Typ", "Lat", "Lon"],
               [[_fmt_dt(v["start_ts"], off), _fmt_dt(v["end_ts"], off),
                 round((v["end_ts"] - v["start_ts"]) / 3600, 2),
                 v["name"], v["address"], v["semantic"], v["lat"], v["lon"]]
                for v in visits],
               widths=[18, 18, 8, 30, 30, 14, 11, 11])

        acts = conn.execute(
            "SELECT start_ts, end_ts, type, distance_m FROM activities "
            "WHERE start_ts BETWEEN ? AND ? ORDER BY start_ts", (lo, hi)).fetchall()
        _sheet(wb, "Cesty",
               ["Od", "Do", "Minut", "Způsob", "Km"],
               [[_fmt_dt(a["start_ts"], off), _fmt_dt(a["end_ts"], off),
                 round((a["end_ts"] - a["start_ts"]) / 60, 1), a["type"],
                 round((a["distance_m"] or 0) / 1000, 2)] for a in acts],
               widths=[18, 18, 8, 24, 9])

        stats = api_stats(from_ts, to_ts, tz_offset_min)
        _sheet(wb, "Km po měsících", ["Měsíc", "Km"],
               [[m["month"], m["km"]] for m in stats["monthly_km"]], widths=[10, 10])
        _sheet(wb, "Top místa", ["Místo", "Návštěv", "Hodin", "Lat", "Lon"],
               [[p["label"], p["count"], p["hours"], round(p["lat"], 6), round(p["lon"], 6)]
                for p in stats["top_places"]], widths=[34, 9, 9, 11, 11])

        if include_points:
            pts = api_points(from_ts, to_ts, limit=100_000)
            ws = _sheet(wb, "GPS body", ["Čas", "Lat", "Lon"],
                        [[_fmt_dt(p[0], off), p[1], p[2]] for p in pts["points"]],
                        widths=[18, 11, 11])
            if pts["step"] > 1:
                ws.append([])
                ws.append([f"Pozn.: vzorkováno 1:{pts['step']} "
                           f"(celkem {pts['total']} bodů v období)"])

    return _xlsx_response(wb, "gmaps-historie.xlsx")


@app.get("/api/export_location.xlsx")
def api_export_location(lat: float = Query(...), lon: float = Query(...),
                        radius_m: float = Query(200, ge=20, le=5000),
                        from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                        tz_offset_min: int = Query(0), label: str = Query("")):
    from openpyxl import Workbook
    lo, hi = _range(from_ts, to_ts)
    off = tz_offset_min * 60
    with db.connect() as conn:
        merged = _stays_at(conn, lat, lon, radius_m, lo, hi)
    wb = Workbook()
    wb.remove(wb.active)
    ws = _sheet(wb, "Pobyty",
                ["Datum", "Od", "Do", "Hodin", "Místo"],
                [[_fmt_dt(s, off).date(), _fmt_dt(s, off).strftime("%H:%M"),
                  _fmt_dt(e, off).strftime("%H:%M"),
                  round(max(e - s, 60) / 3600, 2), n or label]
                 for s, e, n in merged],
                widths=[12, 8, 8, 8, 34])
    ws.append([])
    ws.append([f"Souřadnice: {lat:.6f}, {lon:.6f}; okruh {int(radius_m)} m; "
               f"celkem {len(merged)} pobytů"])
    return _xlsx_response(wb, "gmaps-misto.xlsx")


@app.get("/api/export.gpx")
def api_export_gpx(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                   limit: int = Query(100_000, le=500_000)):
    pts = api_points(from_ts, to_ts, limit=limit)
    parts = ['<?xml version="1.0" encoding="UTF-8"?>\n'
             '<gpx version="1.1" creator="gmaps-historie" '
             'xmlns="http://www.topografix.com/GPX/1/1">\n<trk><trkseg>\n']
    for ts, lat, lon in pts["points"]:
        t = datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        parts.append(f'<trkpt lat="{lat}" lon="{lon}"><time>{t}</time></trkpt>\n')
    parts.append("</trkseg></trk>\n</gpx>\n")
    return Response("".join(parts), media_type="application/gpx+xml",
                    headers={"Content-Disposition": 'attachment; filename="gmaps-historie.gpx"'})


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

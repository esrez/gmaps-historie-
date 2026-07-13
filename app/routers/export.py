"""Exporty XLSX, GPX, GeoJSON."""
from __future__ import annotations

import json
from contextlib import closing
from datetime import UTC, datetime

from fastapi import APIRouter, Query
from fastapi.responses import Response

from .. import db
from ..common import fmt_dt, sheet, ts_range, xlsx_response
from ..routers.map_data import stays_at
from ..routers.stats import api_stats
from ..services.geo import points_data

router = APIRouter(tags=["export"])


@router.get("/api/export.xlsx")
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
              widths=[18, 18,  8, 24, 9])
    stats = api_stats(from_ts=from_ts, to_ts=to_ts, min_stay_min=2)
    sheet(wb, "Km po měsících", ["Měsíc", "Km"],
          [[m["month"], m["km"]] for m in stats["monthly_km"]], widths=[10, 10])
    sheet(wb, "Top místa", ["Místo", "Návštěv", "Hodin", "Lat", "Lon"],
          [[p["label"], p["count"], p["hours"], round(p["lat"], 6), round(p["lon"], 6)]
           for p in stats["top_places"]], widths=[34, 9, 9, 11, 11])
    if include_points:
        pts = points_data(from_ts, to_ts, limit=100_000)
        ws = sheet(wb, "GPS body", ["Čas", "Lat", "Lon"],
                   [[fmt_dt(p[0]), p[1], p[2]] for p in pts["points"]],
                   widths=[18, 11, 11])
        if pts["step"] > 1:
            ws.append([])
            ws.append([f"Pozn.: vzorkováno 1:{pts['step']} (celkem {pts['total']} bodů)"])
    return xlsx_response(wb, "gmaps-historie.xlsx")


@router.get("/api/export_location.xlsx")
def api_export_location(lat: float = Query(...), lon: float = Query(...),
                        radius_m: float = Query(200, ge=20, le=5000),
                        from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                        min_stay_min: float = Query(2, ge=0, le=120),
                        label: str = Query("")):
    from openpyxl import Workbook
    lo, hi = ts_range(from_ts, to_ts)
    with closing(db.connect()) as conn:
        merged = stays_at(conn, lat, lon, radius_m, lo, hi)
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
    ws.append([f"Souřadnice: {lat:.6f}, {lon:.6f}; okruh {int(radius_m)} m"])
    return xlsx_response(wb, "gmaps-misto.xlsx")


@router.get("/api/export.gpx")
def api_export_gpx(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                   limit: int = Query(100_000, ge=1, le=500_000)):
    pts = points_data(from_ts, to_ts, limit=limit)
    parts = ['<?xml version="1.0" encoding="UTF-8"?>\n'
             '<gpx version="1.1" creator="gmaps-historie" '
             'xmlns="http://www.topografix.com/GPX/1/1">\n'
             "<trk><name>GMaps Historie</name>\n"]
    # dělení na <trkseg> podle hranic úseků – jiné aplikace pak nekreslí
    # rovné „teleportační" čáry mezi jednotlivými dny a cestami
    for seg in _segments(pts):
        parts.append("<trkseg>\n")
        for ts, lat, lon in seg:
            t = datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
            parts.append(f'<trkpt lat="{lat}" lon="{lon}"><time>{t}</time></trkpt>\n')
        parts.append("</trkseg>\n")
    parts.append("</trk>\n</gpx>\n")
    return Response("".join(parts), media_type="application/gpx+xml",
                    headers={"Content-Disposition": 'attachment; filename="gmaps-historie.gpx"'})


def _segments(pts: dict) -> list[list]:
    """Rozdělí body na úseky podle hranic z points_data (breaks)."""
    points = pts["points"]
    if not points:
        return []
    bounds = sorted({0, *pts.get("breaks", []), len(points)})
    return [points[a:b] for a, b in zip(bounds, bounds[1:], strict=False) if b > a]


@router.get("/api/export.geojson")
def api_export_geojson(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                       limit: int = Query(50_000, ge=1, le=200_000),
                       anonymize: bool = Query(False),
                       grid_m: float = Query(500, ge=100, le=5000),
                       points: bool = Query(True)):
    """Export tras (LineString), bodů a návštěv jako GeoJSON.
    anonymize=true zaokrouhlí souřadnice, points=false vynechá surové body."""
    lo, hi = ts_range(from_ts, to_ts)
    pts = points_data(from_ts, to_ts, limit=limit)
    features = []

    def coord(lat, lon):
        if not anonymize:
            return [lon, lat]
        step = grid_m / 111_000
        return [round(lon / step) * step, round(lat / step) * step]

    # trasy jako LineString po úsecích – v QGIS a spol. rovnou čitelné čáry
    for seg in _segments(pts):
        if len(seg) < 2:
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString",
                         "coordinates": [coord(lat, lon) for _, lat, lon in seg]},
            "properties": {"kind": "track",
                           "start_ts": seg[0][0], "end_ts": seg[-1][0]},
        })
    if points:
        for ts, lat, lon in pts["points"]:
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": coord(lat, lon)},
                "properties": {"ts": ts, "kind": "point"},
            })
    with closing(db.connect()) as conn:
        visits = conn.execute(
            "SELECT start_ts, end_ts, lat, lon, name, semantic FROM visits "
            "WHERE start_ts BETWEEN ? AND ? LIMIT 5000", (lo, hi)).fetchall()
    for v in visits:
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": coord(v["lat"], v["lon"])},
            "properties": {
                "kind": "visit", "start_ts": v["start_ts"], "end_ts": v["end_ts"],
                "name": v["name"] or v["semantic"],
            },
        })
    body = {"type": "FeatureCollection", "features": features}
    return Response(json.dumps(body, ensure_ascii=False), media_type="application/geo+json",
                    headers={"Content-Disposition": 'attachment; filename="gmaps-historie.geojson"'})

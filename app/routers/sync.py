"""Synchronizace: OwnTracks, GPX, GeoJSON, SSE."""
from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from contextlib import closing
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from .. import db, importer
from ..core.events import event_bus
from ..core.rate_limit import RateLimiter

router = APIRouter(tags=["sync"])

GPX_NS = {"gpx": "http://www.topografix.com/GPX/1/1"}


def import_gpx_file(path: str) -> importer.Counters:
    tree = ET.parse(path)
    root = tree.getroot()
    c = importer.Counters()
    with closing(db.connect()) as conn:
        w = importer.Writer(conn, c, "gpx")
        for trkpt in root.findall(".//gpx:trkpt", GPX_NS) + root.findall(".//trkpt"):
            lat = float(trkpt.get("lat", 0))
            lon = float(trkpt.get("lon", 0))
            # pozor: Element bez potomků je falsy – „el or fallback" by u
            # standardního (namespacovaného) GPX zahodil všechny časy
            time_el = trkpt.find("gpx:time", GPX_NS)
            if time_el is None:
                time_el = trkpt.find("time")
            ts = importer.parse_ts(time_el.text if time_el is not None else None)
            if ts and lat and lon:
                w.point(ts, lat, lon)
        w.flush()
    return c


def import_geojson_file(path: str) -> importer.Counters:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    c = importer.Counters()
    with closing(db.connect()) as conn:
        w = importer.Writer(conn, c, "geojson")
        feats = data.get("features", [data] if data.get("type") == "Feature" else [])
        for f in feats:
            geom = f.get("geometry") or {}
            props = f.get("properties") or {}
            ts = importer.parse_ts(props.get("ts") or props.get("timestamp"))
            coords = geom.get("coordinates") or []
            if geom.get("type") == "Point" and len(coords) >= 2:
                w.point(ts or int(datetime.now(UTC).timestamp()), coords[1], coords[0])
            elif geom.get("type") == "LineString":
                start = ts if ts is not None else props.get("start_ts")
                for i, pt in enumerate(coords):
                    w.point((start or 0) + i * 60, pt[1], pt[0])
        w.flush()
    return c


_sync_limiter = RateLimiter(240)   # bodů za hodinu na IP – proti zahlcení


@router.post("/api/sync/owntracks")
async def api_owntracks(request: Request):
    """OwnTracks HTTP webhook – přijme JSON polohu a uloží bod."""
    client = request.client.host if request.client else "?"
    if not _sync_limiter.allow(client):
        raise HTTPException(429, "Příliš mnoho požadavků – zkuste to později")
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(400, "Neplatný JSON") from exc
    lat = body.get("lat") or (body.get("location") or {}).get("latitude")
    lon = body.get("lon") or body.get("lng") or (body.get("location") or {}).get("longitude")
    ts = importer.parse_ts(body.get("tst") or body.get("timestamp"))
    if lat is None or lon is None:
        raise HTTPException(400, "Chybí souřadnice")
    conn = db.connect()
    c = importer.Counters()
    w = importer.Writer(conn, c, "owntracks")
    acc = body.get("acc") or body.get("accuracy")
    w.point(ts or int(datetime.now(UTC).timestamp()), float(lat), float(lon),
            float(acc) if acc is not None else None)
    w.flush()
    conn.close()
    return {"ok": True, **c.as_dict()}


@router.post("/api/sync/gpx")
async def api_sync_gpx(request: Request):
    client = request.client.host if request.client else "?"
    if not _sync_limiter.allow(client):
        raise HTTPException(429, "Příliš mnoho požadavků – zkuste to později")
    body = await request.body()
    import os
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".gpx", delete=False) as tmp:
        tmp.write(body)
        path = tmp.name
    try:
        c = import_gpx_file(path)
        db.after_import()
        return {"ok": True, **c.as_dict()}
    finally:
        os.unlink(path)


@router.get("/api/events")
async def api_events(channel: str = Query("all")):
    """Server-Sent Events – notifikace o importu a synchronizaci."""
    return StreamingResponse(
        event_bus.sse_stream(channel),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/api/compare")
def api_compare(periods: str = Query(..., description="JSON pole [{from_ts,to_ts,label}]")):
    """Porovnání více období – vrátí km a body pro každé."""
    try:
        items = json.loads(periods)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, "Neplatný JSON v periods") from exc
    from ..services.geo import points_data
    out = []
    for p in items[:5]:
        lo, hi = int(p["from_ts"]), int(p["to_ts"])
        pts = points_data(lo, hi, limit=10_000)
        with closing(db.connect()) as conn:
            km = conn.execute(
                "SELECT SUM(COALESCE(distance_m,0))/1000.0 k FROM activities "
                "WHERE start_ts BETWEEN ? AND ?", (lo, hi)).fetchone()["k"] or 0
        out.append({"label": p.get("label", ""), "from_ts": lo, "to_ts": hi,
                    "km": round(km, 1), "points": pts["sampled"]})
    return {"periods": out}

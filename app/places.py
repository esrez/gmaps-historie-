"""Vlastní názvy míst.

Nový export z telefonu nenese jména míst (jen souřadnice a Home/Work),
takže si uživatel může místo pojmenovat sám – „Zákazník XY", adresa apod.
Název platí pro okruh kolem souřadnice a použije se všude, kde se místo
zobrazuje: top místa, mapa, „Kdy jsem tu byl?" i kniha jízd.
"""
from __future__ import annotations

import json
import math
from contextlib import closing

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import db
from .common import haversine_m

router = APIRouter(prefix="/api/places")

SEMANTIC_CZ = {"HOME": "Domov", "WORK": "Práce", "INFERRED_HOME": "Domov",
               "INFERRED_WORK": "Práce", "SEARCHED_ADDRESS": "", "UNKNOWN": ""}

DEFAULT_RADIUS = 250.0


def load_places(conn) -> list[dict]:
    out = []
    for r in conn.execute(
            "SELECT id, lat, lon, radius_m, name, polygon FROM place_names"):
        d = dict(r)
        d["polygon"] = json.loads(d["polygon"]) if d["polygon"] else None
        out.append(d)
    return out


def point_in_polygon(lat: float, lon: float, poly: list[list[float]]) -> bool:
    """Ray casting; poly = [[lat, lon], ...]."""
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        yi, xi = poly[i][0], poly[i][1]
        yj, xj = poly[j][0], poly[j][1]
        if (yi > lat) != (yj > lat) and \
                lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def custom_place(places: list[dict], lat, lon) -> dict | None:
    """Vlastní místo, do kterého bod spadá: polygon vyhrává, jinak nejbližší
    místo, v jehož okruhu souřadnice leží."""
    if lat is None or lon is None:
        return None
    best, best_d = None, float("inf")
    for p in places:
        if abs(p["lat"] - lat) > 0.05 or abs(p["lon"] - lon) > 0.08:
            continue
        if p["polygon"]:
            if point_in_polygon(lat, lon, p["polygon"]):
                return p
            continue
        d = haversine_m(lat, lon, p["lat"], p["lon"])
        if d <= p["radius_m"] and d < best_d:
            best, best_d = p, d
    return best


def custom_label(places: list[dict], lat, lon) -> str | None:
    p = custom_place(places, lat, lon)
    return p["name"] if p else None


def _place_bbox(place: dict) -> tuple[float, float, float, float]:
    """Obálka (min_lat, max_lat, min_lon, max_lon) místa pro předvýběr z DB."""
    if place["polygon"]:
        lats = [v[0] for v in place["polygon"]]
        lons = [v[1] for v in place["polygon"]]
        return min(lats), max(lats), min(lons), max(lons)
    lat, lon, r = place["lat"], place["lon"], place["radius_m"]
    dlat = r / 111_000
    dlon = r / (111_000 * max(math.cos(math.radians(lat)), 0.01))
    return lat - dlat, lat + dlat, lon - dlon, lon + dlon


def _place_contains(place: dict, lat: float, lon: float) -> bool:
    if place["polygon"]:
        return point_in_polygon(lat, lon, place["polygon"])
    return haversine_m(lat, lon, place["lat"], place["lon"]) <= place["radius_m"]


def stays_for_place(conn, place: dict, lo: int, hi: int, gap_s: int = 2700) -> list[list[int]]:
    """Pobyty na daném místě: GPS body seskupené v čase + záznamy návštěv,
    obojí omezené na geometrii místa (polygon nebo okruh) a sloučené do
    souvislých intervalů. Stejná logika jako mapové „Kdy jsem tu byl?", takže
    přehled míst chytí i pobyty, které existují jen jako GPS body (ne jako
    návštěva z Googlu)."""
    min_lat, max_lat, min_lon, max_lon = _place_bbox(place)
    intervals: list[list[int]] = []

    prev = None
    for ts, plat, plon in conn.execute(
            "SELECT ts, lat, lon FROM points WHERE lat BETWEEN ? AND ? "
            "AND lon BETWEEN ? AND ? AND ts BETWEEN ? AND ? ORDER BY ts",
            (min_lat, max_lat, min_lon, max_lon, lo, hi)):
        if not _place_contains(place, plat, plon):
            continue
        if prev is not None and ts - prev[1] <= gap_s:
            prev[1] = ts
        else:
            prev = [ts, ts]
            intervals.append(prev)

    for v in conn.execute(
            "SELECT start_ts, end_ts, lat, lon FROM visits WHERE lat BETWEEN ? AND ? "
            "AND lon BETWEEN ? AND ? AND start_ts BETWEEN ? AND ? ORDER BY start_ts",
            (min_lat, max_lat, min_lon, max_lon, lo, hi)):
        if _place_contains(place, v["lat"], v["lon"]):
            intervals.append([v["start_ts"], v["end_ts"]])

    intervals.sort(key=lambda x: x[0])
    merged: list[list[int]] = []
    for s, e in intervals:
        if merged and s <= merged[-1][1] + gap_s:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged


def visit_label(places: list[dict], lat, lon, name, semantic) -> str:
    """Popisek místa: vlastní název > jméno z Googlu > Domov/Práce > souřadnice."""
    custom = custom_label(places, lat, lon)
    if custom:
        return custom
    if name:
        return name
    sem = (semantic or "").upper()
    if sem in SEMANTIC_CZ:
        return SEMANTIC_CZ[sem] or f"{lat:.3f}, {lon:.3f}"
    return semantic or f"{lat:.3f}, {lon:.3f}"


class PlaceIn(BaseModel):
    lat: float = 0
    lon: float = 0
    name: str
    radius_m: float = DEFAULT_RADIUS
    polygon: list[list[float]] | None = None   # [[lat, lon], ...], min 3 body


@router.get("")
def list_places():
    with closing(db.connect()) as conn:
        return {"places": sorted(load_places(conn), key=lambda p: p["name"].lower())}


@router.get("/stats")
def place_stats(from_ts: int | None = None, to_ts: int | None = None,
                min_stay_min: float = 2):
    """Pobyt na pojmenovaných místech ve zvoleném období – pro bublinové
    nápovědy na mapě i přehled. Počítá z GPS bodů i návštěv (stejně jako
    „Kdy jsem tu byl?"), takže zachytí i pobyty bez záznamu návštěvy."""
    from .common import ts_range
    lo, hi = ts_range(from_ts, to_ts)
    min_s = int(min_stay_min * 60)
    with closing(db.connect()) as conn:
        out = []
        for p in load_places(conn):
            stays = [(s, e) for s, e in stays_for_place(conn, p, lo, hi) if e - s >= min_s]
            out.append({"id": p["id"], "count": len(stays),
                        "secs": sum(e - s for s, e in stays)})
    return {"stats": out}


@router.get("/{place_id}/stays")
def place_stays_detail(place_id: int, from_ts: int | None = None,
                       to_ts: int | None = None, min_stay_min: float = 2):
    """Jednotlivé pobyty na konkrétním pojmenovaném místě ve zvoleném období:
    kdy (od–do) a jak dlouho. Počítá z GPS bodů i návštěv, takže počty
    souhlasí s přehledem i s mapovým „Kdy jsem tu byl?"."""
    from .common import ts_range
    lo, hi = ts_range(from_ts, to_ts)
    min_s = int(min_stay_min * 60)
    with closing(db.connect()) as conn:
        pls = load_places(conn)
        target = next((p for p in pls if p["id"] == place_id), None)
        if target is None:
            raise HTTPException(404, "Místo nenalezeno")
        stays = [{"start_ts": s, "end_ts": e, "secs": e - s}
                 for s, e in stays_for_place(conn, target, lo, hi) if e - s >= min_s]
    total = sum(x["secs"] for x in stays)
    return {"place": {"id": target["id"], "name": target["name"],
                      "lat": target["lat"], "lon": target["lon"],
                      "polygon": target["polygon"]},
            "count": len(stays), "secs": total, "stays": stays}


@router.post("")
def upsert_place(p: PlaceIn):
    """Pojmenuje místo. Existuje-li vlastní název do 150 m, přejmenuje se
    místo založení duplicitního."""
    name = p.name.strip()
    if not name:
        raise HTTPException(400, "Název nesmí být prázdný")
    poly = None
    lat, lon = p.lat, p.lon
    if p.polygon is not None:
        if len(p.polygon) < 3:
            raise HTTPException(400, "Polygon potřebuje alespoň 3 body")
        poly = json.dumps([[round(a, 6), round(b, 6)] for a, b in p.polygon])
        lat = sum(v[0] for v in p.polygon) / len(p.polygon)   # střed pro popisek
        lon = sum(v[1] for v in p.polygon) / len(p.polygon)
    with closing(db.connect()) as conn:
        nearest_id, nearest_d = None, 150.0
        for e in load_places(conn):
            d = haversine_m(lat, lon, e["lat"], e["lon"])
            if d < nearest_d:
                nearest_id, nearest_d = e["id"], d
        if nearest_id is not None:
            conn.execute(
                "UPDATE place_names SET name=?, radius_m=?, lat=?, lon=?, "
                "polygon=COALESCE(?, polygon) WHERE id=?",
                (name, p.radius_m, round(lat, 6), round(lon, 6), poly, nearest_id))
        else:
            conn.execute(
                "INSERT INTO place_names(lat, lon, radius_m, name, polygon) "
                "VALUES(?,?,?,?,?)",
                (round(lat, 6), round(lon, 6), p.radius_m, name, poly))
        conn.commit()
        return {"places": load_places(conn)}


class PlacePatch(BaseModel):
    name: str | None = None
    radius_m: float | None = None


@router.patch("/{place_id}")
def patch_place(place_id: int, p: PlacePatch):
    """Úprava konkrétního místa podle id (přejmenování, změna okruhu) –
    spolehlivé z přehledu míst, nezávisí na blízkosti jako upsert."""
    sets, args = [], []
    if p.name is not None:
        name = p.name.strip()
        if not name:
            raise HTTPException(400, "Název nesmí být prázdný")
        sets.append("name=?")
        args.append(name)
    if p.radius_m is not None:
        if p.radius_m <= 0:
            raise HTTPException(400, "Okruh musí být kladný")
        sets.append("radius_m=?")
        args.append(p.radius_m)
    if not sets:
        raise HTTPException(400, "Nic k úpravě")
    with closing(db.connect()) as conn:
        cur = conn.execute(f"UPDATE place_names SET {', '.join(sets)} WHERE id=?",
                           (*args, place_id))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Místo nenalezeno")
        return {"places": load_places(conn)}


@router.delete("/{place_id}")
def delete_place(place_id: int):
    with closing(db.connect()) as conn:
        cur = conn.execute("DELETE FROM place_names WHERE id=?", (place_id,))
        conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "Název nenalezen")
    return {"deleted": place_id}

"""Vlastní názvy míst.

Nový export z telefonu nenese jména míst (jen souřadnice a Home/Work),
takže si uživatel může místo pojmenovat sám – „Zákazník XY", adresa apod.
Název platí pro okruh kolem souřadnice a použije se všude, kde se místo
zobrazuje: top místa, mapa, „Kdy jsem tu byl?" i kniha jízd.
"""
from __future__ import annotations

import json
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
    nápovědy na mapě (kolikrát a jak dlouho jsem tam byl)."""
    from .common import ts_range
    lo, hi = ts_range(from_ts, to_ts)
    with closing(db.connect()) as conn:
        pls = load_places(conn)
        agg = {p["id"]: {"id": p["id"], "count": 0, "secs": 0} for p in pls}
        for v in conn.execute(
                "SELECT start_ts, end_ts, lat, lon FROM visits "
                "WHERE start_ts BETWEEN ? AND ? AND end_ts - start_ts >= ?",
                (lo, hi, int(min_stay_min * 60))):
            hit = custom_place(pls, v["lat"], v["lon"])
            if hit is not None:
                agg[hit["id"]]["count"] += 1
                agg[hit["id"]]["secs"] += v["end_ts"] - v["start_ts"]
    return {"stats": list(agg.values())}


@router.get("/{place_id}/stays")
def place_stays(place_id: int, from_ts: int | None = None, to_ts: int | None = None,
                min_stay_min: float = 2):
    """Jednotlivé pobyty na konkrétním pojmenovaném místě ve zvoleném období:
    kdy (od–do) a jak dlouho. Pobyt se přiřadí místu stejně jako v přehledu
    (rozhoduje polygon, jinak nejbližší okruh), takže počty souhlasí."""
    from .common import ts_range
    lo, hi = ts_range(from_ts, to_ts)
    with closing(db.connect()) as conn:
        pls = load_places(conn)
        target = next((p for p in pls if p["id"] == place_id), None)
        if target is None:
            raise HTTPException(404, "Místo nenalezeno")
        stays = []
        for v in conn.execute(
                "SELECT start_ts, end_ts, lat, lon FROM visits "
                "WHERE start_ts BETWEEN ? AND ? AND end_ts - start_ts >= ? "
                "ORDER BY start_ts", (lo, hi, int(min_stay_min * 60))):
            hit = custom_place(pls, v["lat"], v["lon"])
            if hit is not None and hit["id"] == place_id:
                stays.append({"start_ts": v["start_ts"], "end_ts": v["end_ts"],
                              "secs": v["end_ts"] - v["start_ts"]})
    total = sum(s["secs"] for s in stays)
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

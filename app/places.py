"""Vlastní názvy míst.

Nový export z telefonu nenese jména míst (jen souřadnice a Home/Work),
takže si uživatel může místo pojmenovat sám – „Zákazník XY", adresa apod.
Název platí pro okruh kolem souřadnice a použije se všude, kde se místo
zobrazuje: top místa, mapa, „Kdy jsem tu byl?" i kniha jízd.
"""
from __future__ import annotations

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
    return [dict(r) for r in conn.execute(
        "SELECT id, lat, lon, radius_m, name FROM place_names")]


def custom_label(places: list[dict], lat, lon) -> str | None:
    """Nejbližší vlastní název, v jehož okruhu souřadnice leží."""
    if lat is None or lon is None:
        return None
    best, best_d = None, float("inf")
    for p in places:
        if abs(p["lat"] - lat) > 0.02 or abs(p["lon"] - lon) > 0.03:
            continue
        d = haversine_m(lat, lon, p["lat"], p["lon"])
        if d <= p["radius_m"] and d < best_d:
            best, best_d = p["name"], d
    return best


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
    lat: float
    lon: float
    name: str
    radius_m: float = DEFAULT_RADIUS


@router.get("")
def list_places():
    with closing(db.connect()) as conn:
        return {"places": sorted(load_places(conn), key=lambda p: p["name"].lower())}


@router.post("")
def upsert_place(p: PlaceIn):
    """Pojmenuje místo. Existuje-li vlastní název do 150 m, přejmenuje se
    místo založení duplicitního."""
    name = p.name.strip()
    if not name:
        raise HTTPException(400, "Název nesmí být prázdný")
    with closing(db.connect()) as conn:
        nearest_id, nearest_d = None, 150.0
        for e in load_places(conn):
            d = haversine_m(p.lat, p.lon, e["lat"], e["lon"])
            if d < nearest_d:
                nearest_id, nearest_d = e["id"], d
        if nearest_id is not None:
            conn.execute("UPDATE place_names SET name=?, radius_m=? WHERE id=?",
                         (name, p.radius_m, nearest_id))
        else:
            conn.execute(
                "INSERT INTO place_names(lat, lon, radius_m, name) VALUES(?,?,?,?)",
                (round(p.lat, 6), round(p.lon, 6), p.radius_m, name))
        conn.commit()
        return {"places": load_places(conn)}


@router.delete("/{place_id}")
def delete_place(place_id: int):
    with closing(db.connect()) as conn:
        cur = conn.execute("DELETE FROM place_names WHERE id=?", (place_id,))
        conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "Název nenalezen")
    return {"deleted": place_id}

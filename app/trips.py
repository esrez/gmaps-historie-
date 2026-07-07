"""Kniha jízd – generování jízd z historie polohy, ruční úpravy a export
ve formátu XLSX vhodném pro import do programu SPZ (Milk Computers).

Pozn. k SPZ: program importuje knihu jízd z xlsx; vozidlo (SPZ) musí být
v programu SPZ založené, jinak import odmítne. Prázdný řidič se doplní
z karty vozidla.
"""
from __future__ import annotations

import math
from contextlib import closing
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from . import db

router = APIRouter(prefix="/api/trips")

# typy aktivit považované za jízdu firemním vozidlem (normalizované)
CAR_TYPES = {"IN_PASSENGER_VEHICLE", "DRIVING", "MOTORCYCLING", "IN_VEHICLE"}

SEMANTIC_CZ = {"HOME": "Domov", "WORK": "Práce", "INFERRED_HOME": "Domov",
               "INFERRED_WORK": "Práce", "SEARCHED_ADDRESS": ""}


def _haversine_m(lat1, lon1, lat2, lon2):
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def _place_name(conn, lat, lon, cache, radius_m=350):
    """Pojmenuje souřadnici podle nejbližšího navštíveného místa z historie."""
    if lat is None or lon is None:
        return ""
    key = (round(lat, 4), round(lon, 4))
    if key in cache:
        return cache[key]
    dlat = radius_m / 111_000
    dlon = radius_m / (111_000 * max(math.cos(math.radians(lat)), 0.01))
    best, best_d = None, radius_m + 1
    for r in conn.execute(
            "SELECT name, semantic, address, lat, lon FROM visits "
            "WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
            (lat - dlat, lat + dlat, lon - dlon, lon + dlon)):
        d = _haversine_m(lat, lon, r["lat"], r["lon"])
        if d < best_d:
            label = (r["name"]
                     or SEMANTIC_CZ.get((r["semantic"] or "").upper(), r["semantic"])
                     or r["address"])
            if label:
                best, best_d = label, d
    result = best or f"{lat:.4f}, {lon:.4f}"
    cache[key] = result
    return result


class GenerateParams(BaseModel):
    from_ts: int | None = None
    to_ts: int | None = None
    tz_offset_min: int = 0
    workdays_only: bool = True
    hour_from: int = 6
    hour_to: int = 18
    min_km: float = 0.5
    purpose: str = "Služební jízda"
    driver: str = ""
    plate: str = ""


class TripIn(BaseModel):
    start_ts: int
    end_ts: int
    km: float = 0
    origin: str = ""
    destination: str = ""
    purpose: str = ""
    driver: str = ""
    plate: str = ""
    private: bool = False


class TripPatch(BaseModel):
    start_ts: int | None = None
    end_ts: int | None = None
    km: float | None = None
    origin: str | None = None
    destination: str | None = None
    purpose: str | None = None
    driver: str | None = None
    plate: str | None = None
    private: bool | None = None


def _row(r) -> dict:
    d = dict(r)
    d["private"] = bool(d["private"])
    return d


@router.get("")
def list_trips(from_ts: int | None = Query(None), to_ts: int | None = Query(None)):
    lo = from_ts if from_ts is not None else 0
    hi = to_ts if to_ts is not None else 2**53
    with closing(db.connect()) as conn:
        rows = conn.execute(
            "SELECT * FROM trips WHERE start_ts BETWEEN ? AND ? ORDER BY start_ts",
            (lo, hi)).fetchall()
    return {"trips": [_row(r) for r in rows],
            "total_km": round(sum(r["km"] for r in rows), 1)}


@router.post("/generate")
def generate(p: GenerateParams):
    lo = p.from_ts if p.from_ts is not None else 0
    hi = p.to_ts if p.to_ts is not None else 2**53
    off = p.tz_offset_min * 60
    created = 0
    with closing(db.connect()) as conn:
        acts = conn.execute(
            "SELECT start_ts, end_ts, distance_m, start_lat, start_lon, end_lat, end_lon "
            "FROM activities WHERE start_ts BETWEEN ? AND ? "
            "AND REPLACE(UPPER(type), ' ', '_') IN (%s) ORDER BY start_ts"
            % ",".join("?" * len(CAR_TYPES)),
            (lo, hi, *CAR_TYPES)).fetchall()
        cache: dict = {}
        for a in acts:
            km = (a["distance_m"] or 0) / 1000
            if km < p.min_km:
                continue
            local = datetime.fromtimestamp(a["start_ts"] + off, timezone.utc)
            if p.workdays_only and local.weekday() >= 5:
                continue
            if not (p.hour_from <= local.hour < p.hour_to):
                continue
            cur = conn.execute(
                "INSERT OR IGNORE INTO trips(start_ts, end_ts, km, origin, destination,"
                " purpose, driver, plate, private, activity_ts)"
                " VALUES(?,?,?,?,?,?,?,?,0,?)",
                (a["start_ts"], a["end_ts"], round(km, 1),
                 _place_name(conn, a["start_lat"], a["start_lon"], cache),
                 _place_name(conn, a["end_lat"], a["end_lon"], cache),
                 p.purpose, p.driver, p.plate, a["start_ts"]))
            created += cur.rowcount
        conn.commit()
    return {"created": created, "scanned": len(acts)}


@router.post("")
def create_trip(t: TripIn):
    with closing(db.connect()) as conn:
        cur = conn.execute(
            "INSERT INTO trips(start_ts, end_ts, km, origin, destination,"
            " purpose, driver, plate, private) VALUES(?,?,?,?,?,?,?,?,?)",
            (t.start_ts, t.end_ts, t.km, t.origin, t.destination,
             t.purpose, t.driver, t.plate, int(t.private)))
        conn.commit()
        row = conn.execute("SELECT * FROM trips WHERE id=?", (cur.lastrowid,)).fetchone()
    return _row(row)


@router.patch("/{trip_id}")
def update_trip(trip_id: int, patch: TripPatch):
    fields = {k: v for k, v in patch.model_dump(exclude_unset=True).items()}
    if not fields:
        raise HTTPException(400, "Žádná pole ke změně")
    if "private" in fields:
        fields["private"] = int(fields["private"])
    sets = ", ".join(f"{k}=?" for k in fields)
    with closing(db.connect()) as conn:
        cur = conn.execute(f"UPDATE trips SET {sets} WHERE id=?",
                           (*fields.values(), trip_id))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Jízda nenalezena")
        row = conn.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
    return _row(row)


@router.delete("/{trip_id}")
def delete_trip(trip_id: int):
    with closing(db.connect()) as conn:
        cur = conn.execute("DELETE FROM trips WHERE id=?", (trip_id,))
        conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "Jízda nenalezena")
    return {"deleted": trip_id}


@router.delete("")
def delete_range(from_ts: int | None = Query(None), to_ts: int | None = Query(None)):
    """Smaže všechny jízdy ve zvoleném období (např. před novým generováním)."""
    lo = from_ts if from_ts is not None else 0
    hi = to_ts if to_ts is not None else 2**53
    with closing(db.connect()) as conn:
        cur = conn.execute("DELETE FROM trips WHERE start_ts BETWEEN ? AND ?", (lo, hi))
        conn.commit()
    return {"deleted": cur.rowcount}


@router.get("/export.xlsx")
def export_spz(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
               tz_offset_min: int = Query(0)):
    from openpyxl import Workbook
    from openpyxl.styles import Font

    lo = from_ts if from_ts is not None else 0
    hi = to_ts if to_ts is not None else 2**53
    off = tz_offset_min * 60
    with closing(db.connect()) as conn:
        rows = conn.execute(
            "SELECT * FROM trips WHERE start_ts BETWEEN ? AND ? ORDER BY start_ts",
            (lo, hi)).fetchall()

    wb = Workbook()
    ws = wb.active
    ws.title = "Kniha jízd"
    headers = ["SPZ", "Datum", "Odjezd", "Příjezd", "Odkud", "Kam",
               "Účel jízdy", "Km", "Řidič", "Soukromá"]
    ws.append(headers)
    for c in ws[1]:
        c.font = Font(bold=True)
    for r in rows:
        s = datetime.fromtimestamp(r["start_ts"] + off, timezone.utc)
        e = datetime.fromtimestamp(r["end_ts"] + off, timezone.utc)
        ws.append([r["plate"], s.date(), s.strftime("%H:%M"), e.strftime("%H:%M"),
                   r["origin"], r["destination"], r["purpose"], r["km"],
                   r["driver"], "ano" if r["private"] else "ne"])
    for col, w in zip("ABCDEFGHIJ", [12, 11, 8, 8, 26, 26, 22, 7, 16, 9]):
        ws.column_dimensions[col].width = w
    for row in ws.iter_rows(min_row=2, min_col=2, max_col=2):
        row[0].number_format = "DD.MM.YYYY"
    ws.freeze_panes = "A2"

    total = ws.max_row + 1
    ws.cell(row=total, column=7, value="Celkem").font = Font(bold=True)
    ws.cell(row=total, column=8, value=round(sum(r["km"] for r in rows), 1)).font = Font(bold=True)

    import io
    from fastapi.responses import Response
    buf = io.BytesIO()
    wb.save(buf)
    return Response(
        buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="kniha-jizd-spz.xlsx"'})

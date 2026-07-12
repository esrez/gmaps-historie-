"""Služby pro mapová data a prostorové dotazy."""
from __future__ import annotations

from contextlib import closing

from .. import db
from ..common import ts_range
from ..core.config import MAX_TRACK_POINTS
from .simplify import rows_to_api, simplify_track


def bbox_sql(min_lat, max_lat, min_lon, max_lon) -> tuple[str, tuple]:
  """Volitelné omezení na výřez mapy."""
  if None in (min_lat, max_lat, min_lon, max_lon):
    return "", ()
  return (" AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
          (min_lat, max_lat, min_lon, max_lon))


def _fetch_points(conn, lo, hi, bsql, bargs, pre_limit: int) -> tuple[int, list]:
  """Načte body v rozsahu; u velkých sad předvzorkuje pro DP."""
  n = conn.execute(
    f"SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?{bsql}",
    (lo, hi, *bargs)).fetchone()["c"]
  if n == 0:
    return 0, []
  if n <= pre_limit:
    rows = conn.execute(
      f"SELECT ts, lat, lon FROM points WHERE ts BETWEEN ? AND ?{bsql} ORDER BY ts",
      (lo, hi, *bargs)).fetchall()
    return n, rows
  step = max(1, -(-n // pre_limit))
  rows = conn.execute(
    f"SELECT ts, lat, lon FROM points WHERE ts BETWEEN ? AND ?{bsql} "
    f"AND (id % ?) = 0 ORDER BY ts",
    (lo, hi, *bargs, step)).fetchall()
  return n, rows


def _simplify_response(rows: list, total: int, limit: int) -> dict:
  simplified = simplify_track(rows, limit)
  return {
    "total": total,
    "sampled": len(simplified),
    "step": 1,
    "simplified": True,
    "points": rows_to_api(simplified),
  }


def points_data(from_ts, to_ts, limit=MAX_TRACK_POINTS,
                min_lat=None, max_lat=None, min_lon=None, max_lon=None,
                transport: str | None = None):
  lo, hi = ts_range(from_ts, to_ts)
  # bbox přes B-tree index na lat: na malém výřezu srovnatelné s R-tree,
  # na širokém výřezu (miliony bodů v záběru) řádově rychlejší
  bsql, bargs = bbox_sql(min_lat, max_lat, min_lon, max_lon)

  if transport:
    return _points_by_transport(lo, hi, limit, bsql, bargs, transport)

  # 2× limit stačí: DP simplifikace stejně dál redukuje a poloviční vstup
  # znamená poloviční čas Pythonu – důležité u víceletých dat (miliony bodů)
  pre_limit = min(limit * 2, 200_000)
  with closing(db.connect()) as conn:
    n, rows = _fetch_points(conn, lo, hi, bsql, bargs, pre_limit)
  return _simplify_response(rows, n, limit)


def _points_by_transport(lo, hi, limit, bsql, bargs, transport: str):
  """Body filtrované podle typu aktivity v daném čase.

  Intervaly aktivit se nahrají do dočasné tabulky a body se vybírají JOINem
  přes index na ts. Dřívější skládání jednoho OR výrazu padalo u víceletých
  dat na limitu hloubky výrazu SQLite (tisíce aktivit → chyba 500).
  """
  types = _transport_types(transport)
  if not types:
    return points_data(lo, hi, limit)
  ph = ",".join("?" * len(types))
  empty = {"total": 0, "sampled": 0, "step": 1, "simplified": True, "points": []}
  with closing(db.connect()) as conn:
    acts = conn.execute(
      f"SELECT start_ts, end_ts FROM activities WHERE start_ts BETWEEN ? AND ? "
      f"AND REPLACE(UPPER(type),' ','_') IN ({ph}) ORDER BY start_ts",
      (lo, hi, *types)).fetchall()
    if not acts:
      return empty
    conn.execute("CREATE TEMP TABLE IF NOT EXISTS _tr_iv(s INTEGER, e INTEGER)")
    conn.execute("DELETE FROM _tr_iv")
    conn.executemany("INSERT INTO _tr_iv(s, e) VALUES(?, ?)",
                     [(a["start_ts"], a["end_ts"]) for a in acts])
    base = (f"FROM _tr_iv iv JOIN points ON points.ts BETWEEN iv.s AND iv.e"
            f"{bsql}")
    n = conn.execute(
      f"SELECT COUNT(DISTINCT points.id) c {base}", bargs).fetchone()["c"]
    if n == 0:
      return empty
    pre_limit = min(limit * 2, 200_000)
    ssql, sargs = "", ()
    if n > pre_limit:
      step = max(1, -(-n // pre_limit))
      ssql, sargs = " AND (points.id % ?) = 0", (step,)
    rows = conn.execute(
      f"SELECT points.ts ts, points.lat lat, points.lon lon {base}{ssql} "
      f"GROUP BY points.id ORDER BY points.ts", (*bargs, *sargs)).fetchall()
  return _simplify_response(rows, n, limit)


def _transport_types(mode: str) -> list[str]:
  m = mode.upper().replace(" ", "_")
  groups = {
    "CAR": {"IN_PASSENGER_VEHICLE", "DRIVING", "MOTORCYCLING", "IN_VEHICLE"},
    "WALK": {"WALKING", "ON_FOOT", "RUNNING"},
    "BIKE": {"CYCLING", "BICYCLING"},
    "TRANSIT": {"IN_BUS", "IN_TRAM", "IN_SUBWAY", "IN_TRAIN", "IN_FERRY",
                "IN_PUBLIC_TRANSPORT"},
  }
  if m in groups:
    return sorted(groups[m])
  return [m] if m else []

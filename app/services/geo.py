"""Služby pro mapová data a prostorové dotazy."""
from __future__ import annotations

from contextlib import closing

from .. import db
from ..common import ts_range
from ..core.config import MAX_TRACK_POINTS


def bbox_sql(min_lat, max_lat, min_lon, max_lon) -> tuple[str, tuple]:
  """Volitelné omezení na výřez mapy."""
  if None in (min_lat, max_lat, min_lon, max_lon):
    return "", ()
  return (" AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
          (min_lat, max_lat, min_lon, max_lon))


def bbox_rtree_sql(min_lat, max_lat, min_lon, max_lon) -> tuple[str, tuple]:
  """R-tree dotaz pro rychlejší bbox výběr bodů."""
  if None in (min_lat, max_lat, min_lon, max_lon):
    return "", ()
  return (
    " AND id IN (SELECT id FROM points_rtree WHERE max_lat >= ? AND min_lat <= ? "
    "AND max_lon >= ? AND min_lon <= ?)",
    (min_lat, max_lat, min_lon, max_lon),
  )


def _use_rtree(conn) -> bool:
  row = conn.execute(
    "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='points_rtree'"
  ).fetchone()
  return bool(row and row["c"])


def points_data(from_ts, to_ts, limit=MAX_TRACK_POINTS,
                min_lat=None, max_lat=None, min_lon=None, max_lon=None,
                transport: str | None = None):
  lo, hi = ts_range(from_ts, to_ts)
  with closing(db.connect()) as conn:
    use_rt = _use_rtree(conn) and None not in (min_lat, max_lat, min_lon, max_lon)
    bsql, bargs = bbox_rtree_sql(min_lat, max_lat, min_lon, max_lon) if use_rt \
      else bbox_sql(min_lat, max_lat, min_lon, max_lon)

  if transport:
    return _points_by_transport(lo, hi, limit, bsql, bargs, transport)

  with closing(db.connect()) as conn:
    n = conn.execute(
      f"SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?{bsql}",
      (lo, hi, *bargs)).fetchone()["c"]
    step = max(1, -(-n // limit))
    rows = conn.execute(
      f"SELECT ts, lat, lon FROM points WHERE ts BETWEEN ? AND ?{bsql} "
      f"AND (id % ?) = 0 ORDER BY ts",
      (lo, hi, *bargs, step)).fetchall()
  return {"total": n, "sampled": len(rows), "step": step,
          "points": [[r["ts"], round(r["lat"], 6), round(r["lon"], 6)] for r in rows]}


def _points_by_transport(lo, hi, limit, bsql, bargs, transport: str):
  """Body filtrované podle typu aktivity v daném čase."""
  types = _transport_types(transport)
  if not types:
    return points_data(lo, hi, limit)
  ph = ",".join("?" * len(types))
  with closing(db.connect()) as conn:
    acts = conn.execute(
      f"SELECT start_ts, end_ts FROM activities WHERE start_ts BETWEEN ? AND ? "
      f"AND REPLACE(UPPER(type),' ','_') IN ({ph}) ORDER BY start_ts",
      (lo, hi, *types)).fetchall()
    if not acts:
      return {"total": 0, "sampled": 0, "step": 1, "points": []}
    parts, args = [], []
    for a in acts:
      parts.append(f"(ts BETWEEN ? AND ?{bsql})")
      args.extend([a["start_ts"], a["end_ts"], *bargs])
    where = " OR ".join(parts)
    n = conn.execute(f"SELECT COUNT(*) c FROM points WHERE {where}", args).fetchone()["c"]
    step = max(1, -(-n // limit))
    rows = conn.execute(
      f"SELECT ts, lat, lon FROM points WHERE ({where}) AND (id % ?) = 0 ORDER BY ts",
      [*args, step]).fetchall()
  return {"total": n, "sampled": len(rows), "step": step,
          "points": [[r["ts"], round(r["lat"], 6), round(r["lon"], 6)] for r in rows]}


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

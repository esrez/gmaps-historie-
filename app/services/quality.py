"""Detekce problémů v datech."""
from __future__ import annotations

from ..common import haversine_m
from ..core.config import OUTLIER_SPEED


def find_outliers(conn, lo: int, hi: int, limit_ids: int | None = None) -> list[int]:
  ids: list[int] = []
  prev = None
  cand = None
  cur = conn.execute(
    "SELECT id, ts, lat, lon FROM points WHERE ts BETWEEN ? AND ? ORDER BY ts",
    (lo, hi))
  for pid, ts, lat, lon in cur:
    if prev is None:
      prev = (pid, ts, lat, lon)
      continue
    if cand is not None:
      d_prev = haversine_m(prev[2], prev[3], lat, lon)
      dt_prev = ts - prev[1]
      if dt_prev > 0 and d_prev / dt_prev <= OUTLIER_SPEED:
        ids.append(cand[0])
      else:
        prev = cand
      cand = None
      if limit_ids and len(ids) >= limit_ids:
        break
    dt = ts - prev[1]
    d = haversine_m(prev[2], prev[3], lat, lon)
    if dt > 0 and d / dt > OUTLIER_SPEED:
      cand = (pid, ts, lat, lon)
    else:
      prev = (pid, ts, lat, lon)
  return ids


def find_duplicate_activities(conn, lo: int, hi: int) -> list[int]:
  car = {"IN_PASSENGER_VEHICLE", "DRIVING", "IN_VEHICLE"}
  ids: list[int] = []
  active: list[list] = []
  cur = conn.execute(
    "SELECT id, start_ts, end_ts, REPLACE(UPPER(type),' ','_') tn, "
    "COALESCE(distance_m,0) dist FROM activities "
    "WHERE start_ts BETWEEN ? AND ? ORDER BY start_ts", (lo, hi))
  for pid, s, e, tn, dist in cur:
    if tn in car:
      tn = "CAR"
    active = [a for a in active if a[2] > s]
    dup_of = None
    for a in active:
      overlap = min(a[2], e) - max(a[1], s)
      shorter = max(min(a[2] - a[1], e - s), 1)
      if a[3] == tn and overlap > 0.5 * shorter:
        dup_of = a
        break
    if dup_of is not None:
      if dist > dup_of[4]:
        ids.append(dup_of[0])
        active.remove(dup_of)
        active.append([pid, s, e, tn, dist])
      else:
        ids.append(pid)
    else:
      active.append([pid, s, e, tn, dist])
  return ids


def detect_new_places(conn, lo: int, hi: int, limit: int = 20) -> list[dict]:
  """Místa navštívená poprvé v období (oproti historii před obdobím)."""
  rows = conn.execute(
    "SELECT v.lat, v.lon, v.name, v.semantic, MIN(v.start_ts) first_ts, "
    "COUNT(*) n FROM visits v "
    "WHERE v.start_ts BETWEEN ? AND ? "
    "AND NOT EXISTS (SELECT 1 FROM visits o "
    "  WHERE o.start_ts < ? AND ROUND(o.lat,3)=ROUND(v.lat,3) "
    "  AND ROUND(o.lon,3)=ROUND(v.lon,3)) "
    "GROUP BY ROUND(lat,3), ROUND(lon,3) ORDER BY first_ts DESC LIMIT ?",
    (lo, hi, lo, limit)).fetchall()
  return [{"lat": r["lat"], "lon": r["lon"], "name": r["name"] or r["semantic"],
           "first_ts": r["first_ts"], "visits": r["n"]} for r in rows]

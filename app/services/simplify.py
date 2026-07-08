"""Zjednodušení GPS tras (Douglas–Peucker) pro vykreslení na mapě."""
from __future__ import annotations

import math

from ..common import haversine_m
from ..core.config import TRACK_GAP_KM, TRACK_GAP_S, TRACK_SIMPLIFY_EPSILON_M

PointRow = dict | tuple  # sqlite Row nebo (ts, lat, lon)


def _coords(row: PointRow) -> tuple[float, float]:
  if isinstance(row, dict):
    return row["lat"], row["lon"]
  if len(row) >= 3:
    return row[1], row[2]
  return row[0], row[1]


def _ts(row: PointRow) -> int:
  if isinstance(row, dict):
    return row["ts"]
  return row[0]


def cross_track_distance_m(lat: float, lon: float,
                           lat1: float, lon1: float,
                           lat2: float, lon2: float) -> float:
  """Kolmá vzdálenost bodu od úsečky na sféře (cross-track distance)."""
  if lat1 == lat2 and lon1 == lon2:
    return haversine_m(lat, lon, lat1, lon1)
  r = 6_371_000.0
  d13 = haversine_m(lat1, lon1, lat, lon) / r
  if d13 == 0:
    return 0.0
  b12 = math.atan2(
    math.sin(math.radians(lon2 - lon1)) * math.cos(math.radians(lat2)),
    math.cos(math.radians(lat1)) * math.sin(math.radians(lat2))
    - math.sin(math.radians(lat1)) * math.cos(math.radians(lat2))
    * math.cos(math.radians(lon2 - lon1)),
  )
  b13 = math.atan2(
    math.sin(math.radians(lon - lon1)) * math.cos(math.radians(lat)),
    math.cos(math.radians(lat1)) * math.sin(math.radians(lat))
    - math.sin(math.radians(lat1)) * math.cos(math.radians(lat))
    * math.cos(math.radians(lon - lon1)),
  )
  dxt = math.asin(max(-1.0, min(1.0, math.sin(d13) * math.sin(b13 - b12)))) * r
  return abs(dxt)


def _douglas_peucker(rows: list[PointRow], epsilon_m: float) -> list[PointRow]:
  n = len(rows)
  if n <= 2:
    return rows[:]
  lat1, lon1 = _coords(rows[0])
  lat2, lon2 = _coords(rows[-1])
  max_d = 0.0
  idx = 0
  for i in range(1, n - 1):
    lat, lon = _coords(rows[i])
    d = cross_track_distance_m(lat, lon, lat1, lon1, lat2, lon2)
    if d > max_d:
      max_d = d
      idx = i
  if max_d <= epsilon_m:
    return [rows[0], rows[-1]]
  left = _douglas_peucker(rows[: idx + 1], epsilon_m)
  right = _douglas_peucker(rows[idx:], epsilon_m)
  return left[:-1] + right


def split_track_segments(rows: list[PointRow],
                         gap_s: int = TRACK_GAP_S,
                         gap_km: float = TRACK_GAP_KM) -> list[list[PointRow]]:
  """Rozdělí body na souvislé úseky (stejná logika jako frontend)."""
  if not rows:
    return []
  segs: list[list[PointRow]] = []
  cur: list[PointRow] = [rows[0]]
  for i in range(1, len(rows)):
    prev, row = rows[i - 1], rows[i]
    dt = _ts(row) - _ts(prev)
    lat1, lon1 = _coords(prev)
    lat2, lon2 = _coords(row)
    km = haversine_m(lat1, lon1, lat2, lon2) / 1000
    if dt > gap_s or km > gap_km:
      if len(cur) > 1:
        segs.append(cur)
      cur = [row]
    else:
      cur.append(row)
  if len(cur) > 1 or (cur and not segs):
    segs.append(cur)
  return segs


def simplify_track(rows: list[PointRow], limit: int,
                   epsilon_m: float = TRACK_SIMPLIFY_EPSILON_M) -> list[PointRow]:
  """Zjednoduší trasu Douglas–Peuckerem; při překročení limitu zvýší toleranci."""
  if not rows:
    return []
  segments = split_track_segments(rows)
  eps = epsilon_m
  for _ in range(16):
    out: list[PointRow] = []
    for seg in segments:
      if len(seg) <= 2:
        out.extend(seg)
      else:
        out.extend(_douglas_peucker(seg, eps))
    if len(out) <= limit or eps > 500:
      return out[:limit] if len(out) > limit else out
    eps *= 1.6
  # nouzový fallback – zachová první/poslední bod každého segmentu
  out = []
  for seg in segments:
    if seg:
      out.append(seg[0])
      if len(seg) > 1:
        out.append(seg[-1])
  return out[:limit]


def rows_to_api(rows: list[PointRow]) -> list[list]:
  return [[_ts(r), round(_coords(r)[0], 6), round(_coords(r)[1], 6)] for r in rows]

"""Zjednodušení GPS tras (Douglas–Peucker) pro vykreslení na mapě.

Vzdálenosti se počítají v rovinné (equirektangulární) projekci vztažené
k prvnímu bodu segmentu – na délkách jednotlivých cest (km až desítky km)
je odchylka od sférického výpočtu zanedbatelná a výpočet je řádově rychlejší,
což je zásadní pro databáze s miliony bodů (několik let historie).
"""
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


def _douglas_peucker(rows: list[PointRow], epsilon_m: float) -> list[PointRow]:
  """Iterativní DP nad indexy (bez rekurze a slicingu) v rovinné projekci."""
  n = len(rows)
  if n <= 2:
    return rows[:]
  # projekce do metrů vůči prvnímu bodu segmentu
  lat0, lon0 = _coords(rows[0])
  kx = 111_320.0 * math.cos(math.radians(lat0))
  ky = 110_540.0
  xs = [0.0] * n
  ys = [0.0] * n
  for i, r in enumerate(rows):
    la, lo = _coords(r)
    xs[i] = (lo - lon0) * kx
    ys[i] = (la - lat0) * ky

  keep = bytearray(n)
  keep[0] = keep[n - 1] = 1
  eps2 = epsilon_m * epsilon_m
  stack = [(0, n - 1)]
  while stack:
    a, b = stack.pop()
    if b - a < 2:
      continue
    ax, ay = xs[a], ys[a]
    dx, dy = xs[b] - ax, ys[b] - ay
    dd = dx * dx + dy * dy
    max_d2 = 0.0
    idx = -1
    for i in range(a + 1, b):
      px, py = xs[i] - ax, ys[i] - ay
      if dd:
        t = (px * dx + py * dy) / dd
        if t < 0.0:
          t = 0.0
        elif t > 1.0:
          t = 1.0
        ex, ey = px - t * dx, py - t * dy
      else:
        ex, ey = px, py
      d2 = ex * ex + ey * ey
      if d2 > max_d2:
        max_d2 = d2
        idx = i
    if idx >= 0 and max_d2 > eps2:
      keep[idx] = 1
      stack.append((a, idx))
      stack.append((idx, b))
  return [rows[i] for i in range(n) if keep[i]]


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


def _dp_pass(segments: list[list[PointRow]], eps: float) -> list[PointRow]:
  out: list[PointRow] = []
  for seg in segments:
    if len(seg) <= 2:
      out.extend(seg)
    else:
      out.extend(_douglas_peucker(seg, eps))
  return out


def simplify_track(rows: list[PointRow], limit: int,
                   epsilon_m: float = TRACK_SIMPLIFY_EPSILON_M) -> list[PointRow]:
  """Zjednoduší trasu Douglas–Peuckerem; při překročení limitu zvýší toleranci.

  Další průchody s vyšší tolerancí běží už jen nad zjednodušeným výsledkem
  předchozího kola – u velkých dat tak nedochází k opakované práci nad
  původními statisíci bodů.
  """
  if not rows:
    return []
  eps = epsilon_m
  out = _dp_pass(split_track_segments(rows), eps)
  for _ in range(12):
    if len(out) <= limit or eps > 500:
      break
    eps *= 1.8
    out = _dp_pass(split_track_segments(out), eps)
  return out[:limit]


def rows_to_api(rows: list[PointRow]) -> list[list]:
  return [[_ts(r), round(_coords(r)[0], 6), round(_coords(r)[1], 6)] for r in rows]

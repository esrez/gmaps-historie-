"""Předpočítané agregace pro rychlejší statistiky."""
from __future__ import annotations

from .. import db
from ..common import local_dt, ts_range
from ..core.config import MAX_DIST_ROWS
from ..core.logging import log


def refresh_aggregations(conn=None, lo: int | None = None, hi: int | None = None):
  """Přepočítá měsíční a denní agregace po importu."""
  own = conn is None
  if own:
    conn = db.connect()
  try:
    lo, hi = ts_range(lo, hi)
    conn.execute("DELETE FROM agg_monthly_km WHERE 1=1")
    conn.execute("DELETE FROM agg_daily_km WHERE 1=1")
    rows = conn.execute(
      "SELECT strftime('%Y-%m', start_ts, 'unixepoch', 'localtime') m, "
      "SUM(COALESCE(distance_m,0)) dist FROM activities "
      "WHERE start_ts BETWEEN ? AND ? GROUP BY m", (lo, hi)).fetchall()
    if rows and sum(r["dist"] for r in rows) > 0:
      for r in rows:
        conn.execute(
          "INSERT OR REPLACE INTO agg_monthly_km(month, km, source) VALUES(?,?,?)",
          (r["m"], r["dist"] / 1000.0, "activities"))
    else:
      monthly, _ = _point_distances(conn, lo, hi)
      for m, dist in monthly.items():
        conn.execute(
          "INSERT OR REPLACE INTO agg_monthly_km(month, km, source) VALUES(?,?,?)",
          (m, dist / 1000.0, "points"))
    day_km = {r["d"]: r["km"] for r in conn.execute(
      "SELECT date(start_ts,'unixepoch','localtime') d, "
      "SUM(COALESCE(distance_m,0))/1000.0 km FROM activities "
      "WHERE start_ts BETWEEN ? AND ? GROUP BY d", (lo, hi))}
    day_pts = {r["d"]: r["c"] for r in conn.execute(
      "SELECT date(ts,'unixepoch','localtime') d, COUNT(*) c FROM points "
      "WHERE ts BETWEEN ? AND ? GROUP BY d", (lo, hi))}
    for d in sorted(set(day_km) | set(day_pts)):
      conn.execute(
        "INSERT OR REPLACE INTO agg_daily_km(date, km, points) VALUES(?,?,?)",
        (d, day_km.get(d, 0), day_pts.get(d, 0)))
    conn.execute(
      "INSERT OR REPLACE INTO import_meta(key, value) VALUES('agg_updated', datetime('now'))")
    conn.commit()
    log.info("Agregace přepočítány")
  finally:
    if own:
      conn.close()


def _point_distances(conn, lo: int, hi: int):
  from collections import defaultdict

  from ..common import haversine_m

  n = conn.execute("SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?",
                   (lo, hi)).fetchone()["c"]
  step = max(1, -(-n // MAX_DIST_ROWS))
  max_gap = 600 * step
  monthly: dict[str, float] = defaultdict(float)
  prev = None
  cur = conn.execute(
    "SELECT ts, lat, lon FROM points WHERE ts BETWEEN ? AND ? AND (id % ?) = 0 ORDER BY ts",
    (lo, hi, step))
  for ts, lat, lon in cur:
    if prev is not None:
      dt = ts - prev[0]
      if 0 < dt <= max_gap:
        d = haversine_m(prev[1], prev[2], lat, lon)
        if d / dt <= 70:
          monthly[local_dt(ts).strftime("%Y-%m")] += d
    prev = (ts, lat, lon)
  return monthly, step > 1


def get_monthly_km(conn, lo: int, hi: int) -> tuple[dict[str, float], str, bool]:
  total = conn.execute(
    "SELECT SUM(COALESCE(distance_m,0)) s FROM activities WHERE start_ts BETWEEN ? AND ?",
    (lo, hi)).fetchone()["s"] or 0
  rows = conn.execute(
    "SELECT month, km, source FROM agg_monthly_km ORDER BY month").fetchall()
  if rows and total > 0:
    return {r["month"]: r["km"] for r in rows}, rows[0]["source"], False
  act = conn.execute(
    "SELECT strftime('%Y-%m', start_ts, 'unixepoch', 'localtime') m, "
    "SUM(COALESCE(distance_m,0)) dist FROM activities "
    "WHERE start_ts BETWEEN ? AND ? GROUP BY m ORDER BY m", (lo, hi)).fetchall()
  total = sum(r["dist"] for r in act)
  if total > 0:
    return {r["m"]: r["dist"] / 1000.0 for r in act}, "activities", False
  monthly, approx = _point_distances(conn, lo, hi)
  return {m: v / 1000.0 for m, v in monthly.items()}, "points", approx

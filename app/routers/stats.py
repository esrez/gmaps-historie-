"""Statistiky, analýza, kalendář."""
from __future__ import annotations

from contextlib import closing
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Query

from .. import db, places, trips
from ..common import LOCAL_TZ, local_dt, ts_range
from ..services.aggregations import get_monthly_km
from ..services.quality import detect_new_places

router = APIRouter(tags=["statistiky"])


def compute_records(conn, lo: int, hi: int) -> dict:
    day_rows = conn.execute(
        "SELECT date(start_ts,'unixepoch','localtime') d, "
        "SUM(COALESCE(distance_m,0)) dist FROM activities "
        "WHERE start_ts BETWEEN ? AND ? GROUP BY d HAVING dist > 0 "
        "ORDER BY dist DESC LIMIT 1", (lo, hi)).fetchone()
    longest_day = ({"date": day_rows["d"], "km": round(day_rows["dist"] / 1000, 1)}
                   if day_rows else None)
    trip_row = conn.execute(
        "SELECT start_ts, distance_m FROM activities "
        "WHERE start_ts BETWEEN ? AND ? AND distance_m IS NOT NULL "
        "ORDER BY distance_m DESC LIMIT 1", (lo, hi)).fetchone()
    longest_trip = ({"date": local_dt(trip_row["start_ts"]).strftime("%Y-%m-%d"),
                     "km": round(trip_row["distance_m"] / 1000, 1)}
                    if trip_row and trip_row["distance_m"] else None)
    car_days = [r["d"] for r in conn.execute(
        "SELECT DISTINCT date(start_ts,'unixepoch','localtime') d FROM activities "
        "WHERE start_ts BETWEEN ? AND ? "
        f"AND REPLACE(UPPER(type),' ','_') IN ({','.join('?' * len(trips.CAR_TYPES))}) "
        "ORDER BY d", (lo, hi, *trips.CAR_TYPES))]
    best_streak = streak = 0
    prev = None
    for d in car_days:
        cur = date.fromisoformat(d)
        streak = streak + 1 if prev and cur - prev == timedelta(days=1) else 1
        best_streak = max(best_streak, streak)
        prev = cur
    return {"longest_day": longest_day, "longest_trip": longest_trip,
            "longest_streak_days": best_streak}


@router.get("/api/stats")
def api_stats(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
              min_stay_min: float = Query(2, ge=0, le=120)):
    lo, hi = ts_range(from_ts, to_ts)
    min_stay_s = int(min_stay_min * 60)
    with closing(db.connect()) as conn:
        n_points = conn.execute(
            "SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?", (lo, hi)).fetchone()["c"]
        days = conn.execute(
            "SELECT COUNT(DISTINCT date(ts, 'unixepoch', 'localtime')) c "
            "FROM points WHERE ts BETWEEN ? AND ?", (lo, hi)).fetchone()["c"]
        by_type = conn.execute(
            "SELECT type, COUNT(*) n, SUM(COALESCE(distance_m,0)) dist "
            "FROM activities WHERE start_ts BETWEEN ? AND ? "
            "GROUP BY type ORDER BY dist DESC", (lo, hi)).fetchall()
        n_visits, visit_secs = conn.execute(
            "SELECT COUNT(*), SUM(end_ts - start_ts) FROM visits "
            "WHERE start_ts BETWEEN ? AND ? AND end_ts - start_ts >= ?",
            (lo, hi, min_stay_s)).fetchone()
        visit_rows = conn.execute(
            "SELECT lat, lon, name, semantic, end_ts - start_ts secs "
            "FROM visits WHERE start_ts BETWEEN ? AND ? AND end_ts - start_ts >= ?",
            (lo, hi, min_stay_s)).fetchall()
        custom = places.load_places(conn)
        agg: dict[str, dict] = {}
        for v in visit_rows:
            label = places.visit_label(custom, v["lat"], v["lon"],
                                       v["name"], v["semantic"])
            g = agg.setdefault(label, {"label": label, "lat": 0.0, "lon": 0.0,
                                       "n": 0, "secs": 0})
            g["n"] += 1
            g["secs"] += max(v["secs"], 0)
            g["lat"] += v["lat"]
            g["lon"] += v["lon"]
        top_places = sorted(agg.values(), key=lambda g: -g["secs"])[:15]
        for g in top_places:
            g["lat"] /= g["n"]
            g["lon"] /= g["n"]
        monthly, monthly_source, approx = get_monthly_km(conn, lo, hi)
        activities_total = sum(r["dist"] or 0 for r in by_type)
        records = compute_records(conn, lo, hi)
        new_places = detect_new_places(conn, lo, hi)
    activities_total = sum(r["dist"] or 0 for r in by_type)
    if activities_total > 0:
        total_km = activities_total / 1000
    else:
        total_km = sum(monthly.values())
    return {
        "points": n_points,
        "days_with_data": days,
        "visits": n_visits,
        "visit_hours": round((visit_secs or 0) / 3600, 1),
        "total_km": round(total_km, 1),
        "by_type": [{"type": r["type"], "count": r["n"],
                     "km": round((r["dist"] or 0) / 1000, 1)} for r in by_type],
        "monthly_km": [{"month": m, "km": round(v, 1)}
                       for m, v in sorted(monthly.items())],
        "monthly_source": monthly_source,
        "monthly_approx": approx,
        "top_places": [{"label": r["label"], "lat": r["lat"], "lon": r["lon"],
                        "count": r["n"], "hours": round((r["secs"] or 0) / 3600, 1)}
                       for r in top_places],
        "records": records,
        "new_places": new_places,
    }


@router.get("/api/calendar")
def api_calendar(year: int = Query(..., ge=2000, le=2100)):
    lo = int(datetime(year, 1, 1, tzinfo=LOCAL_TZ).timestamp())
    hi = int(datetime(year + 1, 1, 1, tzinfo=LOCAL_TZ).timestamp()) - 1
    with closing(db.connect()) as conn:
        cached = {r["date"]: r for r in conn.execute(
            "SELECT date, km, points FROM agg_daily_km "
            "WHERE date BETWEEN ? AND ?",
            (f"{year}-01-01", f"{year}-12-31",))}
        if cached:
            days = sorted(cached)
            return {"year": year,
                    "days": [{"date": d, "km": round(cached[d]["km"], 1),
                              "points": cached[d]["points"]} for d in days]}
        km = {r["d"]: r["km"] for r in conn.execute(
            "SELECT date(start_ts,'unixepoch','localtime') d, "
            "SUM(COALESCE(distance_m,0))/1000.0 km FROM activities "
            "WHERE start_ts BETWEEN ? AND ? GROUP BY d", (lo, hi))}
        pts = {r["d"]: r["c"] for r in conn.execute(
            "SELECT date(ts,'unixepoch','localtime') d, COUNT(*) c FROM points "
            "WHERE ts BETWEEN ? AND ? GROUP BY d", (lo, hi))}
    days = sorted(set(km) | set(pts))
    return {"year": year,
            "days": [{"date": d, "km": round(km.get(d, 0), 1),
                      "points": pts.get(d, 0)} for d in days]}


@router.get("/api/analysis")
def api_analysis(from_ts: int | None = Query(None), to_ts: int | None = Query(None)):
    lo, hi = ts_range(from_ts, to_ts)
    with closing(db.connect()) as conn:
        weekday = conn.execute(
            "SELECT CAST(strftime('%w', start_ts, 'unixepoch', 'localtime') AS INT) w, "
            "SUM(COALESCE(distance_m,0))/1000.0 km FROM activities "
            "WHERE start_ts BETWEEN ? AND ? GROUP BY w", (lo, hi)).fetchall()
        hours = conn.execute(
            "SELECT CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INT) h, COUNT(*) c "
            "FROM points WHERE ts BETWEEN ? AND ? GROUP BY h", (lo, hi)).fetchall()
        yearly = conn.execute(
            "SELECT strftime('%Y', start_ts, 'unixepoch', 'localtime') y, "
            "SUM(COALESCE(distance_m,0))/1000.0 km, COUNT(*) n FROM activities "
            "WHERE start_ts BETWEEN ? AND ? GROUP BY y ORDER BY y", (lo, hi)).fetchall()
        places_monthly = conn.execute(
            "SELECT strftime('%Y-%m', start_ts, 'unixepoch', 'localtime') m, "
            "COUNT(DISTINCT ROUND(lat,3) || ',' || ROUND(lon,3)) n FROM visits "
            "WHERE start_ts BETWEEN ? AND ? GROUP BY m ORDER BY m", (lo, hi)).fetchall()
    wk = {r["w"]: round(r["km"], 1) for r in weekday}
    hr = {r["h"]: r["c"] for r in hours}
    return {
        "weekday_km": [{"day": d, "km": wk.get(w, 0)}
                       for d, w in zip(["Po", "Út", "St", "Čt", "Pá", "So", "Ne"],
                                       [1, 2, 3, 4, 5, 6, 0], strict=True)],
        "hourly_points": [{"hour": h, "count": hr.get(h, 0)} for h in range(24)],
        "yearly_km": [{"year": r["y"], "km": round(r["km"], 1), "trips": r["n"]}
                      for r in yearly],
        "places_monthly": [{"month": r["m"], "places": r["n"]} for r in places_monthly],
    }

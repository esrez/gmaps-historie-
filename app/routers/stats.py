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
        travel = conn.execute(
            "SELECT COUNT(*) n, SUM(MAX(end_ts - start_ts, 0)) secs "
            "FROM activities WHERE start_ts BETWEEN ? AND ?", (lo, hi)).fetchone()
        unique_places = conn.execute(
            "SELECT COUNT(DISTINCT ROUND(lat,3) || ',' || ROUND(lon,3)) c "
            "FROM visits WHERE start_ts BETWEEN ? AND ? "
            "AND end_ts - start_ts >= ?", (lo, hi, min_stay_s)).fetchone()["c"]
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
        "travel_hours": round((travel["secs"] or 0) / 3600, 1),
        "trips_count": travel["n"],
        "unique_places": unique_places,
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


# noc mimo domov = poslední bod dne dál než tolik metrů od domova
AWAY_NIGHT_M = 30_000


def _detect_home(conn, lo: int, hi: int):
    """Domov = místo s nejvíce stráveným časem (přednost semantic HOME)."""
    row = conn.execute(
        "SELECT AVG(lat) lat, AVG(lon) lon, SUM(end_ts-start_ts) secs "
        "FROM visits WHERE start_ts BETWEEN ? AND ? "
        "AND UPPER(COALESCE(semantic,'')) = 'HOME'", (lo, hi)).fetchone()
    if row and row["secs"]:
        return {"lat": row["lat"], "lon": row["lon"], "label": "Domov"}
    row = conn.execute(
        "SELECT lat, lon, SUM(end_ts-start_ts) secs, "
        "COALESCE(NULLIF(name,''), semantic, 'Nejčastější místo') label "
        "FROM visits WHERE start_ts BETWEEN ? AND ? "
        "GROUP BY ROUND(lat,3), ROUND(lon,3) ORDER BY secs DESC LIMIT 1",
        (lo, hi)).fetchone()
    if row and row["secs"]:
        return {"lat": row["lat"], "lon": row["lon"], "label": row["label"]}
    return None


@router.get("/api/insights")
def api_insights(from_ts: int | None = Query(None), to_ts: int | None = Query(None)):
    """Zajímavosti navíc: akční rádius, noci mimo domov, rytmus týdne…

    Počítá se líně (až když si o to frontend řekne – záložka Analýza nebo
    vrstvy statistik na mapě); u milionů bodů se vzorkuje.
    """
    from ..common import haversine_m
    lo, hi = ts_range(from_ts, to_ts)
    with closing(db.connect()) as conn:
        home = _detect_home(conn, lo, hi)

        n = conn.execute("SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?",
                         (lo, hi)).fetchone()["c"]
        step = max(1, n // 60_000)
        ssql = " AND (id % ?) = 0" if step > 1 else ""
        sargs = (step,) if step > 1 else ()

        # rytmus týdne: kdy (den × hodina) se hýbu; počty škálované krokem
        punch = conn.execute(
            "SELECT CAST(strftime('%w', ts, 'unixepoch', 'localtime') AS INT) w, "
            "CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INT) h, "
            f"COUNT(*) * ? c FROM points WHERE ts BETWEEN ? AND ?{ssql} "
            "GROUP BY w, h", (step, lo, hi, *sargs)).fetchall()

        # denní minima/maxima (typický odjezd/návrat – jen všední dny)
        days = conn.execute(
            "SELECT date(ts,'unixepoch','localtime') d, MIN(ts) a, MAX(ts) b, "
            "CAST(strftime('%w', ts, 'unixepoch', 'localtime') AS INT) w "
            "FROM points WHERE ts BETWEEN ? AND ? GROUP BY d", (lo, hi)).fetchall()

        radius = None
        farthest = None
        away_nights = None
        if home:
            pts = conn.execute(
                f"SELECT ts, lat, lon FROM points WHERE ts BETWEEN ? AND ?{ssql}",
                (lo, hi, *sargs)).fetchall()
            dists = sorted(
                ((haversine_m(home["lat"], home["lon"], p["lat"], p["lon"]), p)
                 for p in pts), key=lambda t: t[0])
            if dists:
                pct = lambda q: dists[min(len(dists) - 1, int(len(dists) * q))][0]  # noqa: E731
                radius = {"p50_m": round(pct(0.50)), "p90_m": round(pct(0.90)),
                          "p99_m": round(pct(0.99))}
                dmax, pmax = dists[-1]
                farthest = {"km": round(dmax / 1000, 1),
                            "lat": pmax["lat"], "lon": pmax["lon"],
                            "date": local_dt(pmax["ts"]).strftime("%Y-%m-%d")}
            last_pts = conn.execute(
                "SELECT lat, lon FROM ("
                "  SELECT lat, lon, ROW_NUMBER() OVER ("
                "    PARTITION BY date(ts,'unixepoch','localtime') "
                "    ORDER BY ts DESC) rn "
                f"  FROM points WHERE ts BETWEEN ? AND ?{ssql}) WHERE rn = 1",
                (lo, hi, *sargs)).fetchall()
            away_nights = sum(
                1 for p in last_pts
                if haversine_m(home["lat"], home["lon"],
                               p["lat"], p["lon"]) > AWAY_NIGHT_M)

        # trasy se souřadnicemi pro „pavouka" na mapě
        routes = _top_routes(conn, lo, hi, with_geo=True)

    # typický začátek/konec dne (medián minut, všední dny)
    def _median_minutes(vals):
        if not vals:
            return None
        vals = sorted(vals)
        m = vals[len(vals) // 2]
        return f"{m // 60:02d}:{m % 60:02d}"
    workdays = [d for d in days if d["w"] not in (0, 6)]
    first_move = _median_minutes(
        [local_dt(d["a"]).hour * 60 + local_dt(d["a"]).minute for d in workdays])
    last_move = _median_minutes(
        [local_dt(d["b"]).hour * 60 + local_dt(d["b"]).minute for d in workdays])

    return {
        "home": home,
        "radius": radius,
        "farthest": farthest,
        "away_nights": away_nights,
        "first_move": first_move,
        "last_move": last_move,
        "punchcard": [[r["w"], r["h"], r["c"]] for r in punch],
        "routes_geo": routes,
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


# skupiny dopravy pro měsíční rozpad (stejné dělení jako filtr na mapě)
_TYPE_GROUPS = {
    "car": {"IN_PASSENGER_VEHICLE", "DRIVING", "MOTORCYCLING", "IN_VEHICLE"},
    "walk": {"WALKING", "ON_FOOT", "RUNNING"},
    "bike": {"CYCLING", "BICYCLING"},
    "transit": {"IN_BUS", "IN_TRAM", "IN_SUBWAY", "IN_TRAIN", "IN_FERRY",
                "IN_PUBLIC_TRANSPORT"},
}

_COORD_LABEL = ", "   # fallback jméno „49.1900, 16.6000" obsahuje čárku+mezeru


def _top_routes(conn, lo: int, hi: int, limit: int = 8,
                with_geo: bool = False) -> list[dict]:
    """Nejčastější trasy: dvojice pojmenovaných míst (obousměrně) z aktivit.
    S with_geo=True navíc vrátí průměrné souřadnice konců (pro mapu)."""
    acts = conn.execute(
        "SELECT start_lat sla, start_lon slo, end_lat ela, end_lon elo, distance_m d "
        "FROM activities WHERE start_ts BETWEEN ? AND ? "
        "AND start_lat IS NOT NULL AND end_lat IS NOT NULL LIMIT 50000",
        (lo, hi)).fetchall()
    if not acts:
        return []
    namer = trips.PlaceNamer(conn)
    agg: dict[tuple, dict] = {}
    for a in acts:
        na, nb = namer.name(a["sla"], a["slo"]), namer.name(a["ela"], a["elo"])
        # souřadnicové fallbacky a smyčky (A→A) v přehledu tras jen šumí
        if na == nb or _COORD_LABEL in na or _COORD_LABEL in nb:
            continue
        key = tuple(sorted((na, nb)))
        g = agg.setdefault(key, {"count": 0, "km": 0.0, "km_n": 0,
                                 "fla": 0.0, "flo": 0.0, "tla": 0.0, "tlo": 0.0})
        g["count"] += 1
        if a["d"]:
            g["km"] += a["d"] / 1000
            g["km_n"] += 1
        first = key[0] == na
        g["fla"] += a["sla"] if first else a["ela"]
        g["flo"] += a["slo"] if first else a["elo"]
        g["tla"] += a["ela"] if first else a["sla"]
        g["tlo"] += a["elo"] if first else a["slo"]
    top = sorted(agg.items(), key=lambda kv: -kv[1]["count"])[:limit]
    out = []
    for k, g in top:
        row = {"from": k[0], "to": k[1], "count": g["count"],
               "km_avg": round(g["km"] / g["km_n"], 1) if g["km_n"] else None}
        if with_geo:
            row.update(from_lat=round(g["fla"] / g["count"], 5),
                       from_lon=round(g["flo"] / g["count"], 5),
                       to_lat=round(g["tla"] / g["count"], 5),
                       to_lon=round(g["tlo"] / g["count"], 5))
        out.append(row)
    return out


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
        by_month_type = conn.execute(
            "SELECT strftime('%Y-%m', start_ts, 'unixepoch', 'localtime') m, "
            "REPLACE(UPPER(type),' ','_') t, SUM(COALESCE(distance_m,0))/1000.0 km "
            "FROM activities WHERE start_ts BETWEEN ? AND ? GROUP BY m, t",
            (lo, hi)).fetchall()
        top_routes = _top_routes(conn, lo, hi)
    wk = {r["w"]: round(r["km"], 1) for r in weekday}
    hr = {r["h"]: r["c"] for r in hours}

    # měsíční km po skupinách dopravy (auto/pěšky/kolo/MHD/ostatní)
    mt: dict[str, dict] = {}
    for r in by_month_type:
        row = mt.setdefault(r["m"], {"month": r["m"], "car": 0.0, "walk": 0.0,
                                     "bike": 0.0, "transit": 0.0, "other": 0.0})
        group = next((g for g, types in _TYPE_GROUPS.items() if r["t"] in types),
                     "other")
        row[group] += r["km"]
    monthly_by_type = [
        {k: (round(v, 1) if isinstance(v, float) else v) for k, v in row.items()}
        for _, row in sorted(mt.items())]

    return {
        "weekday_km": [{"day": d, "km": wk.get(w, 0)}
                       for d, w in zip(["Po", "Út", "St", "Čt", "Pá", "So", "Ne"],
                                       [1, 2, 3, 4, 5, 6, 0], strict=True)],
        "hourly_points": [{"hour": h, "count": hr.get(h, 0)} for h in range(24)],
        "yearly_km": [{"year": r["y"], "km": round(r["km"], 1), "trips": r["n"]}
                      for r in yearly],
        "places_monthly": [{"month": r["m"], "places": r["n"]} for r in places_monthly],
        "monthly_by_type": monthly_by_type,
        "top_routes": top_routes,
    }

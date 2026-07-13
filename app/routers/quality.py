"""Kontrola kvality dat a opravy."""
from __future__ import annotations

from contextlib import closing
from datetime import timedelta

from fastapi import APIRouter, Query

from .. import db
from ..common import local_dt, ts_range
from ..core.config import DEFAULT_ACC_LIMIT
from ..services.quality import find_duplicate_activities, find_outliers

router = APIRouter(tags=["kvalita"])


@router.get("/api/quality")
def api_quality(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                accuracy_limit: float = Query(DEFAULT_ACC_LIMIT, ge=10)):
    lo, hi = ts_range(from_ts, to_ts)
    with closing(db.connect()) as conn:
        low_acc = conn.execute(
            "SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ? AND accuracy > ?",
            (lo, hi, accuracy_limit)).fetchone()["c"]
        bad_visits = conn.execute(
            "SELECT COUNT(*) c FROM visits WHERE start_ts BETWEEN ? AND ? "
            "AND end_ts <= start_ts", (lo, hi)).fetchone()["c"]
        bounds = conn.execute(
            "SELECT MIN(ts) a, MAX(ts) b, COUNT(*) n FROM points WHERE ts BETWEEN ? AND ?",
            (lo, hi)).fetchone()
        outliers = len(find_outliers(conn, lo, hi)) if (bounds["n"] or 0) <= 3_000_000 else None
        dup_acts = len(find_duplicate_activities(conn, lo, hi))
        gaps: list[str] = []
        gap_count = 0
        if bounds["a"] is not None:
            have = {r["d"] for r in conn.execute(
                "SELECT DISTINCT date(ts,'unixepoch','localtime') d FROM points "
                "WHERE ts BETWEEN ? AND ?", (lo, hi))}
            day = local_dt(bounds["a"]).date()
            last = local_dt(bounds["b"]).date()
            while day <= last:
                if day.isoformat() not in have:
                    gap_count += 1
                    if len(gaps) < 30:
                        gaps.append(day.isoformat())
                day += timedelta(days=1)
    return {
        "points": bounds["n"],
        "low_accuracy": low_acc,
        "accuracy_limit": accuracy_limit,
        "outliers": outliers,
        "bad_visits": bad_visits,
        "duplicate_activities": dup_acts,
        "gap_days": gap_count,
        "gap_samples": gaps,
    }


@router.post("/api/purge_range")
def api_purge_range(from_ts: int = Query(...), to_ts: int = Query(...),
                    dry_run: bool = Query(True)):
    """Smaže VŠECHNA polohová data ve zvoleném období (soukromí) – body,
    návštěvy i cesty. Kniha jízd zůstává. Před skutečným smazáním se
    automaticky vytvoří záloha, takže krok jde vrátit obnovou."""
    with closing(db.connect()) as conn:
        counts = {
            "points": conn.execute(
                "SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ?",
                (from_ts, to_ts)).fetchone()["c"],
            "visits": conn.execute(
                "SELECT COUNT(*) c FROM visits WHERE start_ts BETWEEN ? AND ?",
                (from_ts, to_ts)).fetchone()["c"],
            "activities": conn.execute(
                "SELECT COUNT(*) c FROM activities WHERE start_ts BETWEEN ? AND ?",
                (from_ts, to_ts)).fetchone()["c"],
        }
    total = sum(counts.values())
    if dry_run or total == 0:
        return {"dry_run": True, **counts, "backup": None}

    import os

    from ..core.backup import make_backup
    backup = make_backup()                      # pojistka před destrukcí
    with closing(db.connect()) as conn:
        conn.execute("DELETE FROM points WHERE ts BETWEEN ? AND ?",
                     (from_ts, to_ts))
        conn.execute("DELETE FROM visits WHERE start_ts BETWEEN ? AND ?",
                     (from_ts, to_ts))
        conn.execute("DELETE FROM activities WHERE start_ts BETWEEN ? AND ?",
                     (from_ts, to_ts))
        conn.commit()
        conn.execute("VACUUM")
        db.after_import(conn)                   # přepočet agregací (kalendář…)
    return {"dry_run": False, **counts, "backup": os.path.basename(backup)}


@router.post("/api/cleanup")
def api_cleanup(from_ts: int | None = Query(None), to_ts: int | None = Query(None),
                remove_low_accuracy: bool = Query(True),
                accuracy_limit: float = Query(DEFAULT_ACC_LIMIT, ge=10),
                remove_outliers: bool = Query(True),
                remove_bad_visits: bool = Query(True),
                remove_duplicate_activities: bool = Query(True),
                dry_run: bool = Query(True)):
    lo, hi = ts_range(from_ts, to_ts)
    result = {"dry_run": dry_run, "low_accuracy": 0, "outliers": 0,
              "bad_visits": 0, "duplicate_activities": 0}
    with closing(db.connect()) as conn:
        if remove_low_accuracy:
            if dry_run:
                result["low_accuracy"] = conn.execute(
                    "SELECT COUNT(*) c FROM points WHERE ts BETWEEN ? AND ? AND accuracy > ?",
                    (lo, hi, accuracy_limit)).fetchone()["c"]
            else:
                result["low_accuracy"] = conn.execute(
                    "DELETE FROM points WHERE ts BETWEEN ? AND ? AND accuracy > ?",
                    (lo, hi, accuracy_limit)).rowcount
        if remove_outliers:
            ids = find_outliers(conn, lo, hi)
            result["outliers"] = len(ids)
            if not dry_run:
                for i in range(0, len(ids), 900):
                    chunk = ids[i:i + 900]
                    conn.execute(
                        f"DELETE FROM points WHERE id IN ({','.join('?' * len(chunk))})",
                        chunk)
        if remove_bad_visits:
            if dry_run:
                result["bad_visits"] = conn.execute(
                    "SELECT COUNT(*) c FROM visits WHERE start_ts BETWEEN ? AND ? "
                    "AND end_ts <= start_ts", (lo, hi)).fetchone()["c"]
            else:
                result["bad_visits"] = conn.execute(
                    "DELETE FROM visits WHERE start_ts BETWEEN ? AND ? AND end_ts <= start_ts",
                    (lo, hi)).rowcount
        if remove_duplicate_activities:
            dup_ids = find_duplicate_activities(conn, lo, hi)
            result["duplicate_activities"] = len(dup_ids)
            if not dry_run:
                for i in range(0, len(dup_ids), 900):
                    chunk = dup_ids[i:i + 900]
                    conn.execute(
                        f"DELETE FROM activities WHERE id IN ({','.join('?' * len(chunk))})",
                        chunk)
        if not dry_run:
            conn.commit()
            if sum(v for k, v in result.items() if k != "dry_run") > 0:
                conn.execute("VACUUM")
                db.after_import(conn)
    return result

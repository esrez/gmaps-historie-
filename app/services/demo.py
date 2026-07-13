"""Ukázková data pro vyzkoušení aplikace bez vlastního exportu.

Vygeneruje ~3 měsíce věrohodné historie (dojíždění domov–práce, nákupy,
víkendové výlety) přímo do aktivní databáze. Používá se z průvodce prvním
spuštěním; povolené jen nad prázdnou databází, aby nešlo omylem smíchat
ukázku s reálnými daty.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta

from .. import db
from ..common import LOCAL_TZ

HOME = (49.1920, 16.6100)      # Brno – domov
WORK = (49.2280, 16.5710)      # Brno – práce
SHOP = (49.1800, 16.6350)      # nákupy
TRIPS = [                      # víkendové cíle
    (49.2952, 16.3890, "Výlet Tišnov"),
    (48.8555, 16.6420, "Výlet Mikulov"),
    (49.5570, 16.0800, "Výlet Vysočina"),
]


def _drive(w, start_dt, a, b, minutes, typ="IN_PASSENGER_VEHICLE"):
    """Jedna cesta: GPS stopa po trase + záznam aktivity."""
    start = int(start_dt.timestamp())
    n = max(8, minutes * 6)                      # bod ~každých 10 s
    for i in range(n):
        f = i / (n - 1)
        w["points"].append((
            start + int(f * minutes * 60),
            a[0] + (b[0] - a[0]) * f + random.gauss(0, 0.0006),
            a[1] + (b[1] - a[1]) * f + random.gauss(0, 0.0006),
            12.0, "demo"))
    dist = (abs(b[0] - a[0]) * 111_000 + abs(b[1] - a[1]) * 74_000) * 1.25
    w["acts"].append((start, start + minutes * 60, typ, dist,
                      a[0], a[1], b[0], b[1], "demo"))
    return start + minutes * 60


def _visit(w, ts_from, ts_to, place, semantic=None, name=None):
    w["visits"].append((ts_from, ts_to, place[0], place[1],
                        name, None, semantic, "demo"))


def generate_demo(days: int = 90) -> dict:
    """Naplní databázi ukázkou; vrací počty. Volat jen nad prázdnou DB."""
    random.seed(7)
    w = {"points": [], "visits": [], "acts": []}
    today = datetime.now(LOCAL_TZ).replace(hour=0, minute=0, second=0,
                                           microsecond=0)
    for d in range(days, 0, -1):
        day = today - timedelta(days=d)
        wd = day.weekday()
        if wd < 5:                                   # všední den: do práce a zpět
            t = _drive(w, day.replace(hour=7, minute=30)
                       + timedelta(minutes=random.randint(0, 20)),
                       HOME, WORK, 25)
            _visit(w, t, t + 8 * 3600, WORK, semantic="WORK")
            t2 = _drive(w, day.replace(hour=16, minute=30)
                        + timedelta(minutes=random.randint(0, 40)),
                        WORK, HOME, 28)
            _visit(w, t2, t2 + 12 * 3600, HOME, semantic="HOME")
            if wd == 3:                              # čtvrteční nákup
                t3 = _drive(w, day.replace(hour=18, minute=10), HOME, SHOP, 12)
                _visit(w, t3, t3 + 45 * 60, SHOP, name="Nákupní centrum")
                _drive(w, day.replace(hour=19, minute=15), SHOP, HOME, 12)
        elif wd == 5 and random.random() < 0.7:      # sobotní výlet
            dest = TRIPS[d % len(TRIPS)]
            t = _drive(w, day.replace(hour=9, minute=0), HOME,
                       (dest[0], dest[1]), 55)
            _visit(w, t, t + 4 * 3600, (dest[0], dest[1]), name=dest[2])
            _drive(w, day.replace(hour=15, minute=30), (dest[0], dest[1]),
                   HOME, 55)

    conn = db.connect()
    try:
        conn.executemany(
            "INSERT OR IGNORE INTO points(ts,lat,lon,accuracy,source) "
            "VALUES(?,?,?,?,?)", w["points"])
        conn.executemany(
            "INSERT OR IGNORE INTO visits(start_ts,end_ts,lat,lon,name,address,"
            "semantic,source) VALUES(?,?,?,?,?,?,?,?)", w["visits"])
        conn.executemany(
            "INSERT OR IGNORE INTO activities(start_ts,end_ts,type,distance_m,"
            "start_lat,start_lon,end_lat,end_lon,source) VALUES(?,?,?,?,?,?,?,?,?)",
            w["acts"])
        conn.commit()
        db.after_import(conn)
    finally:
        conn.close()
    return {"points": len(w["points"]), "visits": len(w["visits"]),
            "activities": len(w["acts"])}

"""Kniha jízd: generování, pravidla, propagace, tachometr, undo, exporty."""
from contextlib import closing

from conftest import make_timeline_android

from app import importer

RANGE = {"from_ts": 1748728800, "to_ts": 1750629600}


def seed(test_db, tmp_path, **kw):
    importer.import_path(str(make_timeline_android(tmp_path / "t.json", **kw)))


def gen(client, **kw):
    body = {**RANGE, "purpose": "Služební jízda", "driver": "Jan", "plate": "1AB 2345",
            "workdays_only": True, "round_up": True, **kw}
    return client.post("/api/trips/generate", json=body).json()


def test_generate_workdays_and_roundup(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=7)   # po–ne
    res = gen(client)
    assert res["created"] == 5        # víkend odfiltrován
    trips = client.get("/api/trips", params=RANGE).json()
    assert all(t["km"] == 5.0 for t in trips["trips"])     # 4.2 → nahoru na 5
    assert trips["trips"][0]["origin"] and trips["trips"][0]["destination"]


def test_generate_skips_overlapping_duplicates(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    gen(client)
    with closing(test_db.connect()) as conn:   # stejná cesta z „druhého exportu"
        conn.execute("INSERT INTO activities(start_ts,end_ts,type,distance_m)"
                     " SELECT start_ts+120, end_ts+60, 'DRIVING', 4150 FROM activities")
        conn.commit()
    res = gen(client)
    assert res["created"] == 0 and res["skipped_duplicates"] > 0


def test_propagate_and_rules(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=5)
    gen(client)
    tid = client.get("/api/trips", params=RANGE).json()["trips"][0]["id"]
    res = client.post("/api/trips/propagate",
                      json={"trip_id": tid, "km": 11.3, **RANGE}).json()
    assert res["km"] == 12.0 and res["updated"] == 5
    rules = client.get("/api/trips/rules").json()["rules"]
    assert len(rules) == 1 and rules[0]["km"] == 12.0
    # undo vrátí původní km
    undo = client.post("/api/trips/undo").json()
    assert undo["op"] == "propagate" and undo["restored"] == 5
    trips = client.get("/api/trips", params=RANGE).json()["trips"]
    assert all(t["km"] == 5.0 for t in trips)


def test_undo_generate(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    res = gen(client)
    assert res["created"] == 3
    undo = client.post("/api/trips/undo").json()
    assert undo["removed"] == 3
    assert client.get("/api/trips", params=RANGE).json()["trips"] == []


def test_excluded_and_totals(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    gen(client)
    trips = client.get("/api/trips", params=RANGE).json()
    tid = trips["trips"][0]["id"]
    client.patch(f"/api/trips/{tid}", json={"excluded": True})
    after = client.get("/api/trips", params=RANGE).json()
    assert after["total_km"] == trips["total_km"] - 5.0


def test_odometer_per_plate(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    gen(client)
    client.put("/api/trips/odometer", json={"year": 2025, "km": 10000, "plate": "1AB 2345"})
    o = client.get("/api/trips/odometer",
                   params={"year": 2025, "plate": "1AB 2345"}).json()
    assert o["odometer_km"] == 10000 and o["booked_km"] == 15.0
    assert o["remaining_km"] == 9985.0
    other = client.get("/api/trips/odometer",
                       params={"year": 2025, "plate": "9XX 0000"}).json()
    assert other["odometer_km"] is None and other["booked_km"] == 0


def test_plate_filter(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    gen(client)
    assert len(client.get("/api/trips",
                          params={**RANGE, "plate": "1ab 2345"}).json()["trips"]) == 3
    assert client.get("/api/trips",
                      params={**RANGE, "plate": "jiná"}).json()["trips"] == []


def test_missing_days_alert(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    missing = client.get("/api/trips/missing_days", params=RANGE).json()
    assert len(missing["days"]) == 3          # nic není v knize
    gen(client)
    missing = client.get("/api/trips/missing_days", params=RANGE).json()
    assert missing["days"] == []


def test_exports(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    gen(client)
    xlsx = client.get("/api/trips/export.xlsx", params=RANGE)
    assert xlsx.status_code == 200
    pdf = client.get("/api/trips/export.pdf", params=RANGE)
    assert pdf.status_code == 200 and pdf.content[:5] == b"%PDF-"


def test_suggest(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    gen(client)
    s = client.get("/api/trips/suggest").json()
    assert "Práce" in s["places"] and "Domov" in s["places"]
    assert "Služební jízda" in s["purposes"]


def test_km_fallback_from_gps(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    with closing(test_db.connect()) as conn:   # aktivita bez vzdálenosti
        conn.execute("UPDATE activities SET distance_m = NULL")
        conn.commit()
    res = gen(client, round_up=False)
    assert res["created"] == 3
    trips = client.get("/api/trips", params=RANGE).json()["trips"]
    assert all(3.0 < t["km"] < 5.0 for t in trips)   # ~4.2 km dle GPS stopy


def test_city_mode_merges_local_trips(client, test_db, tmp_path):
    """Ohyby v Brně → jeden řádek Brno se sečtenými km; Brno→Praha zvlášť."""
    with closing(test_db.connect()) as conn:
        day = 1748844000  # po 2. 6. 2025 08:00 místního času
        rows = [
            # tři místní jízdy po Brně (3 + 2 + 4 km)
            (day, day + 1200, 3000, 49.19, 16.60, 49.21, 16.63),
            (day + 3600, day + 4500, 2000, 49.21, 16.63, 49.17, 16.58),
            (day + 7200, day + 8100, 4000, 49.17, 16.58, 49.20, 16.61),
            # přejezd Brno → Praha
            (day + 10800, day + 17400, 205000, 49.20, 16.61, 50.08, 14.43),
            # dvě místní jízdy po Praze
            (day + 18000, day + 18900, 5000, 50.08, 14.43, 50.10, 14.39),
            (day + 21600, day + 22500, 6000, 50.10, 14.39, 50.07, 14.44),
        ]
        for s, e, m, la1, lo1, la2, lo2 in rows:
            conn.execute(
                "INSERT INTO activities(start_ts,end_ts,type,distance_m,"
                "start_lat,start_lon,end_lat,end_lon)"
                " VALUES(?,?,'IN_PASSENGER_VEHICLE',?,?,?,?,?)",
                (s, e, m, la1, lo1, la2, lo2))
        conn.commit()

    res = gen(client, city_mode=True, round_up=True)
    assert res["created"] == 3
    trips = client.get("/api/trips", params=RANGE).json()["trips"]
    routes = [(t["origin"], t["destination"], t["km"]) for t in trips]
    assert routes[0] == ("Brno", "Brno", 9.0)      # 3+2+4 km sloučeno
    assert routes[1] == ("Brno", "Praha", 205.0)
    assert routes[2] == ("Praha", "Praha", 11.0)   # 5+6 km sloučeno


def test_single_delete_is_undoable(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    gen(client)
    trips = client.get("/api/trips", params=RANGE).json()["trips"]
    tid = trips[0]["id"]
    assert client.delete(f"/api/trips/{tid}").json()["deleted"] == tid
    assert len(client.get("/api/trips", params=RANGE).json()["trips"]) == 2
    info = client.get("/api/trips/undo").json()
    assert info["available"] and info["op"] == "delete"
    client.post("/api/trips/undo")
    back = client.get("/api/trips", params=RANGE).json()["trips"]
    assert len(back) == 3 and any(t["id"] == tid for t in back)


def test_bulk_delete_one_step_undo(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=5)
    gen(client)
    ids = [t["id"] for t in client.get("/api/trips", params=RANGE).json()["trips"][:3]]
    res = client.post("/api/trips/bulk_delete", json={"ids": ids}).json()
    assert res["deleted"] == 3
    assert len(client.get("/api/trips", params=RANGE).json()["trips"]) == 2
    info = client.get("/api/trips/undo").json()
    assert info["op"] == "bulk_delete" and info["affected"] == 3
    client.post("/api/trips/undo")   # jeden krok vrátí všechny tři
    assert len(client.get("/api/trips", params=RANGE).json()["trips"]) == 5


def test_bulk_delete_empty_is_noop(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=2)
    gen(client)
    before = len(client.get("/api/trips", params=RANGE).json()["trips"])
    assert client.post("/api/trips/bulk_delete", json={"ids": []}).json()["deleted"] == 0
    assert len(client.get("/api/trips", params=RANGE).json()["trips"]) == before


def test_export_csv_czech_excel(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    gen(client)
    r = client.get("/api/trips/export.csv", params=RANGE)
    assert r.status_code == 200
    text = r.content.decode("utf-8")
    assert text.startswith("﻿")                 # BOM pro český Excel
    assert "SPZ;Datum;Odjezd" in text                # středníkový oddělovač
    assert "1AB 2345" in text and ";5,0;" in text     # desetinná čárka


def test_yearly_summary_per_plate(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    gen(client)
    s = client.get("/api/trips/summary",
                   params={"year": 2025, "plate": "1AB 2345"}).json()
    assert s["total_km"] == 15.0 and s["trips"] == 3
    assert s["months"] and s["months"][0]["month"].startswith("2025-")
    empty = client.get("/api/trips/summary", params={"year": 2099}).json()
    assert empty["months"] == [] and empty["total_km"] == 0


def test_month_lock_skips_generation(client, test_db, tmp_path):
    seed(test_db, tmp_path, days=3)
    gen(client)
    month = client.get("/api/trips", params=RANGE).json()["trips"][0]
    from app.common import local_dt
    mkey = local_dt(month["start_ts"]).strftime("%Y-%m")
    client.delete("/api/trips", params=RANGE)          # smazat, ať lze znovu generovat
    client.post("/api/trips/lock", json={"month": mkey, "plate": "1AB 2345"})
    assert mkey in [x["month"] for x in
                    client.get("/api/trips/locks", params={"plate": "1AB 2345"}).json()["locks"]]
    res = gen(client)
    assert res["created"] == 0 and res["skipped_locked"] == 3   # uzavřený měsíc se negeneruje
    client.post("/api/trips/lock", json={"month": mkey, "plate": "1AB 2345", "locked": False})
    assert gen(client)["created"] == 3                 # po odemčení znovu jde

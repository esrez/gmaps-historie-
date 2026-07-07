"""Kniha jízd: generování, pravidla, propagace, tachometr, undo, exporty."""
from contextlib import closing

from app import importer

from conftest import make_timeline_android

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

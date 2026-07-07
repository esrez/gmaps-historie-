"""API mapové stránky: statistiky, body, kvalita dat, opravy."""
from contextlib import closing

from app import importer

from conftest import make_timeline_android


def seed(test_db, tmp_path):
    importer.import_path(str(make_timeline_android(tmp_path / "t.json")))


def test_range_and_points(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    r = client.get("/api/range").json()
    assert r["points"] == 100 and r["visits"] == 5
    pts = client.get("/api/points").json()
    assert pts["total"] == 100 and len(pts["points"]) == 100
    assert client.get("/api/points?limit=0").status_code == 422


def test_stats(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    s = client.get("/api/stats").json()
    assert s["total_km"] == 21.0            # 5 × 4.2 km
    assert s["monthly_source"] == "activities"
    assert s["top_places"][0]["count"] == 5


def test_stats_fallback_to_points(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    with closing(test_db.connect()) as conn:
        conn.execute("UPDATE activities SET distance_m = NULL")
        conn.commit()
    s = client.get("/api/stats").json()
    assert s["monthly_source"] == "points"  # aktivity bez vzdálenosti → fallback
    assert s["total_km"] > 0


def test_at_location(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    res = client.get("/api/at_location",
                     params={"lat": 50.1, "lon": 14.39, "radius_m": 300}).json()
    assert res["count"] == 5


def test_quality_and_cleanup(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    with closing(test_db.connect()) as conn:
        # teleport doprostřed trasy + nepřesný bod + vadná návštěva + duplicitní aktivita
        conn.execute("INSERT INTO points(ts,lat,lon,accuracy) VALUES(1748846520,49.19,16.61,10)")
        conn.execute("INSERT INTO points(ts,lat,lon,accuracy) VALUES(1748850000,50.08,14.44,500)")
        conn.execute("INSERT INTO visits(start_ts,end_ts,lat,lon) VALUES(100,50,50.0,14.0)")
        conn.execute("INSERT INTO activities(start_ts,end_ts,type,distance_m)"
                     " SELECT start_ts+60, end_ts, 'DRIVING', 4100 FROM activities LIMIT 1")
        conn.commit()
    q = client.get("/api/quality").json()
    assert q["low_accuracy"] == 1 and q["outliers"] == 1
    assert q["bad_visits"] == 1 and q["duplicate_activities"] == 1

    dry = client.post("/api/cleanup?dry_run=true").json()
    assert dry["outliers"] == 1 and dry["duplicate_activities"] == 1
    real = client.post("/api/cleanup?dry_run=false").json()
    assert real["low_accuracy"] == 1
    q2 = client.get("/api/quality").json()
    assert q2["outliers"] == 0 and q2["duplicate_activities"] == 0


def test_analysis(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    a = client.get("/api/analysis").json()
    assert len(a["weekday_km"]) == 7 and len(a["hourly_points"]) == 24
    assert sum(d["km"] for d in a["weekday_km"]) == 21.0


def test_exports(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    assert client.get("/api/export.xlsx").status_code == 200
    gpx = client.get("/api/export.gpx")
    assert gpx.status_code == 200 and b"<trkpt" in gpx.content


def test_backup(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    r = client.get("/api/backup")
    assert r.status_code == 200 and r.content[:15] == b"SQLite format 3"

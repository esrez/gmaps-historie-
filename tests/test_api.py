"""API mapové stránky: statistiky, body, kvalita dat, opravy."""
from contextlib import closing

from conftest import make_timeline_android

from app import importer


def seed(test_db, tmp_path):
    importer.import_path(str(make_timeline_android(tmp_path / "t.json")))


def test_range_and_points(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    r = client.get("/api/range").json()
    assert r["points"] == 100 and r["visits"] == 5
    pts = client.get("/api/points").json()
    assert pts["total"] == 100
    assert pts["simplified"] is True
    assert 0 < len(pts["points"]) < 100
    # hranice úseků: 5 denních cest → 5 úseků; indexy míří dovnitř pole bodů
    assert len(pts["breaks"]) == 5
    assert pts["breaks"][0] == 0
    assert all(0 <= b < len(pts["points"]) for b in pts["breaks"])
    assert client.get("/api/points?limit=0").status_code == 422


def test_transport_filter_with_thousands_of_activities(client, test_db, tmp_path):
    """Regrese: filtr dopravy dřív skládal jeden OR výraz přes všechny aktivity
    a u víceletých dat padal na limitu hloubky výrazu SQLite (chyba 500)."""
    seed(test_db, tmp_path)
    with closing(test_db.connect()) as conn:
        day = 1748844000
        conn.executemany(
            "INSERT INTO activities(start_ts,end_ts,type) VALUES(?,?,'DRIVING')",
            [(day + i * 4000, day + i * 4000 + 1800) for i in range(2500)])
        conn.executemany(
            "INSERT OR IGNORE INTO points(ts,lat,lon) VALUES(?,?,?)",
            [(day + i * 4000 + 60, 49.2 + i * 1e-5, 16.6) for i in range(2500)])
        conn.commit()
    r = client.get("/api/points?transport=CAR")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 2500          # body uvnitř intervalů aktivit
    assert len(body["points"]) > 0


def test_stats(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    s = client.get("/api/stats").json()
    assert s["total_km"] == 21.0            # 5 × 4.2 km
    assert s["monthly_source"] == "activities"
    assert s["top_places"][0]["count"] == 5
    # nové dlaždice: cesty, hodiny na cestách, unikátní místa
    assert s["trips_count"] == 5
    assert s["travel_hours"] == round(5 * 40 / 60, 1)   # 5 cest po 40 min
    assert s["unique_places"] == 1                       # jen Práce


def test_stats_fallback_to_points(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    with closing(test_db.connect()) as conn:
        conn.execute("UPDATE activities SET distance_m = NULL")
        conn.commit()
    s = client.get("/api/stats").json()
    assert s["monthly_source"] == "points"  # aktivity bez vzdálenosti → fallback
    assert s["total_km"] > 0


def test_points_viewport_bbox(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    box = {"min_lat": 50.095, "max_lat": 50.105, "min_lon": 14.385, "max_lon": 14.395}
    sub = client.get("/api/points", params=box).json()
    assert 0 < sub["total"] < 100          # jen část bodů u kanceláře
    full = client.get("/api/points").json()
    assert full["total"] == 100


def test_heatmap_precision(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    coarse = client.get("/api/heatmap?precision=2").json()["cells"]
    fine = client.get("/api/heatmap?precision=5").json()["cells"]
    assert len(fine) > len(coarse)          # jemnější mřížka → víc buněk


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
    # měsíční rozpad podle dopravy: 5 jízd autem po 4,2 km v červnu 2025
    assert a["monthly_by_type"] == [{"month": "2025-06", "car": 21.0, "walk": 0,
                                     "bike": 0, "transit": 0, "other": 0}]


def test_analysis_top_routes(client, test_db, tmp_path):
    """Nejčastější trasy: pojmenované dvojice míst z aktivit (obousměrně)."""
    seed(test_db, tmp_path)
    from tests.fixtures import HOME
    with closing(test_db.connect()) as conn:
        # domov zatím nemá návštěvu → doplnit, aby se konec trasy pojmenoval
        conn.execute(
            "INSERT INTO visits(start_ts, end_ts, lat, lon, semantic) "
            "VALUES(1748848000, 1748851600, ?, ?, 'Home')", HOME)
        conn.commit()
    a = client.get("/api/analysis").json()
    assert a["top_routes"], "trasy mezi pojmenovanými místy se mají objevit"
    r = a["top_routes"][0]
    assert {r["from"], r["to"]} == {"Domov", "Práce"}
    assert r["count"] == 5 and r["km_avg"] == 4.2


def test_match_day_snaps_to_road(client, test_db, tmp_path, monkeypatch):
    """Přichycení dne k silnici: mockovaná OSRM odpověď → souřadnice z geometrie;
    výpadek služby → srozumitelná 502, ne pád."""
    seed(test_db, tmp_path)
    from app.routers import map_data

    def fake_fetch(url):
        assert "router.project-osrm.org" in url and "geometries=geojson" in url
        return {"matchings": [{"geometry": {"coordinates":
                [[14.4378, 50.0755], [14.4000, 50.0900], [14.3900, 50.1000]]}}]}

    monkeypatch.setattr(map_data, "_osrm_fetch", fake_fetch)
    map_data._match_cache.clear()
    day = {"from_ts": 1748836800, "to_ts": 1748836800 + 86400}
    r = client.get("/api/match_day", params=day).json()
    assert r["points"][0] == [50.0755, 14.4378]      # lat/lon prohozené z GeoJSON
    assert len(r["points"]) == 3 and r["cached"] is False
    assert client.get("/api/match_day", params=day).json()["cached"] is True

    def broken(url):
        raise OSError("síť nedostupná")
    monkeypatch.setattr(map_data, "_osrm_fetch", broken)
    map_data._match_cache.clear()
    resp = client.get("/api/match_day", params=day)
    assert resp.status_code == 502
    assert "není dostupná" in resp.json()["detail"]


def test_demo_data_only_on_empty_db(client, test_db, tmp_path):
    """Ukázková data: naplní prázdnou DB, nad neprázdnou odmítne (409)."""
    res = client.post("/api/demo")
    assert res.status_code == 200
    body = res.json()
    assert body["points"] > 1000 and body["visits"] > 50
    r = client.get("/api/range").json()
    assert r["points"] == body["points"]
    # druhé volání: databáze už není prázdná → jasná chyba
    assert client.post("/api/demo").status_code == 409


def test_health_and_integrity(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    h = client.get("/api/health").json()
    assert h["db_size"] > 0 and h["points"] == 100
    assert "profile" in h and "trips" in h
    chk = client.post("/api/health/check").json()
    assert chk["ok"] is True and chk["detail"] == ["ok"]


def test_exports(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    assert client.get("/api/export.xlsx").status_code == 200
    gpx = client.get("/api/export.gpx")
    assert gpx.status_code == 200 and b"<trkpt" in gpx.content


def test_calendar(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    cal = client.get("/api/calendar?year=2025").json()
    assert cal["year"] == 2025
    assert len(cal["days"]) == 5               # 5 dní se záznamem (výchozí seed)
    assert sum(d["km"] for d in cal["days"]) > 0
    assert client.get("/api/calendar?year=2010").json()["days"] == []


def test_pmtiles_status_and_range(client, test_db, tmp_path, monkeypatch):
    assert client.get("/api/pmtiles/status").json()["available"] is False
    # podvržený soubor → ověřit Range odpověď
    import app.main as m
    pm = tmp_path / "map.pmtiles"
    pm.write_bytes(b"0123456789abcdef")
    monkeypatch.setattr(m, "_pmtiles_path", lambda: str(pm))
    assert client.get("/api/pmtiles/status").json()["available"] is True
    r = client.get("/api/pmtiles", headers={"Range": "bytes=4-7"})
    assert r.status_code == 206 and r.content == b"4567"
    assert r.headers["content-range"] == "bytes 4-7/16"


def test_backup(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    r = client.get("/api/backup")
    assert r.status_code == 200 and r.content[:15] == b"SQLite format 3"


def test_place_names(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    # pojmenovat místo práce
    r = client.post("/api/places",
                    json={"lat": 50.1, "lon": 14.39, "name": "Zákazník Novák"}).json()
    assert len(r["places"]) == 1
    # top místa i návštěvy používají vlastní název
    stats = client.get("/api/stats").json()
    assert stats["top_places"][0]["label"] == "Zákazník Novák"
    visits = client.get("/api/visits").json()["visits"]
    assert any(v["label"] == "Zákazník Novák" for v in visits)
    # blízké pojmenování jen přejmenuje (žádný duplikát)
    r2 = client.post("/api/places",
                     json={"lat": 50.1004, "lon": 14.3904, "name": "Firma s.r.o."}).json()
    assert len(r2["places"]) == 1 and r2["places"][0]["name"] == "Firma s.r.o."
    # hledání najde vlastní název; smazání vrátí původní popisky
    res = client.get("/api/search_visits?q=firma").json()["results"]
    assert res and res[0]["custom"] is True
    client.delete(f"/api/places/{r2['places'][0]['id']}")
    stats = client.get("/api/stats").json()
    assert stats["top_places"][0]["label"] != "Firma s.r.o."


def test_semantic_translated(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    stats = client.get("/api/stats").json()
    assert stats["top_places"][0]["label"] == "Práce"   # Work → Práce


def test_min_stay_filters_passthrough(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    with closing(test_db.connect()) as conn:
        # 90s „průjezd" místem práce večer (mimo pracovní návštěvu) – nemá se počítat
        conn.execute("INSERT INTO visits(start_ts,end_ts,lat,lon,semantic)"
                     " VALUES(1748880000,1748880090,50.1,14.39,'Work')")
        conn.commit()

    # výchozí filtr 2 min: průjezd se nepočítá nikde
    stats = client.get("/api/stats").json()
    assert stats["visits"] == 5
    loc = client.get("/api/at_location",
                     params={"lat": 50.1, "lon": 14.39, "radius_m": 300}).json()
    assert loc["count"] == 5

    # min_stay_min=0 průjezd ukáže
    stats0 = client.get("/api/stats?min_stay_min=0").json()
    assert stats0["visits"] == 6
    loc0 = client.get("/api/at_location",
                      params={"lat": 50.1, "lon": 14.39, "radius_m": 300,
                              "min_stay_min": 0}).json()
    assert loc0["count"] == 6


def test_polygon_place(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    poly = [[50.095, 14.385], [50.105, 14.385], [50.105, 14.395], [50.095, 14.395]]
    r = client.post("/api/places", json={"name": "Areál firmy", "polygon": poly}).json()
    assert r["places"][0]["polygon"] is not None
    stats = client.get("/api/stats").json()
    assert stats["top_places"][0]["label"] == "Areál firmy"   # práce leží uvnitř
    # bod mimo polygon jméno nedostane
    from app import places as pl
    assert pl.custom_label(r["places"], 50.2, 14.5) is None


def test_place_stats_for_tooltips(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    r = client.post("/api/places",
                    json={"lat": 50.1, "lon": 14.39, "name": "Zákazník"}).json()
    pid = r["places"][0]["id"]
    st = client.get("/api/places/stats").json()["stats"]
    mine = next(s for s in st if s["id"] == pid)
    assert mine["count"] == 5 and mine["secs"] > 0


def test_place_stays_detail(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    pid = client.post("/api/places",
                      json={"lat": 50.1, "lon": 14.39, "name": "Zákazník"}).json()["places"][0]["id"]
    d = client.get(f"/api/places/{pid}/stays").json()
    assert d["place"]["name"] == "Zákazník"
    assert d["count"] == 5 and len(d["stays"]) == 5
    # počet a čas souhlasí s přehledovým /stats
    assert d["secs"] == sum(s["secs"] for s in d["stays"])
    st = next(s for s in client.get("/api/places/stats").json()["stats"] if s["id"] == pid)
    assert d["count"] == st["count"] and d["secs"] == st["secs"]
    # každý pobyt má smysluplný interval
    assert all(s["end_ts"] > s["start_ts"] for s in d["stays"])
    assert client.get("/api/places/9999/stays").status_code == 404


def test_place_stays_from_gps_only(client, test_db, tmp_path):
    """Pobyt jen z GPS bodů (bez záznamu návštěvy) se musí v přehledu ukázat –
    dřív se místo tvářilo „bez pobytu"."""
    lat, lon, base = 49.20, 16.60, 1_749_000_000
    with closing(test_db.connect()) as conn:
        for i in range(40):                       # ~2 h bodů, žádná visit
            conn.execute("INSERT INTO points(ts,lat,lon,accuracy) VALUES(?,?,?,?)",
                         (base + i * 180, lat, lon, 10))
        conn.commit()
    pid = client.post("/api/places",
                      json={"lat": lat, "lon": lon, "name": "Jen GPS"}).json()["places"][0]["id"]
    rng = {"from_ts": base - 1000, "to_ts": base + 40 * 180 + 1000}
    st = next(s for s in client.get("/api/places/stats", params=rng).json()["stats"]
              if s["id"] == pid)
    assert st["count"] == 1 and st["secs"] > 3600      # ~2 h, ne „bez pobytu"
    d = client.get(f"/api/places/{pid}/stays", params=rng).json()
    assert d["count"] == 1 and d["secs"] == st["secs"]


def test_place_patch_rename(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    pid = client.post("/api/places",
                      json={"lat": 50.1, "lon": 14.39, "name": "Starý"}).json()["places"][0]["id"]
    res = client.patch(f"/api/places/{pid}", json={"name": "Nový název"}).json()
    assert next(p for p in res["places"] if p["id"] == pid)["name"] == "Nový název"
    assert client.patch(f"/api/places/{pid}", json={"name": "  "}).status_code == 400
    assert client.patch("/api/places/9999", json={"name": "x"}).status_code == 404


def test_place_patch_area(client, test_db, tmp_path):
    """Editace vyhrazeného prostoru: okruh i polygon, včetně zrušení oblasti."""
    seed(test_db, tmp_path)
    pid = client.post("/api/places",
                      json={"lat": 50.1, "lon": 14.39, "name": "Areál", "radius_m": 250}
                      ).json()["places"][0]["id"]
    get = lambda: next(p for p in client.get("/api/places").json()["places"] if p["id"] == pid)  # noqa: E731
    # změna okruhu
    client.patch(f"/api/places/{pid}", json={"radius_m": 600})
    assert get()["radius_m"] == 600
    assert client.patch(f"/api/places/{pid}", json={"radius_m": 0}).status_code == 400
    # nastavení oblasti (polygon) – centroid se přepočítá
    poly = [[50.098, 14.386], [50.102, 14.386], [50.102, 14.394], [50.098, 14.394]]
    client.patch(f"/api/places/{pid}", json={"polygon": poly})
    p = get()
    assert p["polygon"] and len(p["polygon"]) == 4
    assert abs(p["lat"] - 50.1) < 1e-6 and abs(p["lon"] - 14.39) < 1e-6
    assert client.patch(f"/api/places/{pid}", json={"polygon": [[0, 0], [1, 1]]}).status_code == 400
    # zrušení oblasti → zpět kruh
    client.patch(f"/api/places/{pid}", json={"polygon": []})
    assert get()["polygon"] is None
    # posun středu kruhového místa (interaktivní úprava tvaru na mapě)
    client.patch(f"/api/places/{pid}", json={"radius_m": 300, "lat": 50.2, "lon": 14.5})
    p2 = get()
    assert p2["radius_m"] == 300
    assert abs(p2["lat"] - 50.2) < 1e-6 and abs(p2["lon"] - 14.5) < 1e-6


def test_cities_resolver():
    from app.cities import city_for
    assert city_for(49.19, 16.61) == "Brno"
    assert city_for(50.08, 14.43) == "Praha"
    assert city_for(48.856, 16.05) == "Znojmo"
    assert city_for(0, 0) is None


def test_version_endpoint(client):
    v = client.get("/api/version").json()
    assert v["version"] and isinstance(v["version"], str)
    assert v["desktop"] is False           # v testech není desktopový režim


def test_shutdown_gated_off_desktop(client):
    # mimo desktopovou aplikaci (.exe / run.py) nelze server vypnout přes API
    assert client.post("/api/shutdown").status_code == 403


def test_service_worker_has_version(client):
    r = client.get("/sw.js")
    assert r.status_code == 200
    v = client.get("/api/version").json()["version"]
    assert f"gmaps-historie-{v}" in r.text   # název cache verzován
    assert "__VERSION__" not in r.text
    assert r.headers["cache-control"] == "no-cache"


def test_stats_records(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    rec = client.get("/api/stats").json()["records"]
    assert rec["longest_day"]["km"] == 4.2
    assert rec["longest_trip"]["km"] == 4.2
    assert rec["longest_streak_days"] == 5   # 5 po sobě jdoucích dní s jízdou


def test_backup_list_and_restore(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    assert client.get("/api/points").json()["total"] == 100
    client.get("/api/backup")                       # záloha se 100 body
    backups = client.get("/api/backups").json()["backups"]
    assert backups and backups[0]["name"].startswith("history-")
    name = backups[0]["name"]
    # smazat data importem přes prázdno? jednodušší: přímý zásah do DB
    with closing(test_db.connect()) as conn:
        conn.execute("DELETE FROM points")
        conn.commit()
    assert client.get("/api/points").json()["total"] == 0
    res = client.post("/api/restore", params={"name": name}).json()
    assert res["restored"] == name and res["safety_backup"]
    assert client.get("/api/points").json()["total"] == 100   # obnoveno


def test_restore_rejects_path_traversal(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    assert client.post("/api/restore", params={"name": "../../etc/passwd"}).status_code == 400
    assert client.post("/api/restore", params={"name": "history-nope.db"}).status_code == 404


def test_update_metadata(client, test_db, tmp_path):
    seed(test_db, tmp_path)
    meta = client.get("/api/update").json()
    assert meta["current"]
    assert meta["package_url"] == "/api/update/package"
    assert client.get("/api/update/package").status_code == 404


def test_update_package_served(client, test_db, tmp_path, monkeypatch):
    seed(test_db, tmp_path)
    import zipfile

    from app.core import config
    pkg_dir = tmp_path / "update"
    pkg_dir.mkdir()
    pkg = pkg_dir / "GMapsHistorie-update.zip"
    with zipfile.ZipFile(pkg, "w") as zf:
        zf.writestr("version.json", '{"release":"9.9.9"}')
    monkeypatch.setattr(config, "data_dir", lambda: str(tmp_path))
    r = client.get("/api/update/package")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"


def test_purge_range_with_backup(client, test_db, tmp_path, monkeypatch):
    """Smazání období: dry-run jen počítá; ostrý běh nejdřív zazálohuje,
    smaže jen zvolené rozmezí a přepočítá agregace."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    seed(test_db, tmp_path)
    before = client.get("/api/range").json()
    # den 2. 6. 2025 (první den fixture)
    day = {"from_ts": 1748815200, "to_ts": 1748901599}
    dry = client.post("/api/purge_range", params={**day, "dry_run": True}).json()
    assert dry["dry_run"] is True and dry["points"] == 20
    assert client.get("/api/range").json()["points"] == before["points"]

    res = client.post("/api/purge_range", params={**day, "dry_run": False}).json()
    assert res["dry_run"] is False and res["points"] == 20
    assert res["backup"] and res["backup"].startswith("history-")
    assert (tmp_path / "backups" / res["backup"]).exists()
    after = client.get("/api/range").json()
    assert after["points"] == before["points"] - 20
    assert after["visits"] == before["visits"] - 1


def test_login_sets_secure_cookie_behind_https_proxy(client, test_db, tmp_path,
                                                     monkeypatch):
    from app.core import config
    monkeypatch.setattr(config, "AUTH_PASSWORD", "tajne")
    import app.routers.pages as pages
    monkeypatch.setattr(pages, "AUTH_PASSWORD", "tajne")
    r = client.post("/api/login", json={"password": "tajne"},
                    headers={"x-forwarded-proto": "https"})
    assert r.status_code == 200
    assert "Secure" in r.headers.get("set-cookie", "")
    r2 = client.post("/api/login", json={"password": "tajne"})
    assert "Secure" not in r2.headers.get("set-cookie", "")


def test_insights(client, test_db, tmp_path):
    """Zajímavosti: domov, akční rádius, rytmus týdne, trasy se souřadnicemi."""
    seed(test_db, tmp_path)
    from tests.fixtures import HOME
    with closing(test_db.connect()) as conn:
        conn.execute(
            "INSERT INTO visits(start_ts, end_ts, lat, lon, semantic) "
            "VALUES(1748848000, 1748905600, ?, ?, 'Home')", HOME)   # dlouhý pobyt doma
        conn.commit()
    ins = client.get("/api/insights").json()
    assert ins["home"]["label"] == "Domov"
    assert abs(ins["home"]["lat"] - HOME[0]) < 0.001
    # celý pohyb je domov<->práce (~3 km) → rádius pod 5 km, žádná noc mimo
    assert 0 < ins["radius"]["p50_m"] <= ins["radius"]["p99_m"] < 5000
    assert ins["away_nights"] == 0
    assert ins["farthest"]["km"] > 0 and ins["farthest"]["date"]
    assert ins["first_move"] and ins["last_move"]
    assert len(ins["punchcard"]) > 0
    assert all(len(row) == 3 for row in ins["punchcard"])
    r = ins["routes_geo"][0]
    assert {r["from"], r["to"]} == {"Domov", "Práce"}
    assert abs(r["from_lat"] - HOME[0]) < 0.01 or abs(r["to_lat"] - HOME[0]) < 0.01


def test_heatmap_modes_and_hours(client, test_db, tmp_path):
    """Heatmapa: režim visits váží délkou pobytu; filtr hodin omezí body."""
    seed(test_db, tmp_path)
    vis = client.get("/api/heatmap?mode=visits").json()["cells"]
    assert vis, "návštěvy z fixture se mají objevit"
    assert vis[0][2] >= 3600 * 5          # 5 pobytů po ~7,3 h → velká váha
    # body jsou 8:00–8:40 → ranní filtr je zachytí, noční ne
    morning = client.get("/api/heatmap?hour_from=5&hour_to=9").json()["cells"]
    night = client.get("/api/heatmap?hour_from=22&hour_to=5").json()["cells"]
    assert sum(c[2] for c in morning) == 100
    assert night == []


def test_export_gpx_segments_and_geojson_tracks(client, test_db, tmp_path):
    """GPX se dělí na <trkseg> po cestách; GeoJSON obsahuje LineString trasy."""
    seed(test_db, tmp_path)
    gpx = client.get("/api/export.gpx")
    assert gpx.status_code == 200
    assert gpx.content.count(b"<trkseg>") == 5     # úsek na každý den fixture
    gj = client.get("/api/export.geojson").json()
    kinds = {f["properties"]["kind"] for f in gj["features"]}
    assert {"track", "point", "visit"} <= kinds
    lines = [f for f in gj["features"] if f["geometry"]["type"] == "LineString"]
    assert len(lines) == 5
    assert all(len(f["geometry"]["coordinates"]) >= 2 for f in lines)
    # points=false vynechá surové body, trasy a návštěvy zůstanou
    gj2 = client.get("/api/export.geojson?points=false").json()
    kinds2 = {f["properties"]["kind"] for f in gj2["features"]}
    assert "point" not in kinds2 and {"track", "visit"} <= kinds2


def test_update_check(client, test_db, monkeypatch):
    """Kontrola nové verze: porovnání verzí, cache a chování offline."""
    from app.routers import pages
    monkeypatch.setattr(pages, "_fetch_latest_release",
                        lambda: {"tag_name": "v99.0.0",
                                 "html_url": "https://example.com/rel"})
    monkeypatch.setitem(pages._update_cache, "ts", 0.0)
    u = client.get("/api/update_check").json()
    assert u["available"] is True and u["latest"] == "99.0.0"
    assert u["url"] == "https://example.com/rel"

    # stejná/starší verze → available False
    monkeypatch.setattr(pages, "_fetch_latest_release",
                        lambda: {"tag_name": "v0.1", "html_url": ""})
    monkeypatch.setitem(pages._update_cache, "ts", 0.0)
    assert client.get("/api/update_check").json()["available"] is False

    # GitHub nedostupný → available None, žádná chyba
    def _boom():
        raise OSError("offline")
    monkeypatch.setattr(pages, "_fetch_latest_release", _boom)
    monkeypatch.setitem(pages._update_cache, "ts", 0.0)
    u = client.get("/api/update_check").json()
    assert u["available"] is None and u["latest"] is None

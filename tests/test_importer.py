"""Importér: všechny formáty, autodetekce, deduplikace."""
from contextlib import closing

from conftest import make_records, make_semantic, make_takeout_zip, make_timeline_android

from app import importer


def counts(test_db):
    with closing(test_db.connect()) as conn:
        return {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t in ("points", "visits", "activities")}


def test_import_timeline_android(test_db, tmp_path):
    c = importer.import_path(str(make_timeline_android(tmp_path / "t.json")))
    assert c.points == 100 and c.visits == 5 and c.activities == 5
    assert counts(test_db)["points"] == 100


def test_import_records(test_db, tmp_path):
    c = importer.import_path(str(make_records(tmp_path / "r.json")))
    assert c.points == 50 and c.visits == 0


def test_import_semantic(test_db, tmp_path):
    c = importer.import_path(str(make_semantic(tmp_path / "s.json")))
    assert c.visits == 1 and c.activities == 1
    with closing(test_db.connect()) as conn:
        v = conn.execute("SELECT name FROM visits").fetchone()
    assert v["name"] == "Kancelář"


def test_import_zip_detected_by_content(test_db, tmp_path):
    # schválně bez přípony .zip – musí rozhodnout obsah
    path = make_takeout_zip(tmp_path / "takeout.bin", tmp_path)
    c = importer.import_path(str(path))
    assert c.files == 2 and c.points == 50 and c.visits == 1


def test_reimport_is_deduplicated(test_db, tmp_path):
    p = make_timeline_android(tmp_path / "t.json")
    importer.import_path(str(p))
    c2 = importer.import_path(str(p))
    assert c2.points == 0 and c2.visits == 0 and c2.activities == 0


def test_parse_helpers():
    assert importer.parse_latlng("50.1°, 14.4°") == (50.1, 14.4)
    assert importer.parse_latlng("geo:50.1,14.4") == (50.1, 14.4)
    assert importer.parse_latlng({"latitudeE7": 501000000, "longitudeE7": 144000000}) == (50.1, 14.4)
    assert importer.parse_latlng("99°, 200°") is None
    assert importer.parse_ts("2025-06-01T10:00:00Z") == 1748772000
    assert importer.parse_ts("1748772000000") == 1748772000

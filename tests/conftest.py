import json
import os
import sys
import zipfile
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["DISABLE_BACKGROUND"] = "1"

from app import db  # noqa: E402

TZ = timezone(timedelta(hours=2))
HOME = (50.0755, 14.4378)
WORK = (50.1000, 14.3900)


@pytest.fixture
def test_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setattr(db, "_schema_done", False)
    return db


@pytest.fixture
def client(test_db):
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        yield c


def iso(dt):
    return dt.isoformat()


def make_timeline_android(path, days=5, start=datetime(2025, 6, 2, tzinfo=TZ)):
    """Nový export z telefonu: timelinePath + visit + activity na každý den."""
    segs = []
    for d in range(days):
        day = start + timedelta(days=d)
        m0, m1 = day.replace(hour=8), day.replace(hour=8, minute=40)
        pts = [(m0 + timedelta(minutes=2 * i),
                HOME[0] + (WORK[0] - HOME[0]) * i / 19,
                HOME[1] + (WORK[1] - HOME[1]) * i / 19) for i in range(20)]
        segs.append({"startTime": iso(m0), "endTime": iso(m1),
                     "timelinePath": [{"point": f"{la:.7f}°, {lo:.7f}°",
                                       "time": iso(t)} for t, la, lo in pts]})
        segs.append({"startTime": iso(m0), "endTime": iso(m1),
                     "activity": {
                         "start": {"latLng": f"{HOME[0]}°, {HOME[1]}°"},
                         "end": {"latLng": f"{WORK[0]}°, {WORK[1]}°"},
                         "distanceMeters": 4200.0,
                         "topCandidate": {"type": "in passenger vehicle"}}})
        segs.append({"startTime": iso(m1), "endTime": iso(day.replace(hour=16)),
                     "visit": {"topCandidate": {
                         "semanticType": "Work",
                         "placeLocation": {"latLng": f"{WORK[0]}°, {WORK[1]}°"}}}})
    path.write_text(json.dumps({"semanticSegments": segs}))
    return path


def make_records(path, n=50, start=datetime(2021, 3, 1, 8, tzinfo=TZ)):
    locs = [{"latitudeE7": int((HOME[0] + i * 1e-4) * 1e7),
             "longitudeE7": int((HOME[1] + i * 1e-4) * 1e7),
             "accuracy": 10,
             "timestamp": iso(start + timedelta(minutes=i))} for i in range(n)]
    path.write_text(json.dumps({"locations": locs}))
    return path


def make_semantic(path, start=datetime(2021, 3, 1, tzinfo=TZ)):
    objs = [{"placeVisit": {
        "location": {"latitudeE7": int(WORK[0] * 1e7), "longitudeE7": int(WORK[1] * 1e7),
                     "name": "Kancelář", "address": "Praha 6"},
        "duration": {"startTimestamp": iso(start.replace(hour=9)),
                     "endTimestamp": iso(start.replace(hour=17))}}},
        {"activitySegment": {
            "startLocation": {"latitudeE7": int(HOME[0] * 1e7), "longitudeE7": int(HOME[1] * 1e7)},
            "endLocation": {"latitudeE7": int(WORK[0] * 1e7), "longitudeE7": int(WORK[1] * 1e7)},
            "duration": {"startTimestamp": iso(start.replace(hour=8)),
                         "endTimestamp": iso(start.replace(hour=8, minute=45))},
            "distance": 4300, "activityType": "IN_BUS"}}]
    path.write_text(json.dumps({"timelineObjects": objs}))
    return path


def make_takeout_zip(path, tmp_path):
    rec = make_records(tmp_path / "_r.json")
    sem = make_semantic(tmp_path / "_s.json")
    with zipfile.ZipFile(path, "w") as zf:
        zf.write(rec, "Takeout/Location History/Records.json")
        zf.write(sem, "Takeout/Location History/Semantic Location History/2021/2021_MARCH.json")
    return path

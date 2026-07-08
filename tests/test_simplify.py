"""Douglas–Peucker zjednodušení tras a priorita timelinePath při importu."""
import json
from datetime import datetime, timedelta, timezone

from app import importer
from app.services.simplify import _douglas_peucker, simplify_track, split_track_segments
from tests.fixtures import HOME, WORK, iso


def test_douglas_peucker_reduces_collinear_points():
    rows = [(i, 50.0 + i * 0.001, 14.0) for i in range(100)]
    out = _douglas_peucker(rows, epsilon_m=5.0)
    assert len(out) == 2
    assert out[0] == rows[0]
    assert out[-1] == rows[-1]


def test_douglas_peucker_keeps_corners():
    rows = [
        (0, 50.0, 14.0),
        (1, 50.01, 14.0),
        (2, 50.01, 14.05),
        (3, 50.01, 14.10),
    ]
    out = _douglas_peucker(rows, epsilon_m=5.0)
    assert len(out) >= 3
    assert out[0] == rows[0]
    assert out[-1] == rows[-1]


def test_split_track_segments_on_time_gap():
    rows = [
        (0, 50.0, 14.0),
        (60, 50.001, 14.001),
        (5000, 50.1, 14.1),
        (5060, 50.101, 14.101),
    ]
    segs = split_track_segments(rows, gap_s=1800, gap_km=50)
    assert len(segs) == 2
    assert len(segs[0]) == 2
    assert len(segs[1]) == 2


def test_simplify_track_respects_limit():
    rows = [(i, 50.0 + (i % 7) * 1e-4, 14.0 + (i % 5) * 1e-4) for i in range(5000)]
    out = simplify_track(rows, limit=200)
    assert len(out) <= 200
    assert out[0] == rows[0] or out[0][0] == rows[0][0]


def test_timeline_priority_skips_raw_signals(test_db, tmp_path):
    """rawSignals ve stejném čase jako timelinePath se neimportují."""
    TZ = timezone(timedelta(hours=2))
    t0 = datetime(2025, 6, 2, 8, 0, tzinfo=TZ)
    t1 = t0 + timedelta(minutes=30)
    seg_start, seg_end = iso(t0), iso(t1)
    timeline_pts = [
        {"point": f"{HOME[0]:.7f}°, {HOME[1]:.7f}°", "time": iso(t0 + timedelta(minutes=i * 2))}
        for i in range(10)
    ]
    raw = [
        {"position": {
            "LatLng": f"{HOME[0] + 0.01:.7f}°, {HOME[1]:.7f}°",
            "timestamp": iso(t0 + timedelta(minutes=i * 2)),
            "accuracyMeters": 8,
        }}
        for i in range(10)
    ]
    # surové body mimo timeline segment – ty zůstanou
    raw.append({
        "position": {
            "LatLng": f"{WORK[0]:.7f}°, {WORK[1]:.7f}°",
            "timestamp": iso(t0 + timedelta(hours=3)),
            "accuracyMeters": 8,
        },
    })
    path = tmp_path / "mixed.json"
    path.write_text(json.dumps({
        "semanticSegments": [{
            "startTime": seg_start,
            "endTime": seg_end,
            "timelinePath": timeline_pts,
        }],
        "rawSignals": raw,
    }))
    c = importer.import_path(str(path))
    assert c.points == 11  # 10 timeline + 1 raw mimo pokrytí
    with test_db.connect() as conn:
        n = conn.execute("SELECT COUNT(*) FROM points").fetchone()[0]
    assert n == 11

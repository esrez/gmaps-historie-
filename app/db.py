"""SQLite úložiště pro historii polohy."""
from __future__ import annotations

import os
import sqlite3
import threading

_DATA_ROOT = os.environ.get("DATA_DIR", "data")
_PROFILE = os.environ.get("PROFILE", "default")
DB_PATH = os.environ.get("DB_PATH", os.path.join(_DATA_ROOT, "history.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS points (
    id       INTEGER PRIMARY KEY,
    ts       INTEGER NOT NULL,
    lat      REAL NOT NULL,
    lon      REAL NOT NULL,
    accuracy REAL,
    source   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_points_unique ON points(ts, lat, lon);
CREATE INDEX IF NOT EXISTS idx_points_ts ON points(ts);
CREATE INDEX IF NOT EXISTS idx_points_lat ON points(lat);

CREATE VIRTUAL TABLE IF NOT EXISTS points_rtree USING rtree(
    id, min_lat, max_lat, min_lon, max_lon
);

CREATE TABLE IF NOT EXISTS visits (
    id       INTEGER PRIMARY KEY,
    start_ts INTEGER NOT NULL,
    end_ts   INTEGER NOT NULL,
    lat      REAL NOT NULL,
    lon      REAL NOT NULL,
    name     TEXT,
    address  TEXT,
    semantic TEXT,
    source   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_unique ON visits(start_ts, end_ts, lat, lon);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(start_ts);
CREATE INDEX IF NOT EXISTS idx_visits_lat ON visits(lat);

CREATE TABLE IF NOT EXISTS activities (
    id         INTEGER PRIMARY KEY,
    start_ts   INTEGER NOT NULL,
    end_ts     INTEGER NOT NULL,
    type       TEXT NOT NULL DEFAULT 'UNKNOWN',
    distance_m REAL,
    start_lat  REAL, start_lon REAL,
    end_lat    REAL, end_lon  REAL,
    source     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_act_unique ON activities(start_ts, end_ts, type);
CREATE INDEX IF NOT EXISTS idx_act_ts ON activities(start_ts);

CREATE TABLE IF NOT EXISTS trips (
    id          INTEGER PRIMARY KEY,
    start_ts    INTEGER NOT NULL,
    end_ts      INTEGER NOT NULL,
    km          REAL NOT NULL DEFAULT 0,
    origin      TEXT,
    destination TEXT,
    purpose     TEXT,
    driver      TEXT,
    plate       TEXT,
    private     INTEGER NOT NULL DEFAULT 0,
    activity_ts INTEGER UNIQUE,
    excluded    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trips_ts ON trips(start_ts);

CREATE TABLE IF NOT EXISTS km_rules (
    id          INTEGER PRIMARY KEY,
    origin      TEXT NOT NULL DEFAULT '',
    destination TEXT NOT NULL,
    km          REAL NOT NULL,
    UNIQUE(origin, destination)
);

CREATE TABLE IF NOT EXISTS odometer (
    year  INTEGER NOT NULL,
    plate TEXT NOT NULL DEFAULT '',
    km    REAL NOT NULL,
    PRIMARY KEY (year, plate)
);

CREATE TABLE IF NOT EXISTS place_names (
    id       INTEGER PRIMARY KEY,
    lat      REAL NOT NULL,
    lon      REAL NOT NULL,
    radius_m REAL NOT NULL DEFAULT 250,
    name     TEXT NOT NULL,
    polygon  TEXT
);

CREATE TABLE IF NOT EXISTS undo_log (
    id      INTEGER PRIMARY KEY,
    created INTEGER NOT NULL,
    op      TEXT NOT NULL,
    data    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agg_monthly_km (
    month  TEXT PRIMARY KEY,
    km     REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'activities'
);

CREATE TABLE IF NOT EXISTS agg_daily_km (
    date   TEXT PRIMARY KEY,
    km     REAL NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profiles (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    created_ts INTEGER NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
);
"""

_schema_lock = threading.Lock()
_schema_done = False
_profile_lock = threading.Lock()
_active_profile = _PROFILE


def profile_root() -> str:
    return os.path.join(_DATA_ROOT, "profiles")


def list_profiles() -> list[dict]:
    root = profile_root()
    os.makedirs(root, exist_ok=True)
    out = []
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if os.path.isdir(path) and os.path.exists(os.path.join(path, "history.db")):
            st = os.stat(os.path.join(path, "history.db"))
            out.append({"name": name, "size": st.st_size,
                          "db_path": os.path.join(path, "history.db")})
    if not out and os.path.exists(os.path.join(_DATA_ROOT, "history.db")):
        out.append({"name": "default", "size": os.path.getsize(
            os.path.join(_DATA_ROOT, "history.db")),
            "db_path": os.path.join(_DATA_ROOT, "history.db"), "legacy": True})
    return out


def set_profile(name: str) -> str:
    global DB_PATH, _active_profile, _schema_done
    with _profile_lock:
        safe = "".join(c for c in name if c.isalnum() or c in "-_").strip() or "default"
        path = os.path.join(profile_root(), safe, "history.db")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        DB_PATH = path
        _active_profile = safe
        _schema_done = False
        return safe


def active_profile() -> str:
    return _active_profile


def _migrate(conn: sqlite3.Connection):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(trips)")}
    if cols and "excluded" not in cols:
        conn.execute("ALTER TABLE trips ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0")

    cols = {r[1] for r in conn.execute("PRAGMA table_info(place_names)")}
    if cols and "polygon" not in cols:
        conn.execute("ALTER TABLE place_names ADD COLUMN polygon TEXT")

    cols = {r[1] for r in conn.execute("PRAGMA table_info(odometer)")}
    if cols and "plate" not in cols:
        conn.executescript("""
            ALTER TABLE odometer RENAME TO odometer_old;
            CREATE TABLE odometer (
                year  INTEGER NOT NULL,
                plate TEXT NOT NULL DEFAULT '',
                km    REAL NOT NULL,
                PRIMARY KEY (year, plate)
            );
            INSERT INTO odometer(year, plate, km)
                SELECT year, '', km FROM odometer_old;
            DROP TABLE odometer_old;
        """)


def _sync_rtree(conn: sqlite3.Connection):
    """Doplní R-tree index pro body, které v něm ještě nejsou."""
    has = conn.execute(
        "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='points_rtree'"
    ).fetchone()["c"]
    if not has:
        return
    conn.execute("""
        INSERT INTO points_rtree(id, min_lat, max_lat, min_lon, max_lon)
        SELECT p.id, p.lat, p.lat, p.lon, p.lon FROM points p
        WHERE p.id NOT IN (SELECT id FROM points_rtree)
        LIMIT 500000
    """)


def _ensure_schema(conn: sqlite3.Connection):
    global _schema_done
    if _schema_done:
        return
    with _schema_lock:
        if _schema_done:
            return
        _migrate(conn)
        conn.executescript(SCHEMA)
        _sync_rtree(conn)
        conn.commit()
        _schema_done = True


def connect() -> sqlite3.Connection:
    directory = os.path.dirname(DB_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    _ensure_schema(conn)
    return conn


def after_import(conn: sqlite3.Connection | None = None):
    """Po importu: R-tree sync + agregace."""
    own = conn is None
    if own:
        conn = connect()
    try:
        _sync_rtree(conn)
        conn.commit()
        from .services.aggregations import refresh_aggregations
        refresh_aggregations(conn)
    finally:
        if own:
            conn.close()

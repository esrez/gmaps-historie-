"""SQLite úložiště pro historii polohy."""
import os
import sqlite3

DB_PATH = os.environ.get("DB_PATH", os.path.join("data", "history.db"))

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
    activity_ts INTEGER UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_trips_ts ON trips(start_ts);
"""


def connect() -> sqlite3.Connection:
    directory = os.path.dirname(DB_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    return conn

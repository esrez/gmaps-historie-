"""SQLite úložiště pro historii polohy."""
import os
import sqlite3
import threading

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
    name     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS undo_log (
    id      INTEGER PRIMARY KEY,
    created INTEGER NOT NULL,
    op      TEXT NOT NULL,
    data    TEXT NOT NULL
);
"""

_schema_lock = threading.Lock()
_schema_done = False


def _migrate(conn: sqlite3.Connection):
    """Migrace databází založených staršími verzemi schématu."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(trips)")}
    if cols and "excluded" not in cols:
        conn.execute("ALTER TABLE trips ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0")

    # tachometr: dříve jen (year, km), nyní per vozidlo (year, plate, km)
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


def _ensure_schema(conn: sqlite3.Connection):
    global _schema_done
    if _schema_done:
        return
    with _schema_lock:
        if _schema_done:
            return
        _migrate(conn)
        conn.executescript(SCHEMA)
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
    _ensure_schema(conn)
    return conn

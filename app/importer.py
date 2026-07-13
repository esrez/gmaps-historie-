"""Import historie polohy z Google Maps.

Automaticky rozpozná a zpracuje všechny známé formáty exportu:

1. Nový export z telefonu (od poloviny 2024)
   - Android: objekt s klíčem "semanticSegments" (+ volitelně "rawSignals")
   - iOS: pole segmentů se "startTime"/"endTime" a "visit"/"activity"/"timelinePath"
2. Starý Google Takeout
   - Records.json: objekt s klíčem "locations" (surové GPS body, může mít GB)
   - Semantic Location History/<rok>/<měsíc>.json: objekt s "timelineObjects"
3. ZIP archiv (celý Takeout) – projde všechny .json soubory uvnitř

Použití z příkazové řádky:
    python -m app.importer soubor1.json [soubor2.zip ...]
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import zipfile
from datetime import UTC, datetime

from . import db

try:
    import ijson  # streamované čtení obřích Records.json
except ImportError:  # pragma: no cover
    ijson = None

BATCH = 50_000
_LATLNG_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)\s*°?")


def _short_reason(exc: Exception) -> str:
    """Krátký, srozumitelný důvod přeskočení souboru pro přehled importu."""
    msg = str(exc).strip() or exc.__class__.__name__
    if "nerozpoznaný formát" in msg:
        return "nerozpoznaný formát (nejspíš to nejsou data o poloze)"
    return msg[:100]


class Counters:
    def __init__(self):
        self.points = 0
        self.visits = 0
        self.activities = 0
        self.files = 0            # úspěšně zpracované soubory
        self.skipped = 0          # soubory bez rozpoznaného formátu / chybné
        self.reports: list[dict] = []       # co který soubor přinesl (úspěšné)
        self.skipped_names: list[str] = []  # ukázka přeskočených (max 30)

    def note_file(self, name: str, fmt: str, points: int, visits: int, activities: int):
        self.files += 1
        # detail držíme jen pro rozumný počet souborů, ať status nenabobtná
        if len(self.reports) < 400:
            self.reports.append({"name": name, "format": fmt, "points": points,
                                 "visits": visits, "activities": activities})

    def note_skip(self, name: str, reason: str):
        self.skipped += 1
        if len(self.skipped_names) < 30:
            self.skipped_names.append(f"{name}: {reason}")

    def as_dict(self):
        return {"files": self.files, "points": self.points,
                "visits": self.visits, "activities": self.activities,
                "skipped": self.skipped, "reports": self.reports,
                "skipped_names": self.skipped_names}


# ---------------------------------------------------------------- pomocné

def parse_ts(val) -> int | None:
    """Čas → unix sekundy. Zvládá ISO 8601, unix s/ms, číselné řetězce."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        v = float(val)
        return int(v / 1000) if v > 1e11 else int(v)
    s = str(val).strip()
    if s.lstrip("-").isdigit():
        v = int(s)
        return v // 1000 if abs(v) > 1e11 else v
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return int(dt.timestamp())
    except ValueError:
        return None


def parse_latlng(val) -> tuple[float, float] | None:
    """Souřadnice v libovolné podobě, kterou Google používá."""
    if val is None:
        return None
    if isinstance(val, dict):
        if "latLng" in val:
            return parse_latlng(val["latLng"])
        for lat_k, lon_k in (("latitudeE7", "longitudeE7"), ("latE7", "lngE7")):
            if lat_k in val and lon_k in val:
                return val[lat_k] / 1e7, val[lon_k] / 1e7
        if "latitude" in val and "longitude" in val:
            return float(val["latitude"]), float(val["longitude"])
        return None
    s = str(val).strip()
    if s.startswith("geo:"):
        s = s[4:]
    m = _LATLNG_RE.search(s)
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if abs(lat) > 90 or abs(lon) > 180:
        return None
    return lat, lon


class Writer:
    """Dávkové INSERT OR IGNORE zápisy."""

    def __init__(self, conn, counters: Counters, source: str):
        self.conn = conn
        self.c = counters
        self.source = source
        self._points: list[tuple] = []
        self._visits: list[tuple] = []
        self._acts: list[tuple] = []

    def point(self, ts, lat, lon, accuracy=None):
        if ts is None or lat is None:
            return
        self._points.append((ts, lat, lon, accuracy, self.source))
        if len(self._points) >= BATCH:
            self._flush_points()

    def visit(self, start, end, latlng, name=None, address=None, semantic=None):
        if start is None or end is None or latlng is None:
            return
        self._visits.append((start, end, latlng[0], latlng[1],
                             name, address, semantic, self.source))

    def activity(self, start, end, typ, dist, start_ll, end_ll):
        if start is None or end is None:
            return
        s = start_ll or (None, None)
        e = end_ll or (None, None)
        self._acts.append((start, end, (typ or "UNKNOWN").upper(), dist,
                           s[0], s[1], e[0], e[1], self.source))

    def _flush_points(self):
        if not self._points:
            return
        cur = self.conn.executemany(
            "INSERT OR IGNORE INTO points(ts,lat,lon,accuracy,source) VALUES(?,?,?,?,?)",
            self._points)
        self.c.points += cur.rowcount
        self._points.clear()
        self.conn.commit()

    def flush(self):
        self._flush_points()
        if self._visits:
            cur = self.conn.executemany(
                "INSERT OR IGNORE INTO visits(start_ts,end_ts,lat,lon,name,address,semantic,source)"
                " VALUES(?,?,?,?,?,?,?,?)", self._visits)
            self.c.visits += cur.rowcount
            self._visits.clear()
        if self._acts:
            cur = self.conn.executemany(
                "INSERT OR IGNORE INTO activities(start_ts,end_ts,type,distance_m,"
                "start_lat,start_lon,end_lat,end_lon,source) VALUES(?,?,?,?,?,?,?,?,?)",
                self._acts)
            self.c.activities += cur.rowcount
            self._acts.clear()
        self.conn.commit()


class TimelineCoverage:
    """Časové intervaly pokryté timelinePath – rawSignals se do nich neimportují."""

    def __init__(self):
        self._ranges: list[tuple[int, int]] = []

    def add(self, start: int | None, end: int | None) -> None:
        if start is not None and end is not None and end >= start:
            self._ranges.append((start, end))

    def covers(self, ts: int) -> bool:
        return any(lo <= ts <= hi for lo, hi in self._ranges)


# ------------------------------------------------- jednotlivé formáty

def _import_records_stream(fileobj, w: Writer):
    """Records.json – streamovaně, soubor může mít i gigabajty."""
    if ijson is not None:
        for loc in ijson.items(fileobj, "locations.item"):
            _record_location(loc, w)
    else:
        data = json.load(fileobj)
        for loc in data.get("locations", []):
            _record_location(loc, w)


def _record_location(loc: dict, w: Writer):
    ll = parse_latlng(loc)
    ts = parse_ts(loc.get("timestamp") or loc.get("timestampMs"))
    if ll and ts:
        acc = loc.get("accuracy")
        w.point(ts, ll[0], ll[1], float(acc) if acc is not None else None)


def _import_timeline_objects(data: dict, w: Writer):
    """Starý Takeout – Semantic Location History (měsíční soubory)."""
    for obj in data.get("timelineObjects", []):
        pv = obj.get("placeVisit")
        if pv:
            loc = pv.get("location", {})
            dur = pv.get("duration", {})
            w.visit(
                parse_ts(dur.get("startTimestamp") or dur.get("startTimestampMs")),
                parse_ts(dur.get("endTimestamp") or dur.get("endTimestampMs")),
                parse_latlng(loc),
                name=loc.get("name"), address=loc.get("address"),
                semantic=loc.get("semanticType"))
            continue
        seg = obj.get("activitySegment")
        if not seg:
            continue
        dur = seg.get("duration", {})
        start = parse_ts(dur.get("startTimestamp") or dur.get("startTimestampMs"))
        end = parse_ts(dur.get("endTimestamp") or dur.get("endTimestampMs"))
        w.activity(start, end, seg.get("activityType"), seg.get("distance"),
                   parse_latlng(seg.get("startLocation")),
                   parse_latlng(seg.get("endLocation")))
        raw = (seg.get("simplifiedRawPath") or {}).get("points") or []
        for p in raw:
            ll = parse_latlng(p)
            ts = parse_ts(p.get("timestamp") or p.get("timestampMs"))
            if ll and ts:
                w.point(ts, ll[0], ll[1], p.get("accuracyMeters"))
        # waypointy nemají čas – rozprostřeme je rovnoměrně po trvání úseku
        wps = (seg.get("waypointPath") or {}).get("waypoints") or []
        if wps and not raw and start and end:
            span = max(end - start, 1)
            n = len(wps)
            for i, p in enumerate(wps):
                ll = parse_latlng(p)
                if ll:
                    w.point(start + span * i // max(n - 1, 1), ll[0], ll[1])


def _import_semantic_segments(segments, w: Writer,
                              coverage: TimelineCoverage | None = None):
    """Nový export z telefonu (Android objekt i iOS pole)."""
    for seg in segments:
        start = parse_ts(seg.get("startTime"))
        end = parse_ts(seg.get("endTime"))
        path = seg.get("timelinePath") or []
        had_timeline = False

        for p in path:
            ll = parse_latlng(p.get("point"))
            ts = parse_ts(p.get("time"))
            if ts is None and start is not None:
                off = p.get("durationMinutesOffsetFromStartTime")
                if off is not None:
                    ts = start + int(float(off)) * 60
            if ll and ts:
                w.point(ts, ll[0], ll[1])
                had_timeline = True

        if coverage is not None and had_timeline:
            coverage.add(start, end)

        visit = seg.get("visit")
        if visit:
            top = visit.get("topCandidate") or {}
            ll = parse_latlng(top.get("placeLocation"))
            w.visit(start, end, ll, semantic=top.get("semanticType"))

        act = seg.get("activity")
        if act:
            dist = act.get("distanceMeters")
            top = act.get("topCandidate") or {}
            w.activity(start, end, top.get("type"),
                       float(dist) if dist is not None else None,
                       parse_latlng(act.get("start")),
                       parse_latlng(act.get("end")))


def _import_raw_signals(signals, w: Writer, coverage: TimelineCoverage | None = None):
    for sig in signals or []:
        pos = sig.get("position")
        if not pos:
            continue
        ll = parse_latlng(pos.get("LatLng") or pos.get("latLng"))
        ts = parse_ts(pos.get("timestamp"))
        if not ll or ts is None:
            continue
        if coverage is not None and coverage.covers(ts):
            continue
        acc = pos.get("accuracyMeters")
        w.point(ts, ll[0], ll[1], float(acc) if acc is not None else None)


# ------------------------------------------------------------ dispatcher

def _import_json_stream(fileobj, w: Writer, label: str):
    head = fileobj.read(4096)
    if isinstance(head, bytes):
        head_txt = head.decode("utf-8", "replace")
    else:
        head_txt = head
    fileobj.seek(0)

    # rozhoduje klíč, který se v souboru objeví jako první (top-level klíč
    # je vždy na začátku; jiný výskyt téhož slova hlouběji nevadí)
    markers = {m: head_txt.find(m) for m in
               ('"locations"', '"timelineObjects"', '"semanticSegments"', '"rawSignals"')}
    found = {m: i for m, i in markers.items() if i >= 0}
    first = min(found, key=found.get) if found else None

    if first == '"locations"':
        _import_records_stream(fileobj, w)
        return "Records"

    data = json.load(fileobj)
    if isinstance(data, dict):
        if "timelineObjects" in data:
            _import_timeline_objects(data, w)
            return "Semantic Location History"
        if "semanticSegments" in data or "rawSignals" in data:
            coverage = TimelineCoverage()
            _import_semantic_segments(data.get("semanticSegments") or [], w, coverage)
            _import_raw_signals(data.get("rawSignals"), w, coverage)
            return "Timeline export (Android)"
        if "locations" in data:
            for loc in data["locations"]:
                _record_location(loc, w)
            return "Records"
    if isinstance(data, list):
        _import_semantic_segments(data, w)
        return "Timeline export (iOS)"
    raise ValueError(f"{label}: nerozpoznaný formát JSON")


def import_path(path: str, conn=None, counters: Counters | None = None) -> Counters:
    own_conn = conn is None
    if own_conn:
        conn = db.connect()
    c = counters or Counters()
    try:
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as zf:
                json_names = [n for n in zf.namelist() if n.lower().endswith(".json")]
                if not json_names:
                    raise ValueError(
                        "V ZIP archivu nejsou žádné .json soubory – je to opravdu "
                        "export Google Takeout / Timeline?")
                for name in json_names:
                    base = os.path.basename(name)
                    before = (c.points, c.visits, c.activities)
                    w = Writer(conn, c, base)
                    try:
                        with zf.open(name) as raw:
                            buffered = io.BufferedReader(raw)
                            fmt = _import_json_stream(buffered, w, name)
                        w.flush()
                    except (ValueError, json.JSONDecodeError) as exc:
                        c.note_skip(base, _short_reason(exc))
                        continue
                    except Exception as exc:   # neočekávané – nezastavit celý ZIP
                        c.note_skip(base, _short_reason(exc))
                        print(f"  {name}: přeskočeno – {_short_reason(exc)}")
                        continue
                    c.note_file(base, fmt, c.points - before[0],
                                c.visits - before[1], c.activities - before[2])
                    print(f"  {name}: {fmt}")
        else:
            base = os.path.basename(path)
            before = (c.points, c.visits, c.activities)
            w = Writer(conn, c, base)
            with open(path, "rb") as f:
                fmt = _import_json_stream(f, w, path)
            w.flush()
            c.note_file(base, fmt, c.points - before[0],
                        c.visits - before[1], c.activities - before[2])
            print(f"  {base}: {fmt}")
    finally:
        if own_conn:
            from . import db as _db
            _db.after_import(conn)
            conn.close()
    return c


def main(argv: list[str]):
    if not argv:
        print(__doc__)
        sys.exit(1)
    conn = db.connect()
    c = Counters()
    for path in argv:
        print(f"Importuji {path} ...")
        import_path(path, conn, c)
    # se sdíleným spojením přepočet neproběhl uvnitř import_path – dohnat,
    # jinak by po CLI importu zůstal prázdný kalendář a měsíční km
    db.after_import(conn)
    conn.close()
    print(f"Hotovo: {c.files} souborů, {c.points} bodů, "
          f"{c.visits} návštěv, {c.activities} aktivit (nové záznamy).")


if __name__ == "__main__":
    main(sys.argv[1:])

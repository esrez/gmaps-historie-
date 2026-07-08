#!/usr/bin/env python3
"""Smoke test aplikace – rychlá kontrola klíčových endpointů a update balíčku.

Použití:
  python scripts/smoke_test.py
  python scripts/smoke_test.py --package dist/GMapsHistorie-update.zip
  python scripts/smoke_test.py --live http://127.0.0.1:8000
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DISABLE_BACKGROUND", "1")


def _fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def _ok(msg: str) -> None:
    print(f"OK  : {msg}")


def check_package(path: Path) -> None:
    if not path.exists():
        _fail(f"Update balík neexistuje: {path}")
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        for required in ("version.json",):
            if required not in names:
                _fail(f"V ZIP chybí {required}")
        exe = [n for n in names if n.startswith("dist/GMapsHistorie")]
        if not exe:
            _fail("V ZIP chybí dist/GMapsHistorie(.exe)")
        manifest = json.loads(zf.read("version.json").decode())
        if not manifest.get("release"):
            _fail("version.json nemá release")
    _ok(f"Update balík {path.name} (release {manifest['release']})")


def check_app_client() -> None:
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        checks = [
            ("/api/version", lambda r: "version" in r.json() and "release" in r.json()),
            ("/api/range", lambda r: "points" in r.json()),
            ("/api/update", lambda r: r.json().get("package_url") == "/api/update/package"),
            ("/api/profiles", lambda r: "profiles" in r.json()),
            ("/api/import/since", lambda r: "max_ts" in r.json()),
            ("/", lambda r: r.status_code == 200),
            ("/kniha", lambda r: r.status_code == 200),
            ("/sw.js", lambda r: r.status_code == 200 and "__VERSION__" not in r.text),
        ]
        for path, pred in checks:
            r = client.get(path)
            if r.status_code != 200 or not pred(r):
                _fail(f"{path} → {r.status_code} {r.text[:200]}")
            _ok(path)

        # update package – 404 je OK pokud balík ještě nebyl sestaven
        r = client.get("/api/update/package")
        if r.status_code == 200:
            _ok("/api/update/package (balík přítomen)")
        elif r.status_code == 404:
            _ok("/api/update/package (balík zatím chybí – OK mimo build)")
        else:
            _fail(f"/api/update/package → {r.status_code}")


def check_live(base: str) -> None:
    import urllib.request

    for path in ("/api/version", "/api/range", "/api/update"):
        url = base.rstrip("/") + path
        with urllib.request.urlopen(url, timeout=5) as r:
            body = r.read()
            if r.status != 200:
                _fail(f"{url} → HTTP {r.status}")
        _ok(f"live {path}")
        if path == "/api/update":
            meta = json.loads(body)
            if not meta.get("package_url"):
                _fail("live /api/update bez package_url")


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke test GMaps Historie")
    parser.add_argument("--package", type=Path, help="Cesta k GMapsHistorie-update.zip")
    parser.add_argument("--live", metavar="URL", help="Test běžícího serveru, např. http://127.0.0.1:8000")
    args = parser.parse_args()

    print("=== Smoke test GMaps Historie ===")
    check_app_client()

    pkg = args.package or (ROOT / "dist" / "GMapsHistorie-update.zip")
    if pkg.exists():
        check_package(pkg)
    else:
        _ok(f"Update balík {pkg.name} zatím neexistuje (přeskočeno)")

    if args.live:
        check_live(args.live)

    print("=== Vše prošlo ===")


if __name__ == "__main__":
    main()

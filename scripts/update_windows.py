#!/usr/bin/env python3
"""Jednoduchý aktualizátor Windows instalace."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

APP_DIR = Path(os.environ.get("APP_DIR", Path(__file__).resolve().parents[1]))
CURRENT = os.environ.get("APP_VERSION", "0.0.0")
UPDATE_URL = os.environ.get("UPDATE_URL", "http://127.0.0.1:8000/api/update")


def parse(v: str) -> tuple[int, ...]:
    parts = []
    for x in (v or "0").split("."):
        try:
            parts.append(int(x))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def _resolve_url(base: str, path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        return path
    root = base.rsplit("/api/", 1)[0]
    return urllib.parse.urljoin(root + "/", path.lstrip("/"))


def main() -> int:
    try:
        with urllib.request.urlopen(UPDATE_URL, timeout=10) as r:
            meta = json.loads(r.read().decode())
    except Exception as exc:
        print(f"Nelze načíst metadata aktualizace: {exc}")
        return 1

    latest = meta.get("current", "0.0.0")
    if parse(latest) <= parse(CURRENT):
        print(f"Aplikace je aktuální (máte {CURRENT}, server {latest}).")
        return 0

    pkg_path = meta.get("package_url") or meta.get("download") or "/api/update/package"
    pkg_url = _resolve_url(UPDATE_URL, pkg_path)
    print(f"Stahuji aktualizaci {latest} z {pkg_url} ...")

    with tempfile.TemporaryDirectory() as td:
        zip_path = Path(td) / "update.zip"
        try:
            with urllib.request.urlopen(pkg_url, timeout=120) as r, open(zip_path, "wb") as f:
                f.write(r.read())
        except Exception as exc:
            print(f"Stažení balíku selhalo: {exc}")
            return 1

        with zipfile.ZipFile(zip_path) as zf:
            if "version.json" in zf.namelist():
                info = json.loads(zf.read("version.json"))
                print(f"Balík: release {info.get('release', '?')}")
            zf.extractall(td)

        src = Path(td) / "dist"
        if not src.exists():
            print("Balík neobsahuje složku dist/ – neočekávaná struktura.")
            return 1

        for item in src.iterdir():
            dest = APP_DIR / item.name
            if item.is_dir():
                if dest.exists():
                    shutil.rmtree(dest)
                shutil.copytree(item, dest)
            else:
                shutil.copy2(item, dest)
                print(f"Aktualizováno: {dest.name}")

        scripts_src = Path(td) / "scripts"
        if scripts_src.exists():
            scripts_dst = APP_DIR / "scripts"
            scripts_dst.mkdir(parents=True, exist_ok=True)
            for item in scripts_src.iterdir():
                shutil.copy2(item, scripts_dst / item.name)

    print(f"Hotovo – aktualizováno na {latest}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Vytvoří ZIP balík pro in-place aktualizaci Windows instalace.

Výstup:
  dist/GMapsHistorie-update.zip
  data/update/GMapsHistorie-update.zip  (pro lokální servírování přes /api/update/package)

Struktura ZIP:
  dist/GMapsHistorie.exe
  scripts/update_windows.py
  version.json
"""
from __future__ import annotations

import json
import os
import shutil
import zipfile
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"


def _find_exe() -> Path:
    for name in ("GMapsHistorie.exe", "GMapsHistorie"):
        p = DIST / name
        if p.exists():
            return p
    found = sorted(DIST.glob("GMapsHistorie*"))
    if not found:
        raise SystemExit(f"Chybí build v {DIST}. Nejdřív spusťte build-windows-exe.bat")
    return found[0]


def make_package(release: str | None = None) -> Path:
    RELEASE = release or os.environ.get("APP_VERSION")
    if not RELEASE:
        vf = ROOT / "VERSION"
        if vf.exists():
            for line in vf.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    RELEASE = line
                    break
        else:
            RELEASE = "2.0.0"
    exe = _find_exe()
    out_zip = DIST / "GMapsHistorie-update.zip"
    data_zip = ROOT / "data" / "update" / "GMapsHistorie-update.zip"
    data_zip.parent.mkdir(parents=True, exist_ok=True)

    manifest = {
        "release": RELEASE,
        "built_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "files": [f"dist/{exe.name}"],
    }
    updater = ROOT / "scripts" / "update_windows.py"

    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(exe, f"dist/{exe.name}")
        if updater.exists():
            zf.write(updater, "scripts/update_windows.py")
        zf.writestr("version.json", json.dumps(manifest, indent=2, ensure_ascii=False))

    shutil.copy2(out_zip, data_zip)
    print(f"Vytvořeno: {out_zip} ({out_zip.stat().st_size // 1024} KB)")
    print(f"Zkopírováno: {data_zip}")
    return out_zip


if __name__ == "__main__":
    make_package()

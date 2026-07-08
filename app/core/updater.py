"""Aktualizace Windows instalace (vestavěná v .exe i CLI skript)."""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import urllib.parse
import urllib.request
import zipfile
from configparser import ConfigParser
from pathlib import Path


def parse_version(v: str) -> tuple[int, ...]:
    parts: list[int] = []
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


def install_ini_path(app_dir: Path | None = None) -> Path:
    if app_dir is None:
        app_dir = Path(os.environ.get("APP_DIR", Path(__file__).resolve().parents[2]))
    return app_dir / "version.ini"


def read_install_config(app_dir: Path | None = None) -> dict[str, str]:
    path = install_ini_path(app_dir)
    cfg = ConfigParser()
    if path.exists():
        cfg.read(path, encoding="utf-8")
    sec = cfg["install"] if cfg.has_section("install") else {}
    return {
        "version": sec.get("version", os.environ.get("APP_VERSION", "0.0.0")),
        "update_url": sec.get("update_url", os.environ.get(
            "UPDATE_URL", "http://127.0.0.1:8000/api/update")),
    }


def write_install_config(version: str, update_url: str = "",
                         app_dir: Path | None = None) -> None:
    path = install_ini_path(app_dir)
    cfg = ConfigParser()
    cfg["install"] = {"version": version}
    if update_url:
        cfg["install"]["update_url"] = update_url
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        cfg.write(f)


def apply_update_zip(zip_path: Path, app_dir: Path) -> list[str]:
    """Rozbalí ověřený ZIP a přepíše soubory v instalační složce."""
    updated: list[str] = []
    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
        if "version.json" not in names:
            raise ValueError("Balík neobsahuje version.json")
        exe_members = [n for n in names if n.replace("\\", "/") == "dist/GMapsHistorie.exe"]
        if not exe_members:
            raise ValueError("Balík neobsahuje dist/GMapsHistorie.exe")
        zf.extractall(zip_path.parent)
    root = zip_path.parent
    exe_src = root / "dist" / "GMapsHistorie.exe"
    if not exe_src.exists():
        raise ValueError("Rozbalený balík je poškozený")
    dest_exe = app_dir / "GMapsHistorie.exe"
    backup_dir = app_dir / "backups"
    backup_dir.mkdir(exist_ok=True)
    if dest_exe.exists():
        shutil.copy2(dest_exe, backup_dir / f"GMapsHistorie-{read_install_config(app_dir)['version']}.exe.bak")
    shutil.copy2(exe_src, dest_exe)
    updated.append(dest_exe.name)
    scripts_src = root / "scripts"
    if scripts_src.exists():
        scripts_dst = app_dir / "scripts"
        scripts_dst.mkdir(parents=True, exist_ok=True)
        for item in scripts_src.iterdir():
            if item.name.endswith(".py"):
                shutil.copy2(item, scripts_dst / item.name)
                updated.append(f"scripts/{item.name}")
    manifest = json.loads((root / "version.json").read_text(encoding="utf-8"))
    new_ver = manifest.get("release", read_install_config(app_dir)["version"])
    cfg = read_install_config(app_dir)
    write_install_config(str(new_ver), cfg.get("update_url", ""), app_dir)
    return updated


def run_update(app_dir: Path | None = None, *,
               update_url: str | None = None,
               current_version: str | None = None,
               quiet: bool = False) -> int:
    """Stáhne a nainstaluje aktualizaci. Vrací 0 = OK, 1 = chyba, 2 = již aktuální."""
    app_dir = app_dir or Path(os.environ.get("APP_DIR", Path(__file__).resolve().parents[2]))
    cfg = read_install_config(app_dir)
    current = current_version or cfg["version"]
    log = (lambda m: None) if quiet else print
    url = (update_url or cfg["update_url"] or "").strip()
    if not url:
        log("Adresa aktualizací není nastavena (soubor version.ini v instalační složce).")
        return 1

    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            meta = json.loads(r.read().decode())
    except Exception as exc:
        log(f"Nelze načíst informace o aktualizaci: {exc}")
        return 1

    latest = meta.get("current", "0.0.0")
    if parse_version(latest) <= parse_version(current):
        log(f"Aplikace je aktuální (verze {current}).")
        return 2

    pkg_path = meta.get("package_url") or meta.get("download") or "/api/update/package"
    pkg_url = _resolve_url(url, pkg_path)
    log(f"Stahuji verzi {latest}…")

    with tempfile.TemporaryDirectory() as td:
        zip_path = Path(td) / "update.zip"
        try:
            with urllib.request.urlopen(pkg_url, timeout=180) as r, zip_path.open("wb") as f:
                shutil.copyfileobj(r, f)
        except Exception as exc:
            log(f"Stažení aktualizace selhalo: {exc}")
            return 1
        try:
            files = apply_update_zip(zip_path, app_dir)
        except Exception as exc:
            log(f"Instalace aktualizace selhala: {exc}")
            return 1

    log(f"Aktualizace dokončena (verze {latest}).")
    for name in files:
        log(f"  • {name}")
    return 0

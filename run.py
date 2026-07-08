#!/usr/bin/env python3
"""Spuštění GMaps Historie bez Dockeru (Windows / Linux / macOS).

Nastartuje webový server a (volitelně) otevře prohlížeč. Data se ukládají do
složky ./data vedle tohoto souboru. Nastavení přes proměnné prostředí:

  HOST           adresa naslouchání (výchozí 127.0.0.1 = jen tento počítač;
                 pro přístup z domácí sítě nastavte 0.0.0.0)
  PORT           port (výchozí 8000)
  OPEN_BROWSER   1 = po startu otevřít prohlížeč (výchozí zapnuto)
  DB_PATH        umístění databáze (výchozí data/history.db)
  TZ             časové pásmo (výchozí Europe/Prague)
  AUTH_PASSWORD  když je nastaveno, aplikace vyžaduje heslo (HTTP Basic)

Příklady:
  python run.py                      # lokálně, otevře prohlížeč
  set HOST=0.0.0.0 && python run.py  # dostupné v domácí síti (Windows)
"""
from __future__ import annotations

import os
import sys
import threading
import webbrowser

# Pracovní adresář: u .exe (PyInstaller) vedle spustitelného souboru, jinak
# adresář projektu – aby relativní cesty seděly.
if getattr(sys, "frozen", False):
    _EXE_DIR = os.path.dirname(sys.executable)
    os.chdir(_EXE_DIR)
    if not os.environ.get("DATA_DIR"):
        _local = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        _data = os.path.join(_local, "GMapsHistorie", "data")
        os.makedirs(_data, exist_ok=True)
        os.environ["DATA_DIR"] = _data
    os.environ.setdefault("APP_DIR", _EXE_DIR)
else:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
OPEN_BROWSER = os.environ.get("OPEN_BROWSER", "1") != "0"


def _open_browser_later() -> None:
    import contextlib
    import time
    time.sleep(1.5)
    url = f"http://{'127.0.0.1' if HOST in ('0.0.0.0', '::') else HOST}:{PORT}/"
    with contextlib.suppress(Exception):
        webbrowser.open(url)


def main() -> None:
    if "--update" in sys.argv or "--check-update" in sys.argv:
        from pathlib import Path

        from app.core.updater import run_update
        code = run_update(Path(os.environ.get("APP_DIR", os.getcwd())))
        if "--check-update" in sys.argv and code == 2:
            sys.exit(0)
        sys.exit(0 if code in (0, 2) else 1)

    try:
        # předáváme přímo objekt aplikace (ne řetězec) – funguje i v .exe,
        # kde uvicorn neumí spolehlivě importovat modul podle jména
        import uvicorn

        from app.main import app
    except ModuleNotFoundError:
        sys.exit("Chybí závislosti. Spusťte: python -m pip install -r requirements.txt")

    if OPEN_BROWSER and "--no-browser" not in sys.argv:
        threading.Thread(target=_open_browser_later, daemon=True).start()

    print(f"GMaps Historie běží na http://{HOST}:{PORT}  (Ctrl+C ukončí)")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()

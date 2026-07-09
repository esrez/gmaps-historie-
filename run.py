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

# běží jako desktopová aplikace → povolí tlačítko „Ukončit aplikaci"
os.environ.setdefault("DESKTOP_APP", "1")

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
OPEN_BROWSER = os.environ.get("OPEN_BROWSER", "1") != "0"

_win_console_handler = None   # držet referenci, ať ji GC neuklidí


def _install_win_console_handler() -> None:
    """Na Windows: zavření okna konzole (křížek), odhlášení či vypnutí systému
    aplikaci korektně ukončí (jinak by mohla zůstat běžet na pozadí)."""
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes

        handler_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)

        def _handler(ctrl_type):        # 2=CLOSE, 5=LOGOFF, 6=SHUTDOWN
            if ctrl_type in (2, 5, 6):
                os._exit(0)
            return False                # C/BREAK → nechá zpracovat uvicorn (SIGINT)

        global _win_console_handler
        _win_console_handler = handler_type(_handler)
        ctypes.windll.kernel32.SetConsoleCtrlHandler(_win_console_handler, True)
    except Exception:
        pass


def _app_url() -> str:
    host = "127.0.0.1" if HOST in ("0.0.0.0", "::") else HOST
    return f"http://{host}:{PORT}/"


def _open_browser_later() -> None:
    import contextlib
    import time
    time.sleep(1.5)
    with contextlib.suppress(Exception):
        webbrowser.open(_app_url())


def _already_running() -> bool:
    """Zjistí, zda už na daném portu běží tato aplikace (jedna instance)."""
    import json
    import urllib.request
    try:
        with urllib.request.urlopen(_app_url() + "api/version", timeout=1.5) as r:
            json.loads(r.read().decode("utf-8"))   # ověří, že je to náš server
            return True
    except Exception:
        return False


def main() -> None:
    if "--update" in sys.argv or "--check-update" in sys.argv:
        from pathlib import Path

        from app.core.updater import run_update
        code = run_update(Path(os.environ.get("APP_DIR", os.getcwd())))
        if "--check-update" in sys.argv and code == 2:
            sys.exit(0)
        sys.exit(0 if code in (0, 2) else 1)

    # jedna instance: pokud už aplikace běží, jen otevřít prohlížeč a skončit
    if _already_running():
        print("GMaps Historie už běží – otevírám ji v prohlížeči.")
        if OPEN_BROWSER and "--no-browser" not in sys.argv:
            import contextlib
            with contextlib.suppress(Exception):
                webbrowser.open(_app_url())
        return

    try:
        # předáváme přímo objekt aplikace (ne řetězec) – funguje i v .exe,
        # kde uvicorn neumí spolehlivě importovat modul podle jména
        import uvicorn

        from app.main import app
    except ModuleNotFoundError:
        sys.exit("Chybí závislosti. Spusťte: python -m pip install -r requirements.txt")

    if OPEN_BROWSER and "--no-browser" not in sys.argv:
        threading.Thread(target=_open_browser_later, daemon=True).start()

    # explicitní server, ať ho jde zastavit z aplikace (tlačítko „Ukončit")
    from app.core import runtime
    config = uvicorn.Config(app, host=HOST, port=PORT, log_level="info")
    server = uvicorn.Server(config)
    runtime.set_server(server)
    _install_win_console_handler()

    print(f"GMaps Historie běží na http://{HOST}:{PORT}")
    print("Ukonceni: tlacitko Ukoncit aplikaci v Nastrojich, Ctrl+C, nebo zavreni okna.")
    try:
        server.run()
    except OSError as exc:
        # port obsazený jinou aplikací
        sys.exit(f"Port {PORT} je obsazený jinou aplikací ({exc}). "
                 f"Nastavte jiný přes PORT=… nebo tu aplikaci ukončete.")


if __name__ == "__main__":
    main()

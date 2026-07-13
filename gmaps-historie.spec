# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec – zabalí GMaps Historie do jednoho spustitelného souboru.

Build (na Windows vznikne GMapsHistorie.exe, na Linux/macOS binárka):
    pip install pyinstaller
    pyinstaller gmaps-historie.spec

Výsledek je v dist/. Uživatel jen spustí GMapsHistorie(.exe) – nepotřebuje
Python ani nic instalovat; data se ukládají do složky data/ vedle programu.
"""
from PyInstaller.utils.hooks import collect_all, collect_submodules

# frontend (HTML/JS/CSS/ikony/vendor) + soubor VERSION (číslo vydání pro
# /api/version a aktualizátor – bez něj by exe hlásilo výchozí verzi)
datas = [("app/static", "app/static"), ("VERSION", ".")]
binaries = []
hiddenimports = collect_submodules("uvicorn")
hiddenimports += collect_submodules("app")

# balíčky s datovými soubory / dynamickými importy – přibalit kompletně
for pkg in ("uvicorn", "reportlab", "openpyxl", "ijson", "tzdata", "anyio"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# tray ikona (jen Windows; při buildu na jiné platformě balíčky chybí)
for pkg in ("pystray", "PIL"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

a = Analysis(
    ["run.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "pytest", "playwright"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="GMapsHistorie",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,         # bez konzole – běží z ikony v systémové liště,
                           # výpisy jdou do data/logs/app.log
    disable_windowed_traceback=False,
    icon="app/static/icon.ico" if __import__("os").path.exists("app/static/icon.ico") else None,
)

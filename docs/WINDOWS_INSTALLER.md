# Windows instalátor a aktualizace

## Co je nově

- `build-windows-installer.bat` sestaví `.exe`, update ZIP a instalační balíček.
- `installer.iss` (Inno Setup) vytvoří instalátor `GMapsHistorie-Setup.exe`.
- `scripts/make_update_package.py` automaticky vytvoří `GMapsHistorie-update.zip`.
- `scripts/update_windows.py` provede in-place aktualizaci z `/api/update`.
- `scripts/smoke_test.py` rychle ověří API a strukturu update balíčku.

## Build (Windows)

1. Nainstalujte [Inno Setup 6](https://jrsoftware.org/isinfo.php) (obsahuje `iscc`).
2. Spusťte:

```bat
build-windows-installer.bat
```

Výstup v `dist/`:
- `GMapsHistorie.exe` – spustitelná aplikace
- `GMapsHistorie-update.zip` – balík pro aktualizaci
- `GMapsHistorie-Setup.exe` – instalační program

Navíc se vytvoří `data/update/GMapsHistorie-update.zip` pro lokální servírování přes API.

## Smoke test po buildu

```bat
python scripts\smoke_test.py --package dist\GMapsHistorie-update.zip
```

Nebo jen API (bez Windows exe):

```bat
python scripts\smoke_test.py
```

Proti běžícímu serveru:

```bat
python scripts\smoke_test.py --live http://127.0.0.1:8000
```

## Aktualizace instalace

1. Umístěte nový `GMapsHistorie-update.zip` do `data/update/` na serveru.
2. Spusťte updater (z instalované složky):

```bat
set APP_VERSION=1.9.0
set UPDATE_URL=http://127.0.0.1:8000/api/update
python scripts\update_windows.py
```

Updater:
- načte `/api/update` a porovná verze,
- stáhne `/api/update/package`,
- přepíše `GMapsHistorie.exe` a updater skript.

## Verze

Číslo vydání je v souboru `VERSION` (aktuálně 2.0.0). Build ho použije automaticky;
lze přepsat proměnnou `APP_VERSION`.

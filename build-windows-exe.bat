@echo off
rem === Sestaveni GMapsHistorie.exe (jeden soubor, bez potreby Pythonu u uzivatele) ===
rem Spustte na Windows s nainstalovanym Pythonem. Vysledek: dist\GMapsHistorie.exe
setlocal
cd /d "%~dp0"

rem GitHub Actions: setup-python prida python 3.12 do PATH; py launcher muze vybrat jinou verzi
if defined GITHUB_ACTIONS (
  set "PY=python"
) else (
  where py >nul 2>nul && (set "PY=py") || (set "PY=python")
)
set PYTHONUTF8=1

if not exist ".venv-build\Scripts\python.exe" (
  echo Vytvarim build prostredi...
  %PY% -m venv .venv-build || (echo Nepodarilo se vytvorit venv. & if not defined BUILD_NO_PAUSE pause & exit /b 1)
)
call ".venv-build\Scripts\activate.bat"
python -m pip install --upgrade pip >nul
echo Instaluji zavislosti a PyInstaller...
python -m pip install -r requirements.txt pyinstaller || (echo Instalace selhala. & if not defined BUILD_NO_PAUSE pause & exit /b 1)

echo Sestavuji GMapsHistorie.exe ...
pyinstaller --clean --noconfirm gmaps-historie.spec || (echo Build selhal. & if not defined BUILD_NO_PAUSE pause & exit /b 1)

echo Vytvarim update balik...
python scripts\make_update_package.py || (echo Update balik selhal. & if not defined BUILD_NO_PAUSE pause & exit /b 1)

echo.
echo Hotovo:
echo   dist\GMapsHistorie.exe
echo   dist\GMapsHistorie-update.zip
echo   data\update\GMapsHistorie-update.zip
echo (Prvni spusteni chvili trva - rozbaluje se do docasne slozky.)
if not defined BUILD_NO_PAUSE pause

@echo off
rem === Sestaveni GMapsHistorie.exe (jeden soubor, bez potreby Pythonu u uzivatele) ===
rem Spustte na Windows s nainstalovanym Pythonem. Vysledek: dist\GMapsHistorie.exe
setlocal
cd /d "%~dp0"

where py >nul 2>nul && (set "PY=py") || (set "PY=python")

if not exist ".venv-build\Scripts\python.exe" (
  echo Vytvarim build prostredi...
  %PY% -m venv .venv-build || (echo Nepodarilo se vytvorit venv. & pause & exit /b 1)
)
call ".venv-build\Scripts\activate.bat"
python -m pip install --upgrade pip >nul
echo Instaluji zavislosti a PyInstaller...
python -m pip install -r requirements.txt pyinstaller || (echo Instalace selhala. & pause & exit /b 1)

echo Sestavuji GMapsHistorie.exe ...
pyinstaller --clean --noconfirm gmaps-historie.spec || (echo Build selhal. & pause & exit /b 1)

echo.
echo Hotovo. Spustitelny soubor najdete zde:  dist\GMapsHistorie.exe
echo (Prvni spusteni chvili trva - rozbaluje se do docasne slozky.)
pause

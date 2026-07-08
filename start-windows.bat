@echo off
rem === GMaps Historie - spusteni na Windows bez Dockeru ===
rem Pri prvnim spusteni vytvori virtualni prostredi a nainstaluje zavislosti,
rem pak uz jen nastartuje aplikaci a otevre prohlizec. Data zustavaji ve .\data.
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem najit Python (nejdriv launcher "py", jinak "python")
where py >nul 2>nul && (set "PY=py") || (set "PY=python")
%PY% --version >nul 2>nul
if errorlevel 1 (
  echo Nenasel jsem Python. Nainstalujte Python 3.11+ z https://www.python.org/downloads/
  echo Pri instalaci zaskrtnete "Add python.exe to PATH".
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/3] Vytvarim prostredi (jednorazove, chvili to potrva)...
  %PY% -m venv .venv || (echo Nepodarilo se vytvorit venv. & pause & exit /b 1)
  call ".venv\Scripts\activate.bat"
  echo [2/3] Instaluji zavislosti...
  python -m pip install --upgrade pip >nul
  python -m pip install -r requirements.txt || (echo Instalace selhala. & pause & exit /b 1)
) else (
  call ".venv\Scripts\activate.bat"
)

echo [3/3] Spoustim GMaps Historie...
set "OPEN_BROWSER=1"
rem Pro pristup z domaci site odkomentujte nasledujici radek:
rem set "HOST=0.0.0.0"
python run.py
pause

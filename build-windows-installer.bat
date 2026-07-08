@echo off
setlocal
cd /d "%~dp0"

call build-windows-exe.bat || exit /b 1

where iscc >nul 2>nul
if errorlevel 1 (
  echo Chybi Inno Setup (iscc). Nainstalujte Inno Setup 6.
  exit /b 1
)

iscc installer.iss || exit /b 1

echo.
echo Hotovo:
echo   dist\GMapsHistorie.exe
echo   dist\GMapsHistorie-update.zip
echo   dist\GMapsHistorie-Setup.exe
echo.
echo Smoke test (volitelne):
echo   python scripts\smoke_test.py --package dist\GMapsHistorie-update.zip

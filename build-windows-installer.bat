@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist VERSION (
  echo Chybi soubor VERSION.
  exit /b 1
)
set "APPVER="
for /f "usebackq delims=" %%v in ("VERSION") do set "APPVER=%%v"
if not defined APPVER (
  echo Soubor VERSION je prazdny.
  exit /b 1
)

echo Verze instalatoru: %APPVER%
echo.

set BUILD_NO_PAUSE=1
call build-windows-exe.bat || exit /b 1

where iscc >nul 2>nul
if errorlevel 1 (
  echo.
  echo Chybi Inno Setup 6. Stahnete z: https://jrsoftware.org/isinfo.php
  echo Po instalaci pridejte iscc.exe do PATH.
  exit /b 1
)

echo Sestavuji instalator...
iscc /DAppVersion=%APPVER% installer.iss || exit /b 1

echo.
echo ========================================
echo  HOTOVO - soubory v dist\
echo ========================================
echo   GMapsHistorie-Setup-%APPVER%.exe   ^(instalator pro Windows 11^)
echo   GMapsHistorie.exe
echo   GMapsHistorie-update.zip            ^(balik pro aktualizaci^)
echo.
echo Instalator:
echo   - cestina, pruvodce krok za krokem
echo   - data v %%LOCALAPPDATA%%\GMapsHistorie
echo   - vestavena aktualizace ^(GMapsHistorie.exe --update^)
echo.
echo Smoke test:
echo   python scripts\smoke_test.py --package dist\GMapsHistorie-update.zip
echo.
if not defined GITHUB_ACTIONS if not defined BUILD_NO_PAUSE pause

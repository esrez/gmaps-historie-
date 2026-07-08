@echo off
REM Vytvori update ZIP z existujiciho dist\GMapsHistorie.exe (bez full rebuild)
cd /d "%~dp0"
if not exist dist\GMapsHistorie.exe (
  echo Chybi dist\GMapsHistorie.exe - nejdriv spustte build-windows-exe.bat
  pause
  exit /b 1
)
python scripts\make_update_package.py || exit /b 1
python scripts\smoke_test.py --package dist\GMapsHistorie-update.zip
pause

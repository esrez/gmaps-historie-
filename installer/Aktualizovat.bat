@echo off
REM Aktualizace GMaps Historie (vestavena v .exe – nepotrebuje Python)
cd /d "%~dp0"
echo Kontroluji aktualizace GMaps Historie...
GMapsHistorie.exe --update
echo.
pause

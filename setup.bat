@echo off
REM Lives next to eql-gearbot-plus-source. Double-click to build a deploy zip from
REM eql-gearbot-plus-source (read-only source) into a fresh FOR_UPLOAD folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
echo.
echo Done. Press any key to close this window.
pause >nul

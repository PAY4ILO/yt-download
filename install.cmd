@echo off
rem Double-click wrapper: .ps1 files open in Notepad by default.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause

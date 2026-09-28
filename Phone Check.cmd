@echo off
rem Checks why a phone can't reach ScrewShop. Writes data\phone-check.txt (safe to share with Claude).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\phone_doctor.ps1"
echo.
echo Results saved to data\phone-check.txt
pause

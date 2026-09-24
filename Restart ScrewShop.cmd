@echo off
rem Restart ScrewShop's background service so code updates take effect, then open the studio.
cd /d "%~dp0"
echo Stopping ScrewShop service...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*ScrewShop*local_server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 2 /nobreak >nul
echo Starting ScrewShop...
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\launch.ps1"

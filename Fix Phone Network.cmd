@echo off
rem One-time: lets your iPhone reach ScrewShop on home Wi-Fi only. Windows will ask for admin permission.
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File \"%~dp0scripts\fix_phone_network.ps1\"'"

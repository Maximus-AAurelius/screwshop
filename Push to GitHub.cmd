@echo off
rem Push ScrewShop commits to GitHub (github.com/Maximus-AAurelius/screwshop).
cd /d "%~dp0"
git push origin main
if errorlevel 1 (echo. & echo Push failed - copy the message above and send it to Claude.) else (echo. & echo DONE: https://github.com/Maximus-AAurelius/screwshop)
pause

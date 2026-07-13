@echo off
rem Starts the ATC Production Planner server (hidden). Runs at Windows logon
rem via a shortcut in shell:startup. If the build is missing, rebuild first.
rem Also takes a backup on every logon (plus the daily 12:00 scheduled one).
cd /d D:\SYS\prod-planner
if not exist ".next\BUILD_ID" call npm run build >nul 2>&1
start "" /min cmd /c "npm run start >nul 2>&1"
start "" /min cmd /c "D:\SYS\prod-planner\backup.cmd"

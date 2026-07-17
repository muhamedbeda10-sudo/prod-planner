@echo off
rem Starts PostgreSQL then the ATC Production Planner server (hidden).
rem Runs at Windows logon via a shortcut in shell:startup.
rem Also takes a backup on every logon (plus the daily 12:00 scheduled one).

rem 1) database first — pg_ctl status exits 0 when already running
"D:\SYS\pgsql\bin\pg_ctl.exe" status -D "D:\SYS\pgdata" >nul 2>&1
if errorlevel 1 "D:\SYS\pgsql\bin\pg_ctl.exe" -D "D:\SYS\pgdata" -l "D:\SYS\pgdata\server.log" -w start >nul 2>&1

rem 2) the app
cd /d D:\SYS\prod-planner
if not exist ".next\BUILD_ID" call npm run build >nul 2>&1
start "" /min cmd /c "npm run start >nul 2>&1"

rem 3) backup
start "" /min cmd /c "D:\SYS\prod-planner\backup.cmd"

@echo off
rem ============================================================
rem  ATC Production Planner - desktop launcher
rem  Double-click the desktop icon to open the app.
rem  1) Start PostgreSQL if it is not already running
rem  2) If the app server is already up -> just open the browser
rem  3) Rebuild only if source changed since the last build
rem  4) Start the server minimized, then open the browser
rem ============================================================
cd /d "%~dp0"

rem --- database first: pg_ctl status exits 0 when already running ---
"D:\SYS\pgsql\bin\pg_ctl.exe" status -D "D:\SYS\pgdata" >nul 2>&1
if errorlevel 1 "D:\SYS\pgsql\bin\pg_ctl.exe" -D "D:\SYS\pgdata" -l "D:\SYS\pgdata\server.log" -w start >nul 2>&1

rem --- already running? just open the browser ---
powershell -NoProfile -Command "if ((Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  start "" http://localhost:3000
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install it from https://nodejs.org then run setup.bat
  pause
  exit /b 1
)

rem --- rebuild when the build is missing OR source is newer than it ---
powershell -NoProfile -Command "$b = Get-Item '.next\BUILD_ID' -ErrorAction SilentlyContinue; if (-not $b) { exit 1 }; $s = Get-ChildItem app,components,lib,prisma,package.json -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($s -and $s.LastWriteTime -gt $b.LastWriteTime) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  echo Build missing or source changed - rebuilding to get the latest version...
  call npm run build
)

rem --- never try to start on a broken/missing build: fail LOUDLY instead ---
if not exist ".next\BUILD_ID" (
  echo.
  echo [ERROR] The production build failed - the app cannot start.
  echo Read the build errors above, or run setup.bat again.
  pause
  exit /b 1
)

rem --- start the server minimized and keep it running ---
start "ATC Planner Server" /min cmd /c "npm run start >nul 2>&1"

rem --- wait until it responds, then open the browser ---
powershell -NoProfile -Command "for ($i=0; $i -lt 30; $i++) { try { Invoke-WebRequest 'http://localhost:3000' -UseBasicParsing -TimeoutSec 3 | Out-Null; exit 0 } catch { Start-Sleep -Seconds 2 } }; exit 1"
if errorlevel 1 (
  echo [WARN] The server did not answer within 60s - check the "ATC Planner Server" window.
  pause
  exit /b 1
)
start "" http://localhost:3000
exit /b 0

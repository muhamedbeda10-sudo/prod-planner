@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   ATC Production Planner
echo   URL:  http://localhost:3000
echo   (keep this window open while working)
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install it from https://nodejs.org then run setup.bat first.
  pause
  exit /b 1
)

rem A folder called .next is not enough — a valid build has BUILD_ID inside it.
if not exist ".next\BUILD_ID" (
  echo No valid production build found - building now ^(1-2 minutes^)...
  call npm run build
)
if not exist ".next\BUILD_ID" (
  echo.
  echo [ERROR] Build failed - see the messages above. Fix and try again.
  pause
  exit /b 1
)

start "" http://localhost:3000
call npm run start
pause

@echo off
REM ============================================================
REM FlowAccess — local server start/restart (port 5500)
REM Manual use: scripts\start-server.bat
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0.."

set "PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5500" ^| findstr /I LISTENING') do set "PID=%%P"

if defined PID (
  echo Purana server band kiya, pid !PID!
  taskkill /F /PID !PID! >nul 2>&1
) else (
  echo Koi purana server nahi chal raha tha.
)

echo Server start ho raha hai: http://localhost:5500
start "FlowAccess Server" /min python -m http.server 5500
echo Ho gaya.
echo Website: http://localhost:5500/website/index.html
echo Admin:   http://localhost:5500/admin/index.html

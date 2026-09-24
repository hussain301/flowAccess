@echo off
REM ============================================================
REM FlowAccess — local server start/restart (port 5500)
REM Manual use: scripts\start-server.bat
REM ============================================================
cd /d "%~dp0.."

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5500" ^| findstr /i "LISTENING"') do (
  echo Purana server band kar raha hoon (pid %%a)...
  taskkill /F /PID %%a >nul 2>&1
)

echo Server start ho raha hai: http://localhost:5500
start "FlowAccess Server" /min python -m http.server 5500
echo Ho gaya! Website: http://localhost:5500/website/index.html
echo          Admin:   http://localhost:5500/admin/index.html

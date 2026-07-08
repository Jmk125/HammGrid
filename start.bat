@echo off
setlocal

set "NODE_DIR=C:\Users\hc.62\Documents\Tools\node"
set "PATH=%NODE_DIR%;%PATH%"

cd /d "%~dp0"

echo Starting Drawing App server (Ctrl+C to stop)...
echo.

node src\server.js

echo.
echo Server stopped.
pause

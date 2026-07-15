@echo off
REM ===== JobPilot Desktop — one-double-click launcher (Windows) =====
REM Double-click this file to start JobPilot Desktop. First run installs what it needs
REM and asks for your connect code once; after that it just opens and runs.

cd /d "%~dp0"
title JobPilot Desktop

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Get it once from https://nodejs.org  ^(the "LTS" button^),
  echo   install it, then double-click this file again.
  echo.
  pause
  exit /b
)

if not exist "node_modules" (
  echo   First-time setup: installing JobPilot Desktop ^(one minute^)...
  call npm install
)

node src/index.js
echo.
echo   JobPilot Desktop stopped. Close this window or run it again to reconnect.
pause

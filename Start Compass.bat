@echo off
title Compass
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed. Download the LTS version from https://nodejs.org
  echo  install it, then double-click this file again.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)
if not exist ".env" copy ".env.example" ".env" >nul
set PORT=3000
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" if not "%%b"=="" set PORT=%%b
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
node server.js
echo.
pause

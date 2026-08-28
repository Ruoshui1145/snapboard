@echo off
setlocal
title SnapBoard Studio

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Install Node.js 18 or newer first.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo Installing dependencies for the first run...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:5173/design; exit 0 } catch { exit 1 }"
if not errorlevel 1 goto :open

echo Starting the SnapBoard development server...
start "SnapBoard Dev Server" /D "%~dp0" cmd /k "npm run dev -- --host 127.0.0.1"

echo Waiting for SnapBoard to become ready (up to 45 seconds)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ready=$false; for($i=0;$i -lt 45;$i++){ try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:5173/design; $ready=$true; break } catch { Start-Sleep -Seconds 1 } }; if($ready){ exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [ERROR] SnapBoard did not become ready within 45 seconds.
  echo Check the SnapBoard Dev Server window for details.
  pause
  exit /b 1
)

:open
start "" http://127.0.0.1:5173/design
echo SnapBoard is ready: http://127.0.0.1:5173/design
exit /b 0

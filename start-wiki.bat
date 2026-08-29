@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\react" (
  echo [SnapBoard] 首次启动，正在安装官网依赖...
  call npm install
  if errorlevel 1 goto :error
)

echo [SnapBoard] 现在只启动统一官网（官网、指南、社区、项目资料和设计器共用 5173）。
start "" "http://127.0.0.1:5173/"
cd /d "%~dp0"
call npm run dev
exit /b 0

:error
echo.
echo [SnapBoard] 官网启动失败，请确认 Node.js 和网络连接。
pause
exit /b 1

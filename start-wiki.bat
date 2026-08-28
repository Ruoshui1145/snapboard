@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\@docusaurus\core" (
  echo [SnapBoard] 首次启动，正在安装 Wiki 依赖...
  call npm install
  if errorlevel 1 goto :error
)

start "" "http://127.0.0.1:3000/"
cd /d "%~dp0apps\wiki"
call npx docusaurus start --host 127.0.0.1 --port 3000
exit /b 0

:error
echo.
echo [SnapBoard] Wiki 启动失败，请确认 Node.js 和网络连接。
pause
exit /b 1

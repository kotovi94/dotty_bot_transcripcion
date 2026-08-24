@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-dotty.ps1"
if errorlevel 1 (
  echo.
  echo Dotty no pudo iniciarse. Revisa el mensaje anterior.
  pause
)
endlocal

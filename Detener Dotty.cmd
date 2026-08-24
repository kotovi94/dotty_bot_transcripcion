@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-dotty.ps1"
if errorlevel 1 (
  echo.
  echo No se pudo detener Dotty completamente. Revisa el mensaje anterior.
)
pause
endlocal

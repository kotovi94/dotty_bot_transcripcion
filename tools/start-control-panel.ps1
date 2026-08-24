$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$electronPath = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
$applicationPath = Join-Path $projectRoot "apps\control-panel\dist\main\main\main.js"

if (-not (Test-Path -LiteralPath $electronPath) -or -not (Test-Path -LiteralPath $applicationPath)) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "El nuevo panel de Dotty todavia no esta preparado. Ejecuta npm install y npm run panel:build desde la carpeta del proyecto.",
    "Dotty - Falta preparar el panel",
    "OK",
    "Warning"
  ) | Out-Null
  exit 1
}

Start-Process `
  -FilePath $electronPath `
  -ArgumentList @("`"$applicationPath`"") `
  -WorkingDirectory $projectRoot

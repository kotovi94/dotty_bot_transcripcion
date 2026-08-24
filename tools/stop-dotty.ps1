$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$stopped = 0
$environmentPath = Join-Path $projectRoot ".env"
$configuredDataDirectory = "./data"
if (Test-Path -LiteralPath $environmentPath) {
  foreach ($environmentLine in Get-Content -LiteralPath $environmentPath) {
    if ($environmentLine -match '^DOTTY_DATA_DIR=(.*)$') { $configuredDataDirectory = $Matches[1].Trim() }
  }
}
$dataDirectory = if ([System.IO.Path]::IsPathRooted($configuredDataDirectory)) { $configuredDataDirectory } else { Join-Path $projectRoot $configuredDataDirectory }
$stopLogPath = Join-Path $dataDirectory "shutdown.log"
$botStatusPath = Join-Path $dataDirectory "dotty.status.json"

function Write-LogLine([string]$path, [string]$message) {
  Add-Content -LiteralPath $path -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message) -Encoding UTF8
}

Write-Host ""
Write-Host "Deteniendo Dotty..." -ForegroundColor Cyan
Write-LogLine $stopLogPath "Deteniendo Dotty"

$servicePids = @()
if (Test-Path -LiteralPath $botStatusPath) {
  try {
    $statusPid = (Get-Content -LiteralPath $botStatusPath -Raw | ConvertFrom-Json).pid
    if ($statusPid -as [int]) { $servicePids += [int]$statusPid }
  } catch {
    # El archivo de PID sigue siendo el respaldo.
  }
}

foreach ($pidFile in @("dotty.pid", "transcriber.pid", "ollama.pid")) {
  $path = Join-Path $dataDirectory $pidFile
  if (-not (Test-Path -LiteralPath $path)) { continue }
  $processId = 0
  if ([int]::TryParse((Get-Content -LiteralPath $path -Raw).Trim(), [ref]$processId)) {
    $servicePids += $processId
  }
  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}

foreach ($processId in ($servicePids | Select-Object -Unique)) {
  if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
    $stopped += 1
  }
}

# El cierre forzado del arbol de procesos no permite que Node limpie su propio
# archivo de estado. Se elimina aqui para que el panel nunca muestre un estado
# antiguo al volver a abrirse.
Remove-Item -LiteralPath $botStatusPath -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 1

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 1 | Out-Null
  Write-Warning "El transcriptor sigue respondiendo; puede haber sido iniciado por otra copia."
} catch {
  # Esperado: el servicio ya no responde.
}

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 1 | Out-Null
  Write-Warning "El motor narrativo sigue respondiendo; puede haber sido iniciado por otra copia."
} catch {
  # Esperado: el servicio ya no responde.
}

if ($stopped -eq 0) {
  Write-LogLine $stopLogPath "Dotty ya estaba apagado."
  Write-Host "Dotty ya estaba apagado." -ForegroundColor Yellow
} else {
  Write-LogLine $stopLogPath "Dotty fue detenido."
  Write-Host "[OK] Dotty fue detenido." -ForegroundColor Green
}

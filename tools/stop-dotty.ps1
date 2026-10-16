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

# The script must enforce this too: .cmd callers bypass the desktop guard.
$recordingsDirectory = Join-Path $dataDirectory "recordings"
if (Test-Path -LiteralPath $recordingsDirectory) {
  foreach ($sessionDirectory in Get-ChildItem -LiteralPath $recordingsDirectory -Directory) {
    $manifestFile = Join-Path $sessionDirectory.FullName "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestFile)) { continue }
    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    if ($manifest.status -in @("recording", "paused", "finalizing")) {
      throw "Hay una grabacion activa. Finalizala desde Discord antes de apagar Dotty."
    }
  }
}

if (Test-Path -LiteralPath $botStatusPath) {
  $status = Get-Content -LiteralPath $botStatusPath -Raw | ConvertFrom-Json
  $botProcessId = [int]$status.pid
  if (Get-Process -Id $botProcessId -ErrorAction SilentlyContinue) {
    $requestPath = Join-Path $dataDirectory "dotty.stop-request.json"
    @{ pid = $botProcessId } | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding ASCII
    $deadline = (Get-Date).AddSeconds(45)
    while ((Test-Path -LiteralPath $botStatusPath) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 250
    }
    if (Test-Path -LiteralPath $botStatusPath) {
      throw "Dotty no confirmo el cierre ordenado. No se forzara su terminacion; revisa los registros."
    }
  }
}

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
}

foreach ($processId in ($servicePids | Select-Object -Unique)) {
  if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    # Never trust a PID alone: Windows may have reused it for another program.
    $ownedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    $commandLine = [string]$ownedProcess.CommandLine
    $executablePath = [string]$ownedProcess.ExecutablePath
    if ($commandLine -notmatch 'dotty_transcriber\.main:app|ollama(?:\.exe)?["\s]+serve') {
      throw "El PID $processId no corresponde a un servicio verificable de Dotty. No se terminara."
    }
    if (-not $executablePath.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw "El PID $processId pertenece a otra instalacion. No se terminara."
    }
    & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudo detener el servicio $processId." }
    $stopped += 1
  }
}

foreach ($pidFile in @("dotty.pid", "transcriber.pid", "ollama.pid")) {
  Remove-Item -LiteralPath (Join-Path $dataDirectory $pidFile) -Force -ErrorAction SilentlyContinue
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

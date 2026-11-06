$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$setupLockPath = Join-Path $projectRoot ".setup-operation.lock"
$setupOwner = [guid]::NewGuid().ToString("N")
try {
  $setupLock = [System.IO.File]::Open($setupLockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $ownerBytes = [System.Text.Encoding]::UTF8.GetBytes($setupOwner)
    $setupLock.Write($ownerBytes, 0, $ownerBytes.Length)
    $setupLock.Flush($true)
  } finally { $setupLock.Dispose() }
} catch {
  throw "No se puede detener Dotty mientras hay una operación de configuración o un candado pendiente de revisión."
}
try {
$stopped = 0
$environmentPath = Join-Path $projectRoot ".env"
$configuredDataDirectory = "./data"
$configuredTranscriberBaseUrl = "http://127.0.0.1:8765"
if (Test-Path -LiteralPath $environmentPath) {
  foreach ($environmentLine in Get-Content -LiteralPath $environmentPath) {
    if ($environmentLine -match '^DOTTY_DATA_DIR=(.*)$') { $configuredDataDirectory = $Matches[1].Trim() }
    if ($environmentLine -match '^TRANSCRIBER_BASE_URL=(.*)$') { $configuredTranscriberBaseUrl = $Matches[1].Trim() }
  }
}
$dataDirectory = if ([System.IO.Path]::IsPathRooted($configuredDataDirectory)) { $configuredDataDirectory } else { Join-Path $projectRoot $configuredDataDirectory }
$venvConfig = Join-Path $projectRoot "services\transcriber\.venv\pyvenv.cfg"
$basePython = $null
if (Test-Path -LiteralPath $venvConfig) {
  $basePythonLine = Get-Content -LiteralPath $venvConfig | Where-Object { $_ -match '^executable\s*=' } | Select-Object -First 1
  if ($basePythonLine) { $basePython = ($basePythonLine -split '=', 2)[1].Trim() }
}
$stopLogPath = Join-Path $dataDirectory "shutdown.log"
$botStatusPath = Join-Path $dataDirectory "dotty.status.json"
$transcriberLaunchIdPath = Join-Path $dataDirectory "transcriber.launch-id"
$transcriberUri = [uri]$configuredTranscriberBaseUrl
$transcriberPort = $transcriberUri.Port

function Test-TranscriberCommand([string]$command, [int]$port) {
  return $command -match '(?i)(?:^|\s)-m\s+(?:uvicorn\s+dotty_transcriber\.main:app|dotty_transcriber\.server)(?:\s|$)' -and
    $command -match '(?i)(?:^|\s)--host\s+127\.0\.0\.1(?:\s|$)' -and
    $command -match "(?i)(?:^|\s)--port\s+$port(?:\s|$)"
}

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
    $botProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$botProcessId" -ErrorAction Stop
    $startedAt = ([datetime]$status.processStartedAt).ToUniversalTime()
    if ($status.version -ne 1 -or -not $status.instanceId -or $null -eq $botProcess -or
        [string]$botProcess.Name -notmatch '^node(\.exe)?$' -or
        [string]$botProcess.CommandLine -notmatch '(?i)(?:src[\\/])?index\.ts' -or
        [Math]::Abs((([datetime]$botProcess.CreationDate).ToUniversalTime() - $startedAt).TotalSeconds) -gt 2) {
      throw "La identidad del bot no coincide con su estado. No se enviara una solicitud de cierre."
    }
    $requestPath = Join-Path $dataDirectory "dotty.stop-request.json"
    @{ pid = $botProcessId; instanceId = [string]$status.instanceId } | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding ASCII
    $deadline = (Get-Date).AddSeconds(45)
    while ((Test-Path -LiteralPath $botStatusPath) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 250
    }
    if (Test-Path -LiteralPath $botStatusPath) {
      throw "Dotty no confirmo el cierre ordenado. No se forzara su terminacion; revisa los registros."
    }
    # The status file is removed before Node has fully exited. Wait for the
    # verified process instead of treating that brief interval as a foreign PID.
    $exitDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Process -Id $botProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $exitDeadline) {
      Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $botProcessId -ErrorAction SilentlyContinue) {
      throw "Dotty confirmo el cierre, pero su proceso sigue activo; revisa los registros."
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
$verifiedTranscriberPid = $null
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
    if ($pidFile -eq "transcriber.pid" -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
      $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq $transcriberPort })
      $ownerPid = if ($listeners.Count -gt 0) { [int]$listeners[0].OwningProcess } else { 0 }
      $health = $null
      if ($ownerPid -ne 0) {
        try {
          $health = Invoke-RestMethod -Uri "$($configuredTranscriberBaseUrl.TrimEnd('/'))/health" -TimeoutSec 2
        } catch {
          throw "El puerto del transcriptor esta ocupado pero no responde; no se terminara sin verificar su identidad."
        }
        if ($health.status -ne "ok" -or
            @($listeners | Where-Object { $_.OwningProcess -ne $ownerPid }).Count -gt 0) {
          throw "La identidad del transcriptor no coincide con el puerto; no se terminara."
        }
      }
      $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
      $venvPython = Join-Path $projectRoot "services\transcriber\.venv\Scripts\python.exe"
      if ($null -eq $owner -or -not (Test-TranscriberCommand ([string]$owner.CommandLine) $transcriberPort)) {
        throw "La identidad del transcriptor no pudo verificarse; no se terminara."
      }
      if ($ownerPid -eq 0) {
        # A failed Windows accept loop may leave Python alive with no listener.
        # Verify the exact venv parent/child pair before stopping that orphan.
        $wrapper = Get-CimInstance Win32_Process -Filter "ProcessId=$($owner.ParentProcessId)" -ErrorAction Stop
        if ($null -eq $wrapper -or
            -not [string]::Equals([string]$wrapper.ExecutablePath, $venvPython, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-TranscriberCommand ([string]$wrapper.CommandLine) $transcriberPort) -or
            ([datetime]$owner.CreationDate -lt ([datetime]$wrapper.CreationDate).AddSeconds(-2))) {
          throw "El transcriptor sin puerto no pudo verificarse; no se terminara."
        }
      } elseif (Test-Path -LiteralPath $transcriberLaunchIdPath) {
        $expectedLaunchId = (Get-Content -LiteralPath $transcriberLaunchIdPath -Raw).Trim()
        if ($expectedLaunchId -eq "" -or $health.launch_id -ne $expectedLaunchId -or
            $health.pid -ne $processId -or $ownerPid -ne $processId) {
          throw "La identidad del transcriptor no coincide con el puerto; no se terminara."
        }
      } else {
        # The old launcher stored the venv redirector PID, not its Uvicorn child.
        $wrapper = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
        $listenerOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction Stop
        if ($null -eq $wrapper -or $null -eq $owner -or
            $listenerOwner.ParentProcessId -ne $processId -or
            -not [string]::Equals([string]$wrapper.ExecutablePath, $venvPython, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-TranscriberCommand ([string]$wrapper.CommandLine) $transcriberPort) -or
            -not (Test-TranscriberCommand ([string]$listenerOwner.CommandLine) $transcriberPort) -or
            ($null -ne $health.pid -and $health.pid -ne $ownerPid)) {
          throw "La identidad heredada del transcriptor no pudo verificarse; no se terminara."
        }
      }
      $verifiedTranscriberPid = $processId
    }
    $servicePids += $processId
  }
}

foreach ($processId in ($servicePids | Select-Object -Unique)) {
  $processToStop = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -ne $processToStop) {
    # Never trust a PID alone: Windows may have reused it for another program.
    $ownedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    $commandLine = [string]$ownedProcess.CommandLine
    $executablePath = [string]$ownedProcess.ExecutablePath
    if ($commandLine -notmatch 'dotty_transcriber\.(?:main:app|server)|ollama(?:\.exe)?["\s]+serve') {
      throw "El PID $processId no corresponde a un servicio verificable de Dotty. No se terminara."
    }
    $insideProject = $executablePath.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    $matchesVenvBase = $processId -eq $verifiedTranscriberPid -and $basePython -and
      [string]::Equals($executablePath, $basePython, [StringComparison]::OrdinalIgnoreCase) -and
      $commandLine -match 'dotty_transcriber\.(?:main:app|server)'
    if (-not $insideProject -and -not $matchesVenvBase) {
      throw "El PID $processId pertenece a otra instalacion. No se terminara."
    }
    & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudo detener el servicio $processId." }
    # Wait on the original process handle: a successful taskkill invocation or
    # a later PID lookup does not prove that this process has exited.
    if (-not $processToStop.WaitForExit(15000) -or -not $processToStop.HasExited) {
      throw "El servicio $processId sigue activo tras solicitar su terminacion; se conservaran las referencias."
    }
    $stopped += 1
  }
}

foreach ($pidFile in @("dotty.pid", "transcriber.pid", "ollama.pid")) {
  Remove-Item -LiteralPath (Join-Path $dataDirectory $pidFile) -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $transcriberLaunchIdPath -Force -ErrorAction SilentlyContinue

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
} finally {
  if ((Test-Path -LiteralPath $setupLockPath) -and
      ((Get-Content -LiteralPath $setupLockPath -Raw -ErrorAction SilentlyContinue) -eq $setupOwner)) {
    Remove-Item -LiteralPath $setupLockPath -Force
  }
}

$ErrorActionPreference = "Stop"

# Start-Process de Windows PowerShell falla si el proceso padre contiene Path y
# PATH como entradas separadas. Normalizamos la variable antes de crear procesos.
$inheritedPath = [Environment]::GetEnvironmentVariable("Path", "Process")
Remove-Item Env:Path -ErrorAction SilentlyContinue
[Environment]::SetEnvironmentVariable("Path", $inheritedPath, "Process")

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
  throw "No se puede iniciar Dotty mientras hay una operación de configuración o un candado pendiente de revisión."
}
try {
$environmentPath = Join-Path $projectRoot ".env"
$configuredDataDirectory = "./data"
$configuredTranscriberBaseUrl = "http://127.0.0.1:8765"
$configuredNpm = "npm.cmd"
$configuredOllama = "./runtime/ollama/ollama.exe"
$configuredOllamaModels = "./data/models/ollama"
$configuredOllamaModel = "qwen3:4b"
if (Test-Path -LiteralPath $environmentPath) {
  foreach ($environmentLine in Get-Content -LiteralPath $environmentPath) {
    if ($environmentLine -match '^DOTTY_DATA_DIR=(.*)$') { $configuredDataDirectory = $Matches[1].Trim() }
    if ($environmentLine -match '^TRANSCRIBER_BASE_URL=(.*)$') { $configuredTranscriberBaseUrl = $Matches[1].Trim() }
    if ($environmentLine -match '^DOTTY_NPM_EXECUTABLE=(.*)$') { $configuredNpm = $Matches[1].Trim() }
    if ($environmentLine -match '^DOTTY_OLLAMA_EXECUTABLE=(.*)$') { $configuredOllama = $Matches[1].Trim() }
    if ($environmentLine -match '^OLLAMA_MODELS=(.*)$') { $configuredOllamaModels = $Matches[1].Trim() }
    if ($environmentLine -match '^OLLAMA_MODEL=(.*)$') { $configuredOllamaModel = $Matches[1].Trim() }
  }
}
$dataDirectory = if ([System.IO.Path]::IsPathRooted($configuredDataDirectory)) { $configuredDataDirectory } else { Join-Path $projectRoot $configuredDataDirectory }
$pythonPath = Join-Path $projectRoot "services\transcriber\.venv\Scripts\python.exe"
$transcriberDirectory = Join-Path $projectRoot "services\transcriber"
$transcriberStdout = Join-Path $dataDirectory "transcriber.stdout.log"
$transcriberStderr = Join-Path $dataDirectory "transcriber.stderr.log"
$botStdout = Join-Path $dataDirectory "dotty.stdout.log"
$botStderr = Join-Path $dataDirectory "dotty.stderr.log"
$startLogPath = Join-Path $dataDirectory "startup.log"
$transcriberPidPath = Join-Path $dataDirectory "transcriber.pid"
$transcriberLaunchIdPath = Join-Path $dataDirectory "transcriber.launch-id"
$botPidPath = Join-Path $dataDirectory "dotty.pid"
$botStatusPath = Join-Path $dataDirectory "dotty.status.json"
$botStartupTimeoutSeconds = 300
$transcriberUri = $null
if (-not [Uri]::TryCreate($configuredTranscriberBaseUrl, [UriKind]::Absolute, [ref]$transcriberUri) -or
    $transcriberUri.Scheme -ne "http" -or $transcriberUri.Host -ne "127.0.0.1" -or
    $transcriberUri.AbsolutePath -ne "/" -or $transcriberUri.Query -ne "" -or
    $transcriberUri.Fragment -ne "" -or $transcriberUri.UserInfo -ne "") {
  throw "TRANSCRIBER_BASE_URL debe ser http://127.0.0.1:<puerto> para el lanzador local."
}
$transcriberPort = $transcriberUri.Port
$transcriberHealthUrl = "http://127.0.0.1:$transcriberPort/health"
$ollamaExecutable = if ([System.IO.Path]::IsPathRooted($configuredOllama)) { $configuredOllama } else { Join-Path $projectRoot $configuredOllama }
$ollamaModels = if ([System.IO.Path]::IsPathRooted($configuredOllamaModels)) { $configuredOllamaModels } else { Join-Path $projectRoot $configuredOllamaModels }
$ollamaPidPath = Join-Path $dataDirectory "ollama.pid"
$ollamaStdout = Join-Path $dataDirectory "ollama.stdout.log"
$ollamaStderr = Join-Path $dataDirectory "ollama.stderr.log"

function Write-LogLine([string]$path, [string]$message) {
  Add-Content -LiteralPath $path -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message) -Encoding UTF8
}

function Test-BotRunning([datetime]$since = [datetime]::MinValue) {
  if (-not (Test-Path -LiteralPath $botStatusPath)) { return $false }
  try {
    $status = Get-Content -LiteralPath $botStatusPath -Raw | ConvertFrom-Json
    # ConvertFrom-Json may already turn the ISO timestamp into DateTime. Its
    # localized string representation is not reliably parseable again.
    $connectedAt = if ($status.connectedAt -is [datetime]) {
      [datetime]$status.connectedAt
    } else {
      [datetime]::Parse([string]$status.connectedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    }
    $botProcessId = [int]$status.pid
    if ($status.version -ne 1 -or -not $status.instanceId -or $status.status -ne "ready" -or $connectedAt.ToUniversalTime() -lt $since.ToUniversalTime() -or $botProcessId -le 0) { return $false }
    $heartbeatAt = ([datetime]$status.heartbeatAt).ToUniversalTime()
    $startedAt = ([datetime]$status.processStartedAt).ToUniversalTime()
    if ([Math]::Abs(((Get-Date).ToUniversalTime() - $heartbeatAt).TotalSeconds) -gt 7) { return $false }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$botProcessId" -ErrorAction Stop
    if ($null -eq $process -or [Math]::Abs((([datetime]$process.CreationDate).ToUniversalTime() - $startedAt).TotalSeconds) -gt 2 -or
        [string]$process.Name -notmatch '^node(\.exe)?$' -or
        [string]$process.CommandLine -notmatch '(?i)(?:src[\\/])?index\.ts') { return $false }
    Set-Content -LiteralPath $botPidPath -Value $botProcessId -Encoding ASCII
    return $true
  } catch {
    return $false
  }
}

function Test-TranscriberCommand([string]$command, [int]$port) {
  return $command -match '(?i)(?:^|\s)-m\s+uvicorn\s+dotty_transcriber\.main:app(?:\s|$)' -and
    $command -match '(?i)(?:^|\s)--host\s+127\.0\.0\.1(?:\s|$)' -and
    $command -match "(?i)(?:^|\s)--port\s+$port(?:\s|$)"
}

function Test-ExistingTranscriber([object[]]$listeners) {
  if ($listeners.Count -eq 0) { return $false }
  $ownerPid = [int]$listeners[0].OwningProcess
  if (@($listeners | Where-Object { $_.OwningProcess -ne $ownerPid }).Count -gt 0) { return $false }
  try {
    $health = Invoke-RestMethod -Uri $transcriberHealthUrl -TimeoutSec 2
    if ($health.status -ne "ok" -or ($null -ne $health.pid -and [int]$health.pid -ne $ownerPid)) { return $false }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction Stop
    if ($null -eq $owner -or -not (Test-TranscriberCommand ([string]$owner.CommandLine) $transcriberPort)) { return $false }
    if (Test-Path -LiteralPath $transcriberLaunchIdPath) {
      $expectedId = (Get-Content -LiteralPath $transcriberLaunchIdPath -Raw).Trim()
      return $expectedId -ne "" -and $health.launch_id -eq $expectedId
    }
    # Legacy launchers saved the venv redirector PID. Accept only its direct
    # Uvicorn child, with both processes running the exact local command.
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($owner.ParentProcessId)" -ErrorAction Stop
    return $null -ne $parent -and
      [string]::Equals([string]$parent.ExecutablePath, $pythonPath, [StringComparison]::OrdinalIgnoreCase) -and
      (Test-TranscriberCommand ([string]$parent.CommandLine) $transcriberPort) -and
      ([datetime]$owner.CreationDate -ge ([datetime]$parent.CreationDate).AddSeconds(-2))
  } catch {
    return $false
  }
}

Write-Host ""
Write-Host "Iniciando Dotty..." -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $environmentPath)) {
  throw "No existe el archivo .env. Configura primero las credenciales de Discord."
}

$environmentLines = Get-Content -LiteralPath $environmentPath
foreach ($key in @("DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID")) {
  $line = $environmentLines | Where-Object { $_ -like "$key=*" } | Select-Object -First 1
  if (-not $line -or $line.Length -le ($key.Length + 1)) {
    throw "Falta configurar $key en el archivo .env."
  }
}

if (-not (Test-Path -LiteralPath $pythonPath)) {
  throw "Falta el entorno del transcriptor. Ejecuta la preparacion indicada en services\transcriber\README.md."
}

# A health response alone cannot identify an existing service. Check the saved
# launch identity or the legacy venv redirector parent before reusing it.
try {
  $existingTranscriberListener = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Where-Object { $_.LocalPort -eq $transcriberPort })
} catch {
  throw "No se pudo verificar si el puerto $transcriberPort del transcriptor esta libre; no se inicio Dotty."
}
if ($existingTranscriberListener.Count -gt 0 -and -not (Test-ExistingTranscriber $existingTranscriberListener)) {
  throw "El puerto $transcriberPort del transcriptor ya esta ocupado por un proceso no verificable. No se reutilizara ni detendra."
}
$reuseTranscriber = $existingTranscriberListener.Count -gt 0

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $ollamaModels -Force | Out-Null
Write-LogLine $startLogPath "Arrancando Dotty"

$ollamaReady = $false
try {
  $ollamaHealth = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 2
  $ollamaReady = $null -ne $ollamaHealth.models
} catch {
  $ollamaReady = $false
}

if ($ollamaReady) {
  Write-Host "[OK] Motor narrativo local encendido." -ForegroundColor Green
} else {
  if (-not (Test-Path -LiteralPath $ollamaExecutable)) {
    throw "Falta el motor narrativo local en $ollamaExecutable."
  }
  $env:OLLAMA_MODELS = $ollamaModels
  $env:OLLAMA_FLASH_ATTENTION = "0"
  $env:OLLAMA_NUM_PARALLEL = "1"
  Write-LogLine $startLogPath "Iniciando Ollama en http://127.0.0.1:11434"
  Set-Content -LiteralPath $ollamaStdout -Value "" -Encoding UTF8
  Set-Content -LiteralPath $ollamaStderr -Value "" -Encoding UTF8
  $ollamaProcess = Start-Process `
    -FilePath $ollamaExecutable `
    -ArgumentList @("serve") `
    -WorkingDirectory (Split-Path -Parent $ollamaExecutable) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $ollamaStdout `
    -RedirectStandardError $ollamaStderr `
    -PassThru
  Set-Content -LiteralPath $ollamaPidPath -Value $ollamaProcess.Id -Encoding ASCII
  for ($attempt = 1; $attempt -le 30; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    try {
      $ollamaHealth = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 2
      if ($null -ne $ollamaHealth.models) { $ollamaReady = $true; break }
    } catch { $ollamaReady = $false }
  }
  if (-not $ollamaReady) {
    throw "El motor narrativo local no respondió. Revisa data\ollama.stderr.log."
  }
  Write-Host "[OK] Motor narrativo local encendido." -ForegroundColor Green
}

$ollamaModelReady = @($ollamaHealth.models | Where-Object {
  $_.name -eq $configuredOllamaModel -or $_.model -eq $configuredOllamaModel
}).Count -gt 0
if (-not $ollamaModelReady) {
  throw "Falta el modelo narrativo local $configuredOllamaModel."
}
Write-Host "[OK] Modelo narrativo $configuredOllamaModel disponible." -ForegroundColor Green

if ($reuseTranscriber) {
  Write-LogLine $startLogPath "Reutilizando transcriptor verificado en el puerto $transcriberPort"
  Write-Host "[OK] Transcriptor local ya encendido." -ForegroundColor Green
} else {
$transcriberReady = $false
Write-LogLine $startLogPath "Iniciando transcriptor en http://127.0.0.1:$transcriberPort"
try {
  Set-Content -LiteralPath $transcriberStdout -Value "" -Encoding UTF8
  Set-Content -LiteralPath $transcriberStderr -Value "" -Encoding UTF8
  $transcriberLaunchId = [guid]::NewGuid().ToString()
  $env:DOTTY_TRANSCRIBER_LAUNCH_ID = $transcriberLaunchId
  try {
    $transcriberProcess = Start-Process `
      -FilePath $pythonPath `
      -ArgumentList @("-m", "uvicorn", "dotty_transcriber.main:app", "--host", "127.0.0.1", "--port", "$transcriberPort") `
      -WorkingDirectory $transcriberDirectory `
      -WindowStyle Hidden `
      -RedirectStandardOutput $transcriberStdout `
      -RedirectStandardError $transcriberStderr `
      -PassThru
  } finally {
    Remove-Item Env:DOTTY_TRANSCRIBER_LAUNCH_ID -ErrorAction SilentlyContinue
  }
  $transcriberOwnerPid = $null

  for ($attempt = 1; $attempt -le 20; $attempt += 1) {
    try {
      $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq $transcriberPort })
    } catch {
      throw "No se pudo verificar el propietario del puerto $transcriberPort tras iniciar el transcriptor."
    }
    Start-Sleep -Milliseconds 500
    $health = $null
    try {
      $health = Invoke-RestMethod -Uri $transcriberHealthUrl -TimeoutSec 2
    } catch {
      # El servicio aun esta arrancando.
    }
    try {
      $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq $transcriberPort })
    } catch {
      throw "No se pudo verificar el propietario del puerto $transcriberPort tras consultar health."
    }
    if ($listeners.Count -gt 0 -and $null -ne $health -and ($health.status -ne "ok" -or
        $health.launch_id -ne $transcriberLaunchId -or
        $health.pid -notin @($listeners | ForEach-Object { $_.OwningProcess }) -or
        @($listeners | Where-Object { $_.OwningProcess -ne $health.pid }).Count -gt 0)) {
      throw "Otro proceso ocupo el puerto $transcriberPort durante el arranque; no se aceptara como transcriptor."
    }
    if ($health.status -eq "ok" -and $listeners.Count -gt 0) {
      $transcriberOwnerPid = [int]$listeners[0].OwningProcess
      $transcriberReady = $true
      break
    }
  }
  if (-not $transcriberReady) {
    Write-LogLine $startLogPath "El transcriptor no respondio. Revisa data/transcriber.stderr.log."
    throw "El transcriptor no respondio. Revisa data\transcriber.stderr.log."
  }
  Set-Content -LiteralPath $transcriberLaunchIdPath -Value $transcriberLaunchId -Encoding ASCII
  Set-Content -LiteralPath $transcriberPidPath -Value $transcriberOwnerPid -Encoding ASCII
  Write-Host "[OK] Transcriptor local encendido." -ForegroundColor Green
} catch {
  if ($null -ne $transcriberProcess) {
    try {
      $transcriberProcess.Refresh()
      if ($transcriberProcess.HasExited) {
        Remove-Item -LiteralPath $transcriberPidPath -Force -ErrorAction SilentlyContinue
      }
    } catch {
      # Preserve the original startup error.
    }
  }
  throw
}
}

if (Test-BotRunning) {
  Write-Host "[OK] El bot ya estaba encendido." -ForegroundColor Green
} else {
  Write-LogLine $startLogPath "Iniciando bot de Discord"
  Set-Content -LiteralPath $botStdout -Value "" -Encoding UTF8
  Set-Content -LiteralPath $botStderr -Value "" -Encoding UTF8
  $botProcess = Start-Process `
    -FilePath $configuredNpm `
    -ArgumentList @("run", "start", "-w", "@dotty/bot") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $botStdout `
    -RedirectStandardError $botStderr `
    -PassThru
  Set-Content -LiteralPath $botPidPath -Value $botProcess.Id -Encoding ASCII

  $botReady = $false
  $botLaunchedAt = Get-Date
  $botStartupAttempts = $botStartupTimeoutSeconds * 2
  for ($attempt = 1; $attempt -le $botStartupAttempts; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    if (Test-BotRunning $botLaunchedAt.AddSeconds(-2)) { $botReady = $true; break }
    if ($botProcess.HasExited) { break }
  }
  if (-not $botReady) {
    if ($botProcess.HasExited) {
      Remove-Item -LiteralPath $botPidPath -Force -ErrorAction SilentlyContinue
      Write-LogLine $startLogPath "El proceso del bot termino antes de conectarse. Revisa data/dotty.stderr.log."
      throw "El proceso del bot termino antes de conectarse a Discord. Revisa data\dotty.stderr.log."
    }
    Write-LogLine $startLogPath "El bot no confirmo su conexion en $botStartupTimeoutSeconds segundos."
    throw "El bot sigue abierto, pero no confirmo su conexion a Discord en $botStartupTimeoutSeconds segundos. Revisa tu conexion y data\dotty.stdout.log."
  }
  Write-Host "[OK] Bot conectado a Discord." -ForegroundColor Green
}

Write-LogLine $startLogPath "Dotty listo"
Write-Host ""
Write-Host "Dotty esta listo. Puedes cerrar esta ventana." -ForegroundColor Cyan
Write-Host "Para apagarlo, abre 'Detener Dotty.cmd'."
Start-Sleep -Seconds 3
} finally {
  if ((Test-Path -LiteralPath $setupLockPath) -and
      ((Get-Content -LiteralPath $setupLockPath -Raw -ErrorAction SilentlyContinue) -eq $setupOwner)) {
    Remove-Item -LiteralPath $setupLockPath -Force
  }
}

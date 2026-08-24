$ErrorActionPreference = "Stop"

# Start-Process de Windows PowerShell falla si el proceso padre contiene Path y
# PATH como entradas separadas. Normalizamos la variable antes de crear procesos.
$inheritedPath = [Environment]::GetEnvironmentVariable("Path", "Process")
Remove-Item Env:Path -ErrorAction SilentlyContinue
[Environment]::SetEnvironmentVariable("Path", $inheritedPath, "Process")

$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $projectRoot ".env"
$configuredDataDirectory = "./data"
$configuredNpm = "npm.cmd"
$configuredOllama = "./runtime/ollama/ollama.exe"
$configuredOllamaModels = "./data/models/ollama"
$configuredOllamaModel = "qwen3:4b"
if (Test-Path -LiteralPath $environmentPath) {
  foreach ($environmentLine in Get-Content -LiteralPath $environmentPath) {
    if ($environmentLine -match '^DOTTY_DATA_DIR=(.*)$') { $configuredDataDirectory = $Matches[1].Trim() }
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
$botPidPath = Join-Path $dataDirectory "dotty.pid"
$botStartupTimeoutSeconds = 300
$ollamaExecutable = if ([System.IO.Path]::IsPathRooted($configuredOllama)) { $configuredOllama } else { Join-Path $projectRoot $configuredOllama }
$ollamaModels = if ([System.IO.Path]::IsPathRooted($configuredOllamaModels)) { $configuredOllamaModels } else { Join-Path $projectRoot $configuredOllamaModels }
$ollamaPidPath = Join-Path $dataDirectory "ollama.pid"
$ollamaStdout = Join-Path $dataDirectory "ollama.stdout.log"
$ollamaStderr = Join-Path $dataDirectory "ollama.stderr.log"

function Write-LogLine([string]$path, [string]$message) {
  Add-Content -LiteralPath $path -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message) -Encoding UTF8
}

function Test-PidFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  $processId = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $path -Raw).Trim(), [ref]$processId)) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    return $false
  }
  if ($null -eq (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    return $false
  }
  return $true
}

Write-Host ""
Write-Host "Iniciando Dotty..." -ForegroundColor Cyan
Write-LogLine $startLogPath "Arrancando Dotty"

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

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $ollamaModels -Force | Out-Null

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

$transcriberReady = $false
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 2
  $transcriberReady = $health.status -eq "ok"
} catch {
  $transcriberReady = $false
}

if ($transcriberReady) {
  Write-Host "[OK] El transcriptor ya estaba encendido." -ForegroundColor Green
} else {
  Write-LogLine $startLogPath "Iniciando transcriptor en http://127.0.0.1:8765"
  Set-Content -LiteralPath $transcriberStdout -Value "" -Encoding UTF8
  Set-Content -LiteralPath $transcriberStderr -Value "" -Encoding UTF8
  $transcriberProcess = Start-Process `
    -FilePath $pythonPath `
    -ArgumentList @("-m", "uvicorn", "dotty_transcriber.main:app", "--host", "127.0.0.1", "--port", "8765") `
    -WorkingDirectory $transcriberDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $transcriberStdout `
    -RedirectStandardError $transcriberStderr `
    -PassThru
  Set-Content -LiteralPath $transcriberPidPath -Value $transcriberProcess.Id -Encoding ASCII

  for ($attempt = 1; $attempt -le 20; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 2
      if ($health.status -eq "ok") {
        $transcriberReady = $true
        break
      }
    } catch {
      # El servicio aun esta arrancando.
    }
  }
  if (-not $transcriberReady) {
    Write-LogLine $startLogPath "El transcriptor no respondio. Revisa data/transcriber.stderr.log."
    throw "El transcriptor no respondio. Revisa data\transcriber.stderr.log."
  }
  $transcriberListener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $transcriberListener) {
    Set-Content -LiteralPath $transcriberPidPath -Value $transcriberListener.OwningProcess -Encoding ASCII
  }
  Write-Host "[OK] Transcriptor local encendido." -ForegroundColor Green
}

if (Test-PidFile $botPidPath) {
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
  $botStartupAttempts = $botStartupTimeoutSeconds * 2
  for ($attempt = 1; $attempt -le $botStartupAttempts; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $botStdout) {
      $recentLog = Get-Content -LiteralPath $botStdout -Tail 30 -ErrorAction SilentlyContinue
      if ($recentLog -match "Dotty conectado a Discord") {
        $botReady = $true
        break
      }
    }
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
  if (Test-Path -LiteralPath (Join-Path $dataDirectory "dotty.status.json")) {
    try {
      $actualBotPid = (Get-Content -LiteralPath (Join-Path $dataDirectory "dotty.status.json") -Raw | ConvertFrom-Json).pid
      if ($actualBotPid -is [int] -or $actualBotPid -is [long]) {
        Set-Content -LiteralPath $botPidPath -Value $actualBotPid -Encoding ASCII
      }
    } catch {
      # El PID inicial sigue permitiendo detectar un arranque incompleto.
    }
  }
  Write-Host "[OK] Bot conectado a Discord." -ForegroundColor Green
}

Write-LogLine $startLogPath "Dotty listo"
Write-Host ""
Write-Host "Dotty esta listo. Puedes cerrar esta ventana." -ForegroundColor Cyan
Write-Host "Para apagarlo, abre 'Detener Dotty.cmd'."
Start-Sleep -Seconds 3

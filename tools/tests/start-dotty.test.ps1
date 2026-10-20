$ErrorActionPreference = "Stop"
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot = Join-Path $temporaryBase ("dotty-start-test-" + [Guid]::NewGuid().ToString("N"))
$sourceScript = Join-Path (Split-Path -Parent $PSScriptRoot) "start-dotty.ps1"

function Invoke-Scenario([string]$mode, [string]$expectedError, [bool]$expectStart) {
  $root = Join-Path $fixtureRoot $mode
  $toolsDirectory = Join-Path $root "tools"
  $pythonDirectory = Join-Path $root "services/transcriber/.venv/Scripts"
  New-Item -ItemType Directory -Path $toolsDirectory, $pythonDirectory -Force | Out-Null
  Copy-Item -LiteralPath $sourceScript -Destination (Join-Path $toolsDirectory "start-dotty.ps1")
  Set-Content -LiteralPath (Join-Path $pythonDirectory "python.exe") -Value "fixture" -Encoding ASCII
  @(
    "DISCORD_TOKEN=fixture",
    "DISCORD_CLIENT_ID=fixture",
    "DISCORD_GUILD_ID=fixture",
    "DOTTY_DATA_DIR=./data",
    "TRANSCRIBER_BASE_URL=http://127.0.0.1:8765"
  ) | Set-Content -LiteralPath (Join-Path $root ".env") -Encoding ASCII

  $global:dottyTestMode = $mode
  $global:dottyTestStartedTranscriber = $false
  $global:dottyTestStartedBot = $false
  $global:dottyTestProcessStarts = 0
  $global:dottyTestHealthCalls = 0
  $global:dottyTestRoot = $root
  $global:dottyTestLaunchId = $null
  function Get-NetTCPConnection {
    [CmdletBinding()]
    param([string]$State)
    if ($State -ne "Listen") { throw "Unexpected port query" }
    if ($global:dottyTestMode -eq "query-error") { throw "Fixture listener query failed" }
    if ($global:dottyTestMode -like "occupied-*") { return [pscustomobject]@{ LocalPort = 8765; OwningProcess = 9001 } }
    if (-not $global:dottyTestStartedTranscriber) { return }
    if ($global:dottyTestMode -eq "race") { return [pscustomobject]@{ LocalPort = 8765; OwningProcess = 9001 } }
    if ($global:dottyTestMode -eq "process-failed") { return }
    return [pscustomobject]@{ LocalPort = 8765; OwningProcess = 4242 }
  }
  function Invoke-RestMethod {
    [CmdletBinding()]
    param([string]$Uri, [int]$TimeoutSec)
    if ($Uri -like "*11434/api/tags") {
      return [pscustomobject]@{ models = @([pscustomobject]@{ name = "qwen3:4b" }) }
    }
    if ($Uri -like "*/health") {
      $global:dottyTestHealthCalls += 1
      if ($global:dottyTestMode -eq "occupied-no-health") { throw "Fixture health unavailable" }
      if ($global:dottyTestMode -like "occupied-*") { return [pscustomobject]@{ status = "ok"; pid = 9001 } }
      return [pscustomobject]@{ status = "ok"; pid = 4242; launch_id = $global:dottyTestLaunchId }
    }
    throw "Unexpected HTTP request: $Uri"
  }
  function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    if ($Filter -eq 'ProcessId=4243') {
      return [pscustomobject]@{ ProcessId = 4243; CreationDate = (Get-Date); CommandLine = 'node src/index.ts' }
    }
    if ($Filter -eq 'ProcessId=9001') {
      return [pscustomobject]@{ ProcessId = 9001; ParentProcessId = 9000; CreationDate = (Get-Date);
        CommandLine = 'python -m uvicorn dotty_transcriber.main:app --host 127.0.0.1 --port 8765' }
    }
    if ($Filter -eq 'ProcessId=9000' -and $global:dottyTestMode -eq 'occupied-owned') {
      return [pscustomobject]@{ ProcessId = 9000; CreationDate = (Get-Date);
        ExecutablePath = (Join-Path $global:dottyTestRoot 'services/transcriber/.venv/Scripts/python.exe');
        CommandLine = 'python -m uvicorn dotty_transcriber.main:app --host 127.0.0.1 --port 8765' }
    }
  }
  function Start-Process {
    param(
      [string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory,
      [string]$WindowStyle, [string]$RedirectStandardOutput,
      [string]$RedirectStandardError, [switch]$PassThru
    )
    $global:dottyTestProcessStarts += 1
    if ($FilePath -like "*python.exe") {
      $global:dottyTestStartedTranscriber = $true
      $global:dottyTestLaunchId = $env:DOTTY_TRANSCRIBER_LAUNCH_ID
      $process = [pscustomobject]@{ Id = 4242; HasExited = ($global:dottyTestMode -eq "process-failed") }
      $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
      return $process
    }
    if ($FilePath -eq "npm.cmd") {
      $global:dottyTestStartedBot = $true
      Set-Content -LiteralPath $RedirectStandardOutput -Value "Dotty conectado a Discord" -Encoding UTF8
      @{ status = 'ready'; pid = 4243; connectedAt = (Get-Date).ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $global:dottyTestRoot 'data/dotty.status.json')
      return [pscustomobject]@{ Id = 4243; HasExited = $false }
    }
    throw "Unexpected process start: $FilePath"
  }
  function Start-Sleep { param([int]$Milliseconds, [int]$Seconds) }

  if ($mode -eq 'port-free-stale-bot') {
    New-Item -ItemType Directory -Path (Join-Path $root 'data') -Force | Out-Null
    @{ status = 'ready'; pid = 9999; connectedAt = '2026-01-01T00:00:00Z' } |
      ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'data/dotty.status.json')
  }
  $actualError = $null
  try { & (Join-Path $toolsDirectory "start-dotty.ps1") | Out-Null }
  catch { $actualError = $_.Exception.Message }
  if ($expectedError -eq "") {
    if ($null -ne $actualError) { throw "$mode failed: $actualError" }
  } elseif ($actualError -notmatch $expectedError) {
    throw "$mode returned unexpected error: $actualError"
  }
  if ($global:dottyTestStartedTranscriber -ne $expectStart) { throw "$mode transcriber start mismatch" }
  if ($global:dottyTestStartedBot -ne ($expectedError -eq "")) { throw "$mode bot start mismatch" }
  if ($mode -in @('occupied-foreign', 'occupied-no-health', 'query-error')) {
    if ($global:dottyTestProcessStarts -ne 0) { throw "$mode started a process" }
    if ($mode -eq 'query-error' -and $global:dottyTestHealthCalls -ne 0) { throw "$mode called health" }
    if (Test-Path -LiteralPath (Join-Path $root "data")) { throw "$mode modified the data directory" }
  }
  Write-Output "PASS: $mode"
}

try {
  Invoke-Scenario "occupied-owned" "" $false
  Invoke-Scenario "occupied-foreign" "puerto 8765.*ocupado" $false
  Invoke-Scenario "occupied-no-health" "puerto 8765.*ocupado" $false
  Invoke-Scenario "query-error" "No se pudo verificar si el puerto" $false
  Invoke-Scenario "port-free" "" $true
  Invoke-Scenario "port-free-stale-bot" "" $true
  Invoke-Scenario "process-failed" "no respondio" $true
  Invoke-Scenario "race" "Otro proceso ocupo el puerto" $true
} finally {
  $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
  if (-not $resolvedFixture.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe test cleanup path"
  }
  if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
  Remove-Variable -Name dottyTestMode,dottyTestStartedTranscriber,dottyTestStartedBot,dottyTestProcessStarts,dottyTestHealthCalls,dottyTestRoot,dottyTestLaunchId -Scope Global -ErrorAction SilentlyContinue
}

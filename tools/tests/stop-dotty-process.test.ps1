$ErrorActionPreference = "Stop"
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot = Join-Path $temporaryBase ("dotty-stop-process-test-" + [Guid]::NewGuid().ToString("N"))
$sourceScript = Join-Path (Split-Path -Parent $PSScriptRoot) "stop-dotty.ps1"

function global:Get-Process {
  param([int]$Id, [string]$ErrorAction)
  if ($Id -ne 4242) { return $null }
  return $global:dottySimulatedProcess
}
function global:Get-CimInstance {
  param([string]$ClassName, [string]$Filter)
  if ($Filter -ne "ProcessId=4242") { throw "Unexpected process lookup" }
  return [pscustomobject]@{
    CommandLine = "python -m uvicorn dotty_transcriber.main:app --host 127.0.0.1 --port 8765"
    ExecutablePath = (Join-Path $global:dottyFixtureProject "services/transcriber/python.exe")
  }
}
function global:Get-NetTCPConnection {
  param([string]$State, [string]$ErrorAction)
  return [pscustomobject]@{ LocalPort = 8765; OwningProcess = 4242 }
}
function global:Invoke-RestMethod {
  param([string]$Uri, [int]$TimeoutSec)
  if ($Uri -like "*/health" -and -not $global:dottySimulatedProcess.HasExited) {
    $launchId = if ($global:dottyStopMode -eq "foreign") { "other-launch" } else { "our-launch" }
    return [pscustomobject]@{ status = "ok"; pid = 4242; launch_id = $launchId }
  }
  throw "Simulated service is unavailable"
}
function global:taskkill.exe {
  $global:dottyTaskkillCalls += 1
  $global:LASTEXITCODE = 0
}
function global:Start-Sleep { param([int]$Seconds, [int]$Milliseconds) }

function Invoke-Scenario([string]$mode, [string]$expectedError) {
  $global:dottyStopMode = $mode
  $global:dottyTaskkillCalls = 0
  $global:dottyFixtureProject = Join-Path $fixtureRoot $mode
  $root = $global:dottyFixtureProject
  $data = Join-Path $root "data"
  New-Item -ItemType Directory -Path (Join-Path $root "tools"), $data -Force | Out-Null
  Copy-Item -LiteralPath $sourceScript -Destination (Join-Path $root "tools/stop-dotty.ps1")
  @("DOTTY_DATA_DIR=./data", "TRANSCRIBER_BASE_URL=http://127.0.0.1:8765") |
    Set-Content -LiteralPath (Join-Path $root ".env")
  Set-Content -LiteralPath (Join-Path $data "transcriber.pid") -Value "4242"
  Set-Content -LiteralPath (Join-Path $data "transcriber.launch-id") -Value "our-launch"
  $global:dottySimulatedProcess = [pscustomobject]@{ HasExited = $false }
  $global:dottySimulatedProcess | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
    param([int]$timeout)
    if ($global:dottyStopMode -eq "timeout") { return $false }
    $this.HasExited = $true
    return $true
  }

  $errorText = $null
  try { & (Join-Path $root "tools/stop-dotty.ps1") | Out-Null }
  catch { $errorText = $_.Exception.Message }
  if ($expectedError -eq "") {
    if ($null -ne $errorText) { throw "$mode failed: $errorText" }
    if (Test-Path -LiteralPath (Join-Path $data "transcriber.pid")) { throw "$mode left a stale PID" }
    if (Test-Path -LiteralPath (Join-Path $data "transcriber.launch-id")) { throw "$mode left a stale launch ID" }
  } else {
    if ($errorText -notmatch $expectedError) { throw "$mode unexpected error: $errorText" }
    if ((Get-Content -LiteralPath (Join-Path $data "transcriber.pid") -Raw).Trim() -ne "4242") {
      throw "$mode removed the PID"
    }
    if ((Get-Content -LiteralPath (Join-Path $data "transcriber.launch-id") -Raw).Trim() -ne "our-launch") {
      throw "$mode removed the launch ID"
    }
  }
  if ($global:dottyTaskkillCalls -ne $(if ($mode -eq "foreign") { 0 } else { 1 })) {
    throw "$mode called taskkill an unexpected number of times"
  }
  Write-Output "PASS: $mode"
}

try {
  Invoke-Scenario "foreign" "identidad.*no coincide"
  Invoke-Scenario "timeout" "sigue activo"
  Invoke-Scenario "success" ""
} finally {
  foreach ($name in @("Get-Process", "Get-CimInstance", "Get-NetTCPConnection", "Invoke-RestMethod", "taskkill.exe", "Start-Sleep")) {
    Remove-Item -Path "function:global:$name" -ErrorAction SilentlyContinue
  }
  $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
  if (-not $resolvedFixture.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe test cleanup path"
  }
  if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
  Remove-Variable -Name dottyStopMode,dottyTaskkillCalls,dottyFixtureProject,dottySimulatedProcess -Scope Global -ErrorAction SilentlyContinue
}

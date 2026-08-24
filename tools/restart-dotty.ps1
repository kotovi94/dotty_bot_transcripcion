$ErrorActionPreference = "Stop"

$stopScript = Join-Path $PSScriptRoot "stop-dotty.ps1"
$startScript = Join-Path $PSScriptRoot "start-dotty.ps1"

& $stopScript
& $startScript

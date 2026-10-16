$ErrorActionPreference = "Stop"
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot = Join-Path $temporaryBase ("dotty-stop-test-" + [Guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Path (Join-Path $fixtureRoot "tools"), (Join-Path $fixtureRoot "data/recordings/synthetic") | Out-Null
  $sourceScript = Join-Path (Split-Path -Parent $PSScriptRoot) "stop-dotty.ps1"
  $copiedScript = Join-Path $fixtureRoot "tools/stop-dotty.ps1"
  Copy-Item -LiteralPath $sourceScript -Destination $copiedScript
  foreach ($state in @("recording", "paused", "finalizing")) {
    @{ status = $state } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixtureRoot "data/recordings/synthetic/manifest.json")
    $blocked = $false
    try { & $copiedScript } catch {
      if ($_.Exception.Message -notmatch "grabacion activa") { throw }
      $blocked = $true
    }
    if (-not $blocked) { throw "Direct shutdown did not protect $state" }
    Write-Output "PASS: direct shutdown protects $state"
  }
} finally {
  $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
  if (-not $resolvedFixture.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe test cleanup path" }
  if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}

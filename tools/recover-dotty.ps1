$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $projectRoot "data\recovery.log"
$startScript = Join-Path $PSScriptRoot "start-dotty.ps1"
try {
  Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Recuperacion automatica iniciada." -Encoding UTF8
  # The bot launches this helper. Stopping the bot here also terminates this
  # child process on Windows, so restart only the missing transcriber.
  & $startScript | Out-Null
  Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Recuperacion automatica completada." -Encoding UTF8
} catch {
  Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Recuperacion automatica fallo: $($_.Exception.Message)" -Encoding UTF8
  exit 1
}

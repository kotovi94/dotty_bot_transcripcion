param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("get", "enable", "disable")]
  [string]$Operation
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$name = "DottyBotTranscriptor"
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$script = Join-Path $PSScriptRoot "start-dotty.ps1"
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"'
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
$owned = $null -ne $task -and
  @($task.Actions).Count -eq 1 -and
  [string]::Equals([string]$task.Actions[0].Execute, "powershell.exe", [StringComparison]::OrdinalIgnoreCase) -and
  [string]::Equals([string]$task.Actions[0].Arguments, $arguments, [StringComparison]::Ordinal) -and
  [string]::Equals([string]$task.Actions[0].WorkingDirectory, $projectRoot, [StringComparison]::OrdinalIgnoreCase) -and
  @($task.Triggers).Count -eq 1 -and
  $task.Triggers[0].CimClass.CimClassName -eq "MSFT_TaskLogonTrigger" -and
  [string]::Equals([string]$task.Triggers[0].UserId, $user, [StringComparison]::OrdinalIgnoreCase)

if ($Operation -eq "get") {
  if ($owned -and $task.Settings.Enabled -ne $false) { "true" } else { "false" }
  exit 0
}
if ($null -ne $task -and -not $owned) {
  throw "Otra tarea usa el inicio automatico de Dotty; revisala antes de cambiarlo."
}
if ($Operation -eq "enable") {
  if ($null -eq $task) {
    $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $projectRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $name -Action $taskAction -Trigger $trigger -Principal $principal `
      -Settings $settings -Description "Inicia Dotty al entrar en Windows y reanuda su cola persistente." | Out-Null
  } elseif ($task.Settings.Enabled -eq $false) {
    Enable-ScheduledTask -TaskName $name | Out-Null
  }
} elseif ($null -ne $task) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
$updated = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($Operation -eq "enable" -and ($null -eq $updated -or $updated.Settings.Enabled -eq $false)) {
  throw "Windows no confirmo el inicio automatico."
}
if ($Operation -eq "disable" -and $null -ne $updated) {
  throw "Windows no confirmo la desactivacion del inicio automatico."
}
if ($Operation -eq "enable") { "true" } else { "false" }

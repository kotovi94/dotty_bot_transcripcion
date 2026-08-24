$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
[System.Windows.Forms.Application]::EnableVisualStyles()

# Windows PowerShell 5 interpreta UTF-8 sin BOM como ANSI. Estos caracteres se
# construyen en tiempo de ejecucion para que siempre se muestren correctamente.
$aAcute = [char]0x00E1
$eAcute = [char]0x00E9
$iAcute = [char]0x00ED
$oAcute = [char]0x00F3
$uAcute = [char]0x00FA
$nTilde = [char]0x00F1
$statusSymbol = [char]0x25CF

$projectRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot "start-dotty.ps1"
$stopScript = Join-Path $PSScriptRoot "stop-dotty.ps1"
$restartScript = Join-Path $PSScriptRoot "restart-dotty.ps1"
$exportsRoot = Join-Path $projectRoot "data\exports"
$recordingsRoot = Join-Path $projectRoot "data\recordings"
$dataRoot = Join-Path $projectRoot "data"
$botStatusPath = Join-Path $dataRoot "dotty.status.json"
$script:allTranscriptEntries = @()
$script:filteredTranscriptEntries = @()
$script:selectedRawContent = ""
$script:editing = $false
$script:latestHealth = $null
$script:healthTask = $null
$script:lastHealthStartedAt = [DateTime]::MinValue
$script:operationProcess = $null
$script:operationName = ""
$script:operationStartedAt = $null
$script:statusRefreshPending = $true
$httpClient = New-Object System.Net.Http.HttpClient
$httpClient.Timeout = [TimeSpan]::FromSeconds(2)

$background = [System.Drawing.Color]::FromArgb(24, 27, 34)
$panelColor = [System.Drawing.Color]::FromArgb(34, 38, 48)
$fieldColor = [System.Drawing.Color]::FromArgb(18, 21, 27)
$foreground = [System.Drawing.Color]::FromArgb(235, 238, 245)
$muted = [System.Drawing.Color]::FromArgb(160, 168, 184)
$accent = [System.Drawing.Color]::FromArgb(109, 94, 252)
$green = [System.Drawing.Color]::FromArgb(64, 190, 120)
$red = [System.Drawing.Color]::FromArgb(225, 83, 83)

$form = New-Object System.Windows.Forms.Form
$form.Text = "Dotty - Panel de control"
$form.Size = New-Object System.Drawing.Size(1100, 760)
$form.MinimumSize = New-Object System.Drawing.Size(1100, 760)
$form.StartPosition = "CenterScreen"
$form.BackColor = $background
$form.ForeColor = $foreground
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = "DOTTY"
$title.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 22)
$title.ForeColor = $foreground
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(24, 18)
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "Grabaci${oAcute}n y transcripci${oAcute}n de campa${nTilde}as"
$subtitle.ForeColor = $muted
$subtitle.AutoSize = $true
$subtitle.Location = New-Object System.Drawing.Point(27, 58)
$form.Controls.Add($subtitle)

$statusDot = New-Object System.Windows.Forms.Label
$statusDot.Text = [string]$statusSymbol
$statusDot.Font = New-Object System.Drawing.Font("Segoe UI", 15)
$statusDot.ForeColor = $muted
$statusDot.AutoSize = $true
$statusDot.Location = New-Object System.Drawing.Point(858, 27)
$statusDot.Anchor = "Top,Right"
$form.Controls.Add($statusDot)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Comprobando..."
$statusLabel.ForeColor = $muted
$statusLabel.AutoSize = $true
$statusLabel.Location = New-Object System.Drawing.Point(886, 34)
$statusLabel.Anchor = "Top,Right"
$form.Controls.Add($statusLabel)

$processingLabel = New-Object System.Windows.Forms.Label
$processingLabel.Text = "Sin audios en proceso."
$processingLabel.ForeColor = $muted
$processingLabel.AutoEllipsis = $true
$processingLabel.Location = New-Object System.Drawing.Point(332, 52)
$processingLabel.Size = New-Object System.Drawing.Size(710, 22)
$processingLabel.Anchor = "Top,Left,Right"
$form.Controls.Add($processingLabel)

$processingBar = New-Object System.Windows.Forms.ProgressBar
$processingBar.Location = New-Object System.Drawing.Point(332, 75)
$processingBar.Size = New-Object System.Drawing.Size(710, 10)
$processingBar.Minimum = 0
$processingBar.Maximum = 100
$processingBar.Value = 0
$processingBar.Style = "Continuous"
$processingBar.Anchor = "Top,Left,Right"
$form.Controls.Add($processingBar)

function New-DottyButton([string]$text, [int]$x, [System.Drawing.Color]$color) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $text
  $button.Size = New-Object System.Drawing.Size(155, 42)
  $button.Location = New-Object System.Drawing.Point($x, 94)
  $button.FlatStyle = "Flat"
  $button.FlatAppearance.BorderSize = 0
  $button.BackColor = $color
  $button.ForeColor = [System.Drawing.Color]::White
  $button.Cursor = [System.Windows.Forms.Cursors]::Hand
  $button.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
  return $button
}

$startButton = New-DottyButton "Encender Dotty" 28 $green
$stopButton = New-DottyButton "Apagar Dotty" 193 $red
$restartButton = New-DottyButton "Reiniciar Dotty" 358 $accent
$refreshButton = New-DottyButton "Actualizar bit${aAcute}coras" 523 $panelColor
$logsButton = New-DottyButton "Ver actividad" 688 $panelColor
$dataButton = New-DottyButton "Abrir datos" 853 $panelColor
$form.Controls.AddRange(@($startButton, $stopButton, $restartButton, $refreshButton, $logsButton, $dataButton))

$listLabel = New-Object System.Windows.Forms.Label
$listLabel.Text = "TRANSCRIPCIONES"
$listLabel.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
$listLabel.ForeColor = $muted
$listLabel.AutoSize = $true
$listLabel.Location = New-Object System.Drawing.Point(28, 158)
$form.Controls.Add($listLabel)

$searchBox = New-Object System.Windows.Forms.TextBox
$searchBox.Location = New-Object System.Drawing.Point(28, 181)
$searchBox.Size = New-Object System.Drawing.Size(285, 30)
$searchBox.BackColor = $fieldColor
$searchBox.ForeColor = $foreground
$searchBox.BorderStyle = "FixedSingle"
$searchBox.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$form.Controls.Add($searchBox)

$transcriptList = New-Object System.Windows.Forms.ListBox
$transcriptList.Location = New-Object System.Drawing.Point(28, 220)
$transcriptList.Size = New-Object System.Drawing.Size(285, 417)
$transcriptList.Anchor = "Top,Bottom,Left"
$transcriptList.BackColor = $panelColor
$transcriptList.ForeColor = $foreground
$transcriptList.BorderStyle = "None"
$transcriptList.IntegralHeight = $false
$transcriptList.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$form.Controls.Add($transcriptList)

$readerLabel = New-Object System.Windows.Forms.Label
$readerLabel.Text = "LECTOR"
$readerLabel.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
$readerLabel.ForeColor = $muted
$readerLabel.AutoSize = $true
$readerLabel.Location = New-Object System.Drawing.Point(332, 158)
$form.Controls.Add($readerLabel)

$reader = New-Object System.Windows.Forms.RichTextBox
$reader.Location = New-Object System.Drawing.Point(332, 182)
$reader.Size = New-Object System.Drawing.Size(710, 436)
$reader.Anchor = "Top,Bottom,Left,Right"
$reader.BackColor = $fieldColor
$reader.ForeColor = $foreground
$reader.BorderStyle = "None"
$reader.ReadOnly = $true
$reader.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$reader.Text = "Selecciona una transcripci${oAcute}n para leerla."
$form.Controls.Add($reader)

function New-ReaderButton([string]$text, [int]$x, [System.Drawing.Color]$color) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $text
  $button.Size = New-Object System.Drawing.Size(135, 36)
  $button.Location = New-Object System.Drawing.Point($x, 630)
  $button.Anchor = "Bottom,Left"
  $button.FlatStyle = "Flat"
  $button.FlatAppearance.BorderSize = 0
  $button.BackColor = $color
  $button.ForeColor = [System.Drawing.Color]::White
  $button.Cursor = [System.Windows.Forms.Cursors]::Hand
  return $button
}

$editButton = New-ReaderButton "Editar" 332 $panelColor
$saveButton = New-ReaderButton "Guardar" 477 $green
$cancelEditButton = New-ReaderButton "Cancelar" 622 $red
$openButton = New-ReaderButton "Abrir archivo" 762 $panelColor
$folderButton = New-ReaderButton "Abrir carpeta" 907 $panelColor
$saveButton.Enabled = $false
$cancelEditButton.Enabled = $false
$form.Controls.AddRange(@($editButton, $saveButton, $cancelEditButton, $openButton, $folderButton))

$discordButton = New-Object System.Windows.Forms.Button
$discordButton.Text = "Abrir en Discord"
$discordButton.Size = New-Object System.Drawing.Size(155, 30)
$discordButton.Location = New-Object System.Drawing.Point(887, 148)
$discordButton.FlatStyle = "Flat"
$discordButton.FlatAppearance.BorderSize = 0
$discordButton.BackColor = $accent
$discordButton.ForeColor = [System.Drawing.Color]::White
$discordButton.Cursor = [System.Windows.Forms.Cursors]::Hand
$discordButton.Anchor = "Top,Right"
$form.Controls.Add($discordButton)

$activity = New-Object System.Windows.Forms.Label
$activity.Text = "Listo."
$activity.ForeColor = $muted
$activity.AutoEllipsis = $true
$activity.Location = New-Object System.Drawing.Point(28, 685)
$activity.Size = New-Object System.Drawing.Size(1014, 24)
$activity.Anchor = "Bottom,Left,Right"
$form.Controls.Add($activity)

function Start-HealthRefresh {
  if ($null -ne $script:healthTask) { return }
  if (((Get-Date) - $script:lastHealthStartedAt).TotalSeconds -lt 2 -and -not $script:statusRefreshPending) { return }
  $script:lastHealthStartedAt = Get-Date
  $script:statusRefreshPending = $false
  $script:healthTask = $httpClient.GetStringAsync("http://127.0.0.1:8765/health")
}

function Complete-HealthRefresh {
  if ($null -eq $script:healthTask -or -not $script:healthTask.IsCompleted) { return }
  try {
    if ($script:healthTask.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) {
      $script:latestHealth = $script:healthTask.Result | ConvertFrom-Json
    } else {
      $script:latestHealth = $null
    }
  } catch {
    $script:latestHealth = $null
  } finally {
    $script:healthTask.Dispose()
    $script:healthTask = $null
  }
}

function Format-Duration([double]$seconds) {
  $safeSeconds = [math]::Max(0, [math]::Round($seconds))
  $span = [TimeSpan]::FromSeconds($safeSeconds)
  if ($span.TotalHours -ge 1) { return $span.ToString("h\:mm\:ss") }
  return $span.ToString("m\:ss")
}

function Update-ProcessingStatus {
  $health = $script:latestHealth
  if ($null -eq $health) {
    if ($script:operationName) {
      $processingLabel.Text = "Esperando a que los servicios respondan..."
      $processingBar.Style = "Marquee"
    } else {
      $processingLabel.Text = "Transcriptor no disponible. Puedes encender Dotty desde este panel."
      $processingBar.Style = "Continuous"
    }
    $processingBar.Value = 0
    return
  }
  $work = $health.work
  if ($null -eq $work) {
    $device = if ($health.active_device -eq "cuda") { "GPU CUDA" } else { "CPU" }
    $queue = $health.queue
    $processingLabel.Text = "Transcriptor listo | $device | $($health.model) | cola $($queue.queued) | fallidos $($queue.failed)"
    $processingBar.Style = "Continuous"
    $processingBar.Value = 0
    return
  }
  if ($work.status -eq "queued") {
    $processingLabel.Text = "Audio esperando en la cola."
    $processingBar.Style = "Marquee"
    $processingBar.Value = 0
    return
  }

  $percent = [math]::Max(1, [math]::Min(99, [math]::Round([double]$work.progress * 100)))
  $elapsedSeconds = 0
  if ($null -ne $work.started_at) {
    try {
      $startedAt = [DateTimeOffset]::Parse([string]$work.started_at)
      $elapsedSeconds = ([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds
    } catch {
      $elapsedSeconds = 0
    }
  }
  $elapsedText = Format-Duration $elapsedSeconds
  if ([double]$work.progress -ge 0.03 -and $elapsedSeconds -gt 0) {
    $processingBar.Style = "Continuous"
    $processingBar.Value = [int]$percent
    $remaining = $elapsedSeconds * (1 - [double]$work.progress) / [double]$work.progress
    $processingLabel.Text = "Transcribiendo: $percent%  |  $elapsedText transcurrido  |  aprox. $(Format-Duration $remaining)"
  } elseif ($work.phase -eq "loading") {
    $processingBar.Style = "Marquee"
    $processingLabel.Text = "Preparando el modelo de transcripci${oAcute}n..."
  } else {
    $processingBar.Style = "Marquee"
    $processingLabel.Text = "Analizando el primer fragmento  |  $elapsedText transcurrido  |  calculando tiempo restante..."
  }
}

function Get-BotState {
  if (Test-Path -LiteralPath $botStatusPath) {
    try {
      $status = Get-Content -LiteralPath $botStatusPath -Encoding UTF8 -Raw | ConvertFrom-Json
      $actualProcess = Get-Process -Id ([int]$status.pid) -ErrorAction SilentlyContinue
      if ($null -ne $actualProcess -and $status.status -eq "ready") {
        return [PSCustomObject]@{ Running = $true; Connected = $true; Pid = [int]$status.pid }
      }
    } catch {
      # Se usara el PID del lanzador como respaldo.
    }
  }
  $pidPath = Join-Path $projectRoot "data\dotty.pid"
  if (-not (Test-Path -LiteralPath $pidPath)) {
    return [PSCustomObject]@{ Running = $false; Connected = $false; Pid = $null }
  }
  $processId = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$processId)) {
    return [PSCustomObject]@{ Running = $false; Connected = $false; Pid = $null }
  }
  $running = $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)
  return [PSCustomObject]@{ Running = $running; Connected = $false; Pid = $processId }
}

function Update-DottyStatus {
  $transcriberOn = $null -ne $script:latestHealth -and $script:latestHealth.status -eq "ok"
  $bot = Get-BotState
  if ($transcriberOn -and $bot.Connected) {
    $statusDot.ForeColor = $green
    $statusLabel.Text = "Dotty encendido"
  } elseif ($transcriberOn -or $bot.Running) {
    $statusDot.ForeColor = [System.Drawing.Color]::Orange
    $statusLabel.Text = if ($script:operationName) { "Cambiando estado..." } else { "Inicio incompleto" }
  } else {
    $statusDot.ForeColor = $red
    $statusLabel.Text = "Dotty apagado"
  }
  if (-not $script:operationName) {
    $startButton.Enabled = -not ($transcriberOn -and $bot.Connected)
    $stopButton.Enabled = $transcriberOn -or $bot.Running
    $restartButton.Enabled = $transcriberOn -or $bot.Running
  }
}

function Convert-TranscriptForDisplay([string]$content) {
  $display = $content -replace "(?m)^#{1,6}\s*", ""
  $display = $display -replace "\*\*", ""
  $display = $display -replace "(?m)^- Fuente:.*\r?\n", ""
  return $display.Trim()
}

function Get-SelectedTranscriptEntry {
  $index = $transcriptList.SelectedIndex
  if ($index -lt 0 -or $index -ge $script:filteredTranscriptEntries.Count) {
    return $null
  }
  return $script:filteredTranscriptEntries[$index]
}

function Show-SelectedTranscript {
  if ($script:editing) { return }
  $entry = Get-SelectedTranscriptEntry
  if ($null -eq $entry) {
    if ($script:filteredTranscriptEntries.Count -eq 0) {
      $reader.Text = "No hay transcripciones que coincidan con la b${uAcute}squeda."
    }
    return
  }

  try {
    $script:selectedRawContent = Get-Content -LiteralPath $entry.Path -Encoding UTF8 -Raw
    $reader.Text = Convert-TranscriptForDisplay $script:selectedRawContent
    $activity.Text = "Sesi${oAcute}n seleccionada: $($entry.Title)"
  } catch {
    $reader.Text = "No se pudo leer esta transcripci${oAcute}n."
    $activity.Text = $_.Exception.Message
  }
}

function Apply-TranscriptFilter {
  if ($script:editing) { return }
  $query = $searchBox.Text.Trim()
  if ([string]::IsNullOrWhiteSpace($query)) {
    $script:filteredTranscriptEntries = @($script:allTranscriptEntries)
  } else {
    $script:filteredTranscriptEntries = @(
      $script:allTranscriptEntries | Where-Object { $_.SearchText.IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }
    )
  }

  $transcriptList.BeginUpdate()
  try {
    $transcriptList.Items.Clear()
    foreach ($entry in $script:filteredTranscriptEntries) {
      [void]$transcriptList.Items.Add("$($entry.Title)  -  $($entry.Date.ToString('dd-MM-yyyy HH:mm'))")
    }
  } finally {
    $transcriptList.EndUpdate()
  }

  if ($script:filteredTranscriptEntries.Count -gt 0) {
    $transcriptList.SelectedIndex = 0
  } elseif ($script:allTranscriptEntries.Count -eq 0) {
    $reader.Text = "Todav${iAcute}a no hay transcripciones."
  } else {
    $reader.Text = "No hay transcripciones que coincidan con la b${uAcute}squeda."
  }
}

function Update-TranscriptList {
  if ($script:editing) {
    [System.Windows.Forms.MessageBox]::Show("Guarda o cancela la edici${oAcute}n antes de actualizar.", "Dotty") | Out-Null
    return
  }

  $script:allTranscriptEntries = @()
  if (Test-Path -LiteralPath $exportsRoot) {
    $files = @([System.IO.Directory]::EnumerateFiles(
      $exportsRoot,
      "bitacora.md",
      [System.IO.SearchOption]::AllDirectories
    ) | ForEach-Object { Get-Item -LiteralPath $_ } | Sort-Object LastWriteTime -Descending)
    foreach ($file in $files) {
      $stream = New-Object System.IO.StreamReader($file.FullName, [System.Text.Encoding]::UTF8, $true)
      try {
        $firstLine = $stream.ReadLine()
      } finally {
        $stream.Dispose()
      }
      $name = if ($firstLine -match "^#\s+(.+)$") { $Matches[1] } else { $file.Directory.Name }
      $sessionId = $file.Directory.Name
      $script:allTranscriptEntries += [PSCustomObject]@{
        Path = $file.FullName
        Title = $name
        Date = $file.LastWriteTime
        SearchText = "$name`n$sessionId`n$($file.LastWriteTime.ToString('yyyy-MM-dd'))"
        SessionId = $sessionId
        ManifestPath = Join-Path (Join-Path $recordingsRoot $sessionId) "manifest.json"
      }
    }
  }
  Apply-TranscriptFilter
}

function Set-EditMode([bool]$enabled) {
  $script:editing = $enabled
  $reader.ReadOnly = -not $enabled
  $saveButton.Enabled = $enabled
  $cancelEditButton.Enabled = $enabled
  $editButton.Enabled = -not $enabled
  $transcriptList.Enabled = -not $enabled
  $searchBox.Enabled = -not $enabled
  $refreshButton.Enabled = -not $enabled
  if ($enabled) {
    $reader.BackColor = $panelColor
    $reader.Focus()
  } else {
    $reader.BackColor = $fieldColor
  }
}

function Set-OperationControls([bool]$enabled) {
  $startButton.Enabled = $enabled
  $stopButton.Enabled = $enabled
  $restartButton.Enabled = $enabled
}

function Start-DottyOperation([string]$name, [string]$scriptPath) {
  if ($null -ne $script:operationProcess -and -not $script:operationProcess.HasExited) { return }
  try {
    $stdoutPath = Join-Path $dataRoot "panel-operation.stdout.log"
    $stderrPath = Join-Path $dataRoot "panel-operation.stderr.log"
    $script:operationName = $name
    $script:operationStartedAt = Get-Date
    Set-OperationControls $false
    $processingBar.Style = "Marquee"
    $activity.Text = "$name en curso. El panel seguira respondiendo..."
    $script:operationProcess = Start-Process `
      -FilePath "powershell.exe" `
      -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$scriptPath`"") `
      -WorkingDirectory $projectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru
  } catch {
    $script:operationName = ""
    $script:operationProcess = $null
    Set-OperationControls $true
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "No se pudo ejecutar la operacion", "OK", "Error") | Out-Null
  }
}

function Complete-DottyOperation {
  if ($null -eq $script:operationProcess) { return }
  $script:operationProcess.Refresh()
  if (-not $script:operationProcess.HasExited) {
    $elapsed = [math]::Round(((Get-Date) - $script:operationStartedAt).TotalSeconds)
    $activity.Text = "$($script:operationName) en curso | ${elapsed}s transcurridos | puedes seguir usando el panel."
    return
  }

  $exitCode = $script:operationProcess.ExitCode
  $completedName = $script:operationName
  $script:operationProcess.Dispose()
  $script:operationProcess = $null
  $script:operationName = ""
  $script:statusRefreshPending = $true
  $script:lastHealthStartedAt = [DateTime]::MinValue
  if ($exitCode -eq 0) {
    $activity.Text = "$completedName completado correctamente."
  } else {
    $errorPath = Join-Path $dataRoot "panel-operation.stderr.log"
    $details = if (Test-Path $errorPath) {
      (Get-Content -LiteralPath $errorPath -Tail 25 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
    } else {
      "La operacion termino con codigo $exitCode."
    }
    [System.Windows.Forms.MessageBox]::Show($details, "$completedName no pudo completarse", "OK", "Error") | Out-Null
    $activity.Text = "$completedName termino con un error. Revisa Ver actividad."
  }
  Set-OperationControls $true
}

function Show-DottyLogs {
  $logForm = New-Object System.Windows.Forms.Form
  $logForm.Text = "Dotty - Actividad y diagnostico"
  $logForm.Size = New-Object System.Drawing.Size(900, 600)
  $logForm.MinimumSize = New-Object System.Drawing.Size(700, 450)
  $logForm.StartPosition = "CenterParent"
  $logForm.BackColor = $background
  $logForm.ForeColor = $foreground
  $logForm.Font = New-Object System.Drawing.Font("Segoe UI", 10)

  $selector = New-Object System.Windows.Forms.ComboBox
  $selector.DropDownStyle = "DropDownList"
  $selector.Location = New-Object System.Drawing.Point(18, 16)
  $selector.Size = New-Object System.Drawing.Size(260, 30)
  [void]$selector.Items.AddRange(@("Bot de Discord", "Transcriptor", "Arranque y apagado", "Operacion del panel"))
  $selector.SelectedIndex = 0
  $logForm.Controls.Add($selector)

  $copyButton = New-Object System.Windows.Forms.Button
  $copyButton.Text = "Copiar"
  $copyButton.Location = New-Object System.Drawing.Point(292, 14)
  $copyButton.Size = New-Object System.Drawing.Size(100, 32)
  $copyButton.FlatStyle = "Flat"
  $copyButton.BackColor = $panelColor
  $copyButton.ForeColor = $foreground
  $logForm.Controls.Add($copyButton)

  $logReader = New-Object System.Windows.Forms.RichTextBox
  $logReader.Location = New-Object System.Drawing.Point(18, 58)
  $logReader.Size = New-Object System.Drawing.Size(848, 482)
  $logReader.Anchor = "Top,Bottom,Left,Right"
  $logReader.BackColor = $fieldColor
  $logReader.ForeColor = $foreground
  $logReader.BorderStyle = "None"
  $logReader.ReadOnly = $true
  $logReader.Font = New-Object System.Drawing.Font("Consolas", 9)
  $logForm.Controls.Add($logReader)

  $refreshLogs = {
    $paths = switch ($selector.SelectedIndex) {
      0 { @((Join-Path $dataRoot "dotty.stdout.log"), (Join-Path $dataRoot "dotty.stderr.log")) }
      1 { @((Join-Path $dataRoot "transcriber.stdout.log"), (Join-Path $dataRoot "transcriber.stderr.log")) }
      2 { @((Join-Path $dataRoot "startup.log"), (Join-Path $dataRoot "shutdown.log")) }
      default { @((Join-Path $dataRoot "panel-operation.stdout.log"), (Join-Path $dataRoot "panel-operation.stderr.log")) }
    }
    $lines = @()
    foreach ($path in $paths) {
      if (Test-Path -LiteralPath $path) {
        $lines += "===== $([IO.Path]::GetFileName($path)) ====="
        $lines += @(Get-Content -LiteralPath $path -Tail 150 -ErrorAction SilentlyContinue)
      }
    }
    $nextText = if ($lines.Count) { $lines -join [Environment]::NewLine } else { "Aun no hay registros para mostrar." }
    if ($logReader.Text -ne $nextText) {
      $logReader.Text = $nextText
      $logReader.SelectionStart = $logReader.TextLength
      $logReader.ScrollToCaret()
    }
  }
  $selector.Add_SelectedIndexChanged($refreshLogs)
  $copyButton.Add_Click({ if ($logReader.Text) { [System.Windows.Forms.Clipboard]::SetText($logReader.Text) } })
  $logTimer = New-Object System.Windows.Forms.Timer
  $logTimer.Interval = 1500
  $logTimer.Add_Tick($refreshLogs)
  $logForm.Add_Shown({ & $refreshLogs; $logTimer.Start() })
  $logForm.Add_FormClosed({ $logTimer.Stop(); $logTimer.Dispose() })
  [void]$logForm.ShowDialog($form)
}

$transcriptList.Add_SelectedIndexChanged({ Show-SelectedTranscript })
$searchBox.Add_TextChanged({ Apply-TranscriptFilter })

$startButton.Add_Click({
  Start-DottyOperation "Encendido de Dotty" $startScript
})

$stopButton.Add_Click({
  Start-DottyOperation "Apagado de Dotty" $stopScript
})

$restartButton.Add_Click({ Start-DottyOperation "Reinicio de Dotty" $restartScript })
$logsButton.Add_Click({ Show-DottyLogs })
$dataButton.Add_Click({ Start-Process -FilePath "explorer.exe" -ArgumentList @("`"$dataRoot`"") })

$refreshButton.Add_Click({
  Update-TranscriptList
  if (-not $script:editing) {
    $activity.Text = "Lista de transcripciones actualizada."
  }
})

$openButton.Add_Click({
  $entry = Get-SelectedTranscriptEntry
  if ($null -ne $entry) {
    Start-Process -FilePath $entry.Path
  } else {
    [System.Windows.Forms.MessageBox]::Show("Selecciona una transcripci${oAcute}n primero.", "Dotty") | Out-Null
  }
})

$editButton.Add_Click({
  $entry = Get-SelectedTranscriptEntry
  if ($null -eq $entry) {
    [System.Windows.Forms.MessageBox]::Show("Selecciona una transcripci${oAcute}n primero.", "Dotty") | Out-Null
    return
  }
  $script:selectedRawContent = Get-Content -LiteralPath $entry.Path -Encoding UTF8 -Raw
  $reader.Text = $script:selectedRawContent
  Set-EditMode $true
  $activity.Text = "Editando una copia local. Guardar crear${aAcute} un respaldo autom${aAcute}tico."
})

$cancelEditButton.Add_Click({
  Set-EditMode $false
  $reader.Text = Convert-TranscriptForDisplay $script:selectedRawContent
  $activity.Text = "Edici${oAcute}n cancelada; no se cambi${oAcute} el archivo."
})

$saveButton.Add_Click({
  $entry = Get-SelectedTranscriptEntry
  if ($null -eq $entry) { return }

  $choice = [System.Windows.Forms.MessageBox]::Show(
    "Se guardar${aAcute} la correcci${oAcute}n local y se crear${aAcute} una copia de respaldo. Esta acci${oAcute}n no modifica autom${aAcute}ticamente la publicaci${oAcute}n de Discord.`n`n${iAcute}Deseas continuar?",
    "Guardar correcci${oAcute}n",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) { return }

  try {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = Join-Path (Split-Path -Parent $entry.Path) "bitacora.respaldo-$stamp.md"
    Copy-Item -LiteralPath $entry.Path -Destination $backupPath
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($entry.Path, $reader.Text, $utf8WithoutBom)
    $script:selectedRawContent = $reader.Text
    Set-EditMode $false
    Update-TranscriptList
    $activity.Text = "Correcci${oAcute}n guardada. Se cre${oAcute} un respaldo junto al archivo."
  } catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "No se pudo guardar", "OK", "Error") | Out-Null
  }
})

$folderButton.Add_Click({
  $entry = Get-SelectedTranscriptEntry
  if ($null -eq $entry) {
    [System.Windows.Forms.MessageBox]::Show("Selecciona una transcripci${oAcute}n primero.", "Dotty") | Out-Null
    return
  }
  Start-Process -FilePath "explorer.exe" -ArgumentList @("/select,`"$($entry.Path)`"")
})

$discordButton.Add_Click({
  $entry = Get-SelectedTranscriptEntry
  if ($null -eq $entry) {
    [System.Windows.Forms.MessageBox]::Show("Selecciona una transcripci${oAcute}n primero.", "Dotty") | Out-Null
    return
  }
  if (-not (Test-Path -LiteralPath $entry.ManifestPath)) {
    [System.Windows.Forms.MessageBox]::Show("Esta sesi${oAcute}n no tiene informaci${oAcute}n de publicaci${oAcute}n.", "Dotty") | Out-Null
    return
  }

  try {
    $manifest = Get-Content -LiteralPath $entry.ManifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $threadId = $manifest.publication.threadId
    $guildId = $manifest.discordGuildId
    if ([string]::IsNullOrWhiteSpace($threadId) -or [string]::IsNullOrWhiteSpace($guildId)) {
      [System.Windows.Forms.MessageBox]::Show("Esta sesi${oAcute}n todav${iAcute}a no tiene una publicaci${oAcute}n en Discord.", "Dotty") | Out-Null
      return
    }
    Start-Process -FilePath "https://discord.com/channels/$guildId/$threadId"
  } catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "No se pudo abrir Discord", "OK", "Error") | Out-Null
  }
})

$form.Add_Shown({
  $activity.Text = "Panel listo. Comprobando servicios sin bloquear la interfaz..."
  Update-DottyStatus
  Update-ProcessingStatus
  Update-TranscriptList
  Start-HealthRefresh
})

$statusTimer = New-Object System.Windows.Forms.Timer
$statusTimer.Interval = 250
$statusTimer.Add_Tick({
  Complete-DottyOperation
  Complete-HealthRefresh
  Update-DottyStatus
  Update-ProcessingStatus
  Start-HealthRefresh
})
$statusTimer.Start()
$form.Add_FormClosed({
  $statusTimer.Stop()
  $statusTimer.Dispose()
  if ($null -ne $script:healthTask) { $script:healthTask.Dispose() }
  $httpClient.Dispose()
})

[void]$form.ShowDialog()

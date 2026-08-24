$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot "apps\control-panel\launcher\Program.cs"
$iconPath = Join-Path $projectRoot "apps\control-panel\resources\dotty-icon.ico"
$outputPath = Join-Path $projectRoot "Panel Dotty.exe"

if (-not (Test-Path -LiteralPath $sourcePath) -or -not (Test-Path -LiteralPath $iconPath)) {
  throw "Faltan el codigo del lanzador o el icono de Dotty."
}

$compilerCandidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$compilerPath = $compilerCandidates |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -First 1

if (-not $compilerPath) {
  throw "No se encontro el compilador de C# incluido en Windows."
}

$temporaryOutputPath = Join-Path $projectRoot "Panel Dotty.nuevo.exe"
if (Test-Path -LiteralPath $temporaryOutputPath) {
  Remove-Item -LiteralPath $temporaryOutputPath -Force
}

& $compilerPath `
  /nologo `
  /target:winexe `
  "/out:$temporaryOutputPath" `
  "/win32icon:$iconPath" `
  /reference:System.dll `
  /reference:System.Windows.Forms.dll `
  $sourcePath

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporaryOutputPath)) {
  throw "No se pudo compilar el lanzador de Dotty."
}

Move-Item -LiteralPath $temporaryOutputPath -Destination $outputPath -Force

Write-Output "Lanzador creado: $outputPath"

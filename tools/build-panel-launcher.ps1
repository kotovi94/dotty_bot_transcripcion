$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot "apps\control-panel\launcher\Program.cs"
$iconPath = Join-Path $projectRoot "apps\control-panel\resources\dotty-icon.ico"
$outputPath = Join-Path $projectRoot "Panel Dotty.exe"

if (-not (Test-Path -LiteralPath $sourcePath) -or -not (Test-Path -LiteralPath $iconPath)) {
  throw "Faltan el codigo del lanzador o el icono de Dotty."
}

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Force
}

Add-Type -AssemblyName Microsoft.CSharp

$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
$parameters = New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateExecutable = $true
$parameters.GenerateInMemory = $false
$parameters.OutputAssembly = $outputPath
$parameters.CompilerOptions = "/target:winexe /win32icon:`"$iconPath`""
[void]$parameters.ReferencedAssemblies.Add("System.dll")
[void]$parameters.ReferencedAssemblies.Add("System.Windows.Forms.dll")

$source = Get-Content -LiteralPath $sourcePath -Raw
$result = $provider.CompileAssemblyFromSource($parameters, $source)
$provider.Dispose()

if ($result.Errors.HasErrors) {
  $messages = $result.Errors | ForEach-Object { $_.ToString() }
  throw "No se pudo compilar el lanzador:`n$($messages -join "`n")"
}

Write-Output "Lanzador creado: $outputPath"

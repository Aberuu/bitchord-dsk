param(
    [int]$Port = 8080,
    [string]$BindHost = "127.0.0.1"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$AddonDir = Join-Path $RepoRoot "tools\bitchord-flac-addon"
$PythonExe = Join-Path $AddonDir ".venv\Scripts\python.exe"
$ServerPy = Join-Path $AddonDir "server.py"

if (-not (Test-Path $PythonExe)) {
    throw "Missing Python virtualenv at $PythonExe. Run setup first."
}
if (-not (Test-Path $ServerPy)) {
    throw "Missing addon server script at $ServerPy."
}

$env:HOST = $BindHost
$env:PORT = "$Port"

Write-Host "Starting layzxz/bitchord-flac-addon on http://${BindHost}:${Port} ..."
Write-Host "Addon URL for BitChord Sources: http://${BindHost}:${Port}"
& $PythonExe $ServerPy

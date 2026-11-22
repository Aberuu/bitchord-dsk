# Starts a local BitChord Listen Together Go server with desktop origins permitted.
param(
  [int]$Port = 8000
)

$backendDir = Join-Path $PSScriptRoot "..\BitChord-main\backend"
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  Write-Error "Go toolchain not found. Install Go 1.22+ to run the self-hosted Listen Together server."
  exit 1
}

$env:PORT = "$Port"
$env:JAM_ALLOWED_ORIGINS = "http://localhost:5173,http://tauri.localhost,https://tauri.localhost"
Push-Location $backendDir
try {
  Write-Host "Starting Listen Together server on http://127.0.0.1:$Port ..."
  go run .
} finally {
  Pop-Location
}

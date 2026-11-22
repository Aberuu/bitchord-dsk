param(
    [switch]$Dev,
    [switch]$RebuildWeb
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:PATH = "$env:USERPROFILE\.cargo\bin;C:\mingw64\bin;$env:PATH"

if ($Dev) {
    $viteProc = $null
    $listening = $false
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", 5173)
        $listening = $true
        $tcp.Close()
    } catch {
        $listening = $false
    }

    if (-not $listening) {
        Write-Host "Starting Vite dev server on http://localhost:5173..."
        $viteProc = Start-Process -FilePath "pnpm.cmd" -ArgumentList @("--dir", "$root\web", "--filter", "@bitchord/app", "dev") -PassThru -WindowStyle Hidden
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 300
            try {
                $probe = New-Object System.Net.Sockets.TcpClient
                $probe.Connect("127.0.0.1", 5173)
                $probe.Close()
                break
            } catch {}
        }
    }

    $exe = "$root\target\debug\bitchord-desktop.exe"
    if (-not (Test-Path $exe)) {
        & cargo build --manifest-path "$root\Cargo.toml" --bin bitchord-desktop
    }
    $env:PATH = "$root\target\debug;C:\mingw64\bin;$env:PATH"
    try {
        Write-Host "Launching BitChord Desktop (Dev mode)..."
        & $exe
    } finally {
        if ($viteProc -and -not $viteProc.HasExited) {
            Stop-Process -Id $viteProc.Id -Force -ErrorAction SilentlyContinue
        }
    }
    exit 0
}

if ($RebuildWeb -or -not (Test-Path "$root\web\app\dist\index.html")) {
    Write-Host "Building @bitchord/app production bundle..."
    pnpm --dir "$root\web" --filter @bitchord/app build
}

$exe = "$root\target\release\bitchord-desktop.exe"
if (-not (Test-Path $exe) -or $RebuildWeb) {
    Write-Host "Compiling bitchord-desktop (release)..."
    & cargo build --manifest-path "$root\Cargo.toml" --bin bitchord-desktop --release --features custom-protocol
}

$env:PATH = "$root\target\release;C:\mingw64\bin;$env:PATH"
Write-Host "Launching BitChord Desktop..."
& $exe

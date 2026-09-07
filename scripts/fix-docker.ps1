# Giggora — Docker Desktop stale-socket repair (Windows).
#
# Symptom this fixes:
#
#   Docker Desktop shows "An unexpected error occurred ... needs to close" with
#   a message like:
#
#     starting services: initializing Secrets Engine: listening on
#     unix://C:\Users\<you>\AppData\Local\docker-secrets-engine\engine.sock:
#     remove ...: The file cannot be accessed by the system.
#
#   (The failing component may instead be "Inference manager" or another
#   service — same cause, different socket.)
#
# Cause:
#   Docker implements AF_UNIX sockets on Windows as reparse-point files. An
#   unclean shutdown can leave a 0-byte file whose reparse tag no longer
#   resolves. Windows then refuses to delete it (error 1920), Docker cannot
#   re-bind the socket, and the whole backend aborts on startup.
#
# Why it cannot simply be deleted:
#   Remove-Item, [System.IO.File]::Delete and `fsutil reparsepoint delete` all
#   fail with error 1920. Renaming the PARENT DIRECTORY does work, because that
#   never opens the broken file. Docker recreates the directory on next start.
#
# This does NOT touch images, volumes, or containers. Do not use Docker's
# "Reset to factory defaults" for this — that would destroy them.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/fix-docker.ps1

$ErrorActionPreference = "Continue"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host ""
Write-Host "  Giggora :: Docker stale-socket repair" -ForegroundColor Cyan
Write-Host "  ====================================="

Write-Host ""
Write-Host "  1. Stopping Docker Desktop..."
$procs = Get-Process -Name "*docker*", "com.docker*" -ErrorAction SilentlyContinue
if ($procs) {
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 6
    Write-Host "     stopped $($procs.Count) process(es)"
} else {
    Write-Host "     already stopped"
}

Write-Host ""
Write-Host "  2. Quarantining directories that hold stale sockets..."
$targets = @(
    @{ Path = "$env:LOCALAPPDATA\Docker\run";            Leaf = "run" },
    @{ Path = "$env:LOCALAPPDATA\docker-secrets-engine"; Leaf = "docker-secrets-engine" }
)
$moved = 0
foreach ($t in $targets) {
    if (-not (Test-Path -LiteralPath $t.Path)) {
        Write-Host "     $($t.Leaf): not present"
        continue
    }
    try {
        Rename-Item -LiteralPath $t.Path -NewName "$($t.Leaf).broken-$stamp" -ErrorAction Stop
        Write-Host "     $($t.Leaf): quarantined -> $($t.Leaf).broken-$stamp" -ForegroundColor Green
        $moved++
    } catch {
        Write-Host "     $($t.Leaf): FAILED - $($_.Exception.Message)" -ForegroundColor Red
    }
}
Write-Host "     $moved directory(ies) quarantined"

Write-Host ""
Write-Host "  3. Starting Docker Desktop..."
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"

$ready = $false
for ($i = 0; $i -lt 36; $i++) {
    Start-Sleep -Seconds 5
    & docker ps 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
}

Write-Host ""
if ($ready) {
    Write-Host "  Docker engine is UP after ~$(($i + 1) * 5)s." -ForegroundColor Green
    Write-Host ""
    Write-Host "  Start the chain with:  bash scripts/start-network.sh"
} else {
    Write-Host "  Engine did not come up within 180s." -ForegroundColor Red
    Write-Host "  Check the current error with:"
    Write-Host "    Get-Content `"`$env:LOCALAPPDATA\Docker\backend.error.json`""
    Write-Host ""
    Write-Host "  If it names a DIFFERENT socket path, add its parent directory"
    Write-Host "  to the `$targets list at the top of this script and re-run."
}

Write-Host ""
Write-Host "  Quarantined folders can be deleted once Docker is healthy, but"
Write-Host "  Windows may keep refusing (error 1920). Leaving them is harmless."
Write-Host ""

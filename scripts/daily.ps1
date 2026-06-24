# JobPilot daily run — fetch latest jobs + AI-curated top picks + digest email.
# Usage:        powershell -ExecutionPolicy Bypass -File scripts\daily.ps1
# Env required: JOBPILOT_BACKEND_URL (default http://localhost:8080), JOBPILOT_API_TOKEN

$ErrorActionPreference = "Stop"
$base  = if ($env:JOBPILOT_BACKEND_URL) { $env:JOBPILOT_BACKEND_URL } else { "http://localhost:8080" }
$token = if ($env:JOBPILOT_API_TOKEN) { $env:JOBPILOT_API_TOKEN } else { throw "Set JOBPILOT_API_TOKEN env var" }

Write-Host "JobPilot daily run against $base ..."
try {
    $resp = Invoke-RestMethod -Method Post -Uri "$base/api/daily/run/sync" `
        -Headers @{ "X-Api-Token" = $token } -TimeoutSec 180
    Write-Host ("Fetched {0}, inserted {1}, top picks {2}" -f $resp.fetched, $resp.inserted, $resp.topPicks)
    Write-Host "Briefing:`n$($resp.briefing)"
} catch {
    Write-Error "Daily run failed: $($_.Exception.Message)"
    exit 1
}

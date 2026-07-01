<#
.SYNOPSIS
  Sync secret environment variables from backend/.env to Render via the Render API.
  Secrets stay local — they NEVER touch Git/GitHub.

.DESCRIPTION
  Reads the sensitive keys from your local backend/.env file and pushes them to
  Render's environment using their REST API. This is a secure alternative to
  setting sync: true in render.yaml (which would commit secrets to Git).

.PREREQUISITES
  1. A Render API key — generate one at: https://dashboard.render.com/account/api-keys
  2. Your Render service ID — find it in the service URL:
       https://dashboard.render.com/web/srv-XXXXXXXXX  ← that's the ID
  3. Set them as environment variables or pass as parameters.

.USAGE
  # Option A: Set env vars first (recommended, one-time)
  $env:RENDER_API_KEY = "rnd_xxxxxxxxxxxxxxxx"
  $env:RENDER_SERVICE_ID = "srv-xxxxxxxxxxxxxxxxxx"
  .\scripts\render-sync-env.ps1

  # Option B: Pass as parameters
  .\scripts\render-sync-env.ps1 -ApiKey "rnd_xxx" -ServiceId "srv-xxx"
#>
param(
    [string]$ApiKey    = $env:RENDER_API_KEY,
    [string]$ServiceId = $env:RENDER_SERVICE_ID,
    [string]$EnvFile   = "$PSScriptRoot\..\backend\.env"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Validate inputs ──────────────────────────────────────────────────────────
if (-not $ApiKey)    { Write-Host "❌ RENDER_API_KEY not set. Get one at https://dashboard.render.com/account/api-keys" -ForegroundColor Red; exit 1 }
if (-not $ServiceId) { Write-Host "❌ RENDER_SERVICE_ID not set. Find it in your Render service URL (srv-xxxxxxxxx)" -ForegroundColor Red; exit 1 }

$envPath = Resolve-Path $EnvFile -ErrorAction SilentlyContinue
if (-not $envPath) { Write-Host "❌ .env file not found: $EnvFile" -ForegroundColor Red; exit 1 }

# ── Secret keys to sync (only sensitive ones — non-secrets stay in render.yaml) ──
$SECRET_KEYS = @(
    "JOBPILOT_API_TOKEN",
    "JOBPILOT_GROQ_API_KEY",
    "JOBPILOT_GEMINI_API_KEY",
    "JOBPILOT_BREVO_API_KEY",
    "JOBPILOT_ADZUNA_APP_ID",
    "JOBPILOT_ADZUNA_APP_KEY",
    "JOBPILOT_JOOBLE_KEY",
    "SPRING_MAIL_USERNAME",
    "SPRING_MAIL_PASSWORD",
    "JOBPILOT_MAIL_FROM",
    "JOBPILOT_MAIL_DIGEST_TO"
)

# ── Parse .env file ──────────────────────────────────────────────────────────
Write-Host "`n🔑 Reading secrets from $envPath" -ForegroundColor Cyan
$envVars = @{}
Get-Content $envPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#")) {
        $eqIdx = $line.IndexOf("=")
        if ($eqIdx -gt 0) {
            $key = $line.Substring(0, $eqIdx).Trim()
            $val = $line.Substring($eqIdx + 1).Trim().Trim('"').Trim("'")
            $envVars[$key] = $val
        }
    }
}

# ── First, fetch existing env vars from Render (so we don't clobber non-secret ones) ──
Write-Host "📡 Fetching current Render env vars..." -ForegroundColor Cyan
$headers = @{
    "Authorization" = "Bearer $ApiKey"
    "Accept"        = "application/json"
    "Content-Type"  = "application/json"
}
$baseUrl = "https://api.render.com/v1/services/$ServiceId/env-vars"

try {
    $current = Invoke-RestMethod -Uri $baseUrl -Headers $headers -Method Get
} catch {
    Write-Host "❌ Failed to fetch Render env vars: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response.StatusCode -eq 401) {
        Write-Host "   → Check your RENDER_API_KEY" -ForegroundColor Yellow
    }
    exit 1
}

# Build a map of existing vars
$existing = @{}
foreach ($v in $current) {
    $existing[$v.envVar.key] = $v.envVar.value
}

# ── Merge: update only secret keys, keep everything else ─────────────────────
$updated = @()
$synced = @()
$skipped = @()

foreach ($v in $current) {
    $key = $v.envVar.key
    if ($SECRET_KEYS -contains $key) {
        if ($envVars.ContainsKey($key) -and $envVars[$key]) {
            # Replace with local value
            $updated += @{ key = $key; value = $envVars[$key] }
            $synced += $key
        } else {
            # Keep existing Render value (local .env doesn't have it)
            $updated += @{ key = $key; value = $v.envVar.value }
            $skipped += $key
        }
    } else {
        # Non-secret: keep as-is
        $updated += @{ key = $key; value = $v.envVar.value }
    }
}

# Add any secret keys that exist in local .env but not yet on Render
foreach ($key in $SECRET_KEYS) {
    if (-not $existing.ContainsKey($key) -and $envVars.ContainsKey($key) -and $envVars[$key]) {
        $updated += @{ key = $key; value = $envVars[$key] }
        $synced += $key
    }
}

if ($synced.Count -eq 0) {
    Write-Host "`n⚠️  No secrets to update (all keys are empty in local .env or already match)" -ForegroundColor Yellow
    exit 0
}

# ── Push to Render ───────────────────────────────────────────────────────────
Write-Host "`n🚀 Pushing $($synced.Count) secret(s) to Render..." -ForegroundColor Cyan
$body = $updated | ConvertTo-Json -Depth 3

try {
    Invoke-RestMethod -Uri $baseUrl -Headers $headers -Method Put -Body $body | Out-Null
    Write-Host "`n✅ Synced successfully!" -ForegroundColor Green
    foreach ($k in $synced) {
        $masked = $envVars[$k]
        if ($masked.Length -gt 8) { $masked = $masked.Substring(0,4) + "****" + $masked.Substring($masked.Length - 4) }
        else { $masked = "****" }
        Write-Host "   ✓ $k = $masked" -ForegroundColor DarkGray
    }
    if ($skipped.Count -gt 0) {
        Write-Host "`n   Skipped (not in local .env):" -ForegroundColor DarkYellow
        foreach ($k in $skipped) { Write-Host "   · $k" -ForegroundColor DarkGray }
    }
    Write-Host "`n💡 Render will auto-deploy with the new values." -ForegroundColor Cyan
} catch {
    Write-Host "❌ Failed to update Render env vars: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

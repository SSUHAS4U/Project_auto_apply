# JobPilot launcher — starts backend (with embedded Postgres) + frontend.
# Usage:  powershell -ExecutionPolicy Bypass -File start.ps1
# Opens two windows; close them to stop the services.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# --- Load backend/.env into this process so the backend picks up secrets ---
$envFile = Join-Path $root "backend\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $idx = $line.IndexOf("=")
            $name = $line.Substring(0, $idx).Trim()
            $val  = $line.Substring($idx + 1).Trim().Trim('"')
            [System.Environment]::SetEnvironmentVariable($name, $val, "Process")
        }
    }
    Write-Host "Loaded backend/.env"
} else {
    Write-Warning "backend/.env not found — copy .env.example to backend/.env first."
}

# --- Backend: prefer the prebuilt jar; fall back to the Maven wrapper ---
$jar = Get-ChildItem (Join-Path $root "backend\target") -Filter "jobpilot-backend-*.jar" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($jar) {
    Write-Host "Starting backend (jar) ..."
    Start-Process -FilePath "java" -ArgumentList "-jar", "`"$($jar.FullName)`"" -WorkingDirectory (Join-Path $root "backend")
} else {
    Write-Host "No jar found — building & running with Maven wrapper (first run is slow) ..."
    Start-Process -FilePath "cmd" -ArgumentList "/c", "mvnw.cmd spring-boot:run" -WorkingDirectory (Join-Path $root "backend")
}

# --- Frontend ---
$fe = Join-Path $root "frontend"
if (-not (Test-Path (Join-Path $fe "node_modules"))) {
    Write-Host "Installing frontend deps ..."
    Start-Process -FilePath "cmd" -ArgumentList "/c", "npm install" -WorkingDirectory $fe -Wait
}
Write-Host "Starting frontend (Vite) ..."
Start-Process -FilePath "cmd" -ArgumentList "/c", "npm run dev" -WorkingDirectory $fe

Write-Host ""
Write-Host "Backend  : http://localhost:8080/health   (give it ~10-20s)"
Write-Host "Dashboard: http://localhost:5173"
Write-Host "Two windows opened. Close them to stop the services."
